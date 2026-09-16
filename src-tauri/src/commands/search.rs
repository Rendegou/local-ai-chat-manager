//! 全文搜索命令。

use aichat_core::storage::search::{SearchQuery, SearchResponse};
use tauri::State;

use crate::error::CmdResult;
use crate::state::AppState;

/// 执行全文搜索（FTS5，目标 100 万条消息 < 300ms）。
#[tauri::command]
pub fn search(state: State<'_, AppState>, query: SearchQuery) -> CmdResult<SearchResponse> {
    Ok(state.library.search(&query)?)
}
