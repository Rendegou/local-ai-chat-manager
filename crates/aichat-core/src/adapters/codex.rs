//! OpenAI Codex 适配器（规格 §6）。
//!
//! 真实目录结构（依据本机 `~/.codex` 实测，rollout JSONL）：
//!
//! ```text
//! ~/.codex/
//! ├── session_index.jsonl                # {id, thread_name, updated_at} —— 标题来源
//! ├── sessions/2026/09/01/rollout-<ISO 时间>-<uuid>.jsonl
//! └── archived_sessions/...              # 归档会话（同样解析）
//! ```
//!
//! rollout 行结构（顶层都是 `{timestamp, ordinal, type, payload}`）：
//! - `session_meta`：session_id / cwd / cli_version / git 等；
//! - `turn_context`：model / cwd / approval_policy 等；
//! - `response_item`：真实消息（message / reasoning / function_call / custom_tool_call ...）；
//! - `event_msg`：事件（user_message / agent_message / token_count / item_completed ...）；
//! - `world_state`：整机状态快照（体积大且无对话价值，索引阶段跳过）。
//!
//! 容错原则：**不把任何单一版本 schema 写死**。认不出的 type 只计数并保留提示，
//! 认不出的行不会让整个会话解析失败（规格 §6 / §10）。

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde_json::Value;
use walkdir::WalkDir;

use crate::adapters::{
    cap_metadata, cap_text, message_id, usable_root, AdapterContext, ConversationAdapter,
    DupFilter, MessageSink,
};
use crate::error::Result;
use crate::model::{
    DetectionResult, MessageKind, NormalizedMessage, ParsedSessionInfo, RawFileRef, Role,
    SessionDescriptor, SourceKind,
};
use crate::parser::jsonl::{
    content_to_text, get_str, normalize_timestamp_value, stream_jsonl, ParseLimits,
};
use crate::paths;

/// 会话索引（标题来源）。
const SESSION_INDEX: &str = "session_index.jsonl";
/// rollout 文件名前缀。
const ROLLOUT_PREFIX: &str = "rollout-";
/// 扫描 rollout 文件时的最大递归深度（`sessions/YYYY/MM/DD` = 4 层）。
const MAX_SCAN_DEPTH: usize = 6;

/// 纯计量 / 元数据类 payload 类型：只计数，不进入索引（依据本机真实数据整理）。
///
/// 这些类型出现频次高（单个会话可达上千条）但不含对话信息，
/// 原始信息仍在原始 rollout 文件与快照 raw/ 中。
const TELEMETRY_TYPES: &[&str] = &[
    "token_count",
    "token_usage_record",
    "thread_settings_applied",
    "task_started",
    "task_complete",
    "turn_aborted",
    "inter_agent_communication_metadata",
    "internal_chat_message_metadata_passthrough",
    "rate_limits",
    "keepalive",
];

/// Codex 适配器。
pub struct CodexAdapter;

impl CodexAdapter {
    /// 新建适配器。
    pub fn new() -> Self {
        CodexAdapter
    }

    /// 找到可用的数据根目录。
    ///
    /// 规则：
    /// - **用户显式配置时只认该目录**（可预测、不越界）；
    /// - 未配置时自动发现：`CODEX_HOME` → `~/.codex` → 其他常见位置；
    /// - 自动发现时要求目录里确实有会话痕迹（`sessions/` / `archived_sessions/` /
    ///   `rollout-*.jsonl`），避免把无关目录当成数据源。
    fn find_root(ctx: &AdapterContext<'_>) -> Option<PathBuf> {
        if let Some(manual) = ctx.settings.codex_root() {
            return usable_root(&manual).then_some(manual);
        }
        for candidate in paths::codex_root_candidates(None) {
            if !usable_root(&candidate) {
                continue;
            }
            if candidate.join("sessions").is_dir()
                || candidate.join("archived_sessions").is_dir()
                || !collect_rollouts(&candidate).is_empty()
            {
                return Some(candidate);
            }
        }
        None
    }

    /// 读取会话标题索引：`id → (thread_name, updated_at)`。
    fn read_title_index(root: &Path) -> HashMap<String, (String, Option<String>)> {
        let mut map = HashMap::new();
        let index_path = root.join(SESSION_INDEX);
        if !index_path.is_file() {
            return map;
        }
        let _ = stream_jsonl(&index_path, &ParseLimits::default(), |value| {
            if let Some(id) = get_str(value, "id") {
                let title = get_str(value, "thread_name")
                    .unwrap_or("")
                    .trim()
                    .to_string();
                let updated = value.get("updated_at").and_then(normalize_timestamp_value);
                if !title.is_empty() || updated.is_some() {
                    map.insert(id.to_string(), (title, updated));
                }
            }
            Ok(crate::parser::jsonl::Flow::Continue)
        });
        map
    }
}

impl Default for CodexAdapter {
    fn default() -> Self {
        Self::new()
    }
}

impl ConversationAdapter for CodexAdapter {
    fn id(&self) -> &'static str {
        "codex"
    }

    fn detect(&self, ctx: &AdapterContext<'_>) -> Vec<DetectionResult> {
        let manual = ctx.settings.codex_root();
        match Self::find_root(ctx) {
            Some(root) => {
                let is_manual = manual
                    .as_deref()
                    .map(|m| paths::same_path(m, &root))
                    .unwrap_or(false);
                let mut notes = Vec::new();
                if is_manual {
                    notes.push("使用设置中手工指定的目录".to_string());
                } else if std::env::var_os("CODEX_HOME").is_some() {
                    notes.push("来自环境变量 CODEX_HOME".to_string());
                } else {
                    notes.push(format!(
                        "自动探测目录 {}",
                        crate::error::display_path(&root)
                    ));
                }
                let rollouts = collect_rollouts(&root);
                if rollouts.is_empty() {
                    notes.push(
                        "未发现 rollout-*.jsonl（可在设置中指定 Codex 数据目录）".to_string(),
                    );
                }
                vec![DetectionResult {
                    source: SourceKind::Codex,
                    found: true,
                    root: Some(root),
                    session_hint: rollouts.len(),
                    notes,
                    manual: is_manual,
                }]
            }
            None => vec![DetectionResult::missing(
                SourceKind::Codex,
                "未找到 Codex 数据目录（可用 CODEX_HOME 或设置项指定）",
            )],
        }
    }

    fn scan(&self, ctx: &AdapterContext<'_>) -> Result<Vec<SessionDescriptor>> {
        let Some(root) = Self::find_root(ctx) else {
            return Ok(Vec::new());
        };
        let titles = Self::read_title_index(&root);
        let mut out = Vec::with_capacity(titles.len().max(64));

        for file in collect_rollouts(&root) {
            let Some(external_id) = rollout_session_id(&file) else {
                continue;
            };
            // 标题来自索引（thread_name），避免扫描阶段读取文件内容
            let title_hint = titles.get(&external_id).and_then(|(t, _)| {
                if t.is_empty() {
                    None
                } else {
                    Some(t.clone())
                }
            });

            out.push(SessionDescriptor {
                source: SourceKind::Codex,
                external_id,
                primary_file: file.clone(),
                session_dir: file
                    .parent()
                    .map(|p| p.to_path_buf())
                    .unwrap_or_else(|| root.clone()),
                title_hint,
                project_path: None, // 需要读 session_meta，交给解析阶段
                machine_id: Some(ctx.machine_id.to_string()),
                files: vec![raw_ref("rollout", &file)],
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
        let mut parser = RolloutParser::new(sink, &session_id, descriptor.title_hint.clone());
        let (report, warnings) =
            stream_jsonl(&descriptor.primary_file, &ParseLimits::default(), |value| {
                parser.handle_line(value)
            })?;

        let mut info = parser.into_info();
        info.partial |= report.bad > 0;
        for w in warnings {
            info.warn(w);
        }
        // 标题保持为空而不是退回 thread id：UI 显示「无标题」比显示一串 uuid 更清楚
        if info.updated_at.is_none() {
            info.updated_at = descriptor
                .files
                .first()
                .and_then(|f| std::fs::metadata(&f.path).ok())
                .and_then(|m| m.modified().ok())
                .map(|t| chrono::DateTime::<chrono::Utc>::from(t).to_rfc3339());
        }
        if let Value::Object(obj) = &mut info.metadata {
            obj.insert("format".into(), Value::String("codex/rollout".into()));
            obj.insert("lines".into(), Value::Number((report.lines as i64).into()));
            if report.bad > 0 {
                obj.insert("badLines".into(), Value::Number((report.bad as i64).into()));
            }
        }
        info.metadata = cap_metadata(info.metadata);
        Ok(info)
    }
}

/// Codex rollout 状态机。
struct RolloutParser<'a> {
    sink: &'a mut dyn MessageSink,
    session_id: String,
    sequence: u64,
    message_count: u64,
    dup: DupFilter,
    title_hint: Option<String>,
    /// 首条用户消息：标题兜底
    first_user_text: Option<String>,
    /// 首个找到的用户可见助手文本（用于 task_complete 兜底）
    first_timestamp: Option<String>,
    last_timestamp: Option<String>,
    metadata: serde_json::Map<String, Value>,
    unknown_types: HashMap<String, u64>,
    skipped: u64,
    /// 是否已把「多 Agent 消息」提示写入（避免噪声）
    partial: bool,
}

impl<'a> RolloutParser<'a> {
    fn new(sink: &'a mut dyn MessageSink, session_id: &str, title_hint: Option<String>) -> Self {
        RolloutParser {
            sink,
            session_id: session_id.to_string(),
            sequence: 0,
            message_count: 0,
            dup: DupFilter::default(),
            title_hint,
            first_user_text: None,
            first_timestamp: None,
            last_timestamp: None,
            metadata: serde_json::Map::new(),
            unknown_types: HashMap::new(),
            skipped: 0,
            partial: false,
        }
    }

    /// 处理一行 rollout。
    fn handle_line(&mut self, value: &Value) -> Result<crate::parser::jsonl::Flow> {
        let time = value.get("timestamp").and_then(normalize_timestamp_value);
        if let Some(ts) = &time {
            if self.first_timestamp.is_none() {
                self.first_timestamp = Some(ts.clone());
            }
            self.last_timestamp = Some(ts.clone());
        }
        let type_name = get_str(value, "type").unwrap_or("");
        let payload = value.get("payload").unwrap_or(&Value::Null);
        match type_name {
            "session_meta" => self.on_session_meta(payload),
            "turn_context" => self.on_turn_context(payload),
            "response_item" => self.on_response_item(payload, time.as_deref())?,
            "event_msg" => self.on_event_msg(payload, time.as_deref())?,
            // 整机状态快照：体积大且无对话价值，只计数
            "world_state" => self.skipped += 1,
            "compacted" => {
                self.skipped += 1;
                self.metadata.insert("compacted".into(), Value::Bool(true));
            }
            // 顶层计量 / 协调类事件（实测出现在 rollout 顶层，而非 response_item 内）
            "token_usage_record" | "inter_agent_communication_metadata" => self.skipped += 1,
            other => {
                self.note_unknown(if other.is_empty() {
                    "<无 type>"
                } else {
                    other
                });
                self.skipped += 1;
            }
        }
        Ok(crate::parser::jsonl::Flow::Continue)
    }

    /// `session_meta`：会话级元信息（含项目路径）。
    fn on_session_meta(&mut self, payload: &Value) {
        for key in [
            "session_id",
            "id",
            "cwd",
            "originator",
            "cli_version",
            "model_provider",
            "history_mode",
            "context_window",
            "parent_thread_id",
        ] {
            if let Some(v) = payload.get(key) {
                // base_instructions 等超大字段不复制进索引
                if v.to_string().len() < 4096 {
                    let mapped = match key {
                        "session_id" | "id" => "threadId",
                        other => other,
                    };
                    self.metadata.insert(mapped.to_string(), v.clone());
                }
            }
        }
        if let Some(git) = payload.get("git") {
            if let Some(obj) = git.as_object() {
                let mut git_meta = serde_json::Map::new();
                for key in ["branch", "commit_hash", "repository_url"] {
                    if let Some(v) = obj.get(key) {
                        git_meta.insert(key.to_string(), v.clone());
                    }
                }
                if !git_meta.is_empty() {
                    self.metadata.insert("git".into(), Value::Object(git_meta));
                }
            }
        }
    }

    /// `turn_context`：模型与工作目录（每次 turn 都会出现，取最新值）。
    fn on_turn_context(&mut self, payload: &Value) {
        if let Some(model) = get_str(payload, "model") {
            self.metadata
                .insert("model".into(), Value::String(model.to_string()));
        }
        if let Some(cwd) = get_str(payload, "cwd") {
            if !cwd.trim().is_empty() {
                self.metadata
                    .insert("cwd".into(), Value::String(cwd.to_string()));
            }
        }
    }

    /// `response_item`：模型层记录（消息 / 推理 / 工具调用与结果）。
    fn on_response_item(&mut self, payload: &Value, time: Option<&str>) -> Result<()> {
        let kind = get_str(payload, "type").unwrap_or("");
        match kind {
            "message" => {
                let role = Role::parse(get_str(payload, "role").unwrap_or("unknown"));
                let text = payload
                    .get("content")
                    .map(content_to_text)
                    .unwrap_or_default();
                let text = text.trim();
                if text.is_empty() {
                    return Ok(());
                }
                self.emit_text(role, MessageKind::Message, text, time)?;
            }
            "reasoning" => {
                let text = payload
                    .get("summary")
                    .map(content_to_text)
                    .filter(|s| !s.trim().is_empty())
                    .or_else(|| {
                        payload
                            .get("content")
                            .map(content_to_text)
                            .filter(|s| !s.trim().is_empty())
                    });
                if let Some(text) = text {
                    self.emit_text(Role::Assistant, MessageKind::ReasoningSummary, &text, time)?;
                }
            }
            "function_call" | "local_shell_call" | "web_search_call" | "computer_call"
            | "custom_tool_call" => {
                let name = get_str(payload, "name")
                    .or_else(|| get_str(payload, "tool_name"))
                    .unwrap_or(kind)
                    .to_string();
                let args = payload
                    .get("arguments")
                    .or_else(|| payload.get("input"))
                    .or_else(|| payload.get("action"))
                    .cloned();
                let text = args
                    .as_ref()
                    .map(|a| cap_text(crate::parser::jsonl::value_to_text(a)));
                self.emit_full(
                    Role::Assistant,
                    MessageKind::ToolCall,
                    text,
                    Some(name),
                    None,
                    time,
                )?;
            }
            "function_call_output" | "custom_tool_call_output" | "local_shell_call_output" => {
                let text = payload
                    .get("output")
                    .map(|o| {
                        let text = content_to_text(o);
                        if text.trim().is_empty() {
                            crate::parser::jsonl::value_to_text(o)
                        } else {
                            text
                        }
                    })
                    .filter(|s| !s.trim().is_empty());
                self.emit_full(
                    Role::Tool,
                    MessageKind::ToolResult,
                    text.map(cap_text),
                    get_str(payload, "name").map(|s| s.to_string()),
                    None,
                    time,
                )?;
            }
            "agent_message" => {
                // 多 Agent 协作消息：不是人类对话，标记为事件但保留内容
                let text = payload
                    .get("content")
                    .map(content_to_text)
                    .unwrap_or_default();
                let author = get_str(payload, "author").unwrap_or("agent");
                let recipient = get_str(payload, "recipient").unwrap_or("?");
                if !text.trim().is_empty() {
                    self.emit_full(
                        Role::Unknown,
                        MessageKind::Event,
                        Some(cap_text(format!("[{author} → {recipient}]\n{text}"))),
                        None,
                        crate::adapters::cap_raw(payload),
                        time,
                    )?;
                }
            }
            other => {
                if TELEMETRY_TYPES.contains(&other) {
                    self.skipped += 1;
                } else {
                    self.note_unknown(if other.is_empty() {
                        "<无 type>"
                    } else {
                        other
                    });
                }
            }
        }
        Ok(())
    }

    /// `event_msg`：事件层记录（与 `response_item` 有重叠，靠去重合并）。
    fn on_event_msg(&mut self, payload: &Value, time: Option<&str>) -> Result<()> {
        let kind = get_str(payload, "type").unwrap_or("");
        match kind {
            "user_message" => {
                let text = payload
                    .get("message")
                    .or_else(|| payload.get("text"))
                    .map(crate::parser::jsonl::value_to_text)
                    .unwrap_or_default();
                if !text.trim().is_empty() {
                    self.emit_text(Role::User, MessageKind::Message, &text, time)?;
                }
            }
            "agent_message" => {
                let text = payload
                    .get("message")
                    .or_else(|| payload.get("text"))
                    .map(crate::parser::jsonl::value_to_text)
                    .unwrap_or_default();
                if !text.trim().is_empty() {
                    self.emit_text(Role::Assistant, MessageKind::Message, &text, time)?;
                }
            }
            "agent_reasoning" => {
                let text = payload
                    .get("text")
                    .map(crate::parser::jsonl::value_to_text)
                    .unwrap_or_default();
                if !text.trim().is_empty() {
                    self.emit_text(Role::Assistant, MessageKind::ReasoningSummary, &text, time)?;
                }
            }
            "item_completed" => self.on_item_completed(payload, time)?,
            "error" => {
                let text = payload
                    .get("message")
                    .map(crate::parser::jsonl::value_to_text)
                    .unwrap_or_else(|| "发生错误".to_string());
                self.emit_full(
                    Role::System,
                    MessageKind::Event,
                    Some(cap_text(text)),
                    None,
                    crate::adapters::cap_raw(payload),
                    time,
                )?;
            }
            other => {
                if TELEMETRY_TYPES.contains(&other) {
                    self.skipped += 1;
                } else {
                    self.note_unknown(if other.is_empty() {
                        "<无 type>"
                    } else {
                        other
                    });
                    self.skipped += 1;
                }
            }
        }
        Ok(())
    }

    /// `item_completed`：item 里可能携带 message / reasoning / 工具项。
    fn on_item_completed(&mut self, payload: &Value, time: Option<&str>) -> Result<()> {
        let Some(item) = payload.get("item") else {
            self.skipped += 1;
            return Ok(());
        };
        let item_type = get_str(item, "type").unwrap_or("");
        let text = item
            .get("content")
            .map(content_to_text)
            .or_else(|| item.get("text").map(crate::parser::jsonl::value_to_text))
            .unwrap_or_default();
        match item_type {
            "UserMessage" | "user_message" => {
                if !text.trim().is_empty() {
                    self.emit_text(Role::User, MessageKind::Message, &text, time)?;
                }
            }
            "AgentMessage" | "assistant_message" => {
                if !text.trim().is_empty() {
                    self.emit_text(Role::Assistant, MessageKind::Message, &text, time)?;
                }
            }
            "Reasoning" | "reasoning" => {
                if !text.trim().is_empty() {
                    self.emit_text(Role::Assistant, MessageKind::ReasoningSummary, &text, time)?;
                }
            }
            "FunctionCall" | "CustomToolCall" | "function_call" => {
                let name = get_str(item, "name").unwrap_or("tool").to_string();
                self.emit_full(
                    Role::Assistant,
                    MessageKind::ToolCall,
                    Some(cap_text(text)),
                    Some(name),
                    None,
                    time,
                )?;
            }
            "FunctionCallOutput" | "CustomToolCallOutput" | "function_call_output" => {
                self.emit_full(
                    Role::Tool,
                    MessageKind::ToolResult,
                    Some(cap_text(text)),
                    None,
                    None,
                    time,
                )?;
            }
            // ---- 以下是 Codex 实测出现的 item 类型（保持与真实数据一致）----
            "CommandExecution" | "command_execution" => {
                // 命令本身作为 tool_call，输出作为 tool_result，便于检索「这条命令什么时候跑过」
                let command = item.get("command").map(command_to_text).unwrap_or_default();
                if !command.trim().is_empty() {
                    self.emit_full(
                        Role::Assistant,
                        MessageKind::ToolCall,
                        Some(cap_text(command)),
                        Some("shell".to_string()),
                        None,
                        time,
                    )?;
                }
                let output = item
                    .get("aggregated_output")
                    .map(crate::parser::jsonl::value_to_text)
                    .unwrap_or_default();
                let exit_code = item.get("exit_code").and_then(|v| v.as_i64());
                let text = match (output.trim().is_empty(), exit_code) {
                    (false, Some(code)) => format!(
                        "{output}
(exit code {code})"
                    ),
                    (false, None) => output,
                    (true, Some(code)) => format!("(exit code {code})"),
                    (true, None) => String::new(),
                };
                if !text.trim().is_empty() {
                    self.emit_full(
                        Role::Tool,
                        MessageKind::ToolResult,
                        Some(cap_text(text)),
                        Some("shell".to_string()),
                        None,
                        time,
                    )?;
                }
            }
            "FileChange" | "PatchApply" | "file_change" => {
                // 文件改动：把 changes 结构化内容序列化进 text（超长截断）
                let payload = item
                    .get("changes")
                    .or_else(|| item.get("stdout"))
                    .map(crate::parser::jsonl::value_to_text)
                    .unwrap_or_default();
                self.emit_full(
                    Role::Assistant,
                    MessageKind::ToolCall,
                    Some(cap_text(payload)),
                    Some("apply_patch".to_string()),
                    None,
                    time,
                )?;
            }
            "McpToolCall" | "mcp_tool_call" => {
                let server = get_str(item, "server").unwrap_or("mcp");
                let tool = get_str(item, "tool").unwrap_or("call");
                let args = item
                    .get("arguments")
                    .map(crate::parser::jsonl::value_to_text)
                    .unwrap_or_default();
                self.emit_full(
                    Role::Assistant,
                    MessageKind::ToolCall,
                    Some(cap_text(args)),
                    Some(format!("{server}.{tool}")),
                    None,
                    time,
                )?;
                let result = item
                    .get("result")
                    .map(crate::parser::jsonl::value_to_text)
                    .unwrap_or_default();
                if !result.trim().is_empty() {
                    self.emit_full(
                        Role::Tool,
                        MessageKind::ToolResult,
                        Some(cap_text(result)),
                        Some(format!("{server}.{tool}")),
                        None,
                        time,
                    )?;
                }
            }
            "WebSearch" | "web_search" => {
                let query = get_str(item, "query").unwrap_or("").to_string();
                self.emit_full(
                    Role::Assistant,
                    MessageKind::ToolCall,
                    Some(cap_text(query)),
                    Some("web_search".to_string()),
                    None,
                    time,
                )?;
            }
            "CollabAgentToolCall" => {
                let text = item
                    .get("content")
                    .map(content_to_text)
                    .unwrap_or_else(|| crate::parser::jsonl::value_to_text(item));
                self.emit_full(
                    Role::Assistant,
                    MessageKind::ToolCall,
                    Some(cap_text(text)),
                    Some("collab_agent".to_string()),
                    None,
                    time,
                )?;
            }
            "ContextCompaction" | "context_compaction" => {
                self.emit_full(
                    Role::System,
                    MessageKind::Event,
                    Some("上下文已压缩（compaction）".to_string()),
                    None,
                    None,
                    time,
                )?;
            }
            "SubAgentActivity" | "sub_agent_activity" => {
                let kind = get_str(item, "kind").unwrap_or("activity");
                self.emit_full(
                    Role::System,
                    MessageKind::Event,
                    Some(format!("子 Agent 活动：{kind}")),
                    None,
                    None,
                    time,
                )?;
            }
            other => {
                // 其他 item 类型（如 TaskItem）：保留为事件，避免丢信息
                if !text.trim().is_empty() {
                    self.emit_full(
                        Role::Unknown,
                        MessageKind::Event,
                        Some(cap_text(text)),
                        None,
                        None,
                        time,
                    )?;
                } else if !other.is_empty() {
                    self.note_unknown(&format!("item:{other}"));
                }
                self.skipped += 1;
            }
        }
        Ok(())
    }

    /// 记录一次未识别类型（不丢弃、不报错）。
    fn note_unknown(&mut self, name: &str) {
        *self.unknown_types.entry(name.to_string()).or_insert(0) += 1;
        self.partial = true;
    }

    /// 文本类消息（走相邻去重）。
    fn emit_text(
        &mut self,
        role: Role,
        kind: MessageKind,
        text: &str,
        time: Option<&str>,
    ) -> Result<()> {
        if self.dup.is_duplicate(role, text) {
            return Ok(());
        }
        self.emit_full(
            role,
            kind,
            Some(cap_text(text.to_string())),
            None,
            None,
            time,
        )
    }

    /// 统一产出：分配序号并写入 sink。
    fn emit_full(
        &mut self,
        role: Role,
        kind: MessageKind,
        text: Option<String>,
        tool_name: Option<String>,
        raw: Option<Value>,
        timestamp: Option<&str>,
    ) -> Result<()> {
        // 标题候选：跳过系统注入内容（AGENTS.md / 权限说明等）
        if role == Role::User
            && kind == MessageKind::Message
            && self.first_user_text.is_none()
            && text
                .as_deref()
                .map(|t| !crate::adapters::looks_system_injected(t))
                .unwrap_or(false)
        {
            self.first_user_text = text.clone();
        }
        let seq = self.sequence;
        self.sequence += 1;
        let message = NormalizedMessage {
            id: message_id(&self.session_id, seq),
            role,
            kind,
            timestamp: timestamp
                .map(|s| s.to_string())
                .or_else(|| self.last_timestamp.clone()),
            text,
            tool_name,
            raw,
        };
        self.sink.emit(message)?;
        self.message_count += 1;
        Ok(())
    }

    /// 收尾：汇总元信息与标题。
    fn into_info(self) -> ParsedSessionInfo {
        let mut info = ParsedSessionInfo::new();
        info.message_count = self.message_count;
        info.created_at = self.first_timestamp.clone();
        info.updated_at = self.last_timestamp.clone();
        info.project_path = self
            .metadata
            .get("cwd")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        info.model = self
            .metadata
            .get("model")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        // 标题优先级：session_index.thread_name > 首条用户消息
        info.title = self.title_hint.clone().or_else(|| {
            self.first_user_text
                .as_deref()
                .and_then(crate::adapters::derive_title)
        });
        info.partial = self.partial;
        let mut meta = self.metadata;
        if self.skipped > 0 {
            meta.insert(
                "skippedEvents".into(),
                Value::Number((self.skipped as i64).into()),
            );
        }
        if !self.unknown_types.is_empty() {
            let mut unknown = serde_json::Map::new();
            for (k, v) in &self.unknown_types {
                unknown.insert(k.clone(), Value::Number((*v as i64).into()));
            }
            meta.insert("unknownEventTypes".into(), Value::Object(unknown));
        }
        info.metadata = Value::Object(meta);
        info
    }
}

// ---------------------------------------------------------------------------
// 目录遍历辅助
// ---------------------------------------------------------------------------

/// 收集根目录下所有 rollout 文件（`sessions/`、`archived_sessions/`，必要时回退全目录搜索）。
fn collect_rollouts(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for sub in ["sessions", "archived_sessions"] {
        let dir = root.join(sub);
        if dir.is_dir() {
            walk_rollouts(&dir, &mut out);
        }
    }
    if out.is_empty() {
        // 用户可能直接指向了 `sessions/` 之类的子目录，或使用了自定义命名
        walk_rollouts(root, &mut out);
    }
    out.sort();
    out
}

/// 递归收集 `rollout-*.jsonl`。
///
/// 只做文件名匹配，不读文件内容 —— 10k 会话的扫描必须保持毫秒级。
fn walk_rollouts(dir: &Path, out: &mut Vec<PathBuf>) {
    for entry in WalkDir::new(dir)
        .max_depth(MAX_SCAN_DEPTH)
        .follow_links(false)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        if paths::is_forbidden_path(path) {
            continue;
        }
        let name = entry.file_name().to_string_lossy();
        if name.starts_with(ROLLOUT_PREFIX) && name.ends_with(".jsonl") {
            out.push(path.to_path_buf());
        }
    }
}

/// 从 rollout 文件名提取会话 id。
///
/// 实测存在两种命名，二者的 **第一个 UUID** 都与 `session_meta.session_id` 一致：
/// - `rollout-2026-09-01T17-56-03-<uuid>.jsonl`
/// - `rollout-2026-09-07T00-53-18-<uuid>_<uuid>.jsonl`（父子 / 续写会话）
///
/// 这里只做「取第一个 UUID」这一件事，**不读文件内容**，让扫描阶段保持零 IO。
/// 完全解析不出 UUID 时退回去掉扩展名的文件名，保证会话仍然可见、不会消失。
fn rollout_session_id(path: &Path) -> Option<String> {
    let name = path.file_name()?.to_string_lossy().to_string();
    let stem = name.strip_suffix(".jsonl").unwrap_or(name.as_str());
    let body = stem.strip_prefix(ROLLOUT_PREFIX).unwrap_or(stem);
    if let Some(uuid) = first_uuid(body) {
        return Some(uuid);
    }
    let trimmed = body.trim_matches('-').to_string();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
}

/// 找出字符串中第一个 UUID（8-4-4-4-12 十六进制），纯字符扫描。
fn first_uuid(text: &str) -> Option<String> {
    let chars: Vec<char> = text.chars().collect();
    if chars.len() < 36 {
        return None;
    }
    for start in 0..=(chars.len() - 36) {
        let window = &chars[start..start + 36];
        let matched = window.iter().enumerate().all(|(offset, ch)| match offset {
            8 | 13 | 18 | 23 => *ch == '-',
            _ => ch.is_ascii_hexdigit(),
        });
        if matched {
            return Some(window.iter().collect());
        }
    }
    None
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

/// 把 Codex 的 `command` 字段（可能是字符串或数组）转成可读命令文本。
fn command_to_text(value: &Value) -> String {
    match value {
        Value::Array(parts) => parts
            .iter()
            .map(crate::parser::jsonl::value_to_text)
            .collect::<Vec<_>>()
            .join(" "),
        other => crate::parser::jsonl::value_to_text(other),
    }
}

/// 判断一行 JSON 是否像 Codex rollout 首行（供「按文件特征递归发现」使用）。
///
/// 只依据结构特征，不绑定具体版本字段值：
/// `type == "session_meta"` 且 `payload` 里存在 `session_id` 或 `cwd`。
pub fn looks_like_rollout(first_value: &Value) -> bool {
    if get_str(first_value, "type") != Some("session_meta") {
        return false;
    }
    match first_value.get("payload") {
        Some(payload) => {
            get_str(payload, "session_id").is_some()
                || get_str(payload, "cwd").is_some()
                || get_str(payload, "cli_version").is_some()
        }
        None => false,
    }
}
