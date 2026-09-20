//! IPC 线上格式契约：JSON 字段名必须和前端 `src/types/ipc.ts` 里声明的一致。
//!
//! 为什么需要这个测试：mock QA 用的是手写的假数据，tsconfig 只检查 TS 内部一致性，
//! 两边都**看不到真实的序列化结果**。一个字段名拼错（`shortHash` vs `short_hash`）
//! 会静默变成 `undefined`，界面上只是少了一行信息，不会报错。
//! 所以这里直接把结构序列化一遍，逐字断言前端的字段名。

use aichat_core::localized::{LocalizedText, NoteSeverity, SourceNote};
use aichat_core::model::DetectionResult;
use aichat_core::storage::types::SourceRow;
use aichat_core::sync::git::GitCommit;

/// 序列化成 JSON 对象（便于按键取值断言）。
fn json_of<T: serde::Serialize>(value: &T) -> serde_json::Value {
    serde_json::to_value(value).expect("序列化")
}

#[test]
fn git_commit_字段名与前端一致() {
    let commit = GitCommit {
        hash: "0123456789abcdef".into(),
        short_hash: "0123456".into(),
        author: "rendegou".into(),
        date: "2026-09-20T11:43:22+08:00".into(),
        refs: "HEAD -> main, origin/main".into(),
        subject: "sync: 写入快照".into(),
        unpushed: true,
    };
    let v = json_of(&commit);
    // 前端的 `GitCommit` 接口读的就是这些名字
    for key in ["hash", "shortHash", "author", "date", "refs", "subject", "unpushed"] {
        assert!(v.get(key).is_some(), "GitCommit 少了字段 {key}：{v}");
    }
    assert_eq!(v["shortHash"], "0123456");
    assert_eq!(v["unpushed"], true);
    assert!(v.get("short_hash").is_none(), "不该出现 snake_case 字段（前端读不到）");
}

#[test]
fn localized_text_与_source_note_的线上格式() {
    let plain = LocalizedText::new("source.note.manualDir", "使用设置中手工指定的目录");
    let v = json_of(&plain);
    assert_eq!(v["code"], "source.note.manualDir");
    assert_eq!(v["fallback"], "使用设置中手工指定的目录");
    // 无参数时不写 params，前端按可选处理
    assert!(v.get("params").is_none(), "没有参数时不该出现空的 params：{v}");

    let with = LocalizedText::with("source.note.dirMissing", "path", "D:/x", "目录不存在或不可读：D:/x");
    let v = json_of(&with);
    assert_eq!(v["params"]["path"], "D:/x", "参数名要和字典里的 {{path}} 占位一致");

    let note = SourceNote::error(LocalizedText::new("source.note.readFailed", "读取失败"));
    let v = json_of(&note);
    // 展开写法：前端把 SourceNote 当作 LocalizedText + severity 来读
    assert_eq!(v["code"], "source.note.readFailed");
    assert_eq!(v["fallback"], "读取失败");
    assert_eq!(v["severity"], "error", "严重程度是小写字符串");

    assert_eq!(json_of(&SourceNote::warn(plain.clone()))["severity"], "warn");
    assert_eq!(json_of(&SourceNote::info(plain))["severity"], "info");
}

#[test]
fn detection_result_的说明是结构化数组() {
    let result = DetectionResult::missing(
        aichat_core::model::SourceKind::Cursor,
        SourceNote::error(LocalizedText::new("source.cursor.missingDir", "未找到 Cursor 数据目录")),
    );
    let v = json_of(&result);
    let notes = v["notes"].as_array().expect("notes 应是数组");
    assert_eq!(notes.len(), 1);
    assert_eq!(notes[0]["code"], "source.cursor.missingDir");
    assert_eq!(notes[0]["severity"], "error");
    assert_eq!(v["found"], false);
    assert!(v["root"].is_null());
}

#[test]
fn source_row_带结构化说明且保持旧字段() {
    let row = SourceRow {
        id: "cursor".into(),
        display_name: "Cursor".into(),
        root_path: None,
        found: false,
        session_hint: 0,
        manual: false,
        notes: Some("未找到 Cursor 数据目录".into()),
        notes_text: vec![SourceNote::error(LocalizedText::new(
            "source.cursor.missingDir",
            "未找到 Cursor 数据目录",
        ))],
        detected_at: None,
    };
    let v = json_of(&row);
    // 前端两种都读：notesText 优先（可翻译），notes 兜底（旧数据）
    assert_eq!(v["notes"], "未找到 Cursor 数据目录");
    assert_eq!(v["notesText"][0]["code"], "source.cursor.missingDir");
    assert_eq!(v["displayName"], "Cursor");
}

#[test]
fn severity_的线上取值稳定且齐全() {
    // 后端拿 severity 取代了「用中文字符串 contains 判断来源状态」的做法
    // （见 docs/ADAPTERS.md 的「数据源分类」），所以这三个取值必须稳定，
    // 且与前端 `SourceNote['severity']` 的联合类型一一对应。
    let values: Vec<String> = [NoteSeverity::Info, NoteSeverity::Warn, NoteSeverity::Error]
        .into_iter()
        .map(|s| json_of(&s).as_str().unwrap_or_default().to_string())
        .collect();
    assert_eq!(values, vec!["info", "warn", "error"]);

    // 最严重的那一条决定来源状态：这个优先级不能改错
    let notes = vec![
        SourceNote::info(LocalizedText::new("a", "a")),
        SourceNote::warn(LocalizedText::new("b", "b")),
    ];
    assert_eq!(
        aichat_core::localized::worst_severity(&notes),
        Some(NoteSeverity::Warn)
    );
    let notes = vec![
        SourceNote::warn(LocalizedText::new("b", "b")),
        SourceNote::error(LocalizedText::new("c", "c")),
    ];
    assert_eq!(
        aichat_core::localized::worst_severity(&notes),
        Some(NoteSeverity::Error)
    );
    assert_eq!(aichat_core::localized::worst_severity(&[]), None);
}
