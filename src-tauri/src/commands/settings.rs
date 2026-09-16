//! 设置相关命令。

use aichat_core::AppSettings;
use tauri::State;

use crate::error::CmdResult;
use crate::state::AppState;

/// 读取设置。
#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> CmdResult<AppSettings> {
    Ok(state.library.settings())
}

/// 保存设置（含校验：同步仓库不得指向 AI 工具数据目录）。
#[tauri::command]
pub fn save_settings(state: State<'_, AppState>, settings: AppSettings) -> CmdResult<AppSettings> {
    Ok(state.library.update_settings(settings)?)
}

/// 数据目录（设置页展示，便于用户找到索引文件）。
#[tauri::command]
pub fn data_dir(state: State<'_, AppState>) -> CmdResult<String> {
    Ok(aichat_core::error::display_path(state.library.data_dir()))
}

/// 本机 machine id（用于多设备识别）。
#[tauri::command]
pub fn machine_id(state: State<'_, AppState>) -> CmdResult<String> {
    Ok(state.library.machine_id().to_string())
}
