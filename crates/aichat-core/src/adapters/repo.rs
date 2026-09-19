//! 同步仓库适配器：把「其他机器拉取下来的会话快照」当成第三种数据源（规格 §13 步骤 8）。
//!
//! 扫描 `Sync Repo` 中的规范化快照，使 PC-B 拉取后即可看到 PC-A 的历史会话：
//!
//! ```text
//! <repo>/<source>/<machine-id>/<session-id>/
//! ├── meta.json           # 会话元信息（schemaVersion / 机器 / 项目 / 时间）
//! ├── conversation.jsonl   # 归一化消息流（一行一条消息）
//! └── raw/                 # 可选：原始文件副本（Keep Raw Session Files）
//! ```
//!
//! 隐私：`raw/` 复制时已过滤凭证类文件；此处只读取 `meta.json` 与 `conversation.jsonl`。
//! 读取兼容 schema v1 与 v2：v2 行的 `textRef` 会从 `.aichat/blobs/` 还原文本。

use std::path::{Path, PathBuf};

use serde_json::Value;
use walkdir::WalkDir;

use crate::adapters::{
    cap_metadata, message_id, usable_root, AdapterContext, ConversationAdapter, DupFilter,
    MessageSink,
};
use crate::error::Result;
use crate::model::{
    DetectionResult, MessageKind, NormalizedMessage, ParsedSessionInfo, RawFileRef, Role,
    SessionDescriptor, SessionMetaFile, SourceKind,
};
use crate::parser::jsonl::{stream_jsonl, ParseLimits};
use crate::paths;

/// 快照内固定文件名。
const META_FILE: &str = "meta.json";
const CONVERSATION_FILE: &str = "conversation.jsonl";
/// `raw/` 目录下登记的原始文件上限（避免历史归档把索引撑大）。
const MAX_RAW_REFS: usize = 128;

/// 同步仓库适配器。
pub struct SyncRepoAdapter {
    root: PathBuf,
}

impl SyncRepoAdapter {
    /// 使用仓库根目录构造。
    pub fn new(root: impl Into<String>) -> Self {
        SyncRepoAdapter {
            root: paths::expand_home(&root.into()),
        }
    }

    /// 仓库根目录。
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// 该数据源的会话目录。
    fn source_dir(&self, source: &SourceKind) -> PathBuf {
        self.root.join(source.as_str())
    }
}

impl ConversationAdapter for SyncRepoAdapter {
    fn id(&self) -> &'static str {
        "sync-repo"
    }

    fn detect(&self, _ctx: &AdapterContext<'_>) -> Vec<DetectionResult> {
        if !usable_root(&self.root) {
            return Vec::new();
        }
        let mut out = Vec::new();
        for source in paths::sub_dirs(&self.root).iter().filter_map(|p| p.file_name().and_then(|s| s.to_str()).and_then(SourceKind::parse)) {
            let dir = self.source_dir(&source);
            if !paths::is_dir(&dir) {
                continue;
            }
            let machines = paths::sub_dirs(&dir).len();
            let hint: usize = paths::sub_dirs(&dir)
                .iter()
                .map(|m| paths::sub_dirs(m).len())
                .sum();
            out.push(DetectionResult {
                source: source.clone(),
                found: true,
                root: Some(dir),
                session_hint: hint,
                notes: vec![format!(
                    "同步仓库：{machines} 台机器的 {} 会话",
                    source.display_name()
                )],
                manual: true,
            });
        }
        out
    }

    fn scan(&self, _ctx: &AdapterContext<'_>) -> Result<Vec<SessionDescriptor>> {
        if !usable_root(&self.root) {
            return Ok(Vec::new());
        }
        let mut out = Vec::new();
        for source in paths::sub_dirs(&self.root).iter().filter_map(|p| p.file_name().and_then(|s| s.to_str()).and_then(SourceKind::parse)) {
            let source_dir = self.source_dir(&source);
            for machine_dir in paths::sub_dirs(&source_dir) {
                let machine_id = match machine_dir.file_name() {
                    Some(n) => n.to_string_lossy().to_string(),
                    None => continue,
                };
                for session_dir in paths::sub_dirs(&machine_dir) {
                    let conversation = session_dir.join(CONVERSATION_FILE);
                    if !conversation.is_file() {
                        continue;
                    }
                    let external_id = match session_dir.file_name() {
                        Some(n) => n.to_string_lossy().to_string(),
                        None => continue,
                    };
                    let mut files = vec![raw_ref("conversation", &conversation)];
                    let meta_path = session_dir.join(META_FILE);
                    if meta_path.is_file() {
                        files.push(raw_ref("meta", &meta_path));
                    }
                    out.push(SessionDescriptor {
                        source: source.clone(),
                        external_id,
                        primary_file: conversation,
                        session_dir,
                        // 标题 / 项目路径在解析阶段从 meta.json 读取（扫描阶段不读文件内容）
                        title_hint: None,
                        project_path: None,
                        machine_id: Some(machine_id.clone()),
                        files,
                        content_revision: None,
                    });
                }
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
        let mut meta_metadata = serde_json::Map::new();

        // ---- meta.json：权威的会话级信息 ----
        let meta_path = descriptor.session_dir.join(META_FILE);
        if meta_path.is_file() {
            match std::fs::read_to_string(&meta_path)
                .ok()
                .and_then(|raw| serde_json::from_str::<SessionMetaFile>(&raw).ok())
            {
                Some(meta) => {
                    info.title = meta.title.clone();
                    info.project_path = meta.project_path.clone();
                    info.created_at = meta.created_at.clone();
                    info.updated_at = meta.updated_at.clone();
                    info.model = meta.model.clone();
                    info.partial = meta.partial;
                    meta_metadata.insert(
                        "schemaVersion".into(),
                        Value::Number(meta.schema_version.into()),
                    );
                    meta_metadata
                        .insert("machineId".into(), Value::String(meta.machine_id.clone()));
                    meta_metadata.insert(
                        "contentHash".into(),
                        Value::String(meta.content_hash.clone()),
                    );
                    meta_metadata.insert("hasRaw".into(), Value::Bool(meta.has_raw));
                    meta_metadata.insert(
                        "messageCount".into(),
                        Value::Number(meta.message_count.into()),
                    );
                    if let Some(root) = &meta.source_root {
                        meta_metadata.insert("sourceRoot".into(), Value::String(root.clone()));
                    }
                    if let Some(extra) = meta.metadata.as_object() {
                        for (k, v) in extra {
                            if v.to_string().len() < 2048 {
                                meta_metadata.insert(k.clone(), v.clone());
                            }
                        }
                    }
                }
                None => info.warn("meta.json 缺失或无法解析，按快照内容尽力还原"),
            }
        }

        // ---- conversation.jsonl：逐行流式写入 sink ----
        let mut dup = DupFilter::default();
        let mut sequence: u64 = 0;
        let (report, warnings) =
            stream_jsonl(&descriptor.primary_file, &ParseLimits::default(), |value| {
                let role = Role::parse(
                    value
                        .get("role")
                        .and_then(|v| v.as_str())
                        .unwrap_or("unknown"),
                );
                let kind = MessageKind::parse(
                    value
                        .get("kind")
                        .and_then(|v| v.as_str())
                        .unwrap_or("event"),
                );
                // textRef（schema v2）先于 DupFilter 还原，重复判定基于还原后的文本
                let text = match value.get("text").and_then(|v| v.as_str()) {
                    Some(t) => Some(t.to_string()),
                    None => value
                        .get("textRef")
                        .and_then(|v| v.as_str())
                        .map(|reference| resolve_blob_text(&self.root, reference, &mut info)),
                };
                if let Some(t) = text.as_deref() {
                    if kind == MessageKind::Message && dup.is_duplicate(role, t) {
                        return Ok(crate::parser::jsonl::Flow::Continue);
                    }
                }
                let message = NormalizedMessage {
                    id: message_id(&session_id, sequence),
                    role,
                    kind,
                    timestamp: value
                        .get("timestamp")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string()),
                    text,
                    tool_name: value
                        .get("toolName")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string()),
                    raw: None,
                };
                sequence += 1;
                sink.emit(message)?;
                Ok(crate::parser::jsonl::Flow::Continue)
            })?;

        info.message_count = report.parsed;
        info.partial |= report.bad > 0;
        for w in warnings {
            info.warn(w);
        }
        // 快照没有时间戳时退回文件 mtime，保证列表排序稳定
        if info.updated_at.is_none() {
            info.updated_at = std::fs::metadata(&descriptor.primary_file)
                .ok()
                .and_then(|m| m.modified().ok())
                .map(|t| chrono::DateTime::<chrono::Utc>::from(t).to_rfc3339());
        }
        meta_metadata.insert("format".into(), Value::String("repo/snapshot".into()));
        info.metadata = cap_metadata(Value::Object(meta_metadata));
        Ok(info)
    }

    fn is_remote(&self) -> bool {
        true
    }
}

/// 解析 `textRef`（形如 `blake3:<hex>`）：从 `.aichat/blobs/` 读回文本。
/// 读取失败或文件缺失时记警告并返回占位文本，保证其余消息不受影响。
fn resolve_blob_text(root: &Path, reference: &str, info: &mut ParsedSessionInfo) -> String {
    let hash = reference.strip_prefix("blake3:").unwrap_or(reference);
    let short = &hash[..hash.len().min(12)];
    if reference.strip_prefix("blake3:").is_some() {
        let path = crate::sync::snapshot::blob_path(root, hash);
        match std::fs::read_to_string(&path) {
            Ok(text) => return text,
            Err(err) => info.warn(format!("blob 读取失败（{short}）：{err}")),
        }
    } else {
        info.warn(format!("未知 textRef 格式：{reference}"));
    }
    format!("[快照内容缺失:blob {short}]")
}

/// 列出快照 `raw/` 下的原始文件引用。
pub fn list_raw_files(session_dir: &Path) -> Vec<RawFileRef> {
    let raw_dir = session_dir.join("raw");
    if !paths::is_dir(&raw_dir) {
        return Vec::new();
    }
    let mut out = Vec::new();
    for entry in WalkDir::new(&raw_dir)
        .max_depth(4)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        if out.len() >= MAX_RAW_REFS {
            break;
        }
        if !entry.file_type().is_file() || paths::is_forbidden_path(entry.path()) {
            continue;
        }
        let rel = paths::relative_posix(&raw_dir, entry.path()).unwrap_or_default();
        out.push(RawFileRef {
            role: format!("raw/{rel}"),
            path: entry.path().to_path_buf(),
            size: entry.metadata().map(|m| m.len()).unwrap_or(0),
        });
    }
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
