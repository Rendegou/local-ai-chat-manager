//! Explicit, previewed imports. Managed originals make the index rebuildable.
use std::path::{Path, PathBuf};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use crate::{Error, Result};
use crate::model::*;
use crate::adapters::{AdapterContext, ConversationAdapter, MessageSink};
use crate::localized::{LocalizedText, SourceNote};
use crate::adapters::native::{descriptor, files, read_json};

pub const MAX_IMPORT_BYTES: usize = 16 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportSession {
    pub source: SourceKind,
    #[serde(default)] pub external_id: Option<String>,
    #[serde(default)] pub title: Option<String>,
    #[serde(default)] pub created_at: Option<String>,
    #[serde(default)] pub updated_at: Option<String>,
    pub messages: Vec<ImportMessage>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportMessage {
    pub role: String,
    pub text: String,
    #[serde(default = "default_kind")] pub kind: String,
    #[serde(default)] pub timestamp: Option<String>,
    #[serde(default)] pub tool_name: Option<String>,
    #[serde(default)] pub attachments: Vec<String>,
}
fn default_kind() -> String { "message".into() }
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportPackage { pub schema_version: u32, pub sessions: Vec<ImportSession> }

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreview {
    pub token: String,
    pub sessions: Vec<ImportSessionPreview>,
    pub failed: usize,
    pub warnings: Vec<String>,
    /// 识别出来的输入格式。我们会猜，但必须说清猜的是什么——
    /// 猜错格式的代价是导入一堆半截消息，用户有权在确认前知道依据是什么。
    pub detected_format: String,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSessionPreview {
    pub source: SourceKind, pub external_id: String, pub title: Option<String>,
    pub message_count: usize, pub messages: Vec<ImportMessage>, pub partial: bool,
}
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport { pub success: usize, pub duplicates: usize, pub failed: usize, pub partial: usize, pub warnings: Vec<String> }

fn valid_time(s: &Option<String>) -> bool { s.as_ref().map(|s| chrono::DateTime::parse_from_rfc3339(s).is_ok()).unwrap_or(true) }
pub fn validate(s: &mut ImportSession) -> Result<()> {
    if s.messages.is_empty() || s.messages.len() > 50000 { return Err(Error::parse("消息数量须为 1–50000")); }
    if !valid_time(&s.created_at) || !valid_time(&s.updated_at) { return Err(Error::parse("会话时间须为 RFC3339 格式")); }
    for m in &s.messages {
        if !matches!(m.role.as_str(), "user" | "assistant" | "system" | "developer" | "tool" | "unknown") { return Err(Error::parse("无法识别角色，请使用模板中的角色名称")); }
        if !matches!(m.kind.as_str(), "message" | "tool_call" | "tool_result" | "reasoning_summary" | "event") { return Err(Error::parse("无法识别消息类型")); }
        if m.text.trim().is_empty() && m.attachments.is_empty() { return Err(Error::parse("消息内容不能为空")); }
        if !valid_time(&m.timestamp) { return Err(Error::parse("消息时间须为 RFC3339 格式")); }
    }
    if let Some(id) = &s.external_id {
        if id.is_empty() || id.len() > 160 || !id.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b,b'-' | b'_')) {
            return Err(Error::parse("外部会话 ID 仅支持 1–160 位字母、数字、短横线与下划线"));
        }
    } else {
        // Hash canonical content, excluding an absent external ID.
        s.external_id = Some(format!("import-{}",blake3::hash(&serde_json::to_vec(s)?).to_hex()));
    }
    Ok(())
}
pub fn partial(s: &ImportSession) -> bool {
    s.messages.iter().any(|m| m.role == "unknown" || m.text.len() > crate::adapters::MAX_TEXT_BYTES)
}

/// 识别出来的输入格式。
///
/// 存在的意义是**把猜测说清楚**：导入是「用户把别处的数据交给我们」，
/// 如果识别错了格式却默不作声，用户会在确认之后才发现内容残缺。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImportFormat {
    /// 本产品的标准会话包（`schemaVersion: 1`）
    Package,
    /// 一行一条消息的 JSONL 转录
    Jsonl,
    /// 顶层就是消息数组 `[{role, content}, …]`
    MessageArray,
    /// `{"messages": [...]}` 对象（OpenAI / Anthropic 消息形）
    MessagesObject,
    /// Claude Code 转录（`{type, message:{content:[{type,text}]}}`）
    ClaudeTranscript,
    /// Markdown 模板（兜底）
    Markdown,
}

impl ImportFormat {
    pub fn label(self) -> &'static str {
        match self {
            ImportFormat::Package => "标准会话包（schemaVersion 1）",
            ImportFormat::Jsonl => "JSONL 转录（一行一条消息）",
            ImportFormat::MessageArray => "顶层消息数组",
            ImportFormat::MessagesObject => "messages 数组对象",
            ImportFormat::ClaudeTranscript => "Claude Code 转录",
            ImportFormat::Markdown => "Markdown 模板",
        }
    }
}

/// 判定 JSONL 是否「像转录」的最低命中率：行数里至少这么多比例能取出角色与正文。
/// 定得低一点是为了容纳夹杂的元数据行；但只要低于这个比例就整体拒绝，
/// 免得把一份不相关的 JSONL（例如某种日志）硬塞成会话。
const JSONL_MIN_HIT_RATIO: f64 = 0.6;

pub fn parse_input(source: &str, text: &str) -> Result<(ImportPackage, Vec<String>, ImportFormat)> {
    if text.len() > MAX_IMPORT_BYTES { return Err(Error::parse("导入内容超过 16 MiB，请拆分后重试")); }
    let source = SourceKind::parse(source).ok_or_else(|| Error::parse("数据源标识无效"))?;
    let text = text.trim_start_matches('\u{feff}').trim();
    let mut warnings = Vec::new();

    let (sessions, format) = detect(source.clone(), text, &mut warnings)?;

    let mut valid = Vec::new();
    for (i,mut s) in sessions.into_iter().enumerate() {
        match validate(&mut s) { Ok(()) => valid.push(s), Err(e) => warnings.push(format!("第 {} 个会话：{}",i+1,e.user_message())) }
    }
    if valid.is_empty() { return Err(Error::parse(format!("没有可导入的会话。{}",warnings.join("；")))); }
    Ok((ImportPackage { schema_version: 1, sessions: valid }, warnings, format))
}

/// 按「严格 → 宽松」的顺序逐个探测器尝试，返回第一份能解析出会话的结果。
///
/// 顺序不能随意调：`{messages:[…]}` 对象和标准包都是 `{` 开头，
/// 而 Claude 转录本身就是 JSONL——先试形状明确的，最后才落到 JSONL 与 Markdown，
/// 才不会把结构化输入误判成「一行一条」。
fn detect(source: SourceKind, text: &str, warnings: &mut Vec<String>) -> Result<(Vec<ImportSession>, ImportFormat)> {
    let json = if text.starts_with('{') || text.starts_with('[') {
        serde_json::from_str::<Value>(text).ok()
    } else {
        None
    };

    if let Some(v) = json.as_ref() {
        // 1. 标准会话包
        if v.get("schemaVersion").is_some() {
            return Ok((parse_package(source, v, warnings)?, ImportFormat::Package));
        }
        // 2. messages 数组对象
        if v.get("messages").is_some() {
            let s = session_from_object(source.clone(), v, text)?;
            return Ok((vec![s], ImportFormat::MessagesObject));
        }
        // 3. 顶层数组：既可能是消息数组，也可能是「会话数组」
        if let Some(rows) = v.as_array() {
            if rows.iter().all(|r| r.get("messages").is_some()) {
                let mut out = Vec::new();
                for row in rows { out.push(session_from_object(source.clone(), row, text)?); }
                return Ok((out, ImportFormat::MessageArray));
            }
            return Ok((vec![session_from_messages(source, rows, None, text)?], ImportFormat::MessageArray));
        }
    }

    // 4. JSONL：逐行解析，命中率够高才算转录
    if let Some((session, is_claude)) = try_jsonl(source.clone(), text) {
        let format = if is_claude { ImportFormat::ClaudeTranscript } else { ImportFormat::Jsonl };
        return Ok((vec![session], format));
    }

    // 5. Markdown 兜底
    Ok((vec![parse_markdown(source, text)?], ImportFormat::Markdown))
}

/// 标准会话包（`{schemaVersion:1, sessions:[…]}`）。
fn parse_package(source: SourceKind, v: &Value, warnings: &mut Vec<String>) -> Result<Vec<ImportSession>> {
    if v["schemaVersion"].as_u64() != Some(1) { return Err(Error::parse("仅支持 schemaVersion: 1 的标准会话包")); }
    let rows = v["sessions"].as_array().ok_or_else(|| Error::parse("缺少 sessions 数组"))?;
    if rows.len() > 100 { return Err(Error::parse("每次最多导入 100 个会话")); }
    Ok(rows.iter().enumerate().filter_map(|(i,v)| match serde_json::from_value::<ImportSession>(v.clone()) {
        Ok(s) if s.source == source => Some(s),
        Ok(_) => { warnings.push(format!("第 {} 个会话来源与所选来源不一致",i+1)); None },
        Err(_) => { warnings.push(format!("第 {} 个会话结构不符合标准模板",i+1)); None }
    }).collect())
}

/// 从任意 JSON 值里取正文文本。
///
/// 三种形态都要认：字符串、`[{type:"text",text:"…"}]` 块数组（Anthropic / Claude 形）、
/// 以及 `{text:…}` / `{content:…}` 包一层对象的写法。
fn text_of(v: &Value) -> Option<String> {
    match v {
        Value::String(s) => Some(s.clone()),
        Value::Array(items) => {
            let parts: Vec<String> = items
                .iter()
                .filter_map(|item| match item {
                    Value::String(s) => Some(s.clone()),
                    Value::Object(_) => item.get("text").and_then(Value::as_str).map(str::to_string),
                    _ => None,
                })
                .collect();
            (!parts.is_empty()).then(|| parts.join("\n"))
        }
        Value::Object(o) => o
            .get("text")
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| o.get("content").and_then(text_of)),
        _ => None,
    }
}

/// 从一条记录里取出 (角色, 正文, 时间, 工具名)。取不到角色或正文就返回 None。
fn message_from(v: &Value) -> Option<ImportMessage> {
    if !v.is_object() { return None; }
    // 角色的常见字段名；Claude 转录用顶层 type
    let raw_role = ["role", "author", "sender", "type"]
        .iter()
        .find_map(|k| v.get(*k).and_then(Value::as_str))
        .or_else(|| v.get("author").and_then(|a| a.get("role")).and_then(Value::as_str))?;
    // Claude 转录把内容包在 message 里
    let body = v.get("message").filter(|m| m.is_object()).unwrap_or(v);
    let text = ["content", "text", "message", "body"]
        .iter()
        .find_map(|k| body.get(*k).and_then(text_of))
        .filter(|s| !s.trim().is_empty())?;

    let role = Role::parse(raw_role);
    let timestamp = ["timestamp", "createdAt", "created_at", "time", "date"]
        .iter()
        .find_map(|k| v.get(*k).and_then(Value::as_str))
        .filter(|s| chrono::DateTime::parse_from_rfc3339(s).is_ok())
        .map(str::to_string);
    let tool_name = ["toolName", "tool_name", "name"]
        .iter()
        .find_map(|k| v.get(*k).and_then(Value::as_str))
        .filter(|_| role == Role::Tool)
        .map(str::to_string);
    // 角色认不出来时保留为 unknown + event：validate 会放行，partial 会置位，
    // 界面显示「未识别事件」而不是静默丢掉这条内容。
    let kind = match role {
        Role::Tool => "tool_result",
        Role::Unknown => "event",
        _ => "message",
    };
    Some(ImportMessage { role: role.as_str().to_string(), text, kind: kind.to_string(), timestamp, tool_name, attachments: vec![] })
}

/// 一组消息记录 → 一个会话。
fn session_from_messages(source: SourceKind, rows: &[Value], meta: Option<&Value>, raw: &str) -> Result<ImportSession> {
    let messages: Vec<ImportMessage> = rows.iter().filter_map(message_from).collect();
    if messages.is_empty() {
        return Err(Error::parse("没有识别出任何消息：每行/每项需要包含角色与正文（例如 role + content）"));
    }
    let pick = |keys: &[&str]| meta.and_then(|m| keys.iter().find_map(|k| m.get(*k).and_then(Value::as_str)).map(str::to_string));
    let mut session = ImportSession {
        source,
        external_id: pick(&["id", "sessionId", "externalId"]),
        title: pick(&["title", "summary", "name"]),
        created_at: pick(&["createdAt", "created_at", "startTime"]),
        updated_at: pick(&["updatedAt", "updated_at", "lastUpdated"]),
        messages,
    };
    // 没有显式 id 时用内容哈希派生，保证同一份内容重复导入会被识别成重复而非新增
    if session.external_id.is_none() {
        session.external_id = Some(format!("import-{}", blake3::hash(raw.as_bytes()).to_hex()));
    }
    Ok(session)
}

/// 一个 JSON 对象（可含 messages 数组与会话级元信息）→ 一个会话。
fn session_from_object(source: SourceKind, v: &Value, raw: &str) -> Result<ImportSession> {
    let rows = v["messages"].as_array().ok_or_else(|| Error::parse("缺少 messages 数组"))?;
    session_from_messages(source, rows, Some(v), raw)
}

/// 逐行 JSON → 一个会话；第二项标记它是不是 Claude Code 的转录形状。
///
/// 命中率不足则返回 None，交给后面的探测器——一份不相干的 JSONL（某种日志）
/// 不该被硬塞成会话。
fn try_jsonl(source: SourceKind, text: &str) -> Option<(ImportSession, bool)> {
    let mut rows = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() { continue; }
        let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
        rows.push(v);
    }
    if rows.is_empty() { return None; }
    let hits = rows.iter().filter(|v| message_from(v).is_some()).count();
    if (hits as f64) < rows.len() as f64 * JSONL_MIN_HIT_RATIO { return None; }
    // Claude 转录的结构签名：顶层 type + message.content（不是扁平的 role/content）。
    // 用结构而不是「有没有 uuid」之类的弱特征，免得把别的转录也误报成 Claude。
    let is_claude = rows.iter().any(|v| {
        v.get("type").is_some() && v.get("message").map(|m| m.get("content").is_some()).unwrap_or(false)
    });
    session_from_messages(source, &rows, None, text).ok().map(|s| (s, is_claude))
}


fn parse_markdown(source: SourceKind, text: &str) -> Result<ImportSession> {
    let mut s = ImportSession { source, external_id: None, title: None, created_at: None, updated_at: None, messages: vec![] };
    let mut fence: Option<(char, usize)> = None;
    for line in text.lines() {
        let trimmed = line.trim_start();
        let marker = trimmed.chars().next().filter(|c| *c == '`' || *c == '~');
        if let Some(marker) = marker {
            let n = trimmed.chars().take_while(|c| *c == marker).count();
            if n >= 3 {
                if let Some((c,len)) = fence { if c == marker && n >= len && trimmed[n..].trim().is_empty() { fence = None; } }
                else { fence = Some((marker,n)); }
            }
        }
        if fence.is_none() {
            if let Some(role) = line.strip_prefix("## ") {
                if matches!(role, "user" | "assistant" | "system" | "developer" | "tool") {
                    s.messages.push(ImportMessage { role: role.into(), text: String::new(), kind: default_kind(), timestamp: None, tool_name: None, attachments: vec![] }); continue;
                }
            }
            if s.messages.is_empty() && s.title.is_none() {
                if let Some(title) = line.strip_prefix("# ") { s.title = Some(title.into()); continue; }
            }
        }
        if let Some(message) = s.messages.last_mut() { message.text.push_str(line); message.text.push('\n'); }
        else if !line.trim().is_empty() { return Err(Error::parse("无法识别角色：请使用 ## user 和 ## assistant 分隔消息")); }
    }
    for m in &mut s.messages { m.text = m.text.trim().into(); }
    Ok(s)
}

pub fn preview(package: &ImportPackage, warnings: Vec<String>, token: String, format: ImportFormat) -> ImportPreview {
    ImportPreview { token, failed: warnings.len(), warnings, detected_format: format.label().to_string(), sessions: package.sessions.iter().map(|s| ImportSessionPreview {
        source: s.source.clone(), external_id: s.external_id.clone().unwrap_or_default(), title: s.title.clone(), message_count: s.messages.len(), partial: partial(s),
        messages: s.messages.iter().take(10).map(|m| { let mut m = m.clone(); m.text = m.text.chars().take(1500).collect(); m }).collect(),
    }).collect() }
}

pub struct ImportedAdapter { pub root: PathBuf }
impl ConversationAdapter for ImportedAdapter {
    fn id(&self) -> &str { "imports" }
    fn detect(&self, ctx: &AdapterContext<'_>) -> Vec<DetectionResult> {
        let mut counts = std::collections::BTreeMap::new();
        for d in self.scan(ctx).unwrap_or_default() { *counts.entry(d.source).or_insert(0) += 1; }
        counts.into_iter().map(|(source,n)| DetectionResult { source, found: true, root: Some(self.root.clone()), session_hint: n, notes: vec![SourceNote::info(LocalizedText::new("source.note.importedCopy", "应用管理的导入副本"))], manual: true }).collect()
    }
    fn scan(&self, ctx: &AdapterContext<'_>) -> Result<Vec<SessionDescriptor>> {
        let mut out = Vec::new();
        for path in files(&self.root,"json") {
            let s: ImportSession = serde_json::from_value(read_json(&path)?)?;
            if !ctx.settings.source_enabled(s.source.as_str()) { continue; }
            let mut d = descriptor(s.source,path,&self.root,ctx.machine_id);
            d.external_id = s.external_id.ok_or_else(|| Error::parse("导入副本缺少 ID"))?;
            d.title_hint = s.title; out.push(d);
        }
        Ok(out)
    }
    fn parse_streaming(&self, _: &AdapterContext<'_>, d: &SessionDescriptor, sink: &mut dyn MessageSink) -> Result<ParsedSessionInfo> {
        let mut s: ImportSession = serde_json::from_value(read_json(&d.primary_file)?)?;
        validate(&mut s)?;
        let mut info = ParsedSessionInfo::new();
        info.title = s.title.clone(); info.created_at = s.created_at.clone(); info.updated_at = s.updated_at.clone(); info.partial = partial(&s);
        for m in s.messages {
            crate::adapters::native::emit(d,&mut info,sink,Role::parse(&m.role),MessageKind::parse(&m.kind),Some(m.text),m.tool_name,m.timestamp,
                (!m.attachments.is_empty()).then(|| json!({"attachments":m.attachments})))?;
        }
        info.metadata = json!({"imported":true,"importSchemaVersion":1}); Ok(info)
    }
}

pub fn managed_path(root: &Path, session: &ImportSession) -> PathBuf {
    root.join(session.source.as_str()).join(format!("{}.json",blake3::hash(session.external_id.as_deref().unwrap_or_default().as_bytes()).to_hex()))
}
