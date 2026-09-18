//! Adapter 集成测试：用 `tests/fixtures` 下的合成数据验证 Codex / Kimi 解析行为。
//!
//! 覆盖规格 §25 的重点项：JSONL parser、Kimi Adapter、Codex Adapter、
//! 单行损坏容错、未知事件保留、隐私目录不读取。

use std::path::{Path, PathBuf};

use aichat_core::adapters::{AdapterContext, CodexAdapter, ConversationAdapter, KimiAdapter};
use aichat_core::model::{MessageKind, Role, SourceKind};
use aichat_core::AppSettings;

/// fixture 根目录。
fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/fixtures")
        .canonicalize()
        .expect("fixtures 目录存在")
}

/// 构造指向某个 fixture 的设置。
fn settings_for(source: SourceKind, dir: &str) -> AppSettings {
    let root = fixtures().join(dir).display().to_string();
    let mut settings = AppSettings::default();
    match source {
        SourceKind::Kimi => settings.kimi_path = Some(root),
        SourceKind::Codex => settings.codex_path = Some(root),
        SourceKind::Cursor => settings.cursor_path = Some(root),
        SourceKind::Zcode => settings.zcode_path = Some(root),
    }
    settings
}

/// 解析 fixture 中的第一个（或指定）会话。
fn parse_first(
    adapter: &dyn ConversationAdapter,
    settings: &AppSettings,
    expected_sessions: usize,
) -> aichat_core::model::NormalizedSession {
    let ctx = AdapterContext {
        settings,
        machine_id: "test-machine",
    };
    let descriptors = adapter.scan(&ctx).expect("扫描成功");
    assert_eq!(
        descriptors.len(),
        expected_sessions,
        "会话数量应为 {expected_sessions}"
    );
    adapter.parse(&ctx, &descriptors[0]).expect("解析成功")
}

#[test]
fn kimi_正常会话解析() {
    let settings = settings_for(SourceKind::Kimi, "kimi/normal");
    let adapter = KimiAdapter::new();
    let ctx = AdapterContext {
        settings: &settings,
        machine_id: "test-machine",
    };

    // 探测：应命中手工配置的目录，并且能数出 1 个会话
    let detection = adapter.detect(&ctx);
    assert_eq!(detection.len(), 1);
    assert!(detection[0].found);
    assert!(detection[0].manual);
    assert_eq!(detection[0].session_hint, 1);

    let session = parse_first(&adapter, &settings, 1);
    assert_eq!(session.source, SourceKind::Kimi);
    assert_eq!(
        session.title.as_deref(),
        Some("实现 Redis TTL lazy deletion")
    );
    assert_eq!(
        session.project_path.as_deref(),
        Some("/home/user/projects/demo-project")
    );
    // createdAt / updatedAt 由毫秒时间戳转换而来
    assert!(session.created_at.as_deref().unwrap().starts_with("2025-"));
    assert!(session.updated_at.is_some());

    // 用户消息：prompt.accepted 与 turn.prompt 是同一句，必须只留一条
    let user_messages: Vec<_> = session
        .messages
        .iter()
        .filter(|m| m.role == Role::User && m.kind == MessageKind::Message)
        .collect();
    assert_eq!(
        user_messages.len(),
        2,
        "两条不同用户输入：(prompt 与 append_message)"
    );

    // assistant 文本分片必须合并为一条消息（不是两个碎片）
    let assistant_texts: Vec<_> = session
        .messages
        .iter()
        .filter(|m| m.role == Role::Assistant && m.kind == MessageKind::Message)
        .map(|m| m.text.clone().unwrap_or_default())
        .collect();
    assert_eq!(assistant_texts.len(), 1);
    assert!(assistant_texts[0].contains("watchdog"));
    assert!(assistant_texts[0].contains("lazy deletion"));

    // 推理摘要单独成一条
    assert!(session
        .messages
        .iter()
        .any(|m| m.kind == MessageKind::ReasoningSummary));

    // 工具调用与结果
    let tool_calls: Vec<_> = session
        .messages
        .iter()
        .filter(|m| m.kind == MessageKind::ToolCall)
        .collect();
    assert_eq!(tool_calls.len(), 1);
    assert_eq!(tool_calls[0].tool_name.as_deref(), Some("read_file"));
    assert!(session
        .messages
        .iter()
        .any(|m| m.kind == MessageKind::ToolResult && m.tool_name.is_none()));

    // 未知事件：保留提示 + 标记 partial（规格 §6：不静默丢弃）
    assert!(session.partial, "存在未知事件时应标记 partial");
    assert!(session.messages.iter().any(|m| m.kind == MessageKind::Event
        && m.text.as_deref().unwrap_or("").contains("brand.new.event")));
    let unknown = session
        .metadata
        .get("unknownEventTypes")
        .cloned()
        .unwrap_or_default();
    assert!(unknown.to_string().contains("brand.new.event"));

    // 原始文件：state.json 与主 wire 都在，且绝不包含 credentials
    let roles: Vec<String> = session.raw_files.iter().map(|f| f.role.clone()).collect();
    assert!(roles.contains(&"wire".to_string()));
    assert!(roles.contains(&"state".to_string()));
    for file in &session.raw_files {
        assert!(
            !file.path.to_string_lossy().contains("credentials"),
            "隐私目录不得进入 raw_files: {:?}",
            file.path
        );
    }
}

#[test]
fn kimi_损坏行不影响解析() {
    let settings = settings_for(SourceKind::Kimi, "kimi/malformed-line");
    let adapter = KimiAdapter::new();
    let session = parse_first(&adapter, &settings, 1);

    // 坏行被跳过，其余两行正常解析
    let user_texts: Vec<String> = session
        .messages
        .iter()
        .filter(|m| m.role == Role::User && m.kind == MessageKind::Message)
        .map(|m| m.text.clone().unwrap_or_default())
        .collect();
    assert_eq!(user_texts, vec!["第一句正常内容", "第二句正常内容"]);
    assert!(session.partial, "存在坏行时应标记 partial");
    assert!(session.messages.iter().all(|m| !m
        .text
        .as_deref()
        .unwrap_or("")
        .contains("这一行缺少右括号")
        || m.text.as_deref().unwrap() == "这一行缺少右括号"));
}

#[test]
fn kimi_子agent不进主聊天但被登记() {
    let settings = settings_for(SourceKind::Kimi, "kimi/subagents");
    let adapter = KimiAdapter::new();
    let ctx = AdapterContext {
        settings: &settings,
        machine_id: "test-machine",
    };
    let descriptors = adapter.scan(&ctx).expect("扫描成功");
    assert_eq!(descriptors.len(), 1);

    // 子 Agent 的 wire 登记为 raw 文件（用于备份），但不解析进主聊天
    let subagent_files = descriptors[0]
        .files
        .iter()
        .filter(|f| f.role == "subagent_wire")
        .count();
    assert_eq!(subagent_files, 1);

    let session = adapter.parse(&ctx, &descriptors[0]).expect("解析成功");
    let texts: Vec<String> = session
        .messages
        .iter()
        .filter_map(|m| m.text.clone())
        .collect();
    assert!(texts.iter().any(|t| t.contains("主 Agent 的问题")));
    assert!(
        !texts.iter().any(|t| t.contains("子 Agent 内容")),
        "子 Agent 内容不应出现在主聊天"
    );
    assert_eq!(
        session
            .metadata
            .get("subagentCount")
            .and_then(|v| v.as_i64()),
        Some(1)
    );
}

#[test]
fn codex_正常会话解析() {
    let settings = settings_for(SourceKind::Codex, "codex/normal");
    let adapter = CodexAdapter::new();
    let ctx = AdapterContext {
        settings: &settings,
        machine_id: "test-machine",
    };

    let detection = adapter.detect(&ctx);
    assert!(detection[0].found);
    assert_eq!(detection[0].session_hint, 1);

    let session = parse_first(&adapter, &settings, 1);
    assert_eq!(session.source, SourceKind::Codex);
    // 标题来自 session_index.jsonl 的 thread_name
    assert_eq!(session.title.as_deref(), Some("RESP parser 实现"));
    // 项目路径来自 session_meta.cwd
    assert_eq!(
        session.project_path.as_deref(),
        Some("/home/user/projects/resp-parser")
    );
    assert_eq!(session.model.as_deref(), Some("gpt-5-codex"));
    assert!(!session.partial, "正常 rollout 不应标记 partial");

    // response_item 与 event_msg 双写的同一条消息必须去重
    let user_messages: Vec<_> = session
        .messages
        .iter()
        .filter(|m| m.role == Role::User && m.kind == MessageKind::Message)
        .collect();
    assert_eq!(user_messages.len(), 1, "用户消息应去重");
    assert!(user_messages[0]
        .text
        .as_deref()
        .unwrap()
        .contains("tokenizer"));

    let assistant_messages: Vec<_> = session
        .messages
        .iter()
        .filter(|m| m.role == Role::Assistant && m.kind == MessageKind::Message)
        .collect();
    assert_eq!(assistant_messages.len(), 1, "助手消息应去重");

    // 工具调用与结果、推理摘要
    assert!(session
        .messages
        .iter()
        .any(|m| m.kind == MessageKind::ToolCall && m.tool_name.as_deref() == Some("shell")));
    assert!(session
        .messages
        .iter()
        .any(|m| m.kind == MessageKind::ToolResult
            && m.text.as_deref().unwrap_or("").contains("main.rs")));
    assert!(session
        .messages
        .iter()
        .any(|m| m.kind == MessageKind::ReasoningSummary));

    // 元信息：threadId / cli_version / git 分支
    assert_eq!(
        session.metadata.get("threadId").and_then(|v| v.as_str()),
        Some("019d7b0d-8791-7181-951f-7b0b9c0a6ba7")
    );
    assert!(session.metadata.get("git").is_some());
}

#[test]
fn codex_未知事件与坏行仍可解析() {
    let settings = settings_for(SourceKind::Codex, "codex/unknown-event");
    let adapter = CodexAdapter::new();
    let session = parse_first(&adapter, &settings, 1);

    assert!(session.partial, "未知类型 + 坏行 → partial");
    let texts: Vec<String> = session
        .messages
        .iter()
        .filter_map(|m| m.text.clone())
        .collect();
    assert!(texts.iter().any(|t| t.contains("旧版本 schema 的会话")));
    assert!(
        texts.iter().any(|t| t.contains("仍然能读到这条回答")),
        "坏行之后的合法行仍应解析"
    );
    // 未知类型被计数，便于后续适配
    assert!(session
        .metadata
        .get("unknownEventTypes")
        .map(|v| v.to_string().contains("future_event_type"))
        .unwrap_or(false));
}

#[test]
fn 数据源缺失时给出人话提示() {
    let settings = AppSettings {
        kimi_path: Some("/nonexistent/kimi-home".to_string()),
        ..Default::default()
    };
    let ctx = AdapterContext {
        settings: &settings,
        machine_id: "test",
    };
    // 手工路径不存在时会回退到默认探测；默认目录也不存在时应返回 found=false
    let detection = KimiAdapter::new().detect(&ctx);
    assert_eq!(detection.len(), 1);
    if !detection[0].found {
        assert!(!detection[0].notes.is_empty());
    }
}
