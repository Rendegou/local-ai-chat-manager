//! Explicit, previewed imports. Managed originals make the index rebuildable.
use std::path::{Path, PathBuf};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use crate::{Error, Result};
use crate::model::*;
use crate::adapters::{AdapterContext, ConversationAdapter, MessageSink};
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

pub fn parse_input(source: &str, text: &str) -> Result<(ImportPackage, Vec<String>)> {
    if text.len() > MAX_IMPORT_BYTES { return Err(Error::parse("导入内容超过 16 MiB，请拆分后重试")); }
    let source = SourceKind::parse(source).ok_or_else(|| Error::parse("数据源标识无效"))?;
    let text = text.trim_start_matches('\u{feff}').trim();
    let mut warnings = Vec::new();
    let sessions = if text.starts_with('{') {
        let v: Value = serde_json::from_str(text)?;
        if v["schemaVersion"].as_u64() != Some(1) { return Err(Error::parse("仅支持 schemaVersion: 1 的标准会话包")); }
        let rows = v["sessions"].as_array().ok_or_else(|| Error::parse("缺少 sessions 数组"))?;
        if rows.len() > 100 { return Err(Error::parse("每次最多导入 100 个会话")); }
        rows.iter().enumerate().filter_map(|(i,v)| match serde_json::from_value::<ImportSession>(v.clone()) {
            Ok(s) if s.source == source => Some(s),
            Ok(_) => { warnings.push(format!("第 {} 个会话来源与所选来源不一致",i+1)); None },
            Err(_) => { warnings.push(format!("第 {} 个会话结构不符合标准模板",i+1)); None }
        }).collect()
    } else { vec![parse_markdown(source,text)?] };
    let mut valid = Vec::new();
    for (i,mut s) in sessions.into_iter().enumerate() {
        match validate(&mut s) { Ok(()) => valid.push(s), Err(e) => warnings.push(format!("第 {} 个会话：{}",i+1,e.user_message())) }
    }
    if valid.is_empty() { return Err(Error::parse(format!("没有可导入的会话。{}",warnings.join("；")))); }
    Ok((ImportPackage { schema_version: 1, sessions: valid },warnings))
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

pub fn preview(package: &ImportPackage, warnings: Vec<String>, token: String) -> ImportPreview {
    ImportPreview { token, failed: warnings.len(), warnings, sessions: package.sessions.iter().map(|s| ImportSessionPreview {
        source: s.source.clone(), external_id: s.external_id.clone().unwrap_or_default(), title: s.title.clone(), message_count: s.messages.len(), partial: partial(s),
        messages: s.messages.iter().take(10).map(|m| { let mut m = m.clone(); m.text = m.text.chars().take(1500).collect(); m }).collect(),
    }).collect() }
}

pub struct ImportedAdapter { pub root: PathBuf }
impl ConversationAdapter for ImportedAdapter {
    fn id(&self) -> &'static str { "imports" }
    fn detect(&self, ctx: &AdapterContext<'_>) -> Vec<DetectionResult> {
        let mut counts = std::collections::BTreeMap::new();
        for d in self.scan(ctx).unwrap_or_default() { *counts.entry(d.source).or_insert(0) += 1; }
        counts.into_iter().map(|(source,n)| DetectionResult { source, found: true, root: Some(self.root.clone()), session_hint: n, notes: vec!["应用管理的导入副本".into()], manual: true }).collect()
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
