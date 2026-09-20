//! 持久化与跨设备同步的数据模型（规格 §11、§15、§29）。

use serde::{Deserialize, Serialize};

/// 同步文件 schema 版本：所有写入仓库的文件都必须带版本号（规格 §29）。
///
/// - 1：conversation.jsonl 全部内联文本；
/// - 2：≥ `snapshot::BLOB_THRESHOLD` 的文本外置为 `.aichat/blobs/` 内容寻址 blob，
///   jsonl 行以 `textRef` / `textBytes` 引用（读取端对 1 与 2 均兼容）。
pub const SYNC_SCHEMA_VERSION: u32 = 2;

/// 本地 SQLite 索引 schema 版本，由 `storage::migrations` 使用。
pub const INDEX_SCHEMA_VERSION: u32 = 1;

/// 会话在本地索引中的同步状态。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SyncStatus {
    /// 仅存在于本机，尚未进入同步仓库
    Local,
    /// 已写入同步仓库且内容一致
    Synced,
    /// 本机内容已变化，等待再次提交
    Modified,
    /// 已归档（仓库 `archives/`），本地原始文件仍在
    Archived,
    /// 来源为同步仓库的其他机器
    Remote,
}

impl SyncStatus {
    /// 数据库中的稳定标识。
    pub const fn as_str(self) -> &'static str {
        match self {
            SyncStatus::Local => "local",
            SyncStatus::Synced => "synced",
            SyncStatus::Modified => "modified",
            SyncStatus::Archived => "archived",
            SyncStatus::Remote => "remote",
        }
    }

    /// 从数据库字段解析，未知值退化为 `Local`。
    pub fn parse(s: &str) -> Self {
        match s {
            "synced" => SyncStatus::Synced,
            "modified" => SyncStatus::Modified,
            "archived" => SyncStatus::Archived,
            "remote" => SyncStatus::Remote,
            _ => SyncStatus::Local,
        }
    }
}

/// Git 冲突信息：结构化返回给 UI（规格 §14），绝不自动覆盖任何一边。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitConflict {
    /// 是否处于 rebase 中间态
    pub in_rebase: bool,
    /// 冲突文件（仓库相对路径）
    pub files: Vec<String>,
    /// 人话提示
    pub message: String,
    /// 按冲突内容给出的处理建议（可翻译）。例如「只冲突在共享汇总文件上」——
    /// 那是两台机器首次同步到同一远端时的必然结果，不说明的话用户只会觉得同步坏了。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hint: Option<crate::localized::LocalizedText>,
    /// 原始输出，供「查看冲突文件」与 debug 日志
    pub stdout: String,
    pub stderr: String,
}

/// 同步仓库里的机器登记信息（`.aichat/machines.json`）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MachineRecord {
    pub machine_id: String,
    /// 主机名（仅用于展示，不作为 id）
    pub hostname: String,
    pub platform: String,
    pub first_seen_at: String,
    pub last_sync_at: String,
}

/// `.aichat/version.json` 内容。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoVersionFile {
    pub schema_version: u32,
    pub app: String,
    pub app_version: String,
    pub created_at: String,
}

/// 根 `manifest.json`（规格 §4.3 推荐结构）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoManifest {
    pub schema_version: u32,
    pub app: String,
    pub app_version: String,
    /// 仓库内已知机器 id 列表
    pub machine_ids: Vec<String>,
    pub updated_at: String,
}

/// 单个会话的 `meta.json`（规格 §15）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMetaFile {
    pub schema_version: u32,
    pub source: String,
    pub external_session_id: String,
    pub session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    pub machine_id: String,
    /// conversation.jsonl 的内容哈希（BLAKE3）
    pub content_hash: String,
    pub message_count: u64,
    pub partial: bool,
    /// 是否包含原始文件副本（Keep Raw Session Files）
    pub has_raw: bool,
    /// 原始会话目录（仅本地会话有值，跨机器不保证可用）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_root: Option<String>,
    /// 额外元信息
    #[serde(default)]
    pub metadata: serde_json::Value,
}

/// 归档条目信息。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveEntry {
    /// 仓库相对路径，例如 `archives/kimi/<machine>/<session>.tar.zst`
    pub rel_path: String,
    pub source: String,
    pub machine_id: String,
    pub session_id: String,
    pub size_bytes: u64,
    pub created_at: String,
    /// 压缩格式：zstd / gzip
    pub compression: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}
