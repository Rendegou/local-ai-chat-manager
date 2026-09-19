use tauri::{AppHandle, Emitter, State};
use crate::{error::{CmdResult, CommandError}, state::AppState};
use aichat_core::{adapters::registry::SourceCatalogEntry, imports::{ImportPreview, ImportReport}};

#[tauri::command]
pub fn source_catalog(state: State<'_, AppState>) -> CmdResult<Vec<SourceCatalogEntry>> {
    Ok(state.library.source_catalog()?)
}
#[tauri::command]
pub async fn preview_import(state: State<'_, AppState>, source: String, text: String) -> CmdResult<ImportPreview> {
    let library = state.library.clone();
    tauri::async_runtime::spawn_blocking(move || library.preview_import(&source,&text)).await
        .map_err(|e| CommandError::from(aichat_core::Error::config(e.to_string())))?.map_err(CommandError::from)
}
#[tauri::command]
pub fn cancel_import(state: State<'_, AppState>, token: String) -> CmdResult<()> {
    Ok(state.library.cancel_import(&token)?)
}
#[tauri::command]
pub async fn confirm_import(app: AppHandle, state: State<'_, AppState>, token: String) -> CmdResult<ImportReport> {
    let library = state.library.clone();
    let report = tauri::async_runtime::spawn_blocking(move || library.confirm_import(&token)).await
        .map_err(|e| CommandError::from(aichat_core::Error::config(e.to_string())))??;
    let _ = app.emit(super::EVENT_LIBRARY_CHANGED, "import");
    Ok(report)
}

#[tauri::command]
pub fn save_import_template(path: String, source: String, format: String) -> CmdResult<()> {
    let source = aichat_core::model::SourceKind::parse(&source).ok_or_else(|| aichat_core::Error::config("数据源标识无效"))?;
    let text = if format == "markdown" { "# 示例会话\n\n## user\n请帮我整理工作计划。\n\n## assistant\n下面是整理后的工作计划。\n".to_string() }
        else { serde_json::to_string_pretty(&serde_json::json!({"schemaVersion":1,"sessions":[{"source":source,"title":"示例会话","messages":[{"role":"user","text":"请帮我整理工作计划。"},{"role":"assistant","text":"下面是整理后的工作计划。"}]}]})).map_err(aichat_core::Error::from)? };
    std::fs::write(&path,text).map_err(|e| aichat_core::Error::io(std::path::Path::new(&path),e))?;
    Ok(())
}
