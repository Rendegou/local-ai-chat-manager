//! Claude Code and Gemini CLI: separate schemas, shared bounded file discovery.
use std::path::{Path, PathBuf};
use serde_json::{json, Value};
use super::{AdapterContext, ConversationAdapter, MessageSink, cap_raw, cap_text};
use crate::localized::{LocalizedText, SourceNote};
use crate::{Result, Error, paths};
use crate::model::*;
use crate::parser::jsonl::{stream_jsonl, ParseLimits, Flow};

pub struct NativeAdapter { pub source: SourceKind }
impl NativeAdapter {
    pub fn root(&self, ctx: &AdapterContext<'_>) -> PathBuf {
        ctx.settings.source_root(self.id()).unwrap_or_else(|| paths::expand_home(
            if self.source == SourceKind::Claude { "~/.claude/projects" } else { "~/.gemini/tmp" }))
    }
}

pub fn files(root: &Path, extension: &str) -> Vec<PathBuf> {
    walkdir::WalkDir::new(root).follow_links(false).max_depth(12).into_iter()
        .filter_entry(|e| !paths::is_forbidden_path(e.path()) && !e.file_type().is_symlink())
        .filter_map(|e| e.ok()).filter(|e| e.file_type().is_file() && e.path().extension().and_then(|s| s.to_str()) == Some(extension))
        .map(|e| e.into_path()).collect()
}

pub fn descriptor(source: SourceKind, path: PathBuf, root: &Path, machine: &str) -> SessionDescriptor {
    // Relative path distinguishes subagents and project-local IDs without flattening conversations.
    let relative = path.strip_prefix(root).unwrap_or(&path).to_string_lossy().replace('\\', "/");
    let id = path.file_stem().unwrap_or_default().to_string_lossy().to_string();
    let external_id = if relative.contains("subagents/") { format!("{}-{}", id, &blake3::hash(relative.as_bytes()).to_hex()[..12]) } else { id };
    SessionDescriptor { source, external_id, primary_file: path.clone(), session_dir: path.parent().unwrap_or(root).into(), title_hint: None, project_path: None, machine_id: Some(machine.into()), files: vec![RawFileRef { role: "conversation".into(), size: path.metadata().map(|m| m.len()).unwrap_or(0), path }], content_revision: None }
}

impl ConversationAdapter for NativeAdapter {
    fn id(&self) -> &str { if self.source == SourceKind::Claude { "claude" } else { "gemini" } }
    fn detect(&self, ctx: &AdapterContext<'_>) -> Vec<DetectionResult> {
        let root = self.root(ctx);
        let count = self.scan(ctx).map(|v| v.len());
        let (found, hint, notes) = match count {
            Ok(n) => (n > 0, n, vec![]),
            Err(_) => (
                false,
                0,
                vec![SourceNote::error(LocalizedText::new("source.note.readFailed", "读取失败：请检查目录与权限"))],
            ),
        };
        vec![DetectionResult { source: self.source.clone(), found, root: root.is_dir().then_some(root), session_hint: hint, notes, manual: ctx.settings.source_root(self.id()).is_some() }]
    }
    fn scan(&self, ctx: &AdapterContext<'_>) -> Result<Vec<SessionDescriptor>> {
        let root = self.root(ctx);
        let extension = if self.source == SourceKind::Claude { "jsonl" } else { "json" };
        Ok(files(&root, extension).into_iter().filter(|p| {
            if self.source == SourceKind::Gemini { p.parent().and_then(|p| p.file_name()).and_then(|s| s.to_str()) == Some("chats") && p.file_name().unwrap_or_default().to_string_lossy().starts_with("session-") }
            else { p.file_stem().and_then(|s| s.to_str()).map(|s| uuid::Uuid::parse_str(s).is_ok() || s.starts_with("agent-")).unwrap_or(false) }
        }).map(|p| descriptor(self.source.clone(), p, &root, ctx.machine_id)).collect())
    }
    fn parse_streaming(&self, _: &AdapterContext<'_>, d: &SessionDescriptor, sink: &mut dyn MessageSink) -> Result<ParsedSessionInfo> {
        if self.source == SourceKind::Claude { parse_claude(d, sink) } else { parse_gemini(d, sink) }
    }
}

pub fn emit(d: &SessionDescriptor, info: &mut ParsedSessionInfo, sink: &mut dyn MessageSink, role: Role, kind: MessageKind, text: Option<String>, tool: Option<String>, time: Option<String>, raw: Option<Value>) -> Result<()> {
    let msg = NormalizedMessage { id: format!("{}:{}", d.session_id(), info.message_count), role, kind, text: text.map(cap_text), tool_name: tool, timestamp: time, raw };
    sink.emit(msg)?; info.message_count += 1; Ok(())
}

pub fn string(v: &Value, k: &str) -> Option<String> { v.get(k).and_then(Value::as_str).map(str::to_string) }
fn content_text(v: &Value) -> String { v.as_str().map(str::to_string).unwrap_or_else(|| v.to_string()) }

pub fn parse_claude(d: &SessionDescriptor, sink: &mut dyn MessageSink) -> Result<ParsedSessionInfo> {
    let mut info = ParsedSessionInfo::new();
    // A transcript can contain rewound/forked turns. Follow the last recorded
    // message's parent chain instead of concatenating incompatible branches.
    let mut graph = std::collections::HashMap::<String, Option<String>>::new();
    let mut leaf = None;
    stream_jsonl(&d.primary_file, &ParseLimits::default(), |v| {
        if matches!(v["type"].as_str(), Some("user" | "assistant")) {
            if let Some(id) = string(v,"uuid") { graph.insert(id.clone(),string(v,"parentUuid")); leaf = Some(id); }
        }
        Ok(Flow::Continue)
    })?;
    let mut active = std::collections::HashSet::new();
    while let Some(id) = leaf { if !active.insert(id.clone()) { break; } leaf = graph.get(&id).cloned().flatten(); }
    let branches_omitted = graph.keys().filter(|k| !active.contains(*k)).count();
    if branches_omitted > 0 { info.warn("检测到分支：仅展示最后记录分支的祖先链，其他分支仍保留在原始文件"); }
    let mut seen = std::collections::HashSet::new();
    let mut parents = std::collections::BTreeSet::new();
    let (report, warnings) = stream_jsonl(&d.primary_file, &ParseLimits::default(), |v| {
        let typ = v["type"].as_str().unwrap_or("unknown");
        if matches!(typ,"user" | "assistant") && string(v,"uuid").map(|id| !active.contains(&id)).unwrap_or(false) { return Ok(Flow::Continue); }
        if let Some(id) = string(v, "uuid") { if !seen.insert(id) { return Ok(Flow::Continue); } }
        if let Some(parent) = string(v, "parentUuid") { parents.insert(parent); }
        info.project_path = string(v, "cwd").or(info.project_path.take());
        let time = string(v, "timestamp");
        if info.created_at.is_none() { info.created_at = time.clone(); } info.updated_at = time.clone().or(info.updated_at.take());
        if typ == "summary" { info.title = string(v, "summary"); return Ok(Flow::Continue); }
        if matches!(typ, "queue-operation" | "file-history-snapshot" | "progress" | "system") { return Ok(Flow::Continue); }
        let m = &v["message"];
        if matches!(typ, "user" | "assistant") && m.is_object() {
            let role = Role::parse(typ);
            info.model = string(m, "model").or(info.model.take());
            let blocks = m["content"].as_array().cloned().unwrap_or_else(|| vec![json!({"type":"text", "text":m["content"]})]);
            for b in blocks {
                let bt = b["type"].as_str().unwrap_or("unknown");
                let (r,k,t,tool) = match bt {
                    "text" => (role, MessageKind::Message, string(&b,"text"), None),
                    "thinking" => (role, MessageKind::ReasoningSummary, string(&b,"thinking"), None),
                    "tool_use" => (Role::Assistant, MessageKind::ToolCall, Some(content_text(&b["input"])), string(&b,"name")),
                    "tool_result" => (Role::Tool, MessageKind::ToolResult, Some(content_text(&b["content"])), string(&b,"tool_use_id")),
                    _ => { info.note_unknown(bt); (role, MessageKind::Event, Some(format!("[未识别内容] {bt}")), None) }
                };
                if info.title.is_none() && r == Role::User && k == MessageKind::Message { info.title = t.as_ref().map(|s| s.chars().take(80).collect()); }
                emit(d,&mut info,sink,r,k,t,tool,time.clone(),if k == MessageKind::Message { None } else { cap_raw(&b) })?;
            }
        } else {
            info.note_unknown(typ);
            emit(d,&mut info,sink,Role::Unknown,MessageKind::Event,Some(format!("[未识别事件] {typ}")),None,time,cap_raw(v))?;
        }
        Ok(Flow::Continue)
    })?;
    for w in warnings { info.warn(w); } if report.bad > 0 { info.partial = true; }
    info.metadata = json!({"parentUuids":parents.into_iter().take(64).collect::<Vec<_>>(), "isSubagent":d.primary_file.components().any(|c| c.as_os_str() == "subagents"), "branchPolicy":"last-recorded-parent-chain", "omittedBranchMessages":branches_omitted});
    if info.message_count == 0 { return Err(Error::parse("未发现可解析的 Claude 会话消息")); }
    Ok(info)
}

pub fn read_json(path: &Path) -> Result<Value> {
    if path.metadata().map_err(|e| Error::io(path,e))?.len() > 32 * 1024 * 1024 { return Err(Error::parse("JSON 文件超过 32 MiB，请拆分后重试")); }
    let file = std::fs::File::open(path).map_err(|e| Error::io(path,e))?;
    Ok(serde_json::from_reader(std::io::BufReader::new(file))?)
}

fn parse_gemini(d: &SessionDescriptor, sink: &mut dyn MessageSink) -> Result<ParsedSessionInfo> {
    let v = read_json(&d.primary_file)?;
    let messages = v["messages"].as_array().ok_or_else(|| Error::parse("不是 Gemini 会话：缺少 messages"))?;
    if !v["sessionId"].is_string() { return Err(Error::parse("不是 Gemini 会话：缺少 sessionId")); }
    let mut info = ParsedSessionInfo::new();
    info.created_at = string(&v,"startTime"); info.updated_at = string(&v,"lastUpdated");
    info.title = string(&v,"summary"); info.metadata = json!({"nativeSessionId":v["sessionId"],"projectHash":v["projectHash"]});
    for m in messages {
        let typ = m["type"].as_str().unwrap_or("unknown");
        let role = match typ { "user" => Role::User, "gemini" => Role::Assistant, _ => Role::Unknown };
        let kind = if role == Role::Unknown { info.note_unknown(typ); MessageKind::Event } else { MessageKind::Message };
        let text = if let Some(parts) = m["content"].as_array() { Some(parts.iter().filter_map(|p| p["text"].as_str()).collect::<Vec<_>>().join("\n")) } else { string(m,"content") };
        if info.title.is_none() && role == Role::User { info.title = text.as_ref().map(|s| s.chars().take(80).collect()); }
        info.model = string(m,"model").or(info.model.take());
        let time = string(m,"timestamp");
        emit(d,&mut info,sink,role,kind,text,None,time.clone(),if role == Role::Unknown { cap_raw(m) } else { None })?;
        if let Some(thoughts) = m["thoughts"].as_array() { for thought in thoughts {
            emit(d,&mut info,sink,Role::Assistant,MessageKind::ReasoningSummary,string(thought,"description"),None,time.clone(),None)?;
        }}
        if let Some(calls) = m["toolCalls"].as_array() { for call in calls {
            emit(d,&mut info,sink,Role::Assistant,MessageKind::ToolCall,Some(content_text(&call["args"])),string(call,"name"),time.clone(),cap_raw(call))?;
            if let Some(result) = call.get("result") { emit(d,&mut info,sink,Role::Tool,MessageKind::ToolResult,Some(content_text(result)),string(call,"name"),time.clone(),None)?; }
        }}
    }
    Ok(info)
}
