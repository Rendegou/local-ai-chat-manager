//! Tauri 2 外壳入口。
//!
//! 职责边界（规格 §3）：**系统能力在 Rust，界面在 Web 前端**。
//! 这里只做三件事：
//! 1. 初始化核心库（数据目录 / SQLite 索引 / machine id）；
//! 2. 注册 IPC 命令与插件（目录选择、打开文件）；
//! 3. 启动后台增量扫描与文件监听，并通过事件通知前端刷新。

mod commands;
mod error;
mod state;

use std::sync::{Arc, Mutex};

use aichat_core::scanner::{ScanProgress, ScanReport};
use aichat_core::{init_logging, paths, Library};
use tauri::{AppHandle, Emitter, Manager};

use crate::commands::EVENT_LIBRARY_CHANGED;
use crate::commands::EVENT_SCAN_PROGRESS;
use crate::state::AppState;

/// 扫描串行化锁：文件监听与手动扫描不会并发跑同一份索引。
static SCAN_LOCK: Mutex<()> = Mutex::new(());

/// 启动应用。
pub fn run() {
    init_logging("info");
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // 数据目录：使用平台标准位置（Windows: %LOCALAPPDATA%/<identifier>）
            let data_dir = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| paths::default_data_dir());
            let library = Library::open(&data_dir)?;
            tracing::info!(dir = %aichat_core::error::display_path(&data_dir), "应用数据目录");

            let state = AppState::new(library);
            let settings = state.library.settings();

            // 启动时增量扫描（不阻塞 UI）：未变化会话不会被重新解析
            if settings.auto_scan_on_start {
                spawn_scan(app.handle().clone(), state.library.clone(), false);
            }

            // 文件监听：AI CLI 追加 JSONL 时自动更新索引（内部已 debounce）
            if settings.watch_enabled {
                let app_handle = app.handle().clone();
                let library = state.library.clone();
                match state.library.watch(move || {
                    spawn_scan(app_handle.clone(), library.clone(), false);
                }) {
                    Ok(handle) => {
                        if let Ok(mut slot) = state.watcher.lock() {
                            *slot = Some(handle);
                        }
                    }
                    Err(err) => {
                        // 监听失败不影响使用：仍然可以手动扫描
                        tracing::warn!(error = %err, "文件监听启动失败");
                    }
                }
            }

            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // 会话与索引
            commands::sessions::detect_sources,
            commands::sessions::list_sources,
            commands::sessions::list_sessions,
            commands::sessions::count_sessions,
            commands::sessions::get_session,
            commands::sessions::get_messages,
            commands::sessions::get_messages_around,
            commands::sessions::list_projects,
            commands::sessions::list_machines,
            commands::sessions::get_stats,
            commands::sessions::scan_library,
            commands::sessions::rebuild_index,
            // 搜索
            commands::search::search,
            // 同步
            commands::sync::sync_status,
            commands::sync::sync_now,
            commands::sync::git_log,
            commands::sync::abort_rebase,
            // 设置
            commands::settings::get_settings,
            commands::settings::save_settings,
            commands::settings::data_dir,
            commands::settings::machine_id,
            // 归档
            commands::archive::archive_sessions,
            commands::archive::archive_old_sessions,
            commands::archive::list_archives,
            commands::archive::restore_archive,
        ])
        .run(tauri::generate_context!())
        .expect("Tauri 应用启动失败");
}

/// 在后台线程执行一次增量扫描，并把进度 / 完成事件推送给前端。
fn spawn_scan(app: AppHandle, library: Arc<Library>, force: bool) {
    std::thread::spawn(move || {
        // 已有扫描在跑时直接返回：文件监听可能连续触发
        let Ok(_guard) = SCAN_LOCK.try_lock() else {
            return;
        };
        let report: Result<ScanReport, _> = library.scan(force, &mut |progress: ScanProgress| {
            let _ = app.emit(EVENT_SCAN_PROGRESS, &progress);
        });
        match report {
            Ok(report) => {
                tracing::info!(
                    scanned = report.scanned,
                    parsed = report.parsed,
                    skipped = report.skipped,
                    removed = report.removed,
                    failed = report.failed,
                    elapsed_ms = report.duration_ms,
                    "扫描完成"
                );
                let _ = app.emit(EVENT_LIBRARY_CHANGED, "scan");
            }
            Err(err) => {
                // 扫描失败只记录日志：不打断用户正在看的界面
                tracing::error!(error = %err, "扫描失败");
            }
        }
    });
}
