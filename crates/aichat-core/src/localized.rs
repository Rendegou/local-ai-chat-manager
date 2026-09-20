//! 面向用户的文案：稳定的 `code` + 参数 + 中文回退。
//!
//! ## 为什么后端不直接回中文
//!
//! 这个应用是中英双语的，但探测说明、错误信息、校验提示原本全部硬编码中文。
//! 结果是切到 English 之后，界面框架是英文、里面的每一句人话还是中文
//! （用户实测反馈：「这些切换到 English 没有使用 english」）。
//!
//! ## 做法
//!
//! 后端只说「这是哪一条」+「参数是什么」，翻译表仍然**只有前端那一份**
//! （`src/lib/i18n/*.ts`）。这样不会出现两份字典各自漂移。
//!
//! - `code`：稳定标识，例如 `error.import.tooManyMessages`。
//!   用 `&'static str` 而不是 String，便于全局搜索，也让「哪些 code 存在」可被脚本清点。
//! - `params`：插值参数，前端用 `{name}` 占位。
//! - `fallback`：中文原文。用于日志，以及前端字典里还没有这个 code 的场景——
//!   宁可显示中文，也不要显示一个 `error.foo.bar` 这样的裸键。
//!
//! `tools/check_i18n.mjs` 会清点后端发出的所有 code，并断言前端两份字典都有对应条目，
//! 所以「加了 code 忘了翻译」会在验证阶段被抓住，而不是等用户切语言时才发现。
use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// 一条可翻译的文案。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalizedText {
    /// 稳定标识（前端字典的 key）
    pub code: String,
    /// 插值参数
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub params: BTreeMap<String, String>,
    /// 中文原文（日志 + 前端没有该 code 时的回退）
    pub fallback: String,
}

impl LocalizedText {
    /// 无参数文案。
    pub fn new(code: &'static str, fallback: impl Into<String>) -> Self {
        LocalizedText { code: code.to_string(), params: BTreeMap::new(), fallback: fallback.into() }
    }

    /// 带一个命名参数的文案（参数值由调用方格式化进 fallback）。
    pub fn with(code: &'static str, name: &str, value: impl Into<String>, fallback: impl Into<String>) -> Self {
        let mut params = BTreeMap::new();
        params.insert(name.to_string(), value.into());
        LocalizedText { code: code.to_string(), params, fallback: fallback.into() }
    }

    pub fn param(mut self, name: &str, value: impl Into<String>) -> Self {
        self.params.insert(name.to_string(), value.into());
        self
    }

    /// 前端字典里没有这个 code 时显示什么（也是日志里显示的内容）。
    pub fn text(&self) -> &str {
        &self.fallback
    }
}

/// 探测说明的严重程度。
///
/// 取代过去「靠 `notes.contains("失败")` 判断来源是否出错」的做法——
/// 拿中文子串做控制流，改一个字的文案就会静默改变来源状态。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum NoteSeverity {
    /// 说明性：自动探测到目录、使用手工指定的目录
    Info,
    /// 需要留意：部分解析、目录里没有匹配文件
    Warn,
    /// 出错：读取失败、目录不存在
    Error,
}

/// 一条来源探测说明。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceNote {
    #[serde(flatten)]
    pub text: LocalizedText,
    pub severity: NoteSeverity,
}

impl SourceNote {
    pub fn info(text: LocalizedText) -> Self {
        SourceNote { text, severity: NoteSeverity::Info }
    }
    pub fn warn(text: LocalizedText) -> Self {
        SourceNote { text, severity: NoteSeverity::Warn }
    }
    pub fn error(text: LocalizedText) -> Self {
        SourceNote { text, severity: NoteSeverity::Error }
    }

    /// 兼容旧形态：不带严重程度时按 Info 处理。
    pub fn plain(code: &'static str, fallback: impl Into<String>) -> Self {
        Self::info(LocalizedText::new(code, fallback))
    }

    /// 中文原文（日志与 `SourceRow.notes` 用）。
    pub fn text(&self) -> &str {
        self.text.text()
    }

    /// 该来源是否处于错误状态。
    pub fn is_error(&self) -> bool {
        self.severity == NoteSeverity::Error
    }
}

/// 把一组说明拼成一行（`SourceRow.notes` 是单字符串）。
pub fn join_notes(notes: &[SourceNote]) -> Option<String> {
    let joined = notes.iter().map(SourceNote::text).collect::<Vec<_>>().join("；");
    (!joined.is_empty()).then_some(joined)
}

/// 一组说明里的最高严重程度。
pub fn worst_severity(notes: &[SourceNote]) -> Option<NoteSeverity> {
    if notes.iter().any(|n| n.severity == NoteSeverity::Error) {
        return Some(NoteSeverity::Error);
    }
    if notes.iter().any(|n| n.severity == NoteSeverity::Warn) {
        return Some(NoteSeverity::Warn);
    }
    (!notes.is_empty()).then_some(NoteSeverity::Info)
}
