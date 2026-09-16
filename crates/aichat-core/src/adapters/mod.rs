//! Adapter 层（规格 §4.2）：把不同 AI 工具的原生文件结构，翻译成统一的 [`NormalizedSession`]。
//!
//! 设计要点：
//! - UI / 索引层只依赖本模块的 trait 与模型，**绝不**直接读 Codex / Kimi 的文件；
//! - 扫描（`scan`）只收集路径与轻量元信息，解析（`parse_streaming`）才读正文；
//! - 超大会话走流式解析：边解析边通过 [`MessageSink`] 写入数据库，不整体驻留内存。

pub mod codex;
pub mod kimi;
pub mod repo;

use std::collections::HashSet;

use crate::error::Result;
use crate::model::{
    DetectionResult, NormalizedMessage, NormalizedSession, ParsedSessionInfo, Role,
    SessionDescriptor, SourceKind,
};
use crate::settings::AppSettings;

pub use codex::CodexAdapter;
pub use kimi::KimiAdapter;
pub use repo::SyncRepoAdapter;

/// 单条消息文本上限（索引与 IPC 用）。
///
/// 原始文件（以及可选保留的 `raw/` 快照）才是完整数据源；索引里对超长工具输出做截断，
/// 既避免 SQLite / 前端被单个巨型工具结果拖慢，也不丢原始数据。
pub const MAX_TEXT_BYTES: usize = 256 * 1024;

/// 会话级元数据上限（序列化后字符数），防止异常 schema 撑爆 DB 行。
pub const MAX_METADATA_CHARS: usize = 32 * 1024;

/// 未识别事件的 `raw` 片段上限。
///
/// 规格要求「未知事件保留 raw，不静默丢弃」；但原始文件与快照 `raw/` 才是完整数据源，
/// 索引里只保留可定位的片段即可 —— 实测把工具事件与调用参数的 raw 去掉后，
/// 索引体积从 436MB 降到约 290MB（同机 327 个真实会话）。
pub const MAX_RAW_BYTES: usize = 2048;

/// 生成受体积限制的 raw 片段（超限时保留预览并标记截断）。
pub fn cap_raw(value: &serde_json::Value) -> Option<serde_json::Value> {
    let text = value.to_string();
    if text.len() <= MAX_RAW_BYTES {
        return Some(value.clone());
    }
    let mut end = MAX_RAW_BYTES;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    Some(serde_json::json!({
        "_truncated": true,
        "_originalBytes": text.len(),
        "preview": &text[..end],
    }))
}

/// 适配器上下文：设置 + 本机标识。
#[derive(Clone, Copy)]
pub struct AdapterContext<'a> {
    pub settings: &'a AppSettings,
    /// 本机 machine id（写入快照时使用）
    pub machine_id: &'a str,
}

/// 消息接收器：由存储层实现，边解析边入库。
pub trait MessageSink {
    /// 接收一条归一化消息（实现方负责批量提交与序号分配）。
    fn emit(&mut self, message: NormalizedMessage) -> Result<()>;
}

/// 收集到内存的 sink（测试与 [`ConversationAdapter::parse`] 默认实现使用）。
#[derive(Default)]
pub struct VecSink {
    pub messages: Vec<NormalizedMessage>,
}

impl MessageSink for VecSink {
    fn emit(&mut self, message: NormalizedMessage) -> Result<()> {
        self.messages.push(message);
        Ok(())
    }
}

/// 会话适配器：每种数据源一个实现。
pub trait ConversationAdapter: Send + Sync {
    /// 适配器标识（日志与设置页使用）。
    fn id(&self) -> &'static str;

    /// 探测数据源。返回多条结果用于「一个适配器覆盖多种来源」（如同步仓库适配器）。
    fn detect(&self, ctx: &AdapterContext<'_>) -> Vec<DetectionResult>;

    /// 扫描会话列表：**不解析正文**，只做目录遍历与轻量元信息提取。
    fn scan(&self, ctx: &AdapterContext<'_>) -> Result<Vec<SessionDescriptor>>;

    /// 流式解析：逐条产出消息给 sink，返回会话级信息与统计。
    fn parse_streaming(
        &self,
        ctx: &AdapterContext<'_>,
        descriptor: &SessionDescriptor,
        sink: &mut dyn MessageSink,
    ) -> Result<ParsedSessionInfo>;

    /// 归一化整份会话（规格 §4.2 约定的签名）。
    ///
    /// 默认基于 [`Self::parse_streaming`] 收集消息；大会话应直接使用流式接口。
    fn parse(
        &self,
        ctx: &AdapterContext<'_>,
        descriptor: &SessionDescriptor,
    ) -> Result<NormalizedSession> {
        let mut sink = VecSink::default();
        let info = self.parse_streaming(ctx, descriptor, &mut sink)?;
        Ok(NormalizedSession {
            id: descriptor.session_id(),
            source: descriptor.source,
            external_id: descriptor.external_id.clone(),
            title: info.title.clone().or_else(|| descriptor.title_hint.clone()),
            project_path: info
                .project_path
                .clone()
                .or_else(|| descriptor.project_path.clone()),
            created_at: info.created_at.clone(),
            updated_at: info.updated_at.clone(),
            model: info.model.clone(),
            messages: sink.messages,
            raw_files: descriptor.files.clone(),
            metadata: info.metadata,
            partial: info.partial,
        })
    }

    /// 是否为「同步仓库」适配器（其会话属于跨机器数据，不参与本机推送）。
    fn is_remote(&self) -> bool {
        false
    }

    /// 该适配器当前是否可用（探测成功后为 true）。
    fn available(&self) -> bool {
        true
    }
}

/// 全部内置适配器（顺序即 UI 展示顺序）。
///
/// `repo_root` 为 Some 时追加同步仓库适配器，用于索引其他机器拉取下来的会话。
pub fn default_adapters(repo_root: Option<String>) -> Vec<Box<dyn ConversationAdapter>> {
    let mut list: Vec<Box<dyn ConversationAdapter>> =
        vec![Box::new(CodexAdapter::new()), Box::new(KimiAdapter::new())];
    if let Some(root) = repo_root {
        if !root.trim().is_empty() {
            list.push(Box::new(SyncRepoAdapter::new(root)));
        }
    }
    list
}

/// 相邻重复消息抑制器。
///
/// Codex（`response_item` 与 `event_msg` 双写）与 Kimi（`turn.prompt` 与 `prompt.accepted`）
/// 都会把同一条文本记录两次。归一化后必须去重，否则 UI 出现重复气泡。
pub struct DupFilter {
    recent: Vec<(Role, usize, u64)>,
    seen_hashes: HashSet<u64>,
}

impl Default for DupFilter {
    fn default() -> Self {
        DupFilter {
            recent: Vec::with_capacity(12),
            seen_hashes: HashSet::with_capacity(16),
        }
    }
}

impl DupFilter {
    /// 新建（可指定窗口大小，默认 8 条）。
    pub fn new(window: usize) -> Self {
        let mut f = DupFilter::default();
        f.recent.reserve(window);
        f
    }

    /// 是否与最近消息重复；重复时返回 true（调用方应跳过该消息）。
    ///
    /// 判据：角色相同、文本长度相同、文本哈希相同。哈希对文本前 4KB 与总长度取样，
    /// 既避免为超大工具输出做全量哈希，又能稳定识别重复。
    pub fn is_duplicate(&mut self, role: Role, text: &str) -> bool {
        if text.is_empty() {
            return false;
        }
        let hash = text_sample_hash(text);
        let len = text.len();
        let dup = self
            .recent
            .iter()
            .any(|(r, l, h)| *r == role && *l == len && *h == hash);
        if !dup {
            const WINDOW: usize = 8;
            if self.recent.len() >= WINDOW {
                let dropped = self.recent.remove(0);
                self.seen_hashes.remove(&dropped.2);
            }
            self.recent.push((role, len, hash));
            self.seen_hashes.insert(hash);
        }
        dup
    }
}

/// 文本取样哈希：前 4KB + 总长度，避免对超大文本做全量哈希。
fn text_sample_hash(text: &str) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    let sample_len = text.len().min(4096);
    // 按字节边界截取样本文本，保证不会切坏 UTF-8
    let mut end = sample_len;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    text[..end].hash(&mut hasher);
    text.len().hash(&mut hasher);
    hasher.finish()
}

/// 文本截断到 [`MAX_TEXT_BYTES`]，超出部分提示「已截断」，原文仍在原始文件 / raw 快照中。
pub fn cap_text(text: String) -> String {
    if text.len() <= MAX_TEXT_BYTES {
        return text;
    }
    let mut end = MAX_TEXT_BYTES;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    let mut out = text[..end].to_string();
    out.push_str("\n\n…（内容过长，索引已截断；完整内容见原始会话文件）");
    out
}

/// 元数据体积保护：超限时替换为占位说明，避免 DB 行异常膨胀。
pub fn cap_metadata(mut value: serde_json::Value) -> serde_json::Value {
    let serialized = value.to_string();
    if serialized.len() <= MAX_METADATA_CHARS {
        return value;
    }
    if let Some(obj) = value.as_object_mut() {
        obj.insert(
            "_truncated".to_string(),
            serde_json::Value::String(format!(
                "元数据过大（{} 字符），已省略细节",
                serialized.len()
            )),
        );
        // 只保留小字段
        obj.retain(|_, v| v.to_string().len() < 512);
    }
    value
}

/// 判断用户消息是否其实是「系统注入内容」。
///
/// Codex 会把 AGENTS.md、权限说明、环境信息等以 user 角色的消息写进会话，
/// 直接用它们做标题会得到 `<environment_context>...` / `# AGENTS.md instructions...`
/// 这类无意义标题，因此派生标题时跳过。
pub fn looks_system_injected(text: &str) -> bool {
    let trimmed = text.trim_start();
    if trimmed.is_empty() {
        return true;
    }
    // 结构化注入：XML 标签、Markdown 标题、JSON、代码块
    if trimmed.starts_with('<')
        || trimmed.starts_with('#')
        || trimmed.starts_with('{')
        || trimmed.starts_with('[')
        || trimmed.starts_with("```")
    {
        return true;
    }
    const MARKERS: &[&str] = &[
        "AGENTS.md instructions",
        "permissions instructions",
        "environment_context",
        "recommended_plugins",
        "The following is the Codex agent history",
        "Message Type:",
        "You are running inside the Codex",
    ];
    MARKERS.iter().any(|marker| trimmed.starts_with(marker))
}

/// 由首条用户消息派生标题（Codex 等没有标题字段的数据源使用）。
///
/// 跳过系统注入内容；全部候选都不合适时返回 `None`（UI 显示「无标题」，好过假标题）。
pub fn derive_title(text: &str) -> Option<String> {
    let cleaned = text.trim();
    if cleaned.is_empty() || looks_system_injected(cleaned) {
        return None;
    }
    Some(NormalizedMessage::truncate_text(cleaned, 72))
}

/// 从消息流中构造标题（第一条有内容的用户消息）。
pub fn title_from_messages(messages: &[NormalizedMessage]) -> Option<String> {
    messages
        .iter()
        .filter(|m| m.role == Role::User && m.kind == crate::model::MessageKind::Message)
        .filter_map(|m| m.text.as_deref())
        .find_map(derive_title)
}

/// 生成消息 id：`<session_id>#<序号>`，全局唯一且稳定（重解析结果一致）。
pub fn message_id(session_id: &str, sequence: u64) -> String {
    format!("{session_id}#{sequence}")
}

/// 数据源根目录是否可用（存在且不是隐私红线目录）。
pub fn usable_root(path: &std::path::Path) -> bool {
    crate::paths::is_dir(path) && !crate::paths::is_forbidden_path(path)
}

/// 统计目录下满足条件的直接子目录数量（用于探测阶段的 session_hint）。
pub fn count_child_dirs(
    path: &std::path::Path,
    predicate: &dyn Fn(&std::path::Path) -> bool,
) -> usize {
    if !crate::paths::is_dir(path) {
        return 0;
    }
    let mut count = 0;
    if let Ok(entries) = std::fs::read_dir(path) {
        for entry in entries.flatten() {
            if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            let child = entry.path();
            if crate::paths::is_forbidden_path(&child) {
                continue;
            }
            if predicate(&child) {
                count += 1;
            }
        }
    }
    count
}

/// 数据源标识列表（日志用）。
pub fn source_ids() -> Vec<&'static str> {
    SourceKind::ALL.iter().map(|s| s.as_str()).collect()
}
