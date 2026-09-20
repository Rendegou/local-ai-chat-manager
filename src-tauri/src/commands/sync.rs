//! 同步相关命令。

use aichat_core::sync::{SyncOptions, SyncReport, SyncStatusDto};
use tauri::{AppHandle, Emitter, State};

use crate::commands::EVENT_LIBRARY_CHANGED;
use crate::commands::EVENT_SYNC_PROGRESS;
use crate::error::{CmdResult, CommandError};
use crate::state::AppState;

/// 读取同步状态（Sync 页）。
#[tauri::command]
pub fn sync_status(state: State<'_, AppState>) -> CmdResult<SyncStatusDto> {
    Ok(state.library.sync_status()?)
}

/// 执行一次完整同步（扫描 → 快照 → add → commit → pull --rebase → push → 重建索引）。
#[tauri::command]
pub async fn sync_now(
    app: AppHandle,
    state: State<'_, AppState>,
    options: Option<SyncOptions>,
) -> CmdResult<SyncReport> {
    let library = state.library.clone();
    let options = options.unwrap_or_default();
    // 本次填写的远端地址写回设置，后续同步直接复用（避免每次都要重填）
    if let Some(url) = options
        .set_remote
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        let mut settings = library.settings();
        if settings.remote_url.as_deref() != Some(url) {
            settings.remote_url = Some(url.to_string());
            library.update_settings(settings)?;
        }
    }
    let app_for_progress = app.clone();
    let report = tauri::async_runtime::spawn_blocking(move || {
        library.sync_now(&options, &mut |step: String| {
            let _ = app_for_progress.emit(EVENT_SYNC_PROGRESS, &step);
        })
    })
    .await
    .map_err(|e| CommandError::new(aichat_core::ErrorKind::Git, "同步任务失败", e.to_string()))??;
    let _ = app.emit(EVENT_LIBRARY_CHANGED, "sync");
    Ok(report)
}

/// 查看 Git 日志。
#[tauri::command]
pub fn git_log(state: State<'_, AppState>, limit: Option<usize>) -> CmdResult<Vec<aichat_core::sync::git::GitCommit>> {
    Ok(state.library.git_log(limit.unwrap_or(30))?)
}

/// 冲突处理：中止 rebase（不自动合并、不丢弃任何一边）。
#[tauri::command]
pub fn abort_rebase(state: State<'_, AppState>) -> CmdResult<()> {
    Ok(state.library.abort_rebase()?)
}
