//! Kimi Code CLI 适配器（规格 §5）。
//!
//! 真实目录结构（依据本机 `~/.kimi-code` 实测）：
//!
//! ```text
//! ~/.kimi-code/
//! ├── session_index.jsonl                     # sessionId / sessionDir / workDir
//! └── sessions/
//!     └── <workDirKey>/                        # 例如 wd_my-project_0123456789ab
//!         └── <sessionDir>/                    # 例如 ses_xxx / session_xxx
//!             ├── state.json                   # title / cwd / createdAt / updatedAt
//!             └── agents/
//!                 ├── main/wire.jsonl          # 主聊天事件流（本适配器解析对象）
//!                 └── agent-*/wire.jsonl       # 子 Agent（v1 不进入主聊天）
//! ```
//!
//! 与规格的两点务实差异（规格允许按真实文件调整 Adapter）：
//! 1. **以目录遍历为主、`session_index.jsonl` 为辅**：索引里记录的是绝对路径，
//!    跨机器复制/迁移后会失效；而 `sessions/<workDirKey>/<sessionDir>/` 始终可用。
//!    索引仅用于补充 `workDir`（完整项目路径）。
//! 2. `session_index.jsonl` 里的 id 前缀是 `ses_`，而目录名可能是 `session_`，
//!    因此统一按 UUID 主体做匹配。
//!
//! 隐私：`credentials/`、`logs/`、`bin/`、`plugins/`、`updates/` 一律不读取、不复制。

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};

use serde_json::Value;

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
    content_to_text, get_str, normalize_timestamp_value, stream_jsonl, JsonlReport, ParseLimits,
};
use crate::paths;

/// 会话索引文件名。
const SESSION_INDEX: &str = "session_index.jsonl";
/// 主 Agent 事件流相对路径。
const MAIN_WIRE: &str = "agents/main/wire.jsonl";

/// 已知但不需要进入索引的事件类型（纯遥测 / 配置类）。
///
/// 这些事件数量极大（单个会话可达上千条），全部入库只会让索引与 UI 噪声化；
/// 原始信息仍完整保存在原始 `wire.jsonl` 与快照 `raw/` 中。
const TELEMETRY_EVENTS: &[&str] = &[
    "metadata",
    "runtime.set_binding",
    "profile.bind",
    "config.update",
    "permission.set_mode",
    "plugin.session_start",
    "llm.tools_snapshot",
    "llm.request",
    "usage.record",
    "token_counting.measured",
    "token_counting.turn_recorded",
    "token_counting.measured_turn",
    "file_history.tracked",
    "file_history.checkpoint",
    "tools.update_store",
    "tools.set_active_tools",
    "staleGuard.recorded",
    "token_usage_record",
    "inter_agent_communication_metadata",
    "interaction.request",
    "interaction.resolved",
    "task.waitDelivered",
    "turn.step.retrying",
    "plan.revision",
    "task.started",
    "turn.ended",
    "prompt.completed",
];

/// 会转成 UI 可见「事件」消息的类型。
const EVENT_MESSAGES: &[(&str, &str)] = &[
    ("plan_mode.enter", "进入计划模式"),
    ("plan_mode.exit", "退出计划模式"),
    ("turn.cancel", "回合被取消"),
    ("turn.step.interrupted", "步骤被中断"),
    ("prompt.aborted", "提示被中止"),
    ("task.terminated", "后台任务结束"),
    ("goal.update", "目标更新"),
    ("permission.record_approval_result", "权限审批记录"),
    ("plan_mode.cancel", "取消计划模式"),
    ("swarm_mode.enter", "进入多 Agent 模式"),
    ("swarm_mode.exit", "退出多 Agent 模式"),
];

/// Kimi Code 适配器。
pub struct KimiAdapter;

impl KimiAdapter {
    /// 新建适配器。
    pub fn new() -> Self {
        KimiAdapter
    }

    /// 探测可用根目录。
    ///
    /// 规则：**用户显式配置时只认该目录**（避免"配置了 A 却悄悄扫描 B"这种意外）；
    /// 未配置时才按 `KIMI_CODE_HOME` → `~/.kimi-code` → 常见位置依次自动发现。
    fn find_root(ctx: &AdapterContext<'_>) -> Option<PathBuf> {
        if let Some(manual) = ctx.settings.kimi_root() {
            return usable_root(&manual).then_some(manual);
        }
        paths::kimi_root_candidates(None)
            .into_iter()
            .find(|candidate| usable_root(candidate))
    }

    /// 统计会话数量（只读目录，不读文件内容）。
    fn count_sessions(root: &Path) -> usize {
        let sessions = root.join("sessions");
        let mut total = 0;
        for work_dir in paths::sub_dirs(&sessions) {
            total += crate::adapters::count_child_dirs(&work_dir, &|dir| {
                dir.join("state.json").is_file() || dir.join(MAIN_WIRE).is_file()
            });
        }
        total
    }

    /// 读取 `session_index.jsonl`，建立 `UUID → workDir` 映射。
    ///
    /// 容错：索引缺失或损坏都不会让扫描失败，只是拿不到完整项目路径。
    fn read_index(root: &Path) -> HashMap<String, String> {
        let mut map = HashMap::new();
        let index_path = root.join(SESSION_INDEX);
        if !index_path.is_file() {
            return map;
        }
        let limits = ParseLimits::default();
        let _ = stream_jsonl(&index_path, &limits, |value| {
            if let (Some(id), Some(work_dir)) =
                (get_str(value, "sessionId"), get_str(value, "workDir"))
            {
                map.insert(session_key(id).to_string(), work_dir.to_string());
            }
            Ok(crate::parser::jsonl::Flow::Continue)
        });
        map
    }
}

impl Default for KimiAdapter {
    fn default() -> Self {
        Self::new()
    }
}

impl ConversationAdapter for KimiAdapter {
    fn id(&self) -> &'static str {
        "kimi"
    }

    fn detect(&self, ctx: &AdapterContext<'_>) -> Vec<DetectionResult> {
        let manual = ctx.settings.kimi_root();
        match Self::find_root(ctx) {
            Some(root) => {
                let mut notes = Vec::new();
                let manual_path = manual.as_deref();
                let is_manual = manual_path
                    .map(|m| paths::same_path(m, &root))
                    .unwrap_or(false);
                if is_manual {
                    notes.push("使用设置中手工指定的目录".to_string());
                } else if std::env::var_os("KIMI_CODE_HOME").is_some() {
                    notes.push("来自环境变量 KIMI_CODE_HOME".to_string());
                } else {
                    notes.push("默认目录 ~/.kimi-code".to_string());
                }
                if !root.join(SESSION_INDEX).is_file() {
                    notes.push("未找到 session_index.jsonl，将通过目录遍历发现会话".to_string());
                }
                let hint = Self::count_sessions(&root);
                if is_manual && hint == 0 {
                    notes.push(
                        "该目录下未发现会话（sessions/<工作目录>/<会话>/agents/main/wire.jsonl）"
                            .to_string(),
                    );
                }
                vec![DetectionResult {
                    source: SourceKind::Kimi,
                    found: true,
                    root: Some(root),
                    session_hint: hint,
                    notes,
                    manual: is_manual,
                }]
            }
            None => vec![DetectionResult::missing(
                SourceKind::Kimi,
                "未找到 Kimi Code 数据目录（可用 KIMI_CODE_HOME 或设置项指定）",
            )],
        }
    }

    fn scan(&self, ctx: &AdapterContext<'_>) -> Result<Vec<SessionDescriptor>> {
        let Some(root) = Self::find_root(ctx) else {
            return Ok(Vec::new());
        };
        let index = Self::read_index(&root);
        let sessions_root = root.join("sessions");
        let mut out = Vec::new();

        for work_dir_key in paths::sub_dirs(&sessions_root) {
            // 目录名 `wd_<name>_<hash>` 提供项目名兜底，避免索引缺失时完全没有项目信息
            let fallback_project = project_name_from_key(&work_dir_key);
            for session_dir in paths::sub_dirs(&work_dir_key) {
                let dir_name = match session_dir.file_name() {
                    Some(n) => n.to_string_lossy().to_string(),
                    None => continue,
                };
                let primary =
                    session_dir.join(MAIN_WIRE.replace('/', std::path::MAIN_SEPARATOR_STR));
                if !primary.is_file() {
                    // 没有主 Agent 事件流（会话刚开始或被清理）→ 跳过
                    continue;
                }
                let key = session_key(&dir_name).to_string();
                let project_path = index
                    .get(&key)
                    .cloned()
                    .or_else(|| fallback_project.clone());

                let mut files = vec![file_ref("wire", &primary)];
                for sub in subagent_wires(&session_dir) {
                    files.push(file_ref("subagent_wire", &sub));
                }
                let state_path = session_dir.join("state.json");
                if state_path.is_file() {
                    files.push(file_ref("state", &state_path));
                }

                out.push(SessionDescriptor {
                    source: SourceKind::Kimi,
                    external_id: key,
                    primary_file: primary,
                    session_dir,
                    title_hint: None, // 标题以 state.json 为准，解析时读取
                    project_path,
                    // 本机会话：归属本机（写入索引后用于区分「本机 / 其他设备」）
                    machine_id: Some(ctx.machine_id.to_string()),
                    files,
                    content_revision: None,
                });
            }
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

        // ---- 1. state.json：标题、项目路径、时间 ----
        let state_path = descriptor.session_dir.join("state.json");
        if state_path.is_file() {
            match std::fs::read_to_string(&state_path) {
                Ok(raw) => match serde_json::from_str::<Value>(&raw) {
                    Ok(state) => {
                        if let Some(title) = get_str(&state, "title") {
                            let trimmed = title.trim();
                            if !trimmed.is_empty() {
                                info.title = Some(trimmed.to_string());
                            }
                        }
                        if let Some(cwd) = get_str(&state, "cwd") {
                            if !cwd.trim().is_empty() {
                                info.project_path = Some(cwd.to_string());
                            }
                        }
                        info.created_at =
                            state.get("createdAt").and_then(normalize_timestamp_value);
                        info.updated_at =
                            state.get("updatedAt").and_then(normalize_timestamp_value);
                        let mut meta = serde_json::Map::new();
                        meta.insert("format".into(), Value::String("kimi/wire".into()));
                        for key in [
                            "version",
                            "titleKind",
                            "lastTurnReason",
                            "isCustomTitle",
                            "archived",
                        ] {
                            if let Some(v) = state.get(key) {
                                meta.insert(key.to_string(), v.clone());
                            }
                        }
                        if let Some(agents) = state.get("agents").and_then(|a| a.as_object()) {
                            meta.insert(
                                "agentCount".into(),
                                Value::Number((agents.len() as i64).into()),
                            );
                        }
                        info.metadata = Value::Object(meta);
                    }
                    Err(e) => {
                        info.warn(format!("state.json 解析失败（{}）", brief(&e.to_string())))
                    }
                },
                Err(e) => info.warn(format!("state.json 读取失败（{e}）")),
            }
        }

        // ---- 2. 主 Agent 事件流：流式解析 ----
        let mut parser = WireParser::new(sink, &session_id, descriptor);
        let (report, warnings) =
            stream_jsonl(&descriptor.primary_file, &ParseLimits::default(), |v| {
                parser.handle_line(v)
            })?;
        parser.finish()?;

        info.message_count = parser.message_count;
        info.partial |= report.bad > 0;
        for w in warnings {
            info.warn(w);
        }
        for (kind, count) in &parser.unknown_events {
            for _ in 0..*count {
                info.note_unknown(kind);
            }
        }
        // 标题兜底：state.json 没有 title 时用首条用户消息
        if info.title.is_none() {
            info.title = parser
                .first_user_text
                .as_deref()
                .and_then(crate::adapters::derive_title);
        }
        if info.created_at.is_none() {
            info.created_at = parser.first_timestamp.clone();
        }
        if info.updated_at.is_none() {
            info.updated_at = parser.last_timestamp.clone();
        }
        // 元信息补充：子 Agent、事件统计
        if let Some(obj) = info.metadata.as_object_mut() {
            let subagents = descriptor
                .files
                .iter()
                .filter(|f| f.role == "subagent_wire")
                .count();
            obj.insert(
                "subagentCount".into(),
                Value::Number((subagents as i64).into()),
            );
            obj.insert(
                "wireLines".into(),
                Value::Number((report.lines as i64).into()),
            );
            obj.insert(
                "telemetryEvents".into(),
                Value::Number((parser.telemetry_count as i64).into()),
            );
            if !parser.unknown_events.is_empty() {
                let mut unknown = BTreeMap::new();
                for (k, v) in &parser.unknown_events {
                    unknown.insert(k.clone(), *v);
                }
                obj.insert("unknownEventTypes".into(), serde_json::to_value(unknown)?);
            }
        }
        info.metadata = cap_metadata(info.metadata);
        Ok(info)
    }
}

/// 解析 `wire.jsonl` 的状态机。
struct WireParser<'a> {
    sink: &'a mut dyn MessageSink,
    session_id: String,
    sequence: u64,
    message_count: u64,
    dup: DupFilter,
    /// 当前正在累积的 assistant 文本（`content.part` 会分片推送）
    pending_text: String,
    pending_kind: MessageKind,
    /// 分片所属的 step / turn，用于判断何时切分消息
    pending_key: Option<String>,
    last_timestamp: Option<String>,
    first_timestamp: Option<String>,
    first_user_text: Option<String>,
    /// 已处理的 prompt id，用于 `prompt.accepted` 与 `turn.prompt` 去重
    accepted_prompts: std::collections::HashSet<String>,
    unknown_events: HashMap<String, u64>,
    telemetry_count: u64,
}

impl<'a> WireParser<'a> {
    fn new(
        sink: &'a mut dyn MessageSink,
        session_id: &str,
        _descriptor: &SessionDescriptor,
    ) -> Self {
        WireParser {
            sink,
            session_id: session_id.to_string(),
            sequence: 0,
            message_count: 0,
            dup: DupFilter::default(),
            pending_text: String::new(),
            pending_kind: MessageKind::Message,
            pending_key: None,
            last_timestamp: None,
            first_timestamp: None,
            first_user_text: None,
            accepted_prompts: std::collections::HashSet::new(),
            unknown_events: HashMap::new(),
            telemetry_count: 0,
        }
    }

    /// 处理一行事件。
    fn handle_line(&mut self, value: &Value) -> Result<crate::parser::jsonl::Flow> {
        let time = value.get("time").and_then(normalize_timestamp_value);
        if let Some(ts) = &time {
            if self.first_timestamp.is_none() {
                self.first_timestamp = Some(ts.clone());
            }
            self.last_timestamp = Some(ts.clone());
        }
        let type_name = get_str(value, "type").unwrap_or("").to_string();
        match type_name.as_str() {
            "context.append_message" => self.on_message(value, time.as_deref())?,
            "context.append_loop_event" => self.on_loop_event(value, time.as_deref())?,
            // 用户输入以 `prompt.accepted` 为准（最完整的真实输入），`turn.prompt` 仅作补充，
            // 用 promptId 精确去重，避免同一句用户输入出现两次。
            "prompt.accepted" => {
                if let Some(id) = get_str(value, "promptId") {
                    self.accepted_prompts.insert(id.to_string());
                }
                if let Some(content) = value.get("content") {
                    let text = content_to_text(content);
                    self.emit_user_text(text, time.as_deref())?;
                }
            }
            "turn.prompt" => {
                let prompt_id = get_str(value, "promptId").map(|s| s.to_string());
                let already = prompt_id
                    .as_deref()
                    .map(|id| self.accepted_prompts.contains(id))
                    .unwrap_or(false);
                if !already {
                    if let Some(input) = value.get("input") {
                        let text = content_to_text(input);
                        self.emit_user_text(text, time.as_deref())?;
                    }
                }
            }
            "turn.steer" => {
                if let Some(input) = value.get("input") {
                    let text = content_to_text(input);
                    self.emit_user_text(text, time.as_deref())?;
                }
            }
            "prompt.steered" => {
                if let Some(content) = value.get("content") {
                    let text = content_to_text(content);
                    self.emit_user_text(text, time.as_deref())?;
                }
            }
            other => {
                if let Some((_, label)) = EVENT_MESSAGES.iter().find(|(t, _)| *t == other) {
                    self.flush_pending()?;
                    let reason = value
                        .get("reason")
                        .map(crate::parser::jsonl::value_to_text)
                        .unwrap_or_default();
                    let text = if reason.is_empty() {
                        label.to_string()
                    } else {
                        format!("{label}（{reason}）")
                    };
                    self.emit(
                        Role::System,
                        MessageKind::Event,
                        Some(text),
                        None,
                        None,
                        time.as_deref(),
                    )?;
                } else if TELEMETRY_EVENTS.contains(&other) || other.is_empty() {
                    // 已知遥测 / 无类型：只计数（原始文件保留全部信息）
                    self.telemetry_count += 1;
                } else {
                    // 未识别事件：计数 + 保留一个事件气泡，绝不静默丢弃
                    *self.unknown_events.entry(other.to_string()).or_insert(0) += 1;
                    self.flush_pending()?;
                    self.emit(
                        Role::Unknown,
                        MessageKind::Event,
                        Some(format!("[未识别事件] {other}")),
                        None,
                        // 未知事件保留受体积限制的 raw 片段（规格 §6）
                        crate::adapters::cap_raw(value),
                        time.as_deref(),
                    )?;
                }
            }
        }
        Ok(crate::parser::jsonl::Flow::Continue)
    }

    /// `context.append_message`：用户 / 系统 / 工具消息（含内联 toolCalls）。
    fn on_message(&mut self, value: &Value, time: Option<&str>) -> Result<()> {
        let Some(message) = value.get("message") else {
            return Ok(());
        };
        let role = Role::parse(get_str(message, "role").unwrap_or("unknown"));
        let text = message
            .get("content")
            .map(content_to_text)
            .unwrap_or_default();
        self.flush_pending()?;

        if !text.trim().is_empty() {
            self.emit(
                role,
                MessageKind::Message,
                Some(cap_text(text.clone())),
                None,
                None,
                time,
            )?;
            if role == Role::User
                && self.first_user_text.is_none()
                && !crate::adapters::looks_system_injected(&text)
            {
                self.first_user_text = Some(text);
            }
        }

        // 内联工具调用（assistant 消息里的 toolCalls）
        if let Some(calls) = message.get("toolCalls").and_then(|c| c.as_array()) {
            for call in calls {
                let name = call
                    .get("function")
                    .and_then(|f| get_str(f, "name"))
                    .or_else(|| get_str(call, "name"))
                    .unwrap_or("tool")
                    .to_string();
                let args = call
                    .get("function")
                    .and_then(|f| f.get("arguments"))
                    .or_else(|| call.get("args"))
                    .cloned()
                    .unwrap_or(Value::Null);
                let text = if args.is_null() {
                    None
                } else {
                    Some(cap_text(crate::parser::jsonl::value_to_text(&args)))
                };
                self.emit(
                    Role::Assistant,
                    MessageKind::ToolCall,
                    text,
                    Some(name),
                    Some(call.clone()),
                    time,
                )?;
            }
        }
        Ok(())
    }

    /// `context.append_loop_event`：assistant 文本分片 / 思考分片 / 工具调用与结果。
    fn on_loop_event(&mut self, value: &Value, time: Option<&str>) -> Result<()> {
        let Some(event) = value.get("event") else {
            return Ok(());
        };
        let event_type = get_str(event, "type").unwrap_or("");
        // 同一 step 的文本分片会被合并为一条消息，避免 UI 出现几十个碎片
        let step_key = get_str(event, "stepUuid")
            .or_else(|| get_str(event, "uuid"))
            .map(|s| s.to_string());

        match event_type {
            "content.part" => {
                let Some(part) = event.get("part") else {
                    return Ok(());
                };
                let part_type = get_str(part, "type").unwrap_or("text");
                let text = get_str(part, "text")
                    .map(|s| s.to_string())
                    .or_else(|| part.get("content").map(content_to_text))
                    .unwrap_or_default();
                if text.trim().is_empty() {
                    return Ok(());
                }
                let kind = if part_type == "think" {
                    MessageKind::ReasoningSummary
                } else {
                    MessageKind::Message
                };
                // step 变化或种类变化 → 先落盘上一段
                if self.pending_key != step_key || self.pending_kind != kind {
                    self.flush_pending()?;
                    self.pending_key = step_key;
                    self.pending_kind = kind;
                }
                if !self.pending_text.is_empty() {
                    self.pending_text.push('\n');
                }
                self.pending_text.push_str(&text);
            }
            "tool.call" => {
                self.flush_pending()?;
                let name = get_str(event, "name").unwrap_or("tool").to_string();
                let text = event
                    .get("args")
                    .map(crate::parser::jsonl::value_to_text)
                    .filter(|s| !s.trim().is_empty());
                self.emit(
                    Role::Assistant,
                    MessageKind::ToolCall,
                    text.map(cap_text),
                    Some(name),
                    None,
                    time,
                )?;
            }
            "tool.result" => {
                self.flush_pending()?;
                let text = event
                    .get("result")
                    .map(|r| match r.get("content") {
                        // 结果可能是 {content:[...]} 或纯文本
                        Some(content) => content_to_text(content),
                        None => crate::parser::jsonl::value_to_text(r),
                    })
                    .filter(|s| !s.trim().is_empty());
                self.emit(
                    Role::Tool,
                    MessageKind::ToolResult,
                    text.map(cap_text),
                    None,
                    None,
                    time,
                )?;
            }
            "step.begin" | "step.end" => {
                self.flush_pending()?;
            }
            other => {
                // 未知 loop event：计数并保留提示
                *self
                    .unknown_events
                    .entry(format!("loop:{other}"))
                    .or_insert(0) += 1;
                self.flush_pending()?;
                self.emit(
                    Role::Unknown,
                    MessageKind::Event,
                    Some(format!("[未识别事件] loop:{other}")),
                    None,
                    crate::adapters::cap_raw(value),
                    time,
                )?;
            }
        }
        Ok(())
    }

    /// 把累积的 assistant 分片落成一条消息。
    fn flush_pending(&mut self) -> Result<()> {
        if self.pending_text.trim().is_empty() {
            self.pending_text.clear();
            self.pending_key = None;
            return Ok(());
        }
        let text = std::mem::take(&mut self.pending_text);
        let kind = self.pending_kind;
        self.pending_key = None;
        self.pending_kind = MessageKind::Message;
        let ts = self.last_timestamp.clone();
        self.emit(
            Role::Assistant,
            kind,
            Some(cap_text(text)),
            None,
            None,
            ts.as_deref(),
        )
    }

    /// 用户文本（带相邻去重）。
    fn emit_user_text(&mut self, text: String, time: Option<&str>) -> Result<()> {
        if text.trim().is_empty() {
            return Ok(());
        }
        self.flush_pending()?;
        if self.first_user_text.is_none() && !crate::adapters::looks_system_injected(&text) {
            self.first_user_text = Some(text.clone());
        }
        self.emit(
            Role::User,
            MessageKind::Message,
            Some(cap_text(text)),
            None,
            None,
            time,
        )
    }

    /// 统一产出：分配序号、去重、写入 sink。
    fn emit(
        &mut self,
        role: Role,
        kind: MessageKind,
        text: Option<String>,
        tool_name: Option<String>,
        raw: Option<Value>,
        timestamp: Option<&str>,
    ) -> Result<()> {
        // 正文类消息做相邻去重（工具事件不去重，它们可能合法重复）
        if kind == MessageKind::Message {
            if let Some(t) = text.as_deref() {
                if self.dup.is_duplicate(role, t) {
                    return Ok(());
                }
            }
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

    /// 解析收尾：把最后一段分片落盘。
    fn finish(&mut self) -> Result<()> {
        self.flush_pending()
    }
}

/// 去掉 `ses_` / `session_` 前缀，得到稳定的 UUID 主体。
fn session_key(name: &str) -> &str {
    name.strip_prefix("ses_")
        .or_else(|| name.strip_prefix("session_"))
        .unwrap_or(name)
}

/// 从 `wd_<name>_<hash>` 目录名推导项目名。
fn project_name_from_key(dir: &Path) -> Option<String> {
    let name = dir.file_name()?.to_string_lossy().to_string();
    let body = name.strip_prefix("wd_").unwrap_or(&name);
    // 去掉尾部 12 位哈希（形如 a87aa2d307e8）
    let candidate = match body.rsplit_once('_') {
        Some((head, tail)) if tail.len() == 12 && tail.chars().all(|c| c.is_ascii_hexdigit()) => {
            head
        }
        _ => body,
    };
    if candidate.trim().is_empty() {
        None
    } else {
        Some(candidate.to_string())
    }
}

/// 列出子 Agent 的 wire 文件（v1 不进入主聊天，但登记进 raw_files 便于备份）。
fn subagent_wires(session_dir: &Path) -> Vec<PathBuf> {
    let agents_dir = session_dir.join("agents");
    let mut out = Vec::new();
    for dir in paths::sub_dirs(&agents_dir) {
        let name = dir
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        if !name.starts_with("agent-") && !name.starts_with("agent_") {
            continue;
        }
        let wire = dir.join("wire.jsonl");
        if wire.is_file() && !paths::is_forbidden_path(&wire) {
            out.push(wire);
        }
    }
    out
}

/// 构造文件引用（读取文件大小，失败则记 0）。
fn file_ref(role: &str, path: &Path) -> RawFileRef {
    let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    RawFileRef {
        role: role.to_string(),
        path: path.to_path_buf(),
        size,
    }
}

/// 缩短错误信息（去掉冗长的类型名与位置信息）。
fn brief(msg: &str) -> String {
    msg.lines().next().unwrap_or("解析失败").to_string()
}

/// 提供给测试与工具的 wire 解析辅助：统计事件类型分布。
pub fn wire_event_types(path: &Path) -> Result<(JsonlReport, Vec<String>)> {
    let mut counts: BTreeMap<String, u64> = BTreeMap::new();
    let (report, _warnings) = stream_jsonl(path, &ParseLimits::default(), |v| {
        let t = get_str(v, "type").unwrap_or("?").to_string();
        *counts.entry(t).or_insert(0) += 1;
        Ok(crate::parser::jsonl::Flow::Continue)
    })?;
    let summary: Vec<String> = counts
        .into_iter()
        .map(|(k, v)| format!("{k}={v}"))
        .collect();
    Ok((report, summary))
}
