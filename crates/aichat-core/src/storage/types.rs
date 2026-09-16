//! 存储层 DTO：与数据库表一一对应的行结构。

use serde::{Deserialize, Serialize};

use crate::model::SyncStatus;

/// `sources` 表行：某个数据源的探测结果。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceRow {
    /// `codex` / `kimi`
    pub id: String,
    pub display_name: String,
    pub root_path: Option<String>,
    pub found: bool,
    pub session_hint: usize,
    pub manual: bool,
    pub notes: Option<String>,
    pub detected_at: Option<String>,
}

/// 写入会话前的占位信息（保证 messages 的外键在解析前已存在）。
#[derive(Debug, Clone)]
pub struct SessionStub {
    pub id: String,
    pub source: String,
    pub external_id: String,
    /// 会话归属机器（本机会话为本机 id，仓库会话为来源机器 id）
    pub machine_id: Option<String>,
    /// 原始会话目录（打开 / 快照复制用）
    pub source_root: Option<String>,
    /// 主文件路径
    pub primary_file: Option<String>,
    pub sync_status: SyncStatus,
}

/// `raw_files` 查询结果。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RawFileRow {
    pub path: String,
    pub role: String,
    pub size: u64,
    pub mtime: i64,
    pub hash: Option<String>,
}

/// 项目聚合（左栏 Projects 列表）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSummary {
    pub project_path: String,
    /// 展示用的项目名（路径最后一段）
    pub name: String,
    pub session_count: i64,
    pub last_updated: Option<String>,
    /// 该项目涉及的数据源（codex / kimi）
    pub sources: Vec<String>,
}
