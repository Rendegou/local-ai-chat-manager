//! 应用状态：核心库句柄 + 文件监听句柄。

use std::sync::Arc;

use aichat_core::scanner::watcher::WatcherHandle;
use aichat_core::Library;
use std::sync::Mutex;

/// 全局状态（由 Tauri 托管）。
pub struct AppState {
    /// 核心库：适配器 / 索引 / 同步 / 归档
    pub library: Arc<Library>,
    /// 文件监听句柄（设置变更时可重启）
    pub watcher: Mutex<Option<WatcherHandle>>,
}

impl AppState {
    /// 新建状态。
    pub fn new(library: Library) -> Self {
        AppState {
            library: Arc::new(library),
            watcher: Mutex::new(None),
        }
    }
}
