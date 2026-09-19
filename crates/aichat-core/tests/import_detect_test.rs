//! 导入自动识别测试。
//!
//! 这里覆盖的是「用户把别处的数据丢进来」这条路径。识别总是猜测，所以每个用例
//! 除了断言解析结果，也断言**识别成了什么格式** —— 界面会把这句话显示给用户，
//! 猜错时必须让人看得见，而不是导入出一堆半截消息才被发现。

use aichat_core::imports::{parse_input, partial, ImportFormat};

/// 解析并返回（识别格式，会话数，首个会话的消息数）。
fn detect(source: &str, text: &str) -> (ImportFormat, usize, usize) {
    let (package, _warnings, format) = parse_input(source, text).expect("应该能识别");
    (format, package.sessions.len(), package.sessions[0].messages.len())
}

#[test]
fn 标准会话包按原样解析() {
    let text = r#"{"schemaVersion":1,"sessions":[{"source":"myagent","externalId":"a1","title":"T",
        "messages":[{"role":"user","text":"你好"},{"role":"assistant","text":"你好，有什么可以帮你的"}]}]}"#;
    let (format, sessions, messages) = detect("myagent", text);
    assert_eq!(format, ImportFormat::Package);
    assert_eq!(sessions, 1);
    assert_eq!(messages, 2);
}

#[test]
fn messages_数组对象被识别() {
    let text = r#"{"title":"迁移过来的会话","model":"gpt-4o",
        "messages":[{"role":"user","content":"第一个问题"},{"role":"assistant","content":"第一个回答"}]}"#;
    let (format, sessions, messages) = detect("myagent", text);
    assert_eq!(format, ImportFormat::MessagesObject);
    assert_eq!(sessions, 1);
    assert_eq!(messages, 2);
    let (package, _, _) = parse_input("myagent", text).unwrap();
    assert_eq!(package.sessions[0].title.as_deref(), Some("迁移过来的会话"));
}

#[test]
fn 顶层消息数组被识别() {
    let text = r#"[{"role":"user","text":"问题"},{"role":"assistant","text":"回答"},{"role":"system","text":"规则"}]"#;
    let (format, sessions, messages) = detect("myagent", text);
    assert_eq!(format, ImportFormat::MessageArray);
    assert_eq!(sessions, 1);
    assert_eq!(messages, 3);
}

#[test]
fn 顶层会话数组被识别成多个会话() {
    let text = r#"[{"id":"s1","messages":[{"role":"user","text":"A"}]},
                   {"id":"s2","messages":[{"role":"user","text":"B"}]}]"#;
    let (format, sessions, messages) = detect("myagent", text);
    assert_eq!(format, ImportFormat::MessageArray);
    assert_eq!(sessions, 2);
    assert_eq!(messages, 1);
    let (package, _, _) = parse_input("myagent", text).unwrap();
    assert_eq!(package.sessions[0].external_id.as_deref(), Some("s1"));
    assert_eq!(package.sessions[1].external_id.as_deref(), Some("s2"));
}

#[test]
fn jsonl_转录被识别() {
    let text = r#"{"role":"user","content":"第一行","timestamp":"2026-09-01T10:00:00Z"}
{"role":"assistant","content":"第二行","timestamp":"2026-09-01T10:00:05Z"}
{"role":"user","content":"第三行","timestamp":"2026-09-01T10:00:10Z"}"#;
    let (format, sessions, messages) = detect("myagent", text);
    assert_eq!(format, ImportFormat::Jsonl);
    assert_eq!(sessions, 1);
    assert_eq!(messages, 3);
    let (package, _, _) = parse_input("myagent", text).unwrap();
    assert_eq!(package.sessions[0].messages[1].timestamp.as_deref(), Some("2026-09-01T10:00:05Z"));
}

#[test]
fn claude_转录被识别且内容块被展平() {
    // 结构签名：顶层 type + message.content 块数组；正文在块的 text 字段里
    let text = r#"{"type":"user","uuid":"u1","timestamp":"2026-09-01T10:00:00Z","message":{"role":"user","content":[{"type":"text","text":"问题一"}]}}
{"type":"assistant","uuid":"a1","parentUuid":"u1","timestamp":"2026-09-01T10:00:05Z","message":{"role":"assistant","content":[{"type":"text","text":"回答一"},{"type":"thinking","thinking":"想一下"}]}}"#;
    let (format, sessions, messages) = detect("myagent", text);
    assert_eq!(format, ImportFormat::ClaudeTranscript, "应当按结构签名认成 Claude 转录");
    assert_eq!(sessions, 1);
    // 只展平带 text 的块；thinking 块没有 text，不会被当成正文
    assert_eq!(messages, 2);
    let (package, _, _) = parse_input("myagent", text).unwrap();
    assert_eq!(package.sessions[0].messages[0].text, "问题一");
    assert_eq!(package.sessions[0].messages[1].text, "回答一");
}

#[test]
fn markdown_模板仍是兜底() {
    let text = "# 会话标题\n\n## user\n第一句\n\n## assistant\n第二句\n";
    let (format, sessions, messages) = detect("myagent", text);
    assert_eq!(format, ImportFormat::Markdown);
    assert_eq!(sessions, 1);
    assert_eq!(messages, 2);
}

#[test]
fn 未知角色保留为事件而不是丢弃() {
    let text = r#"[{"role":"user","text":"问题"},{"role":"plugin","text":"来自某个插件的内容"}]"#;
    let (package, _, format) = parse_input("myagent", text).unwrap();
    assert_eq!(format, ImportFormat::MessageArray);
    let session = &package.sessions[0];
    assert_eq!(session.messages.len(), 2, "认不出角色的消息也要保留");
    assert_eq!(session.messages[1].role, "unknown");
    assert_eq!(session.messages[1].kind, "event");
    assert_eq!(session.messages[1].text, "来自某个插件的内容");
    // partial 置位后界面会提示「部分解析」，而不是假装一切正常
    assert!(partial(session));
}

#[test]
fn 取值宽松覆盖常见字段别名() {
    let text = r#"[{"author":{"role":"model"},"content":"别名角色的回答"},
                   {"sender":"human","text":"别名发送者的提问"}]"#;
    let (package, _, _) = parse_input("myagent", text).unwrap();
    let messages = &package.sessions[0].messages;
    assert_eq!(messages[0].role, "assistant", "author.role = model 应归一为 assistant");
    assert_eq!(messages[1].role, "user", "sender = human 应归一为 user");
}

#[test]
fn 拿不出消息的输入给出人话错误() {
    // 一段不像转录的 JSONL：命中率不足，既不该被硬塞成会话，也不该静默成功
    let text = "{\"level\":\"info\",\"msg\":\"starting\"}\n{\"level\":\"warn\",\"msg\":\"slow\"}";
    let error = parse_input("myagent", text).expect_err("不该识别成会话");
    let message = error.user_message();
    assert!(
        message.contains("无法识别角色") || message.contains("没有识别出任何消息") || message.contains("没有可导入的会话"),
        "错误信息要说清为什么不行，实际是：{message}"
    );

    // 完全是垃圾的输入同样要报错而不是 panic
    assert!(parse_input("myagent", "@@@ not json @@@").is_err());
}

#[test]
fn 非法来源标识被拒绝() {
    assert!(parse_input("Bad Source!", "[{\"role\":\"user\",\"text\":\"x\"}]").is_err());
}
