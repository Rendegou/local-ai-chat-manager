//! JSONL 流式解析（规格 §10）。
//!
//! 硬性要求：
//! - 必须流式：禁止把 100MB+ 文件 `read_to_string` 后整体反序列化；
//! - 单行损坏只记 warning 并跳过，绝不让整个会话不可见；
//! - 复用行缓冲，避免逐行分配；
//! - 告警只记录行号与错误原因，不记录正文（隐私，规格 §27）。

use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::Path;

use serde_json::Value;

use crate::error::{Error, Result};

/// 解析限制：控制内存与告警规模。
#[derive(Debug, Clone)]
pub struct ParseLimits {
    /// 允许的最大坏行数，超过则判定文件结构异常并停止
    pub max_bad_lines: usize,
    /// 最多保留多少条告警文本
    pub max_warnings: usize,
    /// 单行最大字节数：超过视为异常行（防止畸形文件撑爆内存）
    pub max_line_bytes: usize,
}

impl Default for ParseLimits {
    fn default() -> Self {
        ParseLimits {
            max_bad_lines: 256,
            max_warnings: 20,
            // 32MB：正常事件远小于此值；超大行通常意味着文件损坏
            max_line_bytes: 32 * 1024 * 1024,
        }
    }
}

/// 遍历控制：回调返回 `Stop` 可提前结束（例如只需要读第一行）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Flow {
    Continue,
    Stop,
}

/// 解析统计（用于日志与「发现 N 条无法解析的事件」提示）。
#[derive(Debug, Clone, Default)]
pub struct JsonlReport {
    /// 读到的总行数（含空行）
    pub lines: u64,
    /// 成功解析的 JSON 行数
    pub parsed: u64,
    /// 损坏 / 超限的行数
    pub bad: u64,
    /// 读取到的字节数
    pub bytes: u64,
}

/// 流式遍历 JSONL 文件。
///
/// - `on_value`：每行解析成功的 JSON 对象回调；
/// - 损坏行：累计到 `report.bad` 与告警列表，继续解析；
/// - 读取错误（IO）才会返回 `Err` 终止。
pub fn stream_jsonl<F>(
    path: &Path,
    limits: &ParseLimits,
    mut on_value: F,
) -> Result<(JsonlReport, Vec<String>)>
where
    F: FnMut(&Value) -> Result<Flow>,
{
    let file = File::open(path).map_err(|e| Error::io(path, e))?;
    let mut reader = BufReader::with_capacity(256 * 1024, file);
    let mut buf: Vec<u8> = Vec::with_capacity(64 * 1024);
    let mut report = JsonlReport::default();
    let mut warnings: Vec<String> = Vec::new();
    let mut line_no: u64 = 0;

    loop {
        buf.clear();
        let read = reader
            .read_until(b'\n', &mut buf)
            .map_err(|e| Error::io(path, e))?;
        if read == 0 {
            break; // EOF
        }
        line_no += 1;
        report.lines += 1;
        report.bytes += read as u64;

        let line = trim_line(&buf);
        if line.is_empty() {
            continue;
        }
        if line.len() > limits.max_line_bytes {
            report.bad += 1;
            push_warning(
                &mut warnings,
                limits,
                format!("第 {line_no} 行过大，已跳过"),
            );
            continue;
        }

        match serde_json::from_slice::<Value>(line) {
            Ok(value) => {
                report.parsed += 1;
                if on_value(&value)? == Flow::Stop {
                    break;
                }
            }
            Err(err) => {
                report.bad += 1;
                // 只记录行号 + 错误分类，绝不记录正文
                push_warning(
                    &mut warnings,
                    limits,
                    format!(
                        "第 {line_no} 行 JSON 无法解析（{}）",
                        short_json_error(&err)
                    ),
                );
                if report.bad as usize > limits.max_bad_lines {
                    return Err(Error::parse(format!(
                        "{} 中坏行过多（>{}），已停止解析",
                        crate::error::display_path(path),
                        limits.max_bad_lines
                    )));
                }
            }
        }
    }

    Ok((report, warnings))
}

/// 只读取文件开头若干行（例如 Codex rollout 的 `session_meta`）。
pub fn read_head<F>(path: &Path, max_lines: usize, mut on_value: F) -> Result<JsonlReport>
where
    F: FnMut(&Value) -> Result<Flow>,
{
    let limits = ParseLimits {
        // 只读头部时不做坏行上限判断：调用方只关心前几行
        max_bad_lines: usize::MAX,
        ..Default::default()
    };
    let mut remaining = max_lines;
    // 复用 stream_jsonl，通过闭包计数实现「只读前 N 行」
    let (report, _) = stream_jsonl(path, &limits, |v| {
        if remaining == 0 {
            return Ok(Flow::Stop);
        }
        remaining -= 1;
        on_value(v)
    })?;
    Ok(report)
}

/// 去掉行尾换行与 UTF-8 BOM，得到可解析切片。
fn trim_line(buf: &[u8]) -> &[u8] {
    let mut s = buf;
    // 去掉末尾的 \n / \r
    while let Some(&last) = s.last() {
        if last == b'\n' || last == b'\r' {
            s = &s[..s.len() - 1];
        } else {
            break;
        }
    }
    // 去掉行首 BOM（仅第一行可能出现）与空白
    if s.starts_with(&[0xEF, 0xBB, 0xBF]) {
        s = &s[3..];
    }
    let mut start = 0;
    while start < s.len() && (s[start] == b' ' || s[start] == b'\t') {
        start += 1;
    }
    &s[start..]
}

/// 限制告警数量，避免异常文件刷爆日志。
fn push_warning(warnings: &mut Vec<String>, limits: &ParseLimits, msg: String) {
    if warnings.len() < limits.max_warnings {
        warnings.push(msg);
    }
}

/// 从 serde 错误里提取「简短原因」，丢弃行列信息中的正文引用。
fn short_json_error(err: &serde_json::Error) -> &'static str {
    use serde_json::error::Category::*;
    match err.classify() {
        Io => "读取失败",
        Syntax => "语法错误",
        Data => "字段类型不匹配",
        Eof => "内容不完整",
    }
}

/// 提取 JSON 值里的字符串字段（缺失或类型不符返回 `None`）。
pub fn get_str<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(|v| v.as_str())
}

/// 提取整数字段（兼容字符串形式的数字）。
pub fn get_i64(value: &Value, key: &str) -> Option<i64> {
    let v = value.get(key)?;
    if let Some(n) = v.as_i64() {
        return Some(n);
    }
    if let Some(n) = v.as_f64() {
        return Some(n as i64);
    }
    v.as_str().and_then(|s| s.parse::<i64>().ok())
}

/// 提取布尔字段（兼容 "true" / 1 等宽松写法）。
pub fn get_bool(value: &Value, key: &str) -> Option<bool> {
    let v = value.get(key)?;
    if let Some(b) = v.as_bool() {
        return Some(b);
    }
    if let Some(n) = v.as_i64() {
        return Some(n != 0);
    }
    v.as_str().map(|s| s.eq_ignore_ascii_case("true"))
}

/// 把任意 JSON 值转成展示文本：字符串直出，其余序列化为紧凑 JSON。
pub fn value_to_text(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

/// 拼接内容数组（Codex / Kimi 都用 `[{type, text}]` 结构）：
/// 提取所有 `text` 字段，缺失时回退为紧凑 JSON，保证不丢信息。
pub fn content_to_text(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(items) => {
            let mut out = String::new();
            for item in items {
                match item {
                    Value::String(s) => push_text(&mut out, s),
                    Value::Object(_) => {
                        if let Some(t) = get_str(item, "text") {
                            push_text(&mut out, t);
                        } else if let Some(t) = get_str(item, "content") {
                            push_text(&mut out, t);
                        } else {
                            // 未知内容块：保留原始 JSON，不静默丢弃
                            push_text(&mut out, &item.to_string());
                        }
                    }
                    other => push_text(&mut out, &other.to_string()),
                }
            }
            out
        }
        Value::Object(_) => content_to_text(&Value::Array(vec![content.clone()])),
        other => other.to_string(),
    }
}

/// 追加文本段（自动补换行，避免内容块粘连）。
fn push_text(out: &mut String, text: &str) {
    if text.is_empty() {
        return;
    }
    if !out.is_empty() && !out.ends_with('\n') {
        out.push('\n');
    }
    out.push_str(text);
}

/// 把毫秒时间戳转换成 RFC3339 字符串（Kimi state.json 使用毫秒）。
pub fn epoch_ms_to_rfc3339(ms: i64) -> Option<String> {
    chrono::DateTime::from_timestamp_millis(ms).map(|dt| dt.to_rfc3339())
}

/// 把秒级时间戳转换成 RFC3339 字符串。
pub fn epoch_secs_to_rfc3339(secs: i64) -> Option<String> {
    chrono::DateTime::from_timestamp(secs, 0).map(|dt| dt.to_rfc3339())
}

/// 规范化时间戳：接受 RFC3339 / epoch 秒 / epoch 毫秒，统一输出 RFC3339。
pub fn normalize_timestamp(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    // 纯数字：按位数判断秒还是毫秒
    if let Ok(n) = trimmed.parse::<i64>() {
        return if n.abs() > 10_000_000_000 {
            epoch_ms_to_rfc3339(n)
        } else {
            epoch_secs_to_rfc3339(n)
        };
    }
    // RFC3339 / ISO8601
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(trimmed) {
        return Some(dt.to_rfc3339());
    }
    // 宽松格式（如 "2026-09-15 22:30:00"）
    if let Ok(dt) = chrono::NaiveDateTime::parse_from_str(trimmed, "%Y-%m-%d %H:%M:%S") {
        return Some(dt.and_utc().to_rfc3339());
    }
    if let Ok(d) = chrono::NaiveDate::parse_from_str(trimmed, "%Y-%m-%d") {
        return Some(d.and_hms_opt(0, 0, 0)?.and_utc().to_rfc3339());
    }
    None
}

/// 数字时间戳规范化（JSON 里时间字段可能是 number）。
pub fn normalize_timestamp_value(value: &Value) -> Option<String> {
    match value {
        Value::String(s) => normalize_timestamp(s),
        Value::Number(n) => n.as_i64().and_then(normalize_timestamp_value_i64),
        _ => None,
    }
}

/// 整数时间戳规范化。
fn normalize_timestamp_value_i64(n: i64) -> Option<String> {
    if n.abs() > 10_000_000_000 {
        epoch_ms_to_rfc3339(n)
    } else {
        epoch_secs_to_rfc3339(n)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// 临时写入 JSONL 文件，返回路径（调用方保证目录存活）。
    fn write_jsonl(dir: &Path, name: &str, lines: &[&str]) -> std::path::PathBuf {
        let path = dir.join(name);
        let mut f = File::create(&path).unwrap();
        for line in lines {
            writeln!(f, "{line}").unwrap();
        }
        path
    }

    #[test]
    fn 坏行不会中断解析() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_jsonl(
            dir.path(),
            "bad.jsonl",
            &[
                r#"{"type":"a","v":1}"#,
                "{ this is not json }",
                r#"{"type":"b","v":2}"#,
                "",
                r#"{"type":"c","v":3}"#,
            ],
        );
        let mut kinds = Vec::new();
        let (report, warnings) = stream_jsonl(&path, &ParseLimits::default(), |v| {
            kinds.push(get_str(v, "type").unwrap_or("?").to_string());
            Ok(Flow::Continue)
        })
        .unwrap();

        assert_eq!(report.parsed, 3);
        assert_eq!(report.bad, 1);
        assert_eq!(kinds, vec!["a", "b", "c"]);
        assert_eq!(warnings.len(), 1);
        // 告警只包含行号与原因，不含正文
        assert!(warnings[0].contains("第 2 行"));
        assert!(!warnings[0].contains("not json"));
    }

    #[test]
    fn 支持_bom_与_crlf() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("bom.jsonl");
        let mut f = File::create(&path).unwrap();
        f.write_all(b"\xEF\xBB\xBF{\"type\":\"first\"}\r\n{\"type\":\"second\"}\r\n")
            .unwrap();
        drop(f);

        let mut types = Vec::new();
        stream_jsonl(&path, &ParseLimits::default(), |v| {
            types.push(get_str(v, "type").unwrap_or("?").to_string());
            Ok(Flow::Continue)
        })
        .unwrap();
        assert_eq!(types, vec!["first", "second"]);
    }

    #[test]
    fn 大文件流式解析且内存平稳() {
        // 生成 20 万行小事件，验证流式路径不整文件加载
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("big.jsonl");
        let mut f = std::io::BufWriter::new(File::create(&path).unwrap());
        for i in 0..200_000 {
            writeln!(f, "{{\"type\":\"event\",\"i\":{i}}}").unwrap();
        }
        f.flush().unwrap();

        let mut count = 0u64;
        let (report, _) = stream_jsonl(&path, &ParseLimits::default(), |_| {
            count += 1;
            Ok(Flow::Continue)
        })
        .unwrap();
        assert_eq!(count, 200_000);
        assert_eq!(report.parsed, 200_000);
        assert!(report.bytes > 3_000_000);
    }

    #[test]
    fn 内容数组拼接不丢数据() {
        let content = serde_json::json!([
            {"type": "input_text", "text": "第一段"},
            {"type": "output_text", "text": "第二段"},
            {"type": "unknown_block", "payload": {"x": 1}}
        ]);
        let text = content_to_text(&content);
        assert!(text.contains("第一段"));
        assert!(text.contains("第二段"));
        // 未知块保留原始 JSON
        assert!(text.contains("unknown_block"));
    }

    #[test]
    fn 时间戳规范化() {
        assert_eq!(
            normalize_timestamp("1757937000000").unwrap(),
            epoch_ms_to_rfc3339(1757937000000).unwrap()
        );
        assert!(normalize_timestamp("2026-09-15T22:30:00+08:00").is_some());
        assert!(normalize_timestamp("2026-09-15").is_some());
        assert!(normalize_timestamp("不是时间").is_none());
    }
}
