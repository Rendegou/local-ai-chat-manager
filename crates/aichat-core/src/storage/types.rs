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
    /// 人话版本（由 `notes_text` 拼接，或旧数据里的纯文本）。
    /// 保留它是为了 CLI / 日志 / 旧数据可读，界面展示请用 `notes_text`。
    pub notes: Option<String>,
    /// 结构化说明：前端按 code 翻译。
    ///
    /// 与 `notes` 存在同一列里（JSON 文本）；读出来解析失败就当旧的中文纯文本处理，
    /// 所以升级不需要数据迁移——下一次扫描会把它覆盖成 JSON。
    #[serde(default)]
    pub notes_text: Vec<crate::localized::SourceNote>,
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
