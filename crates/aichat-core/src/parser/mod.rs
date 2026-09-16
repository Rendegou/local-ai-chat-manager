//! 解析层：目前只有 JSONL 流式解析（规格 §10）。
//!
//! 未来若出现 JSON 单文件格式（如 state.json 之外的体积型文件），在此扩展。

pub mod jsonl;

pub use jsonl::{
    content_to_text, epoch_ms_to_rfc3339, get_bool, get_i64, get_str, normalize_timestamp,
    normalize_timestamp_value, stream_jsonl, value_to_text, Flow, JsonlReport, ParseLimits,
};
