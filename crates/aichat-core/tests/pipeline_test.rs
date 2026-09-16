//! 端到端流程测试：扫描 → 索引 → 搜索 → 快照 → 仓库会话可见 → 归档 → 恢复。
//!
//! 对应规格 §30 的场景 A / C，以及 §15 快照结构与 §17 归档。

use std::path::{Path, PathBuf};

use aichat_core::model::SyncStatus;
use aichat_core::storage::search::{SearchOrder, SearchQuery};
use aichat_core::storage::sessions::SessionFilter;
use aichat_core::{paths, AppSettings, Library};

/// fixtures 根目录。
fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/fixtures")
        .canonicalize()
        .expect("fixtures 目录存在")
}

/// 建立「本机 Kimi + Codex 数据 + 同步仓库」的测试环境。
struct Env {
    _tmp: tempfile::TempDir,
    library: Library,
    repo: PathBuf,
}

impl Env {
    fn new() -> Self {
        let tmp = tempfile::tempdir().expect("临时目录");
        let repo = tmp.path().join("AIChatRepo");
        let data = tmp.path().join("data");
        std::fs::create_dir_all(&repo).unwrap();

        let settings = AppSettings {
            kimi_path: Some(fixtures().join("kimi/normal").display().to_string()),
            codex_path: Some(fixtures().join("codex/normal").display().to_string()),
            sync_repo: Some(repo.display().to_string()),
            // 归档阈值设得很大，避免影响其他用例
            archive_after_days: 100_000,
            ..Default::default()
        };
        settings.save(&data).unwrap();

        let library = Library::open(&data).expect("打开核心库");
        Env {
            _tmp: tmp,
            library,
            repo,
        }
    }
}

#[test]
fn 扫描索引搜索与快照全流程() {
    let env = Env::new();

    // ---- 1. 扫描：应索引 Kimi + Codex 各 1 个会话 ----
    let report = env.library.scan(false, &mut |_| {}).expect("扫描成功");
    assert_eq!(report.parsed, 2, "两个数据源各解析 1 个会话");
    assert_eq!(report.failed, 0);
    assert!(report.duration_ms < 30_000);

    // 第二次扫描：指纹未变化 → 全部跳过（不重新解析）
    let second = env.library.scan(false, &mut |_| {}).expect("二次扫描");
    assert_eq!(second.parsed, 0, "未变化时不应重复解析");
    assert_eq!(second.skipped, 2);

    // ---- 2. 列表与筛选 ----
    let all = env
        .library
        .list_sessions(&SessionFilter::default(), 50, 0)
        .expect("列表");
    assert_eq!(all.len(), 2);

    let kimi_only = env
        .library
        .list_sessions(
            &SessionFilter {
                source: Some("kimi".into()),
                ..Default::default()
            },
            50,
            0,
        )
        .expect("按数据源筛选");
    assert_eq!(kimi_only.len(), 1);
    assert_eq!(
        kimi_only[0].title.as_deref(),
        Some("实现 Redis TTL lazy deletion")
    );
    assert_eq!(
        kimi_only[0].project_path.as_deref(),
        Some("/home/user/projects/demo-project")
    );
    // 本机会话应带上 machine id
    assert_eq!(
        kimi_only[0].machine_id.as_deref(),
        Some(env.library.machine_id())
    );

    // 按项目筛选
    let by_project = env
        .library
        .list_sessions(
            &SessionFilter {
                project_path: Some("/home/user/projects/resp-parser".into()),
                ..Default::default()
            },
            50,
            0,
        )
        .expect("按项目筛选");
    assert_eq!(by_project.len(), 1);
    assert_eq!(by_project[0].source, "codex");

    // 项目聚合
    let projects = env.library.list_projects().expect("项目列表");
    assert_eq!(projects.len(), 2);
    assert!(projects
        .iter()
        .any(|p| p.name == "demo-project" && p.session_count == 1));

    // ---- 3. 消息分页（大会话不会整体进内存）----
    let kimi_id = &kimi_only[0].id;
    let page1 = env.library.messages_page(kimi_id, 0, 3).expect("分页");
    assert_eq!(page1.len(), 3);
    assert_eq!(page1[0].sequence, 0);
    let page2 = env.library.messages_page(kimi_id, 3, 3).expect("分页 2");
    assert!(page2[0].sequence > page1[2].sequence);

    // 会话详情：原始文件已登记
    let detail = env
        .library
        .session_detail(kimi_id)
        .expect("详情")
        .expect("存在");
    assert!(detail
        .raw_files
        .iter()
        .any(|f| f.path.ends_with("wire.jsonl")));
    assert!(detail.source_root.is_some());

    // ---- 4. 全文搜索（规格 §30 场景 C）----
    let response = env
        .library
        .search(&SearchQuery {
            text: "lazy deletion".into(),
            limit: 10,
            order: SearchOrder::Relevance,
            ..Default::default()
        })
        .expect("搜索");
    assert!(!response.hits.is_empty(), "应能搜到 lazy deletion");
    assert!(response.match_query.contains("lazy"));
    // 片段带上下文高亮
    assert!(response.hits.iter().any(|h| h.snippet.contains("<mark>")));
    assert!(response.took_ms < 300, "搜索应远快于 300ms");

    // 前缀匹配：输入前缀也能命中
    let prefix = env
        .library
        .search(&SearchQuery {
            text: "delet".into(),
            limit: 10,
            ..Default::default()
        })
        .expect("前缀搜索");
    assert!(!prefix.hits.is_empty(), "应支持前缀匹配");

    // 过滤条件：只搜 codex
    let codex_hits = env
        .library
        .search(&SearchQuery {
            text: "tokenizer".into(),
            filter: SessionFilter {
                source: Some("codex".into()),
                ..Default::default()
            },
            limit: 10,
            ..Default::default()
        })
        .expect("按数据源搜索");
    assert!(!codex_hits.hits.is_empty());
    assert!(codex_hits.hits.iter().all(|h| h.source == "codex"));

    // 特殊字符不应导致 FTS 语法错误
    let weird = env
        .library
        .search(&SearchQuery {
            text: "NEAR( \"lazy\"".into(),
            limit: 5,
            ..Default::default()
        })
        .expect("特殊字符搜索");
    assert!(weird.hits.len() <= 5);

    // ---- 5. 快照写入同步仓库 ----
    let report = env
        .library
        .sync_now(
            &aichat_core::sync::SyncOptions {
                push: false,
                ..Default::default()
            },
            &mut |_| {},
        )
        .expect("同步（本地提交）");
    assert!(report.committed, "应产生提交");
    assert!(report.snapshot.written >= 2, "至少写入 2 个会话");
    assert!(report.conflict.is_none());

    // 仓库结构符合规格 §4.3 / §11 / §15
    let kimi_external_id = kimi_only[0].external_id.clone();
    let kimi_dir = env
        .repo
        .join("kimi")
        .join(env.library.machine_id())
        .join(&kimi_external_id);
    assert!(kimi_dir.join("meta.json").is_file(), "缺少 meta.json");
    assert!(
        kimi_dir.join("conversation.jsonl").is_file(),
        "缺少 conversation.jsonl"
    );
    assert!(
        env.repo.join("manifest.json").is_file(),
        "缺少 manifest.json"
    );
    assert!(env.repo.join(".aichat/version.json").is_file());
    assert!(env.repo.join(".aichat/machines.json").is_file());
    // Keep Raw Session Files 默认开启：原始文件应被复制
    assert!(kimi_dir.join("raw").is_dir(), "应保留原始文件副本");
    // 仓库中绝不能出现凭证类文件
    assert!(
        !kimi_dir.join("raw/credentials").exists(),
        "凭证目录绝不复制"
    );

    let meta = aichat_core::sync::snapshot::read_meta(&kimi_dir.join("meta.json")).expect("meta");
    assert_eq!(meta.schema_version, aichat_core::model::SYNC_SCHEMA_VERSION);
    assert!(meta.has_raw);
    assert!(!meta.content_hash.is_empty());

    // ---- 6. 会话状态应变为已同步 ----
    let after_sync = env
        .library
        .session_detail(kimi_id)
        .expect("详情")
        .expect("存在");
    assert_eq!(after_sync.summary.sync_status, SyncStatus::Synced.as_str());

    // ---- 7. 归档 + 列表 + 恢复 ----
    let archive_report = env
        .library
        .archive_sessions(std::slice::from_ref(kimi_id))
        .expect("归档");
    assert_eq!(archive_report.archived, 1);
    assert_eq!(archive_report.failed, 0);
    let archive_rel = archive_report.entries.first().cloned().expect("归档路径");
    assert!(archive_rel.starts_with("archives/kimi/"), "{archive_rel}");
    assert!(
        archive_rel.ends_with(".tar.zst"),
        "默认应使用 zstd：{archive_rel}"
    );
    // 归档后活动快照目录被移除，避免重复占空间
    assert!(!kimi_dir.exists(), "归档后应移除活动快照目录");

    let archives = env.library.list_archives().expect("归档列表");
    assert_eq!(archives.len(), 1);
    assert_eq!(archives[0].compression, "zstd");

    // 恢复后会话重新可读
    let restored = env.library.restore_archive(&archive_rel).expect("恢复归档");
    assert!(restored.join("conversation.jsonl").is_file());
    assert!(kimi_dir.join("conversation.jsonl").is_file());

    // ---- 8. 索引统计 ----
    let stats = env.library.stats().expect("统计");
    assert_eq!(stats.sessions, 2);
    assert!(stats.messages > 5);
    assert!(stats.bytes_on_disk > 0);
}

#[test]
fn 同步仓库会话作为第三数据源被索引() {
    let env = Env::new();
    env.library.scan(false, &mut |_| {}).expect("扫描");
    env.library
        .sync_now(
            &aichat_core::sync::SyncOptions {
                push: false,
                ..Default::default()
            },
            &mut |_| {},
        )
        .expect("写快照");

    // 模拟「换一台机器」：另一个数据目录 + 指向同一个仓库
    // 数据源指向空目录，确保索引里只有来自同步仓库的会话
    let other_data = env.repo.parent().unwrap().join("data-b");
    let empty_kimi = env.repo.parent().unwrap().join("empty-kimi");
    let empty_codex = env.repo.parent().unwrap().join("empty-codex");
    std::fs::create_dir_all(&empty_kimi).unwrap();
    std::fs::create_dir_all(&empty_codex).unwrap();
    let settings = AppSettings {
        sync_repo: Some(env.repo.display().to_string()),
        kimi_path: Some(empty_kimi.display().to_string()),
        codex_path: Some(empty_codex.display().to_string()),
        ..Default::default()
    };
    settings.save(&other_data).unwrap();
    let library_b = Library::open(&other_data).expect("打开第二个库");

    // 第二个库通过「同步仓库适配器」看到快照中的会话
    let report = library_b.scan(false, &mut |_| {}).expect("扫描仓库");
    assert_eq!(report.parsed, 2, "仓库里的 2 个会话应被索引");

    let sessions = library_b
        .list_sessions(&SessionFilter::default(), 50, 0)
        .expect("列表");
    assert_eq!(sessions.len(), 2);
    let kimi = sessions
        .iter()
        .find(|s| s.source == "kimi")
        .expect("Kimi 会话");
    assert_eq!(kimi.title.as_deref(), Some("实现 Redis TTL lazy deletion"));
    assert_eq!(
        kimi.project_path.as_deref(),
        Some("/home/user/projects/demo-project")
    );
    // 归属机器是 A（另一台机器）
    assert_eq!(kimi.machine_id.as_deref(), Some(env.library.machine_id()));
    assert_ne!(kimi.machine_id.as_deref(), Some(library_b.machine_id()));
    assert_eq!(kimi.sync_status, SyncStatus::Remote.as_str());

    // 搜索同样可用
    let hits = library_b
        .search(&SearchQuery {
            text: "Redisson".into(),
            limit: 5,
            ..Default::default()
        })
        .expect("搜索仓库会话");
    assert!(!hits.hits.is_empty());

    // 机器筛选
    let machines = library_b.list_machines().expect("机器列表");
    assert_eq!(machines.len(), 1);
    assert!(paths::same_path(&env.repo, &env.repo));
}
