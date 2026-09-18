//! 会话快照内容寻址去重测试（schema v2）。
//!
//! ≥ `BLOB_THRESHOLD` 的消息文本外置为 `.aichat/blobs/` 内容寻址 blob：
//! 相同文本全仓库只存一份，conversation.jsonl 行以 `textRef` / `textBytes` 引用；
//! 回读端（SyncRepoAdapter）按 textRef 还原文本，blob 缺失时降级为占位文本并标 partial。

use std::path::{Path, PathBuf};

use aichat_core::adapters::repo::SyncRepoAdapter;
use aichat_core::adapters::{AdapterContext, ConversationAdapter, VecSink};
use aichat_core::model::{ParsedSessionInfo, SessionDescriptor, SourceKind, SyncStatus, SYNC_SCHEMA_VERSION};
use aichat_core::storage::sessions::{MessageRow, SessionSummary};
use aichat_core::storage::{Database, SessionStub};
use aichat_core::sync::snapshot::{blob_path, snapshot_session, SnapshotOutcome, BLOB_THRESHOLD};
use aichat_core::AppSettings;

const MACHINE: &str = "machine-test";

/// 写入一个会话（含给定文本的消息），返回快照所需的摘要。
fn add_session(db: &Database, external_id: &str, texts: &[String]) -> SessionSummary {
    let id = format!("kimi:{MACHINE}:{external_id}");
    db.upsert_session_stub(&SessionStub {
        id: id.clone(),
        source: "kimi".into(),
        external_id: external_id.into(),
        machine_id: Some(MACHINE.into()),
        source_root: None,
        primary_file: None,
        sync_status: SyncStatus::Local,
    })
    .expect("写入会话占位");
    let rows: Vec<MessageRow> = texts
        .iter()
        .enumerate()
        .map(|(i, text)| MessageRow {
            id: format!("{id}:m{i}"),
            session_id: id.clone(),
            sequence: i as i64,
            role: "user".into(),
            kind: "message".into(),
            text: Some(text.clone()),
            tool_name: None,
            timestamp: None,
            raw: None,
        })
        .collect();
    db.insert_messages(&rows).expect("写入消息");
    SessionSummary {
        id,
        source: "kimi".into(),
        external_id: external_id.into(),
        title: None,
        project_path: None,
        created_at: None,
        updated_at: None,
        machine_id: Some(MACHINE.into()),
        message_count: texts.len() as i64,
        partial: false,
        archived: false,
        sync_status: "local".into(),
        primary_file: None,
        content_hash: None,
    }
}

/// 会话快照目录。
fn session_dir(repo: &Path, external_id: &str) -> PathBuf {
    repo.join("kimi").join(MACHINE).join(external_id)
}

/// 递归收集 `.aichat/blobs/` 下的 blob 文件。
fn blob_files(repo: &Path) -> Vec<PathBuf> {
    let root = repo.join(".aichat").join("blobs");
    let mut out = Vec::new();
    let mut stack = vec![root];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else {
                out.push(path);
            }
        }
    }
    out.sort();
    out
}

/// 构造仓库会话的描述符（与 SyncRepoAdapter::scan 产物一致）。
fn descriptor(repo: &Path, external_id: &str) -> SessionDescriptor {
    let dir = session_dir(repo, external_id);
    SessionDescriptor {
        source: SourceKind::Kimi,
        external_id: external_id.into(),
        primary_file: dir.join("conversation.jsonl"),
        session_dir: dir,
        title_hint: None,
        project_path: None,
        machine_id: Some(MACHINE.into()),
        files: Vec::new(),
        content_revision: None,
    }
}

/// 通过 SyncRepoAdapter 回读一个会话快照。
fn read_back(repo: &Path, external_id: &str) -> (ParsedSessionInfo, VecSink) {
    let adapter = SyncRepoAdapter::new(repo.display().to_string());
    let settings = AppSettings::default();
    let ctx = AdapterContext {
        settings: &settings,
        machine_id: MACHINE,
    };
    let mut sink = VecSink::default();
    let info = adapter
        .parse_streaming(&ctx, &descriptor(repo, external_id), &mut sink)
        .expect("解析快照");
    (info, sink)
}

#[test]
fn 相同大文本全仓库只存一份blob() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path().join("repo");
    let db = Database::open_in_memory().unwrap();
    // ≥ 5KB 的相同文本（模拟 Codex 注入的 AGENTS.md / 重复读取的工具结果）
    let big = "相同的超大文本片段。".repeat(300);
    assert!(big.len() >= BLOB_THRESHOLD);

    let summary_a = add_session(&db, "sess-a", std::slice::from_ref(&big));
    let summary_b = add_session(&db, "sess-b", std::slice::from_ref(&big));
    assert_eq!(
        snapshot_session(&db, &repo, MACHINE, &summary_a, false).unwrap(),
        SnapshotOutcome::Written("kimi/machine-test/sess-a".into())
    );
    assert!(matches!(
        snapshot_session(&db, &repo, MACHINE, &summary_b, false).unwrap(),
        SnapshotOutcome::Written(_)
    ));

    // blob 只有一份，内容与大文本逐字节一致
    let blobs = blob_files(&repo);
    assert_eq!(blobs.len(), 1, "相同文本应只存一份 blob: {blobs:?}");
    let hash = blake3::hash(big.as_bytes()).to_hex().to_string();
    assert_eq!(blobs[0], blob_path(&repo, &hash));
    assert_eq!(std::fs::read_to_string(&blobs[0]).unwrap(), big);

    // 两份 conversation.jsonl 都是 textRef 行，不内联大文本
    for external_id in ["sess-a", "sess-b"] {
        let jsonl = std::fs::read_to_string(session_dir(&repo, external_id).join("conversation.jsonl"))
            .unwrap();
        assert!(jsonl.contains(&format!("\"textRef\":\"blake3:{hash}\"")), "{jsonl}");
        assert!(jsonl.contains(&format!("\"textBytes\":{}", big.len())), "{jsonl}");
        assert!(!jsonl.contains(&big), "大文本不应内联: {jsonl}");
        assert!(!jsonl.contains("\"text\""), "外置行不应带 text 字段: {jsonl}");
    }

    // meta.json 已升级到 schema v2
    let meta = aichat_core::sync::snapshot::read_meta(
        &session_dir(&repo, "sess-a").join("meta.json"),
    )
    .unwrap();
    assert_eq!(meta.schema_version, SYNC_SCHEMA_VERSION);
}

#[test]
fn 回读按text_ref还原文本() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path().join("repo");
    let db = Database::open_in_memory().unwrap();
    let big = "回读还原文本。".repeat(500);
    let summary = add_session(&db, "sess-read", std::slice::from_ref(&big));
    snapshot_session(&db, &repo, MACHINE, &summary, false).unwrap();

    let (info, sink) = read_back(&repo, "sess-read");
    assert!(!info.partial, "blob 存在时不应 partial: {:?}", info.warnings);
    assert_eq!(sink.messages.len(), 1);
    assert_eq!(sink.messages[0].text.as_deref(), Some(big.as_str()));
}

#[test]
fn blob缺失时回读降级为占位文本() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path().join("repo");
    let db = Database::open_in_memory().unwrap();
    let big = "即将被删除的blob。".repeat(500);
    let summary = add_session(&db, "sess-missing", std::slice::from_ref(&big));
    snapshot_session(&db, &repo, MACHINE, &summary, false).unwrap();

    // 删掉 blob（模拟跨机器拉取时缺失）
    let hash = blake3::hash(big.as_bytes()).to_hex().to_string();
    std::fs::remove_file(blob_path(&repo, &hash)).unwrap();

    let (info, sink) = read_back(&repo, "sess-missing");
    assert!(info.partial, "blob 缺失应标 partial");
    assert_eq!(sink.messages.len(), 1, "其余消息不受影响");
    let text = sink.messages[0].text.as_deref().unwrap();
    assert_eq!(
        text,
        format!("[快照内容缺失:blob {}]", &hash[..12]),
        "应使用占位文本"
    );
    assert!(!info.warnings.is_empty());
}

#[test]
fn 小于阈值的文本保持内联() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path().join("repo");
    let db = Database::open_in_memory().unwrap();
    let small = "短".repeat(BLOB_THRESHOLD / 3 - 1);
    assert!(small.len() < BLOB_THRESHOLD);
    let summary = add_session(&db, "sess-small", std::slice::from_ref(&small));
    snapshot_session(&db, &repo, MACHINE, &summary, false).unwrap();

    assert!(blob_files(&repo).is_empty(), "小于阈值不应产生 blob");
    let jsonl =
        std::fs::read_to_string(session_dir(&repo, "sess-small").join("conversation.jsonl"))
            .unwrap();
    assert!(jsonl.contains("\"text\""), "应保持内联: {jsonl}");
    assert!(!jsonl.contains("textRef"), "{jsonl}");

    let (info, sink) = read_back(&repo, "sess-small");
    assert!(!info.partial);
    assert_eq!(sink.messages[0].text.as_deref(), Some(small.as_str()));
}
