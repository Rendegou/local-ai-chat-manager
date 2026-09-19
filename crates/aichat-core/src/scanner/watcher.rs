//! 文件监听（规格 §23）：notify + 自实现 debounce。
//!
//! AI CLI 在流式追加 JSONL 时会连续触发几十次事件，必须合并后再重新扫描。
//! 默认 debounce 900ms（规格建议 500~1500ms）。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, RecvTimeoutError};
use std::sync::Arc;
use std::time::{Duration, Instant};

use notify::{RecursiveMode, Watcher};

use crate::error::{Error, Result};

/// 默认去抖窗口（毫秒）。
pub const DEFAULT_DEBOUNCE_MS: u64 = 900;

/// 监听句柄：drop 或调用 [`WatcherHandle::stop`] 即停止监听。
pub struct WatcherHandle {
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl WatcherHandle {
    /// 主动停止监听（幂等）。
    pub fn stop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(handle) = self.thread.take() {
            let _ = handle.join();
        }
    }

    /// 是否仍在运行。
    pub fn is_running(&self) -> bool {
        !self.stop.load(Ordering::Relaxed)
    }
}

impl Drop for WatcherHandle {
    fn drop(&mut self) {
        self.stop();
    }
}

/// 启动监听：当被监听目录内出现 `.jsonl` / `.json` 变化时，去抖后回调一次。
///
/// - 监听失败（目录不存在、权限不足）不会中断程序，只是少监听一个目录；
/// - 回调在独立线程中执行，内部应避免长时间阻塞（实际动作是「触发一次增量扫描」）。
#[derive(Clone)]
pub struct WatchSpec { pub root: PathBuf, pub extensions: Vec<String> }

pub fn start<F>(roots: Vec<PathBuf>, debounce: Duration, on_change: F) -> Result<WatcherHandle>
where F: FnMut() + Send + 'static {
    start_filtered(roots.into_iter().map(|root| WatchSpec { root, extensions: vec!["json".into(), "jsonl".into()] }).collect(),debounce,on_change)
}
pub fn start_filtered<F>(specs: Vec<WatchSpec>, debounce: Duration, mut on_change: F) -> Result<WatcherHandle>
where F: FnMut() + Send + 'static {
    let (tx, rx) = channel::<notify::Result<notify::Event>>();
    let mut watcher = notify::recommended_watcher(move |res| {
        // 发送失败说明接收端已退出，忽略即可
        let _ = tx.send(res);
    })
    .map_err(|e| Error::adapter(format!("无法创建文件监听器: {e}")))?;

    let mut watched = 0usize;
    for root in specs.iter().map(|s| &s.root).filter(|p| p.is_dir()) {
        match watcher.watch(root, RecursiveMode::Recursive) {
            Ok(()) => {
                watched += 1;
                tracing::info!(path = %crate::error::display_path(root), "已监听会话目录");
            }
            Err(e) => tracing::warn!(
                path = %crate::error::display_path(root),
                error = %e,
                "监听目录失败，已跳过"
            ),
        }
    }
    if watched == 0 {
        return Err(Error::adapter("没有可监听的会话目录"));
    }

    let stop = Arc::new(AtomicBool::new(false));
    let stop_flag = Arc::clone(&stop);
    let thread = std::thread::Builder::new()
        .name("aichat-watcher".to_string())
        .spawn(move || {
            // watcher 必须保持存活，移到线程内持有
            let _watcher = watcher;
            let mut pending = false;
            let mut deadline = Instant::now();
            loop {
                if stop_flag.load(Ordering::Relaxed) {
                    break;
                }
                match rx.recv_timeout(Duration::from_millis(200)) {
                    Ok(Ok(event)) => {
                        if !is_relevant(&event, &specs) {
                            continue;
                        }
                        // 有新事件：重置去抖窗口
                        pending = true;
                        deadline = Instant::now() + debounce;
                    }
                    Ok(Err(_)) => { /* 单个事件错误忽略 */ }
                    Err(RecvTimeoutError::Timeout) => {}
                    Err(RecvTimeoutError::Disconnected) => break,
                }
                // 安静超过 debounce 窗口后触发一次
                if pending && Instant::now() >= deadline {
                    pending = false;
                    if stop_flag.load(Ordering::Relaxed) {
                        break;
                    }
                    on_change();
                }
            }
        })
        .map_err(|e| Error::adapter(format!("无法启动监听线程: {e}")))?;

    Ok(WatcherHandle {
        stop,
        thread: Some(thread),
    })
}

/// 是否与「会话文件变化」相关：只看 JSON / JSONL，忽略日志、缓存、二进制写入。
fn is_relevant(event: &notify::Event, specs: &[WatchSpec]) -> bool {
    event.paths.iter().any(|path| {
        if crate::paths::is_forbidden_path(path) {
            return false;
        }
        specs.iter().any(|s| path.starts_with(&s.root) && extension(path).map(|ext| s.extensions.contains(&ext)).unwrap_or(false))
    })
}

/// 取小写扩展名。
fn extension(path: &Path) -> Option<String> {
    path.extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    #[test]
    fn 监听目录变化并去抖回调() {
        let dir = tempfile::tempdir().unwrap();
        let sessions = dir.path().join("sessions");
        std::fs::create_dir_all(&sessions).unwrap();

        let counter = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counter_thread = Arc::clone(&counter);
        let mut handle = start(
            vec![sessions.clone()],
            Duration::from_millis(300),
            move || {
                counter_thread.fetch_add(1, Ordering::SeqCst);
            },
        )
        .unwrap();

        // 连续写入 5 次，应当只触发 1 次回调
        let file = sessions.join("wire.jsonl");
        for i in 0..5 {
            std::fs::write(&file, format!("{{\"i\":{i}}}\n")).unwrap();
            std::thread::sleep(Duration::from_millis(30));
        }

        let deadline = Instant::now() + Duration::from_secs(5);
        while counter.load(Ordering::SeqCst) == 0 && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(50));
        }
        handle.stop();
        assert!(
            counter.load(Ordering::SeqCst) >= 1,
            "连续写入应当触发至少一次回调"
        );
    }
}
