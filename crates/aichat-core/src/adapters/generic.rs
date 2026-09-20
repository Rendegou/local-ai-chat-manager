//! 用户自定义数据源：按一份字段映射读取任意 JSONL / JSON 目录。
//!
//! 这是「满足所有人」的答案里最实在的一块。给每个 AI 编程工具写一个 Rust 适配器
//! 追不上生态——新工具出现的速度远快于写 parser 的速度。而这类工具几乎都把历史
//! 写成 `~/.xxx/` 下的 JSONL 或 JSON，所以真正需要的不是更多适配器，而是一个
//! **不需要写代码** 的通用读取器 + 一份可验证的字段映射。
//!
//! 三条设计约定：
//!
//! 1. **映射写错不能静默成功**。一条消息都读不出来时返回明确错误，而不是建一个空会话——
//!    否则用户会以为接上了，扫描完才发现什么都没有。
//! 2. **认不出的角色不丢**。保留为 `unknown` + `event`（`note_unknown` 置 partial、
//!    保留 raw），沿用项目既有约定；配合 `role_map` 让用户自己补，而不是我们猜。
//! 3. **与内置来源共用增量机制**。`content_revision` 留空 → 走 size+mtime+hash 指纹，
//!    文件变了才重解析，不为自定义来源发明第二套逻辑。

use std::path::{Path, PathBuf};

use serde_json::Value;

use super::{cap_raw, AdapterContext, ConversationAdapter, MessageSink};
use crate::model::{
    DetectionResult, MessageKind, ParsedSessionInfo, RawFileRef, Role, SessionDescriptor, SourceKind,
};
use crate::parser::jsonl::{stream_jsonl, Flow, ParseLimits};
use crate::localized::{LocalizedText, SourceNote};
use crate::settings::FieldMapping;
use crate::{paths, Error, Result};

/// 一次「试解析」最多采样几个会话。
const PREVIEW_SESSIONS: usize = 3;
/// 试解析里每个会话最多展示几条消息。
const PREVIEW_MESSAGES: usize = 6;
/// 试解析里单条消息文本的截断长度（只为展示，不进索引）。
const PREVIEW_TEXT_CHARS: usize = 400;

/// 通用 JSONL / JSON 适配器：一个用户自定义来源对应一个实例。
pub struct GenericJsonAdapter {
    /// 用 `SourceKind` 而不是 String：会话主键、`sessions.source` 都从这里来
    source: SourceKind,
    display_name: String,
    root: PathBuf,
    mapping: FieldMapping,
}

impl GenericJsonAdapter {
    /// `id` 必须是合法来源标识（`settings.validate()` 已保证）。
    pub fn new(
        id: &str,
        display_name: impl Into<String>,
        root: PathBuf,
        mapping: FieldMapping,
    ) -> Result<Self> {
        let source = SourceKind::parse(id)
            .ok_or_else(|| Error::config(format!("自定义来源标识无效：{id}")))?;
        Ok(GenericJsonAdapter { source, display_name: display_name.into(), root, mapping })
    }

    /// 某个来源 id 在当前设置下的适配器；未配置映射或标识非法时返回 None。
    pub fn from_settings(settings: &crate::settings::AppSettings, id: &str) -> Option<Self> {
        let config = settings.sources.get(id)?;
        let mapping = config.mapping.clone()?;
        let root = settings.source_root(id)?;
        let display = settings.source_display_name(id).unwrap_or(id).to_string();
        Self::new(id, display, root, mapping).ok()
    }

    /// 显示名（探测结果与会话列表用）。
    pub fn display_name(&self) -> &str {
        &self.display_name
    }

    /// 目录里匹配扩展名的文件（有界遍历，跳过隐私目录与符号链接）。
    fn files(&self) -> Vec<PathBuf> {
        let extensions: Vec<String> = self.watch_extensions();
        if !paths::is_dir(&self.root) || extensions.is_empty() {
            return Vec::new();
        }
        walkdir::WalkDir::new(&self.root)
            .follow_links(false)
            .max_depth(self.mapping.max_depth)
            .into_iter()
            .filter_entry(|e| !paths::is_forbidden_path(e.path()) && !e.file_type().is_symlink())
            .filter_map(|e| e.ok())
            .filter(|e| {
                e.file_type().is_file()
                    && e.path()
                        .extension()
                        .and_then(|s| s.to_str())
                        .map(|s| extensions.contains(&s.to_ascii_lowercase()))
                        .unwrap_or(false)
            })
            .map(|e| e.into_path())
            .collect()
    }

    /// 文件 → 会话描述符。
    ///
    /// `external_id` 用文件名；同名文件分布在不同子目录时拼一段相对路径哈希，
    /// 否则两个 `session.json` 会共用同一个会话主键、互相覆盖。
    fn descriptor_for(&self, path: &Path) -> SessionDescriptor {
        let relative = path
            .strip_prefix(&self.root)
            .unwrap_or(path)
            .to_string_lossy()
            .replace('\\', "/");
        let stem = path.file_stem().unwrap_or_default().to_string_lossy().to_string();
        let external_id = if relative.contains('/') {
            format!("{}-{}", stem, &blake3::hash(relative.as_bytes()).to_hex()[..12])
        } else {
            stem
        };
        SessionDescriptor {
            source: self.source.clone(),
            external_id,
            primary_file: path.to_path_buf(),
            session_dir: path.parent().unwrap_or(&self.root).to_path_buf(),
            title_hint: None,
            project_path: None,
            machine_id: Some("local".to_string()),
            files: vec![RawFileRef {
                role: "conversation".to_string(),
                size: path.metadata().map(|m| m.len()).unwrap_or(0),
                path: path.to_path_buf(),
            }],
            // 留空 → 走 size+mtime+hash 指纹：文件变了才重解析
            content_revision: None,
        }
    }

    /// 按 `.` 分隔的路径取值，支持 `data.items` 这类下钻。空路径返回 None。
    fn dig<'a>(value: &'a Value, path: &str) -> Option<&'a Value> {
        let path = path.trim();
        if path.is_empty() {
            return None;
        }
        let mut current = value;
        for segment in path.split('.') {
            if segment.is_empty() {
                return None;
            }
            current = current.get(segment)?;
        }
        Some(current)
    }

    /// 可选字段：留空视为「不配置」。
    fn optional(path: &str) -> Option<&str> {
        let trimmed = path.trim();
        (!trimmed.is_empty()).then_some(trimmed)
    }

    /// 从一条消息里取正文：字符串 / `[{text}]` 块数组 / 嵌套对象都认。
    fn text_of(value: &Value) -> Option<String> {
        match value {
            Value::String(s) => Some(s.clone()),
            Value::Array(items) => {
                let parts: Vec<String> = items
                    .iter()
                    .filter_map(|item| match item {
                        Value::String(s) => Some(s.clone()),
                        Value::Object(_) => {
                            item.get("text").and_then(Value::as_str).map(str::to_string)
                        }
                        _ => None,
                    })
                    .collect();
                (!parts.is_empty()).then(|| parts.join("\n"))
            }
            Value::Object(o) => o
                .get("text")
                .and_then(Value::as_str)
                .map(str::to_string)
                .or_else(|| o.get("content").and_then(Self::text_of)),
            _ => None,
        }
    }

    /// 角色名 → `Role`：先过用户映射，再用宽松解析兜底。
    fn role_of(&self, raw: &str) -> Role {
        let key = raw.trim().to_ascii_lowercase();
        if let Some(mapped) = self.mapping.role_map.get(&key) {
            return Role::parse(mapped);
        }
        Role::parse(&key)
    }

    /// 一条记录 → (原始角色名, 角色, 正文, 时间, 工具名)。
    #[allow(clippy::type_complexity)]
    fn message_of(&self, value: &Value) -> Option<(String, Role, String, Option<String>, Option<String>)> {
        if !value.is_object() {
            return None;
        }
        let raw_role = Self::dig(value, &self.mapping.role_field)
            .and_then(Value::as_str)
            .or_else(|| value.get("role").and_then(Value::as_str))
            .or_else(|| value.get("type").and_then(Value::as_str))?;
        let text = Self::dig(value, &self.mapping.text_field)
            .and_then(Self::text_of)
            .filter(|s| !s.trim().is_empty())?;
        let time = Self::optional(&self.mapping.time_field)
            .and_then(|field| Self::dig(value, field))
            .and_then(Value::as_str)
            .filter(|s| chrono::DateTime::parse_from_rfc3339(s).is_ok())
            .map(str::to_string);
        let role = self.role_of(raw_role);
        let tool = Self::optional(&self.mapping.tool_field)
            .and_then(|field| Self::dig(value, field))
            .and_then(Value::as_str)
            .map(str::to_string)
            .filter(|_| role == Role::Tool);
        Some((raw_role.to_string(), role, text, time, tool))
    }

    /// `json` 布局：读出一个会话文件里的消息数组与会话级根对象。
    fn message_values(&self, file: &Path) -> Result<(Vec<Value>, Option<Value>)> {
        let raw = super::native::read_json(file)?;
        if let Some(rows) = Self::dig(&raw, &self.mapping.messages_path).and_then(Value::as_array) {
            return Ok((rows.clone(), Some(raw)));
        }
        if let Some(rows) = raw.as_array() {
            return Ok((rows.clone(), None));
        }
        Err(Error::parse(format!(
            "在「{}」下找不到数组（若数据是一行一条消息，请把布局改成 jsonl）",
            self.mapping.messages_path
        )))
    }

    /// 从会话级对象里取标题 / 项目路径（字段留空则跳过）。
    fn meta_from(&self, info: &mut ParsedSessionInfo, source: &Value) {
        if info.title.is_none() {
            info.title = Self::optional(&self.mapping.title_field)
                .and_then(|field| Self::dig(source, field))
                .and_then(Value::as_str)
                .filter(|s| !s.trim().is_empty())
                .map(|s| s.chars().take(120).collect());
        }
        if info.project_path.is_none() {
            info.project_path = Self::optional(&self.mapping.project_field)
                .and_then(|field| Self::dig(source, field))
                .and_then(Value::as_str)
                .filter(|s| !s.trim().is_empty())
                .map(str::to_string);
        }
    }

    /// 把一条记录写进 sink。取不出角色或正文时记一笔 `skipped`，不静默吞掉。
    #[allow(clippy::too_many_arguments)]
    fn emit_row(
        &self,
        descriptor: &SessionDescriptor,
        info: &mut ParsedSessionInfo,
        sink: &mut dyn MessageSink,
        value: &Value,
        skipped: &mut usize,
    ) -> Result<()> {
        let Some((raw_role, role, text, time, tool)) = self.message_of(value) else {
            *skipped += 1;
            return Ok(());
        };
        if info.created_at.is_none() {
            info.created_at = time.clone();
        }
        if time.is_some() {
            info.updated_at = time.clone();
        }
        let kind = match role {
            Role::Tool => MessageKind::ToolResult,
            // 角色认不出来也保留内容：事件 + raw，界面上会显示「未识别事件」
            Role::Unknown => MessageKind::Event,
            _ => MessageKind::Message,
        };
        if role == Role::Unknown {
            info.note_unknown(&raw_role);
        }
        if info.title.is_none() && role == Role::User && kind == MessageKind::Message {
            info.title = crate::adapters::derive_title(&text);
        }
        super::native::emit(
            descriptor,
            info,
            sink,
            role,
            kind,
            Some(text),
            tool,
            time,
            if kind == MessageKind::Message { None } else { cap_raw(value) },
        )
    }

    /// 解析一个文件。`parse_streaming` 与 `sample` 共用这一份实现。
    fn parse_file(&self, descriptor: &SessionDescriptor, sink: &mut dyn MessageSink) -> Result<ParsedSessionInfo> {
        let mut info = ParsedSessionInfo::new();
        let mut skipped = 0usize;
        let filename = descriptor
            .primary_file
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();

        if self.mapping.is_jsonl() {
            // 第一条记录常常带会话级元信息（标题、cwd），留一份用于派生标题与项目路径
            let mut first: Option<Value> = None;
            let (report, warnings) =
                stream_jsonl(&descriptor.primary_file, &ParseLimits::default(), |value| {
                    if first.is_none() {
                        first = Some(value.clone());
                    }
                    self.emit_row(descriptor, &mut info, sink, &value, &mut skipped)?;
                    Ok(Flow::Continue)
                })?;
            if let Some(first) = first.as_ref() {
                self.meta_from(&mut info, first);
            }
            if info.message_count == 0 {
                // 一行都取不出角色/正文，几乎一定是字段名填错了
                return Err(Error::parse(format!(
                    "没能从「{filename}」里读出消息（已跳过 {} 条取不到角色或正文的记录）。\
                     请检查「角色字段」与「正文字段」是否和文件里的键名一致",
                    skipped.max(report.bad as usize)
                )));
            }
            for warning in warnings {
                info.warn(warning);
            }
            if report.bad > 0 {
                info.warn(format!("有 {} 行不是合法 JSON，已跳过", report.bad));
            }
        } else {
            let (rows, root) = self.message_values(&descriptor.primary_file)?;
            if let Some(root) = root.as_ref() {
                self.meta_from(&mut info, root);
            }
            for value in rows {
                self.emit_row(descriptor, &mut info, sink, &value, &mut skipped)?;
            }
            if info.message_count == 0 {
                return Err(Error::parse(format!(
                    "在「{filename}」里读到了数组，但没有一条能取出角色与正文。\
                     请检查「角色字段」「正文字段」与「消息数组路径」"
                )));
            }
        }

        if skipped > 0 {
            info.warn(format!(
                "有 {skipped} 条记录没能取出角色或正文，已跳过；若是角色名不认识，可在「角色映射」里补上"
            ));
        }
        if info.created_at.is_none() {
            info.created_at = info.updated_at.clone();
        }
        info.metadata = serde_json::json!({
            "genericSource": true,
            "layout": self.mapping.layout,
            "sourceId": self.source.as_str(),
        });
        Ok(info)
    }

    /// 试解析：采样前几个会话，返回可展示的摘要。
    ///
    /// 参数收 `root` + `mapping`（构造时给），所以用户能在**保存前**反复调映射，
    /// 不必先落盘再改再删。单个文件失败只记 warning，不让整次试解析失败。
    pub fn sample(&self) -> GenericPreview {
        let mut preview = GenericPreview::default();
        let files = self.files();
        preview.files_found = files.len();
        for file in files.iter().take(PREVIEW_SESSIONS) {
            let descriptor = self.descriptor_for(file);
            let mut sink = super::VecSink::default();
            match self.parse_file(&descriptor, &mut sink) {
                Ok(info) => {
                    preview.sessions_sampled += 1;
                    preview.messages += info.message_count as usize;
                    preview.warnings.extend(info.warnings);
                    preview.samples.push(GenericPreviewSample {
                        file: file.display().to_string(),
                        title: info.title,
                        messages: sink
                            .messages
                            .iter()
                            .take(PREVIEW_MESSAGES)
                            .map(|m| GenericPreviewMessage {
                                role: m.role.as_str().to_string(),
                                kind: format!("{:?}", m.kind).to_lowercase(),
                                text: m
                                    .text
                                    .clone()
                                    .unwrap_or_default()
                                    .chars()
                                    .take(PREVIEW_TEXT_CHARS)
                                    .collect(),
                                timestamp: m.timestamp.clone(),
                            })
                            .collect(),
                    });
                }
                Err(error) => preview.warnings.push(format!(
                    "{}：{}",
                    file.file_name().unwrap_or_default().to_string_lossy(),
                    error.user_message()
                )),
            }
        }
        preview
    }
}

impl ConversationAdapter for GenericJsonAdapter {
    fn id(&self) -> &str {
        self.source.as_str()
    }

    /// 目录在不在、能读多少条，交给探测阶段如实报告。
    fn detect(&self, _ctx: &AdapterContext<'_>) -> Vec<DetectionResult> {
        if !paths::is_dir(&self.root) {
            return vec![DetectionResult {
                source: self.source.clone(),
                found: false,
                root: None,
                session_hint: 0,
                notes: vec![SourceNote::error(LocalizedText::with(
                    "source.note.dirMissing",
                    "path",
                    self.root.display().to_string(),
                    format!("目录不存在或不可读：{}", self.root.display()),
                ))],
                manual: true,
            }];
        }
        let hint = self.files().len();
        vec![DetectionResult {
            source: self.source.clone(),
            found: hint > 0,
            root: Some(self.root.clone()),
            session_hint: hint,
            notes: if hint == 0 {
                vec![SourceNote::warn(LocalizedText::with(
                    "source.note.noMatchingFiles",
                    "extensions",
                    self.watch_extensions().join(" / "),
                    format!("目录里没有匹配 {} 的文件", self.watch_extensions().join(" / ")),
                ))]
            } else {
                Vec::new()
            },
            manual: true,
        }]
    }

    fn scan(&self, _ctx: &AdapterContext<'_>) -> Result<Vec<SessionDescriptor>> {
        Ok(self.files().iter().map(|path| self.descriptor_for(path)).collect())
    }

    fn parse_streaming(
        &self,
        _ctx: &AdapterContext<'_>,
        descriptor: &SessionDescriptor,
        sink: &mut dyn MessageSink,
    ) -> Result<ParsedSessionInfo> {
        self.parse_file(descriptor, sink)
    }

    /// 必须覆写：默认实现从静态 catalog 查扩展名，而自定义来源不在 catalog 里，
    /// 会静默退回 json/jsonl —— 用户填了别的扩展名就永远收不到文件变更通知。
    fn watch_extensions(&self) -> Vec<String> {
        self.mapping
            .extensions
            .iter()
            .map(|e| e.trim().trim_start_matches('.').to_ascii_lowercase())
            .filter(|e| !e.is_empty())
            .collect()
    }
}

/// 试解析结果（IPC 返回给设置页的「试试看」面板）。
#[derive(Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GenericPreview {
    pub files_found: usize,
    pub sessions_sampled: usize,
    pub messages: usize,
    pub samples: Vec<GenericPreviewSample>,
    pub warnings: Vec<String>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GenericPreviewSample {
    pub file: String,
    pub title: Option<String>,
    pub messages: Vec<GenericPreviewMessage>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GenericPreviewMessage {
    pub role: String,
    pub kind: String,
    pub text: String,
    pub timestamp: Option<String>,
}
