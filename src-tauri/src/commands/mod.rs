//! Tauri 命令（IPC 接口）：全部是薄封装，真正的逻辑在 `aichat-core`。
//!
//! 约定：
//! - 读操作直接执行；重活（扫描 / 同步 / 归档）放到 `spawn_blocking`，避免阻塞 UI 线程；
//! - 长任务通过事件向前端推送进度：`scan-progress` / `sync-progress` / `library-changed`；
//! - 错误统一转换为 [`crate::error::CommandError`]。

pub mod archive;
pub mod imports;
pub mod search;
pub mod sessions;
pub mod settings;
pub mod sync;

/// 进度事件名（前端监听这些事件名）。
pub const EVENT_SCAN_PROGRESS: &str = "scan-progress";
/// 同步进度事件名。
pub const EVENT_SYNC_PROGRESS: &str = "sync-progress";
/// 索引变化事件名（文件监听触发）。
pub const EVENT_LIBRARY_CHANGED: &str = "library-changed";
