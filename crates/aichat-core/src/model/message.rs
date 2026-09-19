//! 统一消息模型（规格 §7）。
//!
//! 归一化的目标是「方便展示」，不是替代原始文件：
//! - 未知 / 未识别的事件不会丢弃，而是保留到原始快照的 `raw/` 与 `raw` 字段；
//! - 认不出来的字段不会让整段会话解析失败。

use serde::{Deserialize, Serialize};

/// 消息角色。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
#[derive(Default)]
pub enum Role {
    User,
    Assistant,
    System,
    Tool,
    Developer,
    #[default]
    Unknown,
}

impl Role {
    /// 数据库 / JSONL 中的稳定标识。
    pub const fn as_str(self) -> &'static str {
        match self {
            Role::User => "user",
            Role::Assistant => "assistant",
            Role::System => "system",
            Role::Tool => "tool",
            Role::Developer => "developer",
            Role::Unknown => "unknown",
        }
    }

    /// 从字符串宽松解析（大小写不敏感），无法识别时返回 `Unknown`。
    ///
    /// 别名的取舍：只收「几乎不可能有第二种含义」的写法。多认一个别名能少一批
    /// 无意义的「未识别事件」（通用导入与用户自定义来源尤其明显），但把疑似工具名
    /// （gpt / gemini 之类）也当角色会误判，所以那些留在各自适配器里处理。
    pub fn parse(s: &str) -> Self {
        match s.trim().to_ascii_lowercase().as_str() {
            "user" | "human" => Role::User,
            "assistant" | "model" | "ai" | "bot" | "agent" => Role::Assistant,
            "system" => Role::System,
            "tool" | "function" | "tool_result" => Role::Tool,
            "developer" => Role::Developer,
            _ => Role::Unknown,
        }
    }
}

/// 消息种类：区分「正文」与「工具调用 / 结果 / 推理摘要 / 其他事件」。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[derive(Default)]
pub enum MessageKind {
    Message,
    ToolCall,
    ToolResult,
    ReasoningSummary,
    #[default]
    Event,
}

impl MessageKind {
    /// 数据库 / JSONL 中的稳定标识。
    pub const fn as_str(self) -> &'static str {
        match self {
            MessageKind::Message => "message",
            MessageKind::ToolCall => "tool_call",
            MessageKind::ToolResult => "tool_result",
            MessageKind::ReasoningSummary => "reasoning_summary",
            MessageKind::Event => "event",
        }
    }

    /// 数据库字段反序列化（未知值退化为 `Event`，保证老索引可读）。
    pub fn parse(s: &str) -> Self {
        match s {
            "message" => MessageKind::Message,
            "tool_call" => MessageKind::ToolCall,
            "tool_result" => MessageKind::ToolResult,
            "reasoning_summary" => MessageKind::ReasoningSummary,
            _ => MessageKind::Event,
        }
    }
}

/// 归一化消息。
///
/// `raw` 保存无法归一的原始片段（可选，避免索引体积过大时全量冗余）。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NormalizedMessage {
    /// 消息 id：优先使用原始事件 id，缺失时由适配器生成（`<session>:<seq>`）。
    pub id: String,
    pub role: Role,
    pub kind: MessageKind,
    /// RFC3339 时间戳（可排序字符串）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timestamp: Option<String>,
    /// 展示文本：工具调用为参数摘要，工具结果为输出文本
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// 工具名（仅 kind = tool_call / tool_result 有意义）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    /// 未识别 / 需要保真的原始数据
    #[serde(skip_serializing_if = "Option::is_none")]
    pub raw: Option<serde_json::Value>,
}

impl NormalizedMessage {
    /// 快速构造文本消息。
    pub fn text(role: Role, kind: MessageKind, text: impl Into<String>) -> Self {
        NormalizedMessage {
            text: Some(text.into()),
            role,
            kind,
            ..Default::default()
        }
    }

    /// 是否有可展示内容（用于过滤纯空事件）。
    pub fn has_content(&self) -> bool {
        self.text
            .as_deref()
            .map(|t| !t.trim().is_empty())
            .unwrap_or(false)
    }

    /// 文本截断（用于标题派生），按字符边界安全截断。
    pub fn truncate_text(s: &str, max_chars: usize) -> String {
        let mut out = String::with_capacity(max_chars.min(s.len()));
        for (idx, ch) in s.chars().enumerate() {
            if idx >= max_chars {
                out.push('…');
                break;
            }
            // 换行折叠成空格，避免标题多行
            out.push(if ch == '\n' || ch == '\r' { ' ' } else { ch });
        }
        out.trim().to_string()
    }
}
