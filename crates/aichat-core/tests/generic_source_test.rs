//! 用户自定义来源（通用 JSONL / JSON）测试。
//!
//! 这条路径的用户是「用一个我们没适配的工具的人」。它必须满足两件事：
//! 1. 映射填对了，数据能正确读出来（含增量重扫）；
//! 2. **映射填错了，必须明确报错**——静默建一个空会话会让人以为接上了，
//!    扫描完才发现什么都没有，那时已经不知道错在哪了。

use std::path::{Path, PathBuf};

use aichat_core::adapters::generic::GenericJsonAdapter;
use aichat_core::adapters::{AdapterContext, ConversationAdapter};
use aichat_core::model::{MessageKind, Role};
use aichat_core::settings::{AppSettings, FieldMapping, SourceConfig};
use aichat_core::{AppSettings as Settings, Library};

mod common;
use common::isolate_sources;

/// 写一个文件（自动建父目录）。
fn write(path: &Path, content: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, content).unwrap();
}

/// 默认的 JSONL 映射。
fn jsonl_mapping() -> FieldMapping {
    FieldMapping { layout: "jsonl".into(), extensions: vec!["jsonl".into()], ..Default::default() }
}

fn json_mapping(path: &str) -> FieldMapping {
    FieldMapping {
        layout: "json".into(),
        messages_path: path.into(),
        extensions: vec!["json".into()],
        ..Default::default()
    }
}

fn adapter(root: &Path, mapping: FieldMapping) -> GenericJsonAdapter {
    GenericJsonAdapter::new("myagent", "My Agent", root.to_path_buf(), mapping).expect("合法 id")
}

/// 空 context（通用适配器不读 ctx——目录与映射都在实例上）。
fn ctx(settings: &AppSettings) -> AdapterContext<'_> {
    AdapterContext { settings, machine_id: "test" }
}

// ---------------------------------------------------------------------------
// 正确映射：能读出来
// ---------------------------------------------------------------------------

#[test]
fn jsonl_标准形状按行读出消息() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("sessions");
    write(
        &root.join("chat-a.jsonl"),
        r#"{"role":"user","content":"第一个问题","timestamp":"2026-09-01T10:00:00Z"}
{"role":"assistant","content":"第一个回答","timestamp":"2026-09-01T10:00:05Z"}
{"role":"user","content":"追问","timestamp":"2026-09-01T10:01:00Z"}
"#,
    );

    let settings = Settings::default();
    let adapter = adapter(&root, jsonl_mapping());
    let descriptors = adapter.scan(&ctx(&settings)).unwrap();
    assert_eq!(descriptors.len(), 1);
    assert_eq!(descriptors[0].external_id, "chat-a");
    assert_eq!(descriptors[0].source.as_str(), "myagent");

    let session = adapter.parse(&ctx(&settings), &descriptors[0]).unwrap();
    assert_eq!(session.messages.len(), 3);
    assert_eq!(session.messages[0].role, Role::User);
    assert_eq!(session.messages[0].text.as_deref(), Some("第一个问题"));
    assert_eq!(session.messages[1].role, Role::Assistant);
    // 标题从首条用户消息派生
    assert_eq!(session.title.as_deref(), Some("第一个问题"));
    assert_eq!(session.created_at.as_deref(), Some("2026-09-01T10:00:00Z"));
    assert_eq!(session.updated_at.as_deref(), Some("2026-09-01T10:01:00Z"));
}

#[test]
fn json_布局按数组路径下钻() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("sessions");
    write(
        &root.join("s1.json"),
        r#"{"title":"会话一","data":{"items":[
            {"role":"user","content":"问","timestamp":"2026-09-01T10:00:00Z"},
            {"role":"assistant","content":"答","timestamp":"2026-09-01T10:00:05Z"}]}}"#,
    );

    let settings = Settings::default();
    let adapter = adapter(&root, json_mapping("data.items"));
    let descriptors = adapter.scan(&ctx(&settings)).unwrap();
    assert_eq!(descriptors.len(), 1);

    let session = adapter.parse(&ctx(&settings), &descriptors[0]).unwrap();
    assert_eq!(session.messages.len(), 2);
    assert_eq!(session.messages[1].text.as_deref(), Some("答"));
}

#[test]
fn 字段名与正文形态都可以自定义() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("sessions");
    // 非标准字段名 + 内容块数组（Anthropic 形）
    write(
        &root.join("s.jsonl"),
        r#"{"author":"human","payload":{"content":[{"type":"text","text":"块里的正文"}]}}
{"author":"assistant","payload":{"content":[{"type":"text","text":"两段"},{"type":"text","text":"拼接"}]}}
"#,
    );

    let settings = Settings::default();
    let mapping = FieldMapping {
        role_field: "author".into(),
        text_field: "payload.content".into(),
        ..jsonl_mapping()
    };
    let session = {
        let a = adapter(&root, mapping);
        let d = a.scan(&ctx(&settings)).unwrap();
        a.parse(&ctx(&settings), &d[0]).unwrap()
    };
    assert_eq!(session.messages.len(), 2);
    assert_eq!(session.messages[0].text.as_deref(), Some("块里的正文"));
    // 多个文本块拼成一條
    assert_eq!(session.messages[1].text.as_deref(), Some("两段\n拼接"));
}

#[test]
fn 角色映射把自定义角色名归一到标准角色() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("sessions");
    write(
        &root.join("s.jsonl"),
        r#"{"role":"human","content":"问"}
{"role":"bot","content":"答"}
"#,
    );

    let settings = Settings::default();
    let mut mapping = jsonl_mapping();
    mapping.role_map.insert("bot".into(), "assistant".into());
    mapping.role_map.insert("human".into(), "user".into());
    let a = adapter(&root, mapping);
    let d = a.scan(&ctx(&settings)).unwrap();
    let session = a.parse(&ctx(&settings), &d[0]).unwrap();
    assert_eq!(session.messages[0].role, Role::User);
    assert_eq!(session.messages[1].role, Role::Assistant);
    assert!(!session.partial, "映射覆盖到的角色不该被标成 partial");
}

#[test]
fn 未知角色保留为事件并标记_partial() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("sessions");
    write(
        &root.join("s.jsonl"),
        r#"{"role":"user","content":"问"}
{"role":"plugin","content":"某个插件写的内容"}
"#,
    );

    let settings = Settings::default();
    let a = adapter(&root, jsonl_mapping());
    let d = a.scan(&ctx(&settings)).unwrap();
    let session = a.parse(&ctx(&settings), &d[0]).unwrap();
    assert_eq!(session.messages.len(), 2, "认不出角色的内容也不能丢");
    assert_eq!(session.messages[1].role, Role::Unknown);
    assert_eq!(session.messages[1].kind, MessageKind::Event);
    assert!(session.partial, "未知角色应标记 partial，界面才会提示「部分解析」");
}

#[test]
fn 监视扩展名取自映射而不是静态目录() {
    let tmp = tempfile::tempdir().unwrap();
    let mapping = FieldMapping { extensions: vec![".chat".into(), "LOG".into()], ..jsonl_mapping() };
    let a = adapter(&tmp.path().join("x"), mapping);
    assert_eq!(
        a.watch_extensions(),
        vec!["chat".to_string(), "log".to_string()],
        "自定义来源不在静态 catalog 里，默认实现会静默退回 json/jsonl，必须覆写"
    );
}

#[test]
fn 按扩展名过滤且忽略其它文件() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("sessions");
    write(&root.join("a.jsonl"), "{\"role\":\"user\",\"content\":\"要读的\"}\n");
    write(&root.join("b.txt"), "不该被读到\n");
    write(&root.join("c.json"), "{\"role\":\"user\",\"content\":\"扩展名不匹配\"}");

    let settings = Settings::default();
    let a = adapter(&root, jsonl_mapping());
    let descriptors = a.scan(&ctx(&settings)).unwrap();
    assert_eq!(descriptors.len(), 1);
    assert!(descriptors[0].primary_file.ends_with("a.jsonl"));
}

#[test]
fn 同名文件在不同子目录不会撞会话主键() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("sessions");
    write(&root.join("proj-a/session.jsonl"), "{\"role\":\"user\",\"content\":\"A\"}\n");
    write(&root.join("proj-b/session.jsonl"), "{\"role\":\"user\",\"content\":\"B\"}\n");

    let settings = Settings::default();
    let a = adapter(&root, jsonl_mapping());
    let descriptors = a.scan(&ctx(&settings)).unwrap();
    assert_eq!(descriptors.len(), 2);
    let ids: std::collections::HashSet<String> =
        descriptors.iter().map(|d| d.session_id()).collect();
    assert_eq!(ids.len(), 2, "两个 session.jsonl 必须得到不同的会话主键，否则会互相覆盖");
}

// ---------------------------------------------------------------------------
// 错误映射：必须明确报错，不能静默成功
// ---------------------------------------------------------------------------

#[test]
fn 正文字段写错时报明确错误而不是空会话() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("sessions");
    write(&root.join("s.jsonl"), r#"{"role":"user","content":"真的有内容"}"#);

    let settings = Settings::default();
    let mapping = FieldMapping { text_field: "不存在的字段".into(), ..jsonl_mapping() };
    let a = adapter(&root, mapping);
    let d = a.scan(&ctx(&settings)).unwrap();
    let error = a.parse(&ctx(&settings), &d[0]).expect_err("字段名写错必须报错");
    let message = error.user_message();
    assert!(
        message.contains("正文字段") && message.contains("键名"),
        "错误信息要指向该改哪个字段，实际是：{message}"
    );
}

#[test]
fn 数组路径写错时报明确错误() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("sessions");
    write(
        &root.join("s.json"),
        r#"{"messages":[{"role":"user","content":"在 messages 下"}]}"#,
    );

    let settings = Settings::default();
    // 路径写成别的字段 → 顶层也不是数组 → 报「找不到数组」
    let a = adapter(&root, json_mapping("data.items"));
    let d = a.scan(&ctx(&settings)).unwrap();
    let error = a.parse(&ctx(&settings), &d[0]).expect_err("数组路径写错必须报错");
    assert!(error.user_message().contains("data.items"), "错误里要回显用户填的路径：{}", error.user_message());
}

#[test]
fn 试解析汇总文件数与会话数并在全失败时给出告警() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("sessions");
    write(&root.join("good.jsonl"), "{\"role\":\"user\",\"content\":\"ok\"}\n");
    write(&root.join("bad.jsonl"), "{\"kind\":\"note\",\"body\":\"没有角色也没有正文\"}\n");

    let settings = Settings::default();

    // 全对的映射：文件数 2，采样 1 成功 + 1 失败（bad 里的字段名对不上）
    let ok = adapter(&root, jsonl_mapping()).sample();
    assert_eq!(ok.files_found, 2);
    assert_eq!(ok.sessions_sampled, 1);
    assert_eq!(ok.messages, 1);
    assert_eq!(ok.samples[0].messages[0].text, "ok");
    assert_eq!(ok.warnings.len(), 1, "失败的那个文件要进告警，而不是让整次试解析失败");

    // 映射填错：一个会话都读不出来，告警要说清原因
    let mapping = FieldMapping { text_field: "不存在的字段".into(), ..jsonl_mapping() };
    let bad = adapter(&root, mapping).sample();
    assert_eq!(bad.sessions_sampled, 0);
    assert_eq!(bad.messages, 0);
    assert_eq!(bad.warnings.len(), 2);
    assert!(bad.warnings[0].contains("键名"));
    let _ = settings;
}

// ---------------------------------------------------------------------------
// 与索引层串联：能扫进库、能增量
// ---------------------------------------------------------------------------

/// 把自定义来源写进设置并建库。
fn library_with_custom(root: &Path, mapping: FieldMapping) -> (tempfile::TempDir, Library) {
    let tmp = tempfile::tempdir().unwrap();
    let data = tmp.path().join("data");
    let mut settings = AppSettings {
        sources: [(
            "myagent".to_string(),
            SourceConfig {
                enabled: true,
                path: Some(root.display().to_string()),
                display_name: Some("My Agent".to_string()),
                mapping: Some(mapping),
            },
        )]
        .into_iter()
        .collect(),
        ..Default::default()
    };
    isolate_sources(&mut settings, tmp.path(), &[]);
    settings.save(&data).unwrap();
    let library = Library::open(&data).expect("打开核心库");
    (tmp, library)
}

#[test]
fn 自定义来源能被扫描索引并显示名生效() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("sessions");
    write(
        &root.join("s1.jsonl"),
        "{\"role\":\"user\",\"content\":\"来自自定义来源\"}\n{\"role\":\"assistant\",\"content\":\"收到\"}\n",
    );

    let (_t, library) = library_with_custom(&root, jsonl_mapping());
    let report = library.scan(false, &mut |_| {}).expect("扫描");
    assert_eq!(report.parsed, 1, "自定义来源应被扫描到");

    // 设置里的显示名要生效（它不在静态 catalog 里，只能从设置读）
    let rows = library.list_sources().unwrap();
    let row = rows.iter().find(|r| r.id == "myagent").expect("sources 里应有自定义来源");
    assert_eq!(row.display_name, "My Agent");
    assert!(row.found, "目录里有文件，found 应为 true");
    assert!(row.manual, "自定义来源是用户手工配置的");

    let sessions = library
        .list_sessions(&aichat_core::storage::sessions::SessionFilter::default(), 20, 0)
        .unwrap();
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0].source, "myagent");
    assert_eq!(sessions[0].title.as_deref(), Some("来自自定义来源"));
}

#[test]
fn 自定义来源走指纹增量_未改则跳过改了则重解析() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("sessions");
    let file = root.join("s1.jsonl");
    write(&file, "{\"role\":\"user\",\"content\":\"第一版\"}\n");

    let (_t, library) = library_with_custom(&root, jsonl_mapping());
    let first = library.scan(false, &mut |_| {}).expect("首次扫描");
    assert_eq!(first.parsed, 1);

    // 内容与 mtime 都没变 → 第二次应短路跳过
    let second = library.scan(false, &mut |_| {}).expect("二次扫描");
    assert_eq!(second.parsed, 0);
    assert_eq!(second.skipped, 1);

    // 改内容（并确保 mtime 前进）→ 重新解析
    std::thread::sleep(std::time::Duration::from_millis(1100));
    write(&file, "{\"role\":\"user\",\"content\":\"第二版更长的内容\"}\n");
    let third = library.scan(false, &mut |_| {}).expect("三次扫描");
    assert_eq!(third.parsed, 1, "文件变了应该重新解析");
}

#[test]
fn 目录不存在时探测结果如实报告未发现() {
    let tmp = tempfile::tempdir().unwrap();
    let mapping = jsonl_mapping();
    let a = adapter(&tmp.path().join("does-not-exist"), mapping);
    let settings = Settings::default();
    let detections = a.detect(&ctx(&settings));
    assert_eq!(detections.len(), 1);
    assert!(!detections[0].found);
    assert!(detections[0].root.is_none());
    assert!(
        detections[0]
            .notes
            .iter()
            .any(|n| n.text.code == "source.note.dirMissing"),
        "要说清为什么没发现，实际：{:?}",
        detections[0].notes
    );
}

#[test]
fn 目录里没有匹配文件时探测给出可行动的原因() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("sessions");
    std::fs::create_dir_all(&root).unwrap();
    write(&root.join("readme.md"), "只有这个文件");

    let settings = Settings::default();
    let a = adapter(&root, jsonl_mapping());
    let detections = a.detect(&ctx(&settings));
    assert!(!detections[0].found);
    assert_eq!(detections[0].session_hint, 0);
    assert!(
        detections[0]
            .notes
            .iter()
            .any(|n| n.text.text().contains("jsonl")),
        "提示里要写清在找什么扩展名，实际：{:?}",
        detections[0].notes
    );
}

#[test]
fn 映射校验拒绝明显写错的配置() {
    // 布局拼错
    let bad_layout = FieldMapping { layout: "ndjson".into(), ..Default::default() };
    assert!(bad_layout.validate().is_err());

    // 正文字段为空
    let empty_text = FieldMapping { text_field: "  ".into(), ..Default::default() };
    assert!(empty_text.validate().is_err());

    // 扩展名为空
    let no_ext = FieldMapping { extensions: vec![], ..Default::default() };
    assert!(no_ext.validate().is_err());

    // 深度越界
    let deep = FieldMapping { max_depth: 99, ..Default::default() };
    assert!(deep.validate().is_err());

    // 角色映射的目标认不出来
    let bad_role = FieldMapping {
        role_map: [("bot".to_string(), "随便什么".to_string())].into_iter().collect(),
        ..Default::default()
    };
    assert!(bad_role.validate().is_err());

    // 默认值本身必须合法
    assert!(FieldMapping::default().validate().is_ok());
}

#[test]
fn 未配置目录的自定义来源在保存设置时就被拒绝() {
    let mut settings = AppSettings {
        sources: [(
            "myagent".to_string(),
            SourceConfig {
                enabled: true,
                path: None,
                display_name: Some("My Agent".to_string()),
                mapping: Some(FieldMapping::default()),
            },
        )]
        .into_iter()
        .collect(),
        ..Default::default()
    };
    isolate_sources(&mut settings, Path::new("."), &[]);
    let error = settings.validate().expect_err("没有目录的映射不该通过校验");
    assert!(
        error.user_message().contains("myagent"),
        "错误里要点名是哪个来源，实际：{}",
        error.user_message()
    );
}

/// 自定义来源不在 catalog 里，所以不能被「停用全部」的钩子误伤。
#[test]
fn 隔离钩子不会动自定义来源() {
    let tmp = tempfile::tempdir().unwrap();
    let mut settings = AppSettings {
        sources: [(
            "myagent".to_string(),
            SourceConfig {
                enabled: true,
                path: Some(PathBuf::from("D:/x").display().to_string()),
                display_name: None,
                mapping: Some(FieldMapping::default()),
            },
        )]
        .into_iter()
        .collect(),
        ..Default::default()
    };
    isolate_sources(&mut settings, tmp.path(), &[]);
    assert!(settings.source_enabled("myagent"), "自定义来源应当保持启用");
    assert_eq!(settings.custom_sources().count(), 1);
}

/// 自定义来源不能占用内置来源的标识，否则两个适配器会同 id 抢同一批会话。
#[test]
fn 自定义来源不能占用内置标识但可以接上待适配的工具() {
    let with_id = |id: &str| AppSettings {
        sources: [(
            id.to_string(),
            SourceConfig {
                enabled: true,
                path: Some("D:/x".to_string()),
                display_name: None,
                mapping: Some(FieldMapping::default()),
            },
        )]
        .into_iter()
        .collect(),
        ..Default::default()
    };

    // codex 是内置原生来源 → 拒绝
    let error = with_id("codex").validate().expect_err("不该允许占用内置标识");
    assert!(
        error.user_message().contains("codex") && error.user_message().contains("内置"),
        "错误要说清和谁冲突，实际：{}",
        error.user_message()
    );

    // cline 是 pending（我们还没适配）→ 允许，这正是「自己接上没适配的工具」的用途
    with_id("cline").validate().expect("pending 来源应允许用自定义映射接上");
}
