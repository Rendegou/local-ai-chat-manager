//! Cursor / ZCode 适配器集成测试（数据全部合成，不含真实用户内容）。
//!
//! 覆盖：detect / scan / parse 行为、Cursor 的 content_revision 增量短路、
//! ZCode 根目录旁凭证文件不进入任何产物。

use std::path::{Path, PathBuf};

use aichat_core::adapters::{
    AdapterContext, ConversationAdapter, CursorAdapter, ZcodeAdapter,
};
use aichat_core::model::{MessageKind, Role, SourceKind};
use aichat_core::{AppSettings, Library};

mod common;
use common::{empty_dir, isolate_sources};

/// 构造只保留 cursor / zcode 手工路径的设置（其余数据源显式停用，保证测试自包含）。
fn settings_with(
    tmp: &Path,
    cursor_path: Option<&Path>,
    zcode_path: Option<&Path>,
) -> AppSettings {
    let mut settings = AppSettings {
        cursor_path: Some(match cursor_path {
            Some(p) => p.display().to_string(),
            None => empty_dir(tmp, "empty-cursor"),
        }),
        zcode_path: Some(match zcode_path {
            Some(p) => p.display().to_string(),
            None => empty_dir(tmp, "empty-zcode"),
        }),
        ..Default::default()
    };
    // cursor / zcode 由调用方给出路径；codex / kimi 保留但会被钉到空目录
    isolate_sources(&mut settings, tmp, &["codex", "kimi", "cursor", "zcode"]);
    settings
}

// ---------------------------------------------------------------------------
// ZCode
// ---------------------------------------------------------------------------

/// 写入一个合成的 ZCode 会话文件，返回 sessions 根目录。
fn make_zcode_root(tmp: &Path) -> PathBuf {
    let root = tmp.join("zcode-sessions");
    let session_dir = root.join("a1b2c3d4e5f6");
    std::fs::create_dir_all(&session_dir).unwrap();
    std::fs::write(
        session_dir.join("task-0001.json"),
        r#"{
            "meta": {
                "taskId": "task-0001",
                "title": "修复登录页样式",
                "workspacePath": "D:\\projects\\demo",
                "createdAt": 1785123524317,
                "updatedAt": 1785139029924,
                "status": "completed"
            },
            "messages": [
                {"role": "user", "content": "登录页按钮错位了"},
                {"role": "assistant", "content": "我来检查 flex 布局"},
                {"role": "tool", "content": "read_file 结果占位"}
            ]
        }"#,
    )
    .unwrap();
    root
}

#[test]
fn zcode_探测扫描与解析() {
    let tmp = tempfile::tempdir().unwrap();
    let root = make_zcode_root(tmp.path());
    let settings = settings_with(tmp.path(), None, Some(&root));
    let adapter = ZcodeAdapter::new();
    let ctx = AdapterContext {
        settings: &settings,
        machine_id: "test-machine",
    };

    // 探测：命中手工配置目录，数出 1 个会话
    let detection = adapter.detect(&ctx);
    assert_eq!(detection.len(), 1);
    assert!(detection[0].found);
    assert!(detection[0].manual);
    assert_eq!(detection[0].session_hint, 1);

    // 扫描：external_id = 文件名去 .json，content_revision 为空（文件型数据源）
    let descriptors = adapter.scan(&ctx).expect("扫描成功");
    assert_eq!(descriptors.len(), 1);
    assert_eq!(descriptors[0].external_id, "task-0001");
    assert_eq!(descriptors[0].source, SourceKind::Zcode);
    assert!(descriptors[0].content_revision.is_none());
    assert!(descriptors[0].primary_file.ends_with("task-0001.json"));

    // 解析：meta 映射 + 消息角色映射
    let session = adapter.parse(&ctx, &descriptors[0]).expect("解析成功");
    assert_eq!(session.title.as_deref(), Some("修复登录页样式"));
    assert_eq!(session.project_path.as_deref(), Some("D:\\projects\\demo"));
    // 毫秒时间戳 → RFC3339（1785123524317 毫秒 ≈ 2026 年）
    assert!(session.created_at.as_deref().unwrap().starts_with("2026-"));
    assert!(session.updated_at.is_some());

    let roles: Vec<(Role, MessageKind)> = session
        .messages
        .iter()
        .map(|m| (m.role, m.kind))
        .collect();
    assert_eq!(
        roles,
        vec![
            (Role::User, MessageKind::Message),
            (Role::Assistant, MessageKind::Message),
            // 未知 role（tool）映射为事件消息，并计入 unknown_events
            (Role::Unknown, MessageKind::Event),
        ]
    );
    assert!(session.partial, "未知 role 应标记 partial");
    assert_eq!(
        session
            .metadata
            .get("format")
            .and_then(|v| v.as_str()),
        Some("zcode/session")
    );
}

#[test]
fn zcode_标题兜底用首条用户消息() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("zcode-sessions");
    let session_dir = root.join("beefbeef");
    std::fs::create_dir_all(&session_dir).unwrap();
    std::fs::write(
        session_dir.join("task-0002.json"),
        r#"{
            "meta": {"taskId": "task-0002", "createdAt": 1785123524317},
            "messages": [{"role": "user", "content": "没有标题时的兜底标题"}]
        }"#,
    )
    .unwrap();

    let settings = settings_with(tmp.path(), None, Some(&root));
    let adapter = ZcodeAdapter::new();
    let ctx = AdapterContext {
        settings: &settings,
        machine_id: "test-machine",
    };
    let descriptors = adapter.scan(&ctx).unwrap();
    let session = adapter.parse(&ctx, &descriptors[0]).unwrap();
    assert_eq!(session.title.as_deref(), Some("没有标题时的兜底标题"));
}

#[test]
fn zcode_凭证文件不被读取或登记() {
    let tmp = tempfile::tempdir().unwrap();
    let root = make_zcode_root(tmp.path());
    // 在 sessions 根下伪造一个凭证目录（真实环境里凭证在 ~/.zcode/v2/ 下，
    // 这里验证的是：任何命中隐私红线的路径都不会进入扫描结果）
    let cred_dir = root.join("credentials");
    std::fs::create_dir_all(&cred_dir).unwrap();
    std::fs::write(cred_dir.join("task-secret.json"), r#"{"meta":{},"messages":[]}"#).unwrap();

    let settings = settings_with(tmp.path(), None, Some(&root));
    let adapter = ZcodeAdapter::new();
    let ctx = AdapterContext {
        settings: &settings,
        machine_id: "test-machine",
    };
    let descriptors = adapter.scan(&ctx).unwrap();
    assert_eq!(descriptors.len(), 1, "凭证目录下的 json 不得进入扫描结果");
    let session = adapter.parse(&ctx, &descriptors[0]).unwrap();
    for file in &session.raw_files {
        assert!(
            !file.path.to_string_lossy().contains("credentials"),
            "凭证路径不得进入 raw_files: {:?}",
            file.path
        );
    }
}

// ---------------------------------------------------------------------------
// Cursor
// ---------------------------------------------------------------------------

/// 合成一个 Cursor state.vscdb（composerHeaders + cursorDiskKV），返回 globalStorage 目录。
fn make_cursor_root(tmp: &Path) -> PathBuf {
    let root = tmp.join("cursor-globalStorage");
    std::fs::create_dir_all(&root).unwrap();
    let db_path = root.join("state.vscdb");
    let conn = rusqlite::Connection::open(&db_path).unwrap();
    conn.execute_batch(
        "CREATE TABLE composerHeaders(
            composerId TEXT PRIMARY KEY, workspaceId TEXT, createdAt INTEGER,
            lastUpdatedAt INTEGER, isArchived INTEGER, isSubagent INTEGER,
            recency INTEGER, checkpointAt INTEGER, value TEXT
        );
        CREATE TABLE cursorDiskKV(key TEXT, value BLOB);",
    )
    .unwrap();

    // 正常会话（value JSON 里带标题）
    conn.execute(
        "INSERT INTO composerHeaders VALUES(?1,'ws-1',1785123524317,1785139029924,0,0,0,NULL,?2)",
        rusqlite::params![
            "composer-a",
            r#"{"name":"重构状态管理","unifiedMode":"agent"}"#
        ],
    )
    .unwrap();
    // 已归档会话：不得出现在扫描结果
    conn.execute(
        "INSERT INTO composerHeaders VALUES('composer-archived','ws-1',1785123524317,1785139029924,1,0,0,NULL,'{}')",
        [],
    )
    .unwrap();
    // 草稿占位行：必须排除
    conn.execute(
        "INSERT INTO composerHeaders VALUES('empty-state-draft','ws-1',1785123524317,1785139029924,0,0,0,NULL,'{}')",
        [],
    )
    .unwrap();

    // bubble：key 故意与 createdAt 顺序错位，验证按时间戳排序
    let bubbles = [
        ("bubbleId:composer-a:zz-later", r#"{"type":2,"text":"先看 store 结构","createdAt":"2026-07-27T10:00:02.000Z"}"#),
        ("bubbleId:composer-a:aa-first", r#"{"type":1,"text":"帮我把组件状态迁到 zustand","createdAt":"2026-07-27T10:00:00.000Z"}"#),
        ("bubbleId:composer-a:mm-mid", r#"{"type":2,"text":"","thinking":{"text":"先梳理依赖"},"toolFormerData":{"name":"read_file","params":"{\"path\":\"store.ts\"}","result":"文件内容占位"},"createdAt":"2026-07-27T10:00:01.000Z"}"#),
    ];
    for (key, value) in bubbles {
        conn.execute(
            "INSERT INTO cursorDiskKV VALUES(?1, ?2)",
            rusqlite::params![key, value.as_bytes()],
        )
        .unwrap();
    }
    root
}

#[test]
fn cursor_探测扫描与解析() {
    let tmp = tempfile::tempdir().unwrap();
    let root = make_cursor_root(tmp.path());
    let settings = settings_with(tmp.path(), Some(&root), None);
    let adapter = CursorAdapter::new();
    let ctx = AdapterContext {
        settings: &settings,
        machine_id: "test-machine",
    };

    // 探测：能只读打开、有 composerHeaders 表、只数未归档会话
    let detection = adapter.detect(&ctx);
    assert_eq!(detection.len(), 1);
    assert!(detection[0].found);
    assert!(detection[0].manual);
    assert_eq!(detection[0].session_hint, 1, "已归档与草稿不计入");

    // 扫描
    let descriptors = adapter.scan(&ctx).expect("扫描成功");
    assert_eq!(descriptors.len(), 1);
    let d = &descriptors[0];
    assert_eq!(d.external_id, "composer-a");
    assert_eq!(d.source, SourceKind::Cursor);
    assert_eq!(d.title_hint.as_deref(), Some("重构状态管理"));
    // content_revision = lastUpdatedAt（毫秒字符串），作为增量短路依据
    assert_eq!(d.content_revision.as_deref(), Some("1785139029924"));
    // 伪路径：db 路径 + #composerId，且不命中隐私红线
    let pseudo = d.primary_file.to_string_lossy().to_string();
    assert!(pseudo.ends_with("#composer-a"));
    assert!(!aichat_core::paths::is_forbidden_path(&d.primary_file));
    assert!(d.files.is_empty(), "db 行没有可复制文件");

    // 解析：按 createdAt 排序（user → thinking/工具 → 正文）
    let session = adapter.parse(&ctx, d).expect("解析成功");
    assert_eq!(session.title.as_deref(), Some("重构状态管理"));
    assert!(session.created_at.as_deref().unwrap().starts_with("2026-07-27"));
    assert!(session.updated_at.is_some());

    let kinds: Vec<(Role, MessageKind)> = session
        .messages
        .iter()
        .map(|m| (m.role, m.kind))
        .collect();
    assert_eq!(
        kinds,
        vec![
            (Role::User, MessageKind::Message),
            (Role::Assistant, MessageKind::ReasoningSummary),
            (Role::Assistant, MessageKind::ToolCall),
            (Role::Tool, MessageKind::ToolResult),
            (Role::Assistant, MessageKind::Message),
        ],
        "消息必须按 bubble 内 createdAt 排序，而非 key 字典序"
    );
    let tool_call = session
        .messages
        .iter()
        .find(|m| m.kind == MessageKind::ToolCall)
        .unwrap();
    assert_eq!(tool_call.tool_name.as_deref(), Some("read_file"));
    assert!(!session.partial);
    assert_eq!(
        session.metadata.get("format").and_then(|v| v.as_str()),
        Some("cursor/state.vscdb")
    );
}

#[test]
fn cursor_未知bubble类型保留为事件() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("cursor-globalStorage");
    std::fs::create_dir_all(&root).unwrap();
    let conn = rusqlite::Connection::open(root.join("state.vscdb")).unwrap();
    conn.execute_batch(
        "CREATE TABLE composerHeaders(
            composerId TEXT PRIMARY KEY, workspaceId TEXT, createdAt INTEGER,
            lastUpdatedAt INTEGER, isArchived INTEGER, isSubagent INTEGER,
            recency INTEGER, checkpointAt INTEGER, value TEXT
        );
        CREATE TABLE cursorDiskKV(key TEXT, value BLOB);
        INSERT INTO composerHeaders VALUES('composer-x','ws',NULL,NULL,0,0,0,NULL,'{}');
        INSERT INTO cursorDiskKV VALUES('bubbleId:composer-x:b1', '{\"type\":1,\"text\":\"问题\"}');
        INSERT INTO cursorDiskKV VALUES('bubbleId:composer-x:b2', '{\"type\":7,\"text\":\"未来版本的气泡\"}');",
    )
    .unwrap();

    let settings = settings_with(tmp.path(), Some(&root), None);
    let adapter = CursorAdapter::new();
    let ctx = AdapterContext {
        settings: &settings,
        machine_id: "test-machine",
    };
    let descriptors = adapter.scan(&ctx).unwrap();
    // 实测存在 lastUpdatedAt / createdAt 均为 NULL 的 composer：revision 兜底为 "0"，
    // 保证依然走 revision 短路而不是对伪路径做文件哈希
    assert_eq!(descriptors[0].content_revision.as_deref(), Some("0"));
    let session = adapter.parse(&ctx, &descriptors[0]).unwrap();

    assert!(session.partial, "未知 bubble type 应标记 partial");
    assert!(session.messages.iter().any(|m| m.kind == MessageKind::Event
        && m.text.as_deref().unwrap_or("").contains("未来版本的气泡")));
}

#[test]
fn cursor_内容版本号驱动增量扫描() {
    let tmp = tempfile::tempdir().unwrap();
    let root = make_cursor_root(tmp.path());
    let data_dir = tmp.path().join("data");
    let settings = settings_with(tmp.path(), Some(&root), None);
    settings.save(&data_dir).unwrap();
    let library = Library::open(&data_dir).expect("打开核心库");

    // 首次扫描：解析 1 个会话
    let report = library.scan(false, &mut |_| {}).expect("首次扫描");
    assert_eq!(report.parsed, 1);
    assert_eq!(report.failed, 0);

    // revision 不变：第二次扫描短路跳过（不重解析）
    let report = library.scan(false, &mut |_| {}).expect("二次扫描");
    assert_eq!(report.parsed, 0);
    assert_eq!(report.skipped, 1);

    // 模拟 Cursor 更新了会话：lastUpdatedAt 变化 → 重新解析
    let conn = rusqlite::Connection::open(root.join("state.vscdb")).unwrap();
    conn.execute(
        "UPDATE composerHeaders SET lastUpdatedAt = 1785999999999 WHERE composerId = 'composer-a'",
        [],
    )
    .unwrap();
    drop(conn);
    let report = library.scan(false, &mut |_| {}).expect("三次扫描");
    assert_eq!(report.parsed, 1, "revision 变化应触发重解析");
    assert_eq!(report.failed, 0);
}
