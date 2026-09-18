//! ZCode（智谱桌面 IDE）适配器。
//!
//! 真实目录结构（依据本机 `~/.zcode` 实测）：
//!
//! ```text
//! ~/.zcode/v2/sessions/
//! └── <hex目录>/
//!     └── <taskId>.json        # 单文件会话：{meta, messages}
//! ```
//!
//! 会话文件结构：
//! - `meta`：taskId / title / workspacePath / createdAt / updatedAt（毫秒）/ status；
//! - `messages`：`[{role, content}]`，role 常见为 user / assistant。
//!
//! 隐私：`~/.zcode/v2/` 下还有 `credentials.json` 等凭证文件，一律不读取、不复制
//! （由 [`crate::paths::is_forbidden_path`] 兜底拦截）。

use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::adapters::{
    cap_metadata, cap_text, message_id, usable_root, AdapterContext, ConversationAdapter,
    DupFilter, MessageSink,
};
use crate::error::{Error, Result};
use crate::model::{
    DetectionResult, MessageKind, NormalizedMessage, ParsedSessionInfo, RawFileRef, Role,
    SessionDescriptor, SourceKind,
};
use crate::parser::jsonl::{content_to_text, get_str, normalize_timestamp_value};
use crate::paths;

/// ZCode 适配器。
pub struct ZcodeAdapter;

impl ZcodeAdapter {
    /// 新建适配器。
    pub fn new() -> Self {
        ZcodeAdapter
    }

    /// 找到可用的会话根目录。
    ///
    /// 规则与 Codex / Kimi 一致：**用户显式配置时只认该目录**；
    /// 未配置时使用默认目录 `~/.zcode/v2/sessions`，且要求目录里确实存在会话 json。
    fn find_root(ctx: &AdapterContext<'_>) -> Option<PathBuf> {
        if let Some(manual) = ctx.settings.zcode_root() {
            return usable_root(&manual).then_some(manual);
        }
        let default = paths::default_zcode_root();
        if usable_root(&default) && !collect_session_files(&default).is_empty() {
            return Some(default);
        }
        None
    }
}

impl Default for ZcodeAdapter {
    fn default() -> Self {
        Self::new()
    }
}

impl ConversationAdapter for ZcodeAdapter {
    fn id(&self) -> &'static str {
        "zcode"
    }

    fn detect(&self, ctx: &AdapterContext<'_>) -> Vec<DetectionResult> {
        let manual = ctx.settings.zcode_root();
        match Self::find_root(ctx) {
            Some(root) => {
                let is_manual = manual
                    .as_deref()
                    .map(|m| paths::same_path(m, &root))
                    .unwrap_or(false);
                let mut notes = Vec::new();
                if is_manual {
                    notes.push("使用设置中手工指定的目录".to_string());
                } else {
                    notes.push(format!(
                        "自动探测目录 {}",
                        crate::error::display_path(&root)
                    ));
                }
                let files = collect_session_files(&root);
                if files.is_empty() {
                    notes.push("未发现 <目录>/<taskId>.json 会话文件".to_string());
                }
                vec![DetectionResult {
                    source: SourceKind::Zcode,
                    found: true,
                    root: Some(root),
                    session_hint: files.len(),
                    notes,
                    manual: is_manual,
                }]
            }
            None => vec![DetectionResult::missing(
                SourceKind::Zcode,
                "未找到 ZCode 会话目录（~/.zcode/v2/sessions，可在设置中指定）",
            )],
        }
    }

    fn scan(&self, ctx: &AdapterContext<'_>) -> Result<Vec<SessionDescriptor>> {
        let Some(root) = Self::find_root(ctx) else {
            return Ok(Vec::new());
        };
        let mut out = Vec::new();
        for file in collect_session_files(&root) {
            // external_id = 文件名去掉 .json（即 taskId），不读文件内容
            let Some(external_id) = file
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .and_then(|n| n.strip_suffix(".json").map(|s| s.to_string()))
            else {
                continue;
            };
            if external_id.is_empty() {
                continue;
            }
            out.push(SessionDescriptor {
                source: SourceKind::Zcode,
                external_id,
                primary_file: file.clone(),
                session_dir: file
                    .parent()
                    .map(|p| p.to_path_buf())
                    .unwrap_or_else(|| root.clone()),
                title_hint: None, // 标题在 meta 里，交给解析阶段
                project_path: None,
                machine_id: Some(ctx.machine_id.to_string()),
                files: vec![raw_ref("session", &file)],
                content_revision: None,
            });
        }
        Ok(out)
    }

    fn parse_streaming(
        &self,
        _ctx: &AdapterContext<'_>,
        descriptor: &SessionDescriptor,
        sink: &mut dyn MessageSink,
    ) -> Result<ParsedSessionInfo> {
        let session_id = descriptor.session_id();
        let mut info = ParsedSessionInfo::new();

        // 单文件会话，体积不大（实测 KB 级），整体读取即可
        let raw = std::fs::read_to_string(&descriptor.primary_file)
            .map_err(|e| Error::io(&descriptor.primary_file, e))?;
        let value: Value = serde_json::from_str(&raw).map_err(|_| {
            // 错误信息只含分类，不引用正文（隐私约定）
            Error::parse(format!("会话 {} 的 JSON 无法解析", descriptor.external_id))
        })?;

        // ---- meta：标题 / 项目路径 / 时间 ----
        let mut meta = serde_json::Map::new();
        meta.insert("format".into(), Value::String("zcode/session".into()));
        if let Some(m) = value.get("meta") {
            if let Some(title) = get_str(m, "title") {
                let trimmed = title.trim();
                if !trimmed.is_empty() {
                    info.title = Some(trimmed.to_string());
                }
            }
            if let Some(workspace) = get_str(m, "workspacePath") {
                if !workspace.trim().is_empty() {
                    info.project_path = Some(workspace.to_string());
                }
            }
            info.created_at = m.get("createdAt").and_then(normalize_timestamp_value);
            info.updated_at = m.get("updatedAt").and_then(normalize_timestamp_value);
            for key in ["taskId", "status"] {
                if let Some(v) = m.get(key) {
                    meta.insert(key.to_string(), v.clone());
                }
            }
        } else {
            info.warn("缺少 meta 字段，会话元信息不完整");
        }

        // ---- messages：逐条产出 ----
        let mut parser = SessionParser::new(sink, &session_id);
        match value.get("messages").and_then(|m| m.as_array()) {
            Some(messages) => {
                for message in messages {
                    parser.handle_message(message, &mut info)?;
                }
            }
            None => info.warn("缺少 messages 字段或不是数组"),
        }

        info.message_count = parser.message_count;
        // 标题兜底：meta 没有 title 时用首条用户消息
        if info.title.is_none() {
            info.title = parser
                .first_user_text
                .as_deref()
                .and_then(crate::adapters::derive_title);
        }
        info.metadata = cap_metadata(Value::Object(meta));
        Ok(info)
    }
}

/// ZCode 会话消息解析器（结构简单，仍走状态机以复用去重 / 序号分配约定）。
struct SessionParser<'a> {
    sink: &'a mut dyn MessageSink,
    session_id: String,
    sequence: u64,
    message_count: u64,
    dup: DupFilter,
    first_user_text: Option<String>,
}

impl<'a> SessionParser<'a> {
    fn new(sink: &'a mut dyn MessageSink, session_id: &str) -> Self {
        SessionParser {
            sink,
            session_id: session_id.to_string(),
            sequence: 0,
            message_count: 0,
            dup: DupFilter::default(),
            first_user_text: None,
        }
    }

    /// 处理一条 `{role, content}` 消息。
    fn handle_message(&mut self, message: &Value, info: &mut ParsedSessionInfo) -> Result<()> {
        let role_name = get_str(message, "role").unwrap_or("unknown");
        let text = message
            .get("content")
            .map(content_to_text)
            .unwrap_or_default();
        let text = text.trim();

        let (role, kind) = match role_name {
            "user" => (Role::User, MessageKind::Message),
            "assistant" => (Role::Assistant, MessageKind::Message),
            "system" => (Role::System, MessageKind::Message),
            other => {
                // 未知 role：保留为事件消息并计数，不静默丢弃
                info.note_unknown(&format!("role:{other}"));
                (Role::Unknown, MessageKind::Event)
            }
        };
        if text.is_empty() {
            return Ok(());
        }
        // 正文类消息做相邻去重
        if kind == MessageKind::Message && self.dup.is_duplicate(role, text) {
            return Ok(());
        }
        if role == Role::User
            && kind == MessageKind::Message
            && self.first_user_text.is_none()
            && !crate::adapters::looks_system_injected(text)
        {
            self.first_user_text = Some(text.to_string());
        }
        let seq = self.sequence;
        self.sequence += 1;
        self.sink.emit(NormalizedMessage {
            id: message_id(&self.session_id, seq),
            role,
            kind,
            timestamp: None,
            text: Some(cap_text(text.to_string())),
            tool_name: None,
            // 未知 role 保留受体积限制的 raw 片段（规格 §6）
            raw: if kind == MessageKind::Event {
                crate::adapters::cap_raw(message)
            } else {
                None
            },
        })?;
        self.message_count += 1;
        Ok(())
    }
}

/// 收集 `<root>/*/*.json` 会话文件（只读目录项，不读内容；跳过隐私红线路径）。
fn collect_session_files(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for dir in paths::sub_dirs(root) {
        let entries = match std::fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
                continue;
            }
            let path = entry.path();
            if paths::is_forbidden_path(&path) {
                continue;
            }
            if entry.file_name().to_string_lossy().ends_with(".json") {
                out.push(path);
            }
        }
    }
    out.sort();
    out
}

/// 构造文件引用。
fn raw_ref(role: &str, path: &Path) -> RawFileRef {
    let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    RawFileRef {
        role: role.to_string(),
        path: path.to_path_buf(),
        size,
    }
}
