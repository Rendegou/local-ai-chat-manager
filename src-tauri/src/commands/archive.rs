//! 归档相关命令（zstd / gzip）。

use aichat_core::archive::ArchiveReport;
use aichat_core::model::ArchiveEntry;
use tauri::State;

use crate::error::CmdResult;
use crate::state::AppState;

/// 归档指定会话。
#[tauri::command]
pub async fn archive_sessions(
    state: State<'_, AppState>,
    session_ids: Vec<String>,
) -> CmdResult<ArchiveReport> {
    let library = state.library.clone();
    Ok(
        tauri::async_runtime::spawn_blocking(move || library.archive_sessions(&session_ids))
            .await
            .map_err(|e| {
                crate::error::CommandError::new(
                    aichat_core::ErrorKind::Archive,
                    "归档任务失败",
                    e.to_string(),
                )
            })??,
    )
}

/// 按设置中的天数阈值批量归档旧会话。
#[tauri::command]
pub async fn archive_old_sessions(state: State<'_, AppState>) -> CmdResult<ArchiveReport> {
    let library = state.library.clone();
    Ok(
        tauri::async_runtime::spawn_blocking(move || library.archive_old_sessions())
            .await
            .map_err(|e| {
                crate::error::CommandError::new(
                    aichat_core::ErrorKind::Archive,
                    "批量归档失败",
                    e.to_string(),
                )
            })??,
    )
}

/// 列出仓库中的归档。
#[tauri::command]
pub fn list_archives(state: State<'_, AppState>) -> CmdResult<Vec<ArchiveEntry>> {
    Ok(state.library.list_archives()?)
}

/// 从归档恢复到活动会话目录（随后可重新浏览）。
#[tauri::command]
pub async fn restore_archive(state: State<'_, AppState>, rel_path: String) -> CmdResult<String> {
    let library = state.library.clone();
    let path = tauri::async_runtime::spawn_blocking(move || library.restore_archive(&rel_path))
        .await
        .map_err(|e| {
            crate::error::CommandError::new(
                aichat_core::ErrorKind::Archive,
                "恢复归档失败",
                e.to_string(),
            )
        })??;
    Ok(aichat_core::error::display_path(&path))
}
