//! IPC 错误：把核心错误转成前端可理解的结构（规格 §26：前端不显示 Rust backtrace）。

use aichat_core::{Error, ErrorKind};
use serde::Serialize;

/// 传给前端的错误结构。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandError {
    /// 错误分类：adapter / parse / database / git / io / archive / config / notFound / conflict
    pub kind: String,
    /// 人话提示
    pub message: String,
    /// 详细原因（debug 面板展示，不直接弹给用户）
    pub detail: String,
}

impl CommandError {
    /// 构造错误。
    pub fn new(kind: ErrorKind, message: impl Into<String>, detail: impl Into<String>) -> Self {
        CommandError {
            kind: kind.as_str().to_string(),
            message: message.into(),
            detail: detail.into(),
        }
    }
}

impl From<Error> for CommandError {
    fn from(err: Error) -> Self {
        CommandError {
            kind: err.kind().as_str().to_string(),
            message: err.user_message(),
            detail: err.to_string(),
        }
    }
}

impl From<tauri::Error> for CommandError {
    fn from(err: tauri::Error) -> Self {
        CommandError::new(ErrorKind::Config, "界面操作失败", err.to_string())
    }
}

impl From<std::sync::PoisonError<()>> for CommandError {
    fn from(_: std::sync::PoisonError<()>) -> Self {
        CommandError::new(
            ErrorKind::Config,
            "内部状态不可用，请重试",
            "state poisoned",
        )
    }
}

/// 命令结果别名。
pub type CmdResult<T> = std::result::Result<T, CommandError>;
