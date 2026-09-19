//! 数据源的「试解析」：填完字段映射先看看能读出什么，再决定要不要保存。
//!
//! 逻辑在 aichat-core，这里只做转发。命令收 path + mapping 而不是读设置，
//! 所以用户可以在保存前反复试——映射填错时能立刻看见，而不是扫描完才发现
//! 一条会话都没有。

use tauri::State;

use aichat_core::adapters::generic::GenericPreview;
use aichat_core::settings::FieldMapping;

use crate::error::{CmdResult, CommandError};
use crate::state::AppState;

#[tauri::command]
pub fn preview_generic_source(
    state: State<'_, AppState>,
    source_id: String,
    path: String,
    mapping: FieldMapping,
) -> CmdResult<GenericPreview> {
    state
        .library
        .preview_generic_mapping(&source_id, &path, &mapping)
        .map_err(CommandError::from)
}
