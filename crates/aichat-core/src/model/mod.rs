//! 领域模型：会话、消息、同步数据结构。
//!
//! 所有对外的 IPC 类型都来自这里，前端只依赖这套结构，不感知 Codex / Kimi 细节。

pub mod message;
pub mod session;
pub mod sync;

pub use message::{MessageKind, NormalizedMessage, Role};
pub use session::{
    DetectionResult, NormalizedSession, ParsedSessionInfo, RawFileRef, SessionDescriptor,
    SourceKind,
};
pub use sync::{
    ArchiveEntry, GitConflict, MachineRecord, RepoManifest, RepoVersionFile, SessionMetaFile,
    SyncStatus, INDEX_SCHEMA_VERSION, SYNC_SCHEMA_VERSION,
};
