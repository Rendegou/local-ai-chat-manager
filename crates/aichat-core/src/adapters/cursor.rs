//! Cursor（桌面 IDE）适配器。
//!
//! 真实存储结构（依据本机 `%APPDATA%/Cursor/User/globalStorage/state.vscdb` 实测）：
//!
//! ```text
//! state.vscdb（SQLite，WAL 模式，Cursor 运行时持有 → 必须只读打开）
//! ├── composerHeaders                      # 会话头：一行一个 composer
//! │     composerId TEXT PRIMARY KEY        # 会话 id
//! │     createdAt / lastUpdatedAt INTEGER  # epoch 毫秒
//! │     isArchived / isSubagent INTEGER
//! │     value TEXT                         # JSON，含 name（标题）等
//! └── cursorDiskKV(key TEXT, value BLOB)   # 消息体，key = bubbleId:<composerId>:<bubbleId>
//! ```
//!
//! bubble value 是 JSON 对象（实测键名约 70 个，多数是上下文快照，与对话无关）：
//! - `type`：1 = 用户消息，2 = 助手消息（抽样 3000 条仅出现这两种）；
//! - `text`：正文文本（工具调用气泡常为空）；
//! - `thinking.text`：思考内容（dict，含 signature/text）；
//! - `toolFormerData`：`{name, params(JSON 字符串), rawArgs, result, status, ...}`；
//! - `createdAt`：ISO8601 字符串（约 4% 缺失）。
//!
//! 顺序依据（实测）：key 字典序与 `createdAt` 顺序不一致（抽样 100 条全部错位），
//! 因此解析时按 `createdAt` 排序（缺失的按 key 序排在最前，保持稳定）。
//!
//! 增量：descriptor 的 `content_revision` 取 `lastUpdatedAt`（毫秒字符串），
//! 扫描器据此短路，避免对共享的巨型 db 反复 size+mtime+hash。
//!
//! 隐私：只读打开数据库，绝不复制整个 db；`raw_files` 为空（db 行不是文件）。

use std::path::{Path, PathBuf};

use rusqlite::{Connection, OpenFlags};
use serde_json::Value;

use crate::adapters::{
    cap_metadata, cap_text, message_id, usable_root, AdapterContext, ConversationAdapter,
    DupFilter, MessageSink,
};
use crate::error::{Error, Result};
use crate::model::{
    DetectionResult, MessageKind, NormalizedMessage, ParsedSessionInfo, Role, SessionDescriptor,
    SourceKind,
};
use crate::parser::jsonl::{epoch_ms_to_rfc3339, get_str, normalize_timestamp};
use crate::paths;

/// Cursor 全局存储库文件名。
const DB_FILE: &str = "state.vscdb";
/// 草稿占位行：不是真实会话，扫描时排除。
const DRAFT_COMPOSER: &str = "empty-state-draft";

/// Cursor 适配器。
pub struct CursorAdapter;

impl CursorAdapter {
    /// 新建适配器。
    pub fn new() -> Self {
        CursorAdapter
    }

    /// 找到可用的 globalStorage 目录。
    ///
    /// 规则与 Codex / Kimi 一致：**用户显式配置时只认该目录**；
    /// 未配置时使用平台默认目录，且要求 `state.vscdb` 确实存在。
    fn find_root(ctx: &AdapterContext<'_>) -> Option<PathBuf> {
        if let Some(manual) = ctx.settings.cursor_root() {
            return (usable_root(&manual) && paths::is_file(&manual.join(DB_FILE)))
                .then_some(manual);
        }
        let default = paths::default_cursor_root()?;
        if usable_root(&default) && paths::is_file(&default.join(DB_FILE)) {
            return Some(default);
        }
        None
    }

    /// 只读打开数据库（Cursor 可能正在运行，绝不以读写方式触碰）。
    fn open_readonly(db_path: &Path) -> Result<Connection> {
        Connection::open_with_flags(db_path, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(Error::from)
    }

    /// 确认库里有 `composerHeaders` 表（区分「是 Cursor 的库」与「随便一个 sqlite 文件」）。
    fn has_composer_table(conn: &Connection) -> bool {
        conn.query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'composerHeaders'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map(|n| n > 0)
        .unwrap_or(false)
    }

    /// 伪路径：`<db 路径>#<composerId>`。
    ///
    /// 每个 composer 需要独立的指纹 key（它们共享同一个 db 文件），
    /// 扫描器对伪路径的 quick_stat 会失败并安全跳过；解析时自行剥离后缀还原真路径。
    /// 注意：`#` 后缀不会命中 `paths::is_forbidden_path` 的任何规则。
    fn pseudo_path(db_path: &Path, composer_id: &str) -> PathBuf {
        PathBuf::from(format!("{}#{}", db_path.display(), composer_id))
    }

    /// 从伪路径还原 db 真路径（找不到后缀时报错，绝不猜）。
    fn real_db_path(descriptor: &SessionDescriptor) -> Result<PathBuf> {
        let raw = descriptor.primary_file.to_string_lossy();
        let suffix = format!("#{}", descriptor.external_id);
        raw.strip_suffix(&suffix)
            .map(PathBuf::from)
            .ok_or_else(|| Error::adapter("Cursor 会话描述符的 primary_file 不是预期的伪路径"))
    }
}

impl Default for CursorAdapter {
    fn default() -> Self {
        Self::new()
    }
}

impl ConversationAdapter for CursorAdapter {
    fn id(&self) -> &str {
        "cursor"
    }

    fn detect(&self, ctx: &AdapterContext<'_>) -> Vec<DetectionResult> {
        let manual = ctx.settings.cursor_root();
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
                // 探测阶段只验证「能只读打开且是 Cursor 的库」，并数出会话数
                let db_path = root.join(DB_FILE);
                let mut found = true;
                let mut hint = 0usize;
                match Self::open_readonly(&db_path) {
                    Ok(conn) => {
                        if !Self::has_composer_table(&conn) {
                            found = false;
                            notes.push("state.vscdb 中没有 composerHeaders 表，可能不是 Cursor 数据".to_string());
                        } else {
                            hint = conn
                                .query_row(
                                    "SELECT COUNT(*) FROM composerHeaders WHERE isArchived = 0 AND composerId != ?1",
                                    [DRAFT_COMPOSER],
                                    |row| row.get::<_, i64>(0),
                                )
                                .map(|n| n.max(0) as usize)
                                .unwrap_or(0);
                        }
                    }
                    Err(_) => {
                        found = false;
                        notes.push("state.vscdb 只读打开失败（文件可能被占用或已损坏）".to_string());
                    }
                }
                vec![DetectionResult {
                    source: SourceKind::Cursor,
                    found,
                    root: Some(root),
                    session_hint: hint,
                    notes,
                    manual: is_manual,
                }]
            }
            None => vec![DetectionResult::missing(
                SourceKind::Cursor,
                "未找到 Cursor 数据目录（%APPDATA%/Cursor/User/globalStorage，可在设置中指定）",
            )],
        }
    }

    fn scan(&self, ctx: &AdapterContext<'_>) -> Result<Vec<SessionDescriptor>> {
        let Some(root) = Self::find_root(ctx) else {
            return Ok(Vec::new());
        };
        let db_path = root.join(DB_FILE);
        let conn = Self::open_readonly(&db_path)?;
        if !Self::has_composer_table(&conn) {
            return Ok(Vec::new());
        }

        let mut stmt = conn.prepare(
            "SELECT composerId, workspaceId, createdAt, lastUpdatedAt, isSubagent, value \
             FROM composerHeaders WHERE isArchived = 0 AND composerId != ?1",
        )?;
        let rows = stmt.query_map([DRAFT_COMPOSER], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, Option<i64>>(2)?,
                row.get::<_, Option<i64>>(3)?,
                row.get::<_, Option<i64>>(4)?,
                row.get::<_, Option<String>>(5)?,
            ))
        })?;

        let mut out = Vec::new();
        for row in rows {
            let (composer_id, _workspace_id, created_at, last_updated, _is_subagent, value) = row?;
            if composer_id.trim().is_empty() {
                continue;
            }
            // 标题来自 value JSON 的 name 字段（扫描阶段只读这一行的头信息，不读消息体）
            let title_hint = value
                .as_deref()
                .and_then(|v| serde_json::from_str::<Value>(v).ok())
                .and_then(|v| get_str(&v, "name").map(|s| s.to_string()))
                .filter(|s| !s.trim().is_empty());
            out.push(SessionDescriptor {
                source: SourceKind::Cursor,
                external_id: composer_id.clone(),
                primary_file: Self::pseudo_path(&db_path, &composer_id),
                session_dir: root.clone(),
                title_hint,
                // workspaceId 到实际项目路径的映射需要再查 workspaceStorage 目录，
                // 且多个 composer 常共享同一 workspace，留 None 由 UI 显示「未知项目」
                project_path: None,
                machine_id: Some(ctx.machine_id.to_string()),
                files: Vec::new(), // db 行不是文件，没有可复制快照
                // 实测存在 lastUpdatedAt 为 NULL 的 composer（会退回按文件哈希，
                // 对伪路径必然失败），因此永远给 revision：lastUpdatedAt → createdAt → "0"
                content_revision: Some(
                    last_updated
                        .or(created_at)
                        .unwrap_or(0)
                        .to_string(),
                ),
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
        let db_path = Self::real_db_path(descriptor)?;
        let conn = Self::open_readonly(&db_path)?;
        let mut info = ParsedSessionInfo::new();

        let mut stmt = conn.prepare(
            "SELECT key, value FROM cursorDiskKV WHERE key LIKE ?1 ESCAPE '\\'",
        )?;
        // composerId 来自库里自己的主键，但仍按 LIKE 元字符转义后走参数绑定
        let pattern = format!(
            "bubbleId:{}:%",
            descriptor.external_id.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")
        );
        let rows = stmt.query_map([pattern], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, rusqlite::types::Value>(1)?,
            ))
        })?;

        let mut bubbles: Vec<(String, Value)> = Vec::new();
        let mut bad_rows = 0u64;
        for row in rows {
            let (key, raw) = row?;
            let text = match raw {
                rusqlite::types::Value::Text(s) => s,
                rusqlite::types::Value::Blob(b) => String::from_utf8_lossy(&b).into_owned(),
                _ => {
                    bad_rows += 1;
                    continue;
                }
            };
            match serde_json::from_str::<Value>(&text) {
                Ok(v) => bubbles.push((key, v)),
                Err(_) => bad_rows += 1,
            }
        }
        if bad_rows > 0 {
            info.warn(format!("{bad_rows} 条 bubble 无法解析，已跳过"));
        }

        // 顺序依据：实测 key 字典序与 createdAt 错位，必须以 bubble 内时间戳为准
        bubbles.sort_by(|(ka, va), (kb, vb)| {
            let ta = get_str(va, "createdAt");
            let tb = get_str(vb, "createdAt");
            // 缺失 createdAt 的排在最前（稳定排序保持 key 序）
            (ta.is_none(), ta.unwrap_or(""), ka).cmp(&(tb.is_none(), tb.unwrap_or(""), kb))
        });

        let session_id = descriptor.session_id();
        let mut parser = BubbleParser::new(sink, &session_id);
        for (_, bubble) in &bubbles {
            parser.handle_bubble(bubble, &mut info)?;
        }

        info.message_count = parser.message_count;
        // 会话级时间：bubble 时间戳优先，其次 composerHeaders 的毫秒时间戳（revision）
        info.created_at = parser.first_timestamp.clone().or_else(|| {
            descriptor
                .content_revision
                .as_deref()
                .and_then(|s| s.parse::<i64>().ok())
                .and_then(epoch_ms_to_rfc3339)
        });
        info.updated_at = parser.last_timestamp.clone().or_else(|| {
            descriptor
                .content_revision
                .as_deref()
                .and_then(|s| s.parse::<i64>().ok())
                .and_then(epoch_ms_to_rfc3339)
        });
        // 标题：composerHeaders.value.name（title_hint）优先，其次首条用户消息
        info.title = descriptor.title_hint.clone().or_else(|| {
            parser
                .first_user_text
                .as_deref()
                .and_then(crate::adapters::derive_title)
        });

        let mut meta = serde_json::Map::new();
        meta.insert("format".into(), Value::String("cursor/state.vscdb".into()));
        meta.insert(
            "bubbleCount".into(),
            Value::Number((bubbles.len() as i64).into()),
        );
        info.metadata = cap_metadata(Value::Object(meta));
        Ok(info)
    }
}

/// bubble 解析器：把一条 bubble JSON 映射成 0..N 条归一化消息。
struct BubbleParser<'a> {
    sink: &'a mut dyn MessageSink,
    session_id: String,
    sequence: u64,
    message_count: u64,
    dup: DupFilter,
    first_user_text: Option<String>,
    first_timestamp: Option<String>,
    last_timestamp: Option<String>,
}

impl<'a> BubbleParser<'a> {
    fn new(sink: &'a mut dyn MessageSink, session_id: &str) -> Self {
        BubbleParser {
            sink,
            session_id: session_id.to_string(),
            sequence: 0,
            message_count: 0,
            dup: DupFilter::default(),
            first_user_text: None,
            first_timestamp: None,
            last_timestamp: None,
        }
    }

    /// 处理一条 bubble（`type` 1 = 用户，2 = 助手；其余记未知）。
    fn handle_bubble(&mut self, bubble: &Value, info: &mut ParsedSessionInfo) -> Result<()> {
        let time = get_str(bubble, "createdAt").and_then(normalize_timestamp);
        if let Some(ts) = &time {
            if self.first_timestamp.is_none() {
                self.first_timestamp = Some(ts.clone());
            }
            self.last_timestamp = Some(ts.clone());
        }
        let time = time.as_deref();

        // type 是数字（1 / 2），宽松解析兼容字符串写法
        let bubble_type = bubble
            .get("type")
            .and_then(|v| v.as_i64().or_else(|| v.as_str()?.parse::<i64>().ok()));
        match bubble_type {
            Some(1) => self.on_user(bubble, time),
            Some(2) => self.on_assistant(bubble, time),
            other => {
                // 未知 type：保留为事件 + cap_raw 片段，绝不静默丢弃
                let label = other.map(|n| n.to_string()).unwrap_or_else(|| "<缺失>".into());
                info.note_unknown(&format!("bubbleType:{label}"));
                let text = get_str(bubble, "text")
                    .map(|s| s.to_string())
                    .filter(|s| !s.trim().is_empty())
                    .unwrap_or_else(|| format!("[未识别 bubble 类型] {label}"));
                self.emit(
                    Role::Unknown,
                    MessageKind::Event,
                    Some(cap_text(text)),
                    None,
                    crate::adapters::cap_raw(bubble),
                    time,
                )
            }
        }
    }

    /// 用户气泡：正文即 `text`。
    fn on_user(&mut self, bubble: &Value, time: Option<&str>) -> Result<()> {
        let text = get_str(bubble, "text").unwrap_or("").trim();
        if text.is_empty() {
            return Ok(());
        }
        if self.first_user_text.is_none() && !crate::adapters::looks_system_injected(text) {
            self.first_user_text = Some(text.to_string());
        }
        self.emit(
            Role::User,
            MessageKind::Message,
            Some(cap_text(text.to_string())),
            None,
            None,
            time,
        )
    }

    /// 助手气泡：思考 + 正文 + 工具调用与结果（一条 bubble 可产出多条消息）。
    fn on_assistant(&mut self, bubble: &Value, time: Option<&str>) -> Result<()> {
        // 思考内容先行（时序上思考先于正文输出）
        if let Some(thinking) = bubble.get("thinking") {
            let text = get_str(thinking, "text").unwrap_or("").trim();
            if !text.is_empty() {
                self.emit(
                    Role::Assistant,
                    MessageKind::ReasoningSummary,
                    Some(cap_text(text.to_string())),
                    None,
                    None,
                    time,
                )?;
            }
        }
        let text = get_str(bubble, "text").unwrap_or("").trim();
        if !text.is_empty() {
            self.emit(
                Role::Assistant,
                MessageKind::Message,
                Some(cap_text(text.to_string())),
                None,
                None,
                time,
            )?;
        }
        // 工具调用：toolFormerData = {name, params(JSON 字符串), rawArgs, result, ...}
        if let Some(tool) = bubble.get("toolFormerData") {
            let name = get_str(tool, "name").unwrap_or("tool").to_string();
            let args = get_str(tool, "params")
                .or_else(|| get_str(tool, "rawArgs"))
                .unwrap_or("")
                .trim();
            if !args.is_empty() {
                self.emit(
                    Role::Assistant,
                    MessageKind::ToolCall,
                    Some(cap_text(args.to_string())),
                    Some(name.clone()),
                    None,
                    time,
                )?;
            }
            let result = get_str(tool, "result").unwrap_or("").trim();
            if !result.is_empty() {
                self.emit(
                    Role::Tool,
                    MessageKind::ToolResult,
                    Some(cap_text(result.to_string())),
                    Some(name),
                    None,
                    time,
                )?;
            }
        }
        Ok(())
    }

    /// 统一产出：分配序号、相邻去重（正文类）、写入 sink。
    fn emit(
        &mut self,
        role: Role,
        kind: MessageKind,
        text: Option<String>,
        tool_name: Option<String>,
        raw: Option<Value>,
        timestamp: Option<&str>,
    ) -> Result<()> {
        if kind == MessageKind::Message {
            if let Some(t) = text.as_deref() {
                if self.dup.is_duplicate(role, t) {
                    return Ok(());
                }
            }
        }
        let seq = self.sequence;
        self.sequence += 1;
        self.sink.emit(NormalizedMessage {
            id: message_id(&self.session_id, seq),
            role,
            kind,
            timestamp: timestamp
                .map(|s| s.to_string())
                .or_else(|| self.last_timestamp.clone()),
            text,
            tool_name,
            raw,
        })?;
        self.message_count += 1;
        Ok(())
    }
}
