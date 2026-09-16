//! 本地索引层（规格 §8）：SQLite + FTS5。
//!
//! 定位：**可删除可重建的缓存**，不是同步数据的 source of truth。
//! 跨设备数据由 Git 同步仓库负责（见 [`crate::sync`]）。
//!
//! 模块划分：
//! - [`db`]：连接、PRAGMA、迁移、数据源登记、文件指纹、键值设置；
//! - [`sessions`]：会话与消息的读写、列表 / 分页查询、流式写入 sink；
//! - [`search`]：FTS5 全文搜索与筛选。

pub mod db;
pub mod migrations;
pub mod search;
pub mod sessions;
pub mod types;

pub use db::{Database, FingerprintRow};
pub use search::{build_match_query, SearchHit, SearchOrder, SearchQuery, SearchResponse};
pub use sessions::{
    DatabaseSink, MessageRow, SessionDetail, SessionFilter, SessionSummary, StorageStats,
};
pub use types::{ProjectSummary, RawFileRow, SessionStub, SourceRow};
