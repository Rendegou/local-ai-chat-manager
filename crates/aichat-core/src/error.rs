//! 统一错误类型（对应规格 §26「错误处理」）。
//!
//! 约定：
//! - 所有可失败操作返回 [`Result`]，禁止在业务代码里大量 `unwrap()`；
//! - 错误按 [`ErrorKind`] 分类，前端据此决定展示方式；
//! - [`Error::user_message`] 提供「人话」提示，绝不把 Rust backtrace / SQL 原文抛给用户；
//! - 底层细节（stderr、SQL、路径）保留在 `source` 与 `Display` 里，写入 debug 日志。

use std::fmt;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// 错误分类，序列化给前端用于区分处理。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ErrorKind {
    /// 适配器（目录不存在、索引缺失、schema 不认识等）
    Adapter,
    /// JSON / JSONL 解析
    Parse,
    /// SQLite 索引
    Database,
    /// Git 命令
    Git,
    /// 文件系统
    Io,
    /// 归档 / 压缩
    Archive,
    /// 配置与设置
    Config,
    /// 资源不存在
    NotFound,
    /// Git 冲突（需要用户介入，非程序错误）
    Conflict,
}

impl ErrorKind {
    /// 分类标识，日志与 IPC 使用。
    pub const fn as_str(self) -> &'static str {
        match self {
            ErrorKind::Adapter => "adapter",
            ErrorKind::Parse => "parse",
            ErrorKind::Database => "database",
            ErrorKind::Git => "git",
            ErrorKind::Io => "io",
            ErrorKind::Archive => "archive",
            ErrorKind::Config => "config",
            ErrorKind::NotFound => "notFound",
            ErrorKind::Conflict => "conflict",
        }
    }
}

/// 核心错误枚举。
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// 适配器层错误（探测失败、schema 不兼容等）
    #[error("适配器错误: {0}")]
    Adapter(String),

    /// 解析错误（仅在整份文件无法读取时使用；单行损坏走 warning 不报错）
    #[error("解析错误: {0}")]
    Parse(String),

    /// 数据库错误
    #[error("数据库错误: {0}")]
    Database(#[from] rusqlite::Error),

    /// Git 命令错误：保留 stdout / stderr / exit code（规格 §28）
    #[error("Git 命令失败 ({code}): {stderr}")]
    Git {
        code: i32,
        stdout: String,
        stderr: String,
    },

    /// 文件系统错误：带上路径，便于定位
    #[error("文件操作失败 {path}: {source}")]
    Io {
        path: String,
        #[source]
        source: std::io::Error,
    },

    /// 归档错误
    #[error("归档错误: {0}")]
    Archive(String),

    /// 配置错误（用户输入非法路径等）
    #[error("配置错误: {0}")]
    Config(String),

    /// 资源不存在
    #[error("未找到: {0}")]
    NotFound(String),

    /// Git 冲突（结构化信息由 sync 层转成 GitConflict 给 UI）
    #[error("同步冲突: {0}")]
    Conflict(String),
}

impl Error {
    /// 错误分类。
    pub fn kind(&self) -> ErrorKind {
        match self {
            Error::Adapter(_) => ErrorKind::Adapter,
            Error::Parse(_) => ErrorKind::Parse,
            Error::Database(_) => ErrorKind::Database,
            Error::Git { .. } => ErrorKind::Git,
            Error::Io { .. } => ErrorKind::Io,
            Error::Archive(_) => ErrorKind::Archive,
            Error::Config(_) => ErrorKind::Config,
            Error::NotFound(_) => ErrorKind::NotFound,
            Error::Conflict(_) => ErrorKind::Conflict,
        }
    }

    /// 面向用户的中文提示。
    ///
    /// 不含 Rust 类型名、SQL 语句、堆栈，只说明「发生了什么 + 大致怎么办」。
    pub fn user_message(&self) -> String {
        match self {
            Error::Adapter(msg) => format!("无法读取会话数据源：{msg}"),
            Error::Parse(msg) => format!("会话文件解析失败：{msg}"),
            Error::Database(_) => "本地索引数据库操作失败，可尝试重建索引".to_string(),
            Error::Git { stderr, code, .. } => {
                let hint = stderr.lines().next().unwrap_or("").trim();
                if hint.is_empty() {
                    format!("Git 命令失败（退出码 {code}）")
                } else {
                    format!("Git 命令失败：{hint}")
                }
            }
            Error::Io { path, source } => format!("无法访问 {path}：{source}"),
            Error::Archive(msg) => format!("归档失败：{msg}"),
            Error::Config(msg) => format!("设置无效：{msg}"),
            Error::NotFound(msg) => format!("未找到{msg}"),
            Error::Conflict(msg) => format!("当前仓库存在冲突：{msg}"),
        }
    }

    /// 便捷构造：文件系统错误。
    pub fn io(path: impl AsRef<Path>, source: std::io::Error) -> Self {
        Error::Io {
            path: path.as_ref().display().to_string(),
            source,
        }
    }

    /// 便捷构造：适配器错误。
    pub fn adapter(msg: impl Into<String>) -> Self {
        Error::Adapter(msg.into())
    }

    /// 便捷构造：解析错误。
    pub fn parse(msg: impl Into<String>) -> Self {
        Error::Parse(msg.into())
    }

    /// 便捷构造：配置错误。
    pub fn config(msg: impl Into<String>) -> Self {
        Error::Config(msg.into())
    }

    /// 便捷构造：归档错误。
    pub fn archive(msg: impl Into<String>) -> Self {
        Error::Archive(msg.into())
    }

    /// 便捷构造：资源不存在。
    pub fn not_found(msg: impl Into<String>) -> Self {
        Error::NotFound(msg.into())
    }

    /// 便捷构造：Git 冲突。
    pub fn conflict(msg: impl Into<String>) -> Self {
        Error::Conflict(msg.into())
    }
}

impl From<serde_json::Error> for Error {
    fn from(e: serde_json::Error) -> Self {
        Error::Parse(e.to_string())
    }
}

impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Self {
        Error::Io {
            path: String::new(),
            source: e,
        }
    }
}

/// 带路径上下文的结果扩展：把「无路径」的 IO 错误补齐为可定位的错误。
pub trait IoContext<T> {
    /// 为 IO 错误补充路径信息。
    fn with_path(self, path: impl AsRef<Path>) -> Result<T>;
}

impl<T> IoContext<T> for std::result::Result<T, std::io::Error> {
    fn with_path(self, path: impl AsRef<Path>) -> Result<T> {
        self.map_err(|e| Error::io(path, e))
    }
}

/// 便于在日志里输出简短错误（只取第一层，不带回溯）。
pub struct ShortError<'a>(pub &'a Error);

impl fmt::Display for ShortError<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "[{}] {}", self.0.kind().as_str(), self.0)
    }
}

/// 统一 Result 别名。
pub type Result<T> = std::result::Result<T, Error>;

/// 把 PathBuf 转成可展示字符串（Windows 反斜杠统一成正斜杠，便于跨平台比对）。
pub fn display_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

/// 便于上层构造「路径不存在」错误。
pub fn missing(path: &Path) -> Error {
    Error::NotFound(display_path(path))
}

impl From<PathBuf> for Error {
    fn from(p: PathBuf) -> Self {
        Error::NotFound(display_path(&p))
    }
}
