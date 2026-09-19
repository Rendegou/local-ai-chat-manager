//! WorkBuddy desktop history, verified against Windows WorkBuddyExtension storage.
use std::path::{Path, PathBuf};
use serde_json::{json, Value};
use super::{AdapterContext, ConversationAdapter, MessageSink, cap_raw};
use super::native::{descriptor, emit, files, read_json, string};
use crate::{Error, Result, paths};
use crate::model::*;

pub struct WorkbuddyAdapter;
impl WorkbuddyAdapter {
    pub fn root(ctx: &AdapterContext<'_>) -> PathBuf {
        ctx.settings.source_root("workbuddy").unwrap_or_else(|| paths::expand_home("~/AppData/Local/WorkBuddyExtension/Data"))
    }
    fn message_path(dir: &Path, id: &str) -> Result<PathBuf> {
        if id.is_empty() || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') {
            return Err(Error::parse("WorkBuddy 消息 ID 不合法"));
        }
        let path = dir.join("messages").join(format!("{id}.json"));
        if path.exists() {
            let real = path.canonicalize().map_err(|e| Error::io(&path,e))?;
            let base = dir.canonicalize().map_err(|e| Error::io(dir,e))?;
            if !real.starts_with(base) { return Err(Error::parse("消息文件超出会话目录")); }
        }
        Ok(path)
    }
    fn index_count(ctx: &AdapterContext<'_>) -> Result<usize> {
        let root = Self::root(ctx);
        let db = if ctx.settings.source_root("workbuddy").is_some() { root.join("codebuddy-sessions.vscdb") }
            else { paths::expand_home("~/AppData/Roaming/WorkBuddy/codebuddy-sessions.vscdb") };
        if !db.is_file() { return Ok(0); }
        let c = rusqlite::Connection::open_with_flags(db, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        let mut s = c.prepare("SELECT value FROM ItemTable")?;
        let mut count = 0;
        let mut rows = s.query([])?;
        while let Some(row) = rows.next()? {
            let bytes = row.get_ref(0)?.as_bytes().unwrap_or_default();
            if serde_json::from_slice::<Value>(bytes).ok().and_then(|v| v.get("conversationId").cloned()).is_some() { count += 1; }
        }
        Ok(count)
    }
}

impl ConversationAdapter for WorkbuddyAdapter {
    fn id(&self) -> &'static str { "workbuddy" }
    fn detect(&self, ctx: &AdapterContext<'_>) -> Vec<DetectionResult> {
        let root = Self::root(ctx);
        let mut notes = vec!["已验证 Windows WorkBuddyExtension 历史格式；其他版本需验证".into()];
        let index_count = Self::index_count(ctx).unwrap_or_else(|_| { notes.push("会话摘要库读取失败（占用或损坏）".into()); 0 });
        let count = match self.scan(ctx) { Ok(v) => v.len(), Err(_) => { notes.push("正文目录读取失败".into()); 0 } };
        if count == 0 && index_count > 0 { notes.push("仅发现索引，正文未适配".into()); }
        vec![DetectionResult { source: SourceKind::Workbuddy, found: count > 0, root: root.is_dir().then_some(root), session_hint: count, notes, manual: ctx.settings.source_root("workbuddy").is_some() }]
    }
    fn scan(&self, ctx: &AdapterContext<'_>) -> Result<Vec<SessionDescriptor>> {
        let root = Self::root(ctx);
        let mut out = Vec::new();
        for p in files(&root,"json") {
            if p.file_name().and_then(|n| n.to_str()) != Some("index.json") || !p.components().any(|c| c.as_os_str() == "history") { continue; }
            let Ok(v) = read_json(&p) else { continue; };
            let Some(messages) = v["messages"].as_array().filter(|m| !m.is_empty()) else { continue; };
            if !v["requests"].is_array() { continue; }
            let mut d = descriptor(SourceKind::Workbuddy,p.clone(),&root,ctx.machine_id);
            d.external_id = d.session_dir.file_name().unwrap_or_default().to_string_lossy().into_owned();
            let mut hasher = blake3::Hasher::new();
            hasher.update(v.to_string().as_bytes());
            let mut readable = false;
            for m in messages {
                if let Some(id) = m["id"].as_str() {
                    if let Ok(path) = Self::message_path(&d.session_dir,id) {
                        if let Ok(meta) = path.metadata() {
                            readable = true;
                            hasher.update(id.as_bytes()); hasher.update(&meta.len().to_le_bytes());
                            hasher.update(format!("{:?}",meta.modified().ok()).as_bytes());
                            d.files.push(RawFileRef { role: "message".into(), path, size: meta.len() });
                        }
                    }
                }
            }
            if !readable { continue; }
            if let Some(parent) = d.session_dir.parent() {
                if let Ok(global) = read_json(&parent.join("index.json")) {
                    if let Some(c) = global["conversations"].as_array().and_then(|cs| cs.iter().find(|c| c["id"].as_str() == Some(&d.external_id))) {
                        d.title_hint = string(c,"name"); hasher.update(c.to_string().as_bytes());
                    }
                }
            }
            d.content_revision = Some(hasher.finalize().to_hex().to_string());
            out.push(d);
        }
        Ok(out)
    }
    fn parse_streaming(&self, _: &AdapterContext<'_>, d: &SessionDescriptor, sink: &mut dyn MessageSink) -> Result<ParsedSessionInfo> {
        let index = read_json(&d.primary_file)?;
        let mut info = ParsedSessionInfo::new(); info.title = d.title_hint.clone();
        let messages = index["messages"].as_array().ok_or_else(|| Error::parse("缺少 WorkBuddy 消息索引"))?;
        let mut seen = std::collections::HashSet::new();
        for header in messages {
            let Some(id) = header["id"].as_str() else { info.warn("消息缺少 ID"); continue; };
            if !seen.insert(id) { continue; }
            let path = Self::message_path(&d.session_dir,id)?;
            let row = match read_json(&path) { Ok(v) => v, Err(_) => { info.warn("消息文件缺失或无法解析"); continue; } };
            let m: Value = match row["message"].as_str().and_then(|s| serde_json::from_str(s).ok()) { Some(v) => v, None => { info.warn("消息正文格式无法识别"); continue; } };
            let extra: Value = row["extra"].as_str().and_then(|s| serde_json::from_str(s).ok()).unwrap_or(Value::Null);
            info.model = string(&extra,"modelName").or(info.model.take());
            let time = index["requests"].as_array().and_then(|rs| rs.iter().find(|r| r["messages"].as_array().map(|ms| ms.iter().any(|m| m.as_str() == Some(id))).unwrap_or(false)))
                .and_then(|r| r["startedAt"].as_i64()).and_then(chrono::DateTime::from_timestamp_millis).map(|t| t.to_rfc3339());
            if info.created_at.is_none() { info.created_at = time.clone(); } info.updated_at = time.clone().or(info.updated_at.take());
            let role = Role::parse(m["role"].as_str().unwrap_or("unknown"));
            if role == Role::Unknown { info.warn("消息角色无法识别"); }
            let blocks = m["content"].as_array().cloned().unwrap_or_else(|| vec![json!({"type":"text","text":m["content"]})]);
            for b in blocks {
                let typ = b["type"].as_str().unwrap_or("unknown");
                let (kind,text,tool) = match typ {
                    "text" => (MessageKind::Message,string(&b,"text"),None),
                    "reasoning" => (MessageKind::ReasoningSummary,string(&b,"text"),None),
                    "tool-call" => (MessageKind::ToolCall,Some(b["args"].to_string()),string(&b,"toolName")),
                    "tool-result" => (MessageKind::ToolResult,Some(b["result"].to_string()),string(&b,"toolName")),
                    _ => { info.note_unknown(typ); (MessageKind::Event,Some(format!("[未识别内容] {typ}")),None) }
                };
                if info.title.is_none() && role == Role::User { info.title = text.as_ref().map(|s| s.chars().take(80).collect()); }
                emit(d,&mut info,sink,role,kind,text,tool,time.clone(),if kind == MessageKind::Message { None } else { cap_raw(&b) })?;
            }
        }
        if info.message_count == 0 { return Err(Error::parse("WorkBuddy 索引存在，但没有可读取的正文")); }
        info.metadata = json!({"format":"workbuddy-extension-history-v1"});
        Ok(info)
    }
}
