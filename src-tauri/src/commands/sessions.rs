//! 会话列表 / 详情 / 消息分页相关命令。

use aichat_core::scanner::{ScanProgress, ScanReport};
use aichat_core::storage::sessions::{
    MessageRow, SessionDetail, SessionFilter, SessionSummary, StorageStats,
};
use aichat_core::storage::types::{ProjectSummary, SourceRow};
use tauri::{AppHandle, Emitter, State};

use crate::commands::EVENT_LIBRARY_CHANGED;
use crate::commands::EVENT_SCAN_PROGRESS;
use crate::error::{CmdResult, CommandError};
use crate::state::AppState;

/// 探测数据源（Codex / Kimi 目录），返回并缓存到索引库。
#[tauri::command]
pub fn detect_sources(state: State<'_, AppState>) -> CmdResult<Vec<SourceRow>> {
    Ok(state.library.detect_sources()?)
}

/// 读取已缓存的数据源信息。
#[tauri::command]
pub fn list_sources(state: State<'_, AppState>) -> CmdResult<Vec<SourceRow>> {
    Ok(state.library.list_sources()?)
}

/// 会话列表（虚拟滚动按需分页）。
#[tauri::command]
pub fn list_sessions(
    state: State<'_, AppState>,
    filter: Option<SessionFilter>,
    limit: Option<i64>,
    offset: Option<i64>,
) -> CmdResult<Vec<SessionSummary>> {
    let filter = filter.unwrap_or_default();
    Ok(state.library.list_sessions(
        &filter,
        limit.unwrap_or(200).clamp(1, 1000),
        offset.unwrap_or(0),
    )?)
}

/// 满足条件的会话总数。
#[tauri::command]
pub fn count_sessions(state: State<'_, AppState>, filter: Option<SessionFilter>) -> CmdResult<i64> {
    Ok(state.library.count_sessions(&filter.unwrap_or_default())?)
}

/// 会话详情（含原始文件与元信息）。
#[tauri::command]
pub fn get_session(
    state: State<'_, AppState>,
    session_id: String,
) -> CmdResult<Option<SessionDetail>> {
    Ok(state.library.session_detail(&session_id)?)
}

/// 消息分页读取（大会话不会整体进入前端内存）。
#[tauri::command]
pub fn get_messages(
    state: State<'_, AppState>,
    session_id: String,
    offset: Option<i64>,
    limit: Option<i64>,
) -> CmdResult<Vec<MessageRow>> {
    Ok(state.library.messages_page(
        &session_id,
        offset.unwrap_or(0),
        limit.unwrap_or(200).clamp(1, 1000),
    )?)
}

/// 读取某条消息前后文（搜索结果跳转定位）。
#[tauri::command]
pub fn get_messages_around(
    state: State<'_, AppState>,
    session_id: String,
    sequence: i64,
    before: Option<i64>,
    after: Option<i64>,
) -> CmdResult<Vec<MessageRow>> {
    Ok(state.library.messages_around(
        &session_id,
        sequence,
        before.unwrap_or(30),
        after.unwrap_or(60),
    )?)
}

/// 项目聚合列表。
#[tauri::command]
pub fn list_projects(state: State<'_, AppState>) -> CmdResult<Vec<ProjectSummary>> {
    Ok(state.library.list_projects()?)
}

/// 机器列表（多设备筛选）。
#[tauri::command]
pub fn list_machines(state: State<'_, AppState>) -> CmdResult<Vec<String>> {
    Ok(state.library.list_machines()?)
}

/// 索引统计。
#[tauri::command]
pub fn get_stats(state: State<'_, AppState>) -> CmdResult<StorageStats> {
    Ok(state.library.stats()?)
}

/// 增量扫描（重活放到 blocking 线程，进度通过事件推送）。
#[tauri::command]
pub async fn scan_library(
    app: AppHandle,
    state: State<'_, AppState>,
    force: Option<bool>,
) -> CmdResult<ScanReport> {
    let library = state.library.clone();
    let force = force.unwrap_or(false);
    let app_for_progress = app.clone();
    let report = tauri::async_runtime::spawn_blocking(move || {
        library.scan(force, &mut |progress: ScanProgress| {
            // 前端进度条；失败（例如窗口已关闭）忽略即可
            let _ = app_for_progress.emit(EVENT_SCAN_PROGRESS, &progress);
        })
    })
    .await
    .map_err(|e| {
        CommandError::new(
            aichat_core::ErrorKind::Adapter,
            "扫描任务失败",
            e.to_string(),
        )
    })??;
    let _ = app.emit(EVENT_LIBRARY_CHANGED, "scan");
    Ok(report)
}

/// 重建索引（清空后全量解析）。
#[tauri::command]
pub async fn rebuild_index(app: AppHandle, state: State<'_, AppState>) -> CmdResult<ScanReport> {
    let library = state.library.clone();
    let app_for_progress = app.clone();
    let report = tauri::async_runtime::spawn_blocking(move || {
        library.rebuild_index(&mut |progress| {
            let _ = app_for_progress.emit(EVENT_SCAN_PROGRESS, &progress);
        })
    })
    .await
    .map_err(|e| {
        CommandError::new(
            aichat_core::ErrorKind::Database,
            "重建索引失败",
            e.to_string(),
        )
    })??;
    let _ = app.emit(EVENT_LIBRARY_CHANGED, "rebuild");
    Ok(report)
}
