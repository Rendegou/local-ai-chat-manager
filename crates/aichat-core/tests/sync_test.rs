//! 多设备 Git 同步集成测试（规格 §25）。
//!
//! 场景：
//! ```text
//! repo-a（机器 A） ─┐
//!                   ├─ bare-remote（裸仓库，模拟 GitHub/GitLab）
//! repo-b（机器 B） ─┘
//! ```
//! 验证：A 产生会话 → push → B pull → B 能看到 A 的历史；
//! 以及 §14：冲突时不自动合并、不丢数据，并可以中止 rebase。

use std::path::{Path, PathBuf};
use std::process::Command;

use aichat_core::storage::search::SearchQuery;
use aichat_core::storage::sessions::SessionFilter;
use aichat_core::sync::git::GitRepo;
use aichat_core::sync::SyncOptions;
use aichat_core::{AppSettings, Library};

/// fixtures 根目录。
fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/fixtures")
        .canonicalize()
        .expect("fixtures 目录存在")
}

/// git 是否可用（不可用则跳过集成测试）。
fn git_available() -> bool {
    Command::new("git")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// 设置提交身份，避免依赖开发机的全局 git 配置。
fn ensure_git_identity() {
    if Command::new("git")
        .args(["config", "--global", "user.email"])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
    {
        return;
    }
    std::env::set_var("GIT_AUTHOR_NAME", "AI Chat Manager Test");
    std::env::set_var("GIT_AUTHOR_EMAIL", "test@example.com");
    std::env::set_var("GIT_COMMITTER_NAME", "AI Chat Manager Test");
    std::env::set_var("GIT_COMMITTER_EMAIL", "test@example.com");
}

/// 在指定目录执行 git 命令（测试辅助）。
fn git(dir: &Path, args: &[&str]) {
    let output = Command::new("git")
        .current_dir(dir)
        .args(args)
        .output()
        .expect("执行 git");
    assert!(
        output.status.success(),
        "git {:?} 失败：{}",
        args,
        String::from_utf8_lossy(&output.stderr)
    );
}

/// 创建一台机器的测试环境（数据目录 + 同步仓库 + 数据源设置）。
struct Machine {
    library: Library,
}

impl Machine {
    /// `kimi_fixture`：Some 时把该 fixture 作为本机 Kimi 数据源；None 表示空数据源。
    fn new(root: &Path, name: &str, kimi_fixture: Option<&str>, repo: Option<PathBuf>) -> Self {
        let data_dir = root.join(format!("data-{name}"));
        let empty_kimi = root.join(format!("empty-kimi-{name}"));
        let empty_codex = root.join(format!("empty-codex-{name}"));
        std::fs::create_dir_all(&empty_kimi).unwrap();
        std::fs::create_dir_all(&empty_codex).unwrap();

        let settings = AppSettings {
            kimi_path: Some(match kimi_fixture {
                Some(fixture) => fixtures().join(fixture).display().to_string(),
                None => empty_kimi.display().to_string(),
            }),
            codex_path: Some(empty_codex.display().to_string()),
            sync_repo: repo.as_ref().map(|p| p.display().to_string()),
            ..Default::default()
        };
        settings.save(&data_dir).unwrap();

        let library = Library::open(&data_dir).expect("打开核心库");
        Machine { library }
    }

    /// 修改设置（例如预先写入远端地址）。
    fn configure(&self, f: impl FnOnce(&mut AppSettings)) {
        let mut settings = self.library.settings();
        f(&mut settings);
        self.library.update_settings(settings).expect("保存设置");
    }

    /// 执行一次同步。
    fn sync(&self, push: bool, remote: Option<&str>) -> aichat_core::sync::SyncReport {
        self.library
            .sync_now(
                &SyncOptions {
                    push,
                    set_remote: remote.map(|r| r.to_string()),
                    ..Default::default()
                },
                &mut |_| {},
            )
            .expect("同步成功")
    }
}

#[test]
fn 两台机器通过裸仓库同步会话() {
    if !git_available() {
        eprintln!("跳过：环境没有 git");
        return;
    }
    ensure_git_identity();
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();

    // 裸仓库充当远端
    let bare = root.join("bare-remote.git");
    std::fs::create_dir_all(&bare).unwrap();
    git(&bare, &["init", "--bare"]);

    // ---- 机器 A：有 Kimi 历史 ----
    let repo_a = root.join("repo-a");
    std::fs::create_dir_all(&repo_a).unwrap();
    let machine_a = Machine::new(root, "a", Some("kimi/normal"), Some(repo_a.clone()));

    let report_a = machine_a.sync(true, Some(&bare.display().to_string()));
    assert!(report_a.committed, "A 应产生提交");
    assert!(report_a.pushed, "A 应推送成功: {:?}", report_a.steps);
    assert!(report_a.conflict.is_none());
    assert!(report_a.snapshot.written >= 1, "A 应写入会话快照");

    // 同步状态：A 本地会话应标记为已同步
    let status_a = machine_a.library.sync_status().unwrap();
    assert_eq!(status_a.pending_sessions, 0, "同步后没有待同步会话");
    assert_eq!(status_a.behind, 0);

    // ---- 机器 B：克隆远端后拉取 ----
    let repo_b = root.join("repo-b");
    git(
        root,
        &[
            "clone",
            &bare.display().to_string(),
            &repo_b.display().to_string(),
        ],
    );
    // clone 后远端分支已跟踪：模拟「新电脑克隆仓库」
    let machine_b = Machine::new(root, "b", None, Some(repo_b.clone()));

    let report_b = machine_b.sync(false, None);
    assert!(report_b.pulled, "B 应拉取成功: {:?}", report_b.steps);
    assert!(report_b.conflict.is_none());

    // ---- B 能看到 A 的历史（规格 §30 场景 D）----
    let sessions = machine_b
        .library
        .list_sessions(&SessionFilter::default(), 50, 0)
        .unwrap();
    assert_eq!(sessions.len(), 1, "B 应看到 A 的 1 个会话");
    let session = &sessions[0];
    assert_eq!(session.source, "kimi");
    assert_eq!(
        session.title.as_deref(),
        Some("实现 Redis TTL lazy deletion")
    );
    assert_eq!(
        session.project_path.as_deref(),
        Some("/home/user/projects/demo-project")
    );
    assert_eq!(
        session.machine_id.as_deref(),
        Some(machine_a.library.machine_id()),
        "会话应归属机器 A"
    );
    assert_eq!(session.sync_status, "remote");
    assert_ne!(
        machine_a.library.machine_id(),
        machine_b.library.machine_id()
    );

    // B 可以搜索 A 的会话内容
    let hits = machine_b
        .library
        .search(&SearchQuery {
            text: "lazy deletion".into(),
            limit: 5,
            ..Default::default()
        })
        .unwrap();
    assert!(!hits.hits.is_empty(), "B 应能搜索到 A 的会话内容");

    // B 可以读消息
    let messages = machine_b.library.messages_page(&session.id, 0, 10).unwrap();
    assert!(!messages.is_empty());

    // 机器列表里有 A
    let machines = machine_b.library.list_machines().unwrap();
    assert_eq!(machines, vec![machine_a.library.machine_id().to_string()]);

    // 机器登记文件记录了 A（规格 §11）
    let machines_json = std::fs::read_to_string(repo_b.join(".aichat/machines.json")).unwrap();
    assert!(machines_json.contains(&machine_a.library.machine_id()[..8]));
}

#[test]
fn 冲突时不自动合并且可中止_rebase() {
    if !git_available() {
        eprintln!("跳过：环境没有 git");
        return;
    }
    ensure_git_identity();
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();

    let bare = root.join("bare-remote.git");
    std::fs::create_dir_all(&bare).unwrap();
    git(&bare, &["init", "--bare"]);

    // A 建立历史并推送
    let repo_a = root.join("repo-a");
    std::fs::create_dir_all(&repo_a).unwrap();
    let machine_a = Machine::new(root, "a", Some("kimi/normal"), Some(repo_a.clone()));
    let report = machine_a.sync(true, Some(&bare.display().to_string()));
    assert!(report.pushed);

    // B 克隆并拉取
    let repo_b = root.join("repo-b");
    git(
        root,
        &[
            "clone",
            &bare.display().to_string(),
            &repo_b.display().to_string(),
        ],
    );
    let machine_b = Machine::new(root, "b", None, Some(repo_b.clone()));
    machine_b.sync(false, None);

    // ---- 制造冲突：两边都修改同一份会话快照 ----
    let session_a = machine_a
        .library
        .list_sessions(&SessionFilter::default(), 5, 0)
        .unwrap()
        .into_iter()
        .next()
        .expect("A 已索引会话");
    let rel = format!(
        "kimi/{}/{}/conversation.jsonl",
        machine_a.library.machine_id(),
        session_a.external_id
    );
    let file_a = repo_a.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR));
    let file_b = repo_b.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR));
    assert!(file_a.is_file(), "A 的快照存在：{file_a:?}");
    assert!(file_b.is_file(), "B 的快照存在：{file_b:?}");

    // A 追加一行并推送
    let mut content_a = std::fs::read_to_string(&file_a).unwrap();
    content_a
        .push_str("{\"role\":\"user\",\"kind\":\"message\",\"text\":\"来自机器 A 的新增内容\"}\n");
    std::fs::write(&file_a, &content_a).unwrap();
    let git_a = GitRepo::new(&repo_a, "git");
    git_a.add_all().unwrap();
    assert!(git_a.commit("sync: 机器 A 追加内容").unwrap());
    assert!(git_a.push().unwrap().ok());

    // B 在同一文件上做不同的修改并提交（模拟两边都动过同一会话）
    let mut content_b = std::fs::read_to_string(&file_b).unwrap();
    content_b.push_str(
        "{\"role\":\"assistant\",\"kind\":\"message\",\"text\":\"来自机器 B 的本地改动\"}\n",
    );
    std::fs::write(&file_b, &content_b).unwrap();
    let git_b = GitRepo::new(&repo_b, "git");
    git_b.add_all().unwrap();
    assert!(git_b.commit("local: 机器 B 本地改动").unwrap());

    // B 同步：应检测到冲突，并且不推送、不丢数据
    let report_b = machine_b.sync(true, None);
    let conflict = report_b.conflict.as_ref().expect("应返回结构化冲突");
    assert!(!report_b.pushed, "冲突时不应推送");
    assert!(conflict.in_rebase, "应处于 rebase 中间态");
    assert!(
        !conflict.files.is_empty(),
        "应列出冲突文件：{:?}",
        conflict.message
    );
    assert!(conflict.files[0].contains("conversation.jsonl"));

    // B 本地改动仍在（绝不自动丢弃用户数据）
    let after = std::fs::read_to_string(&file_b).unwrap();
    assert!(after.contains("来自机器 B 的本地改动"), "本地改动必须保留");

    // 状态接口也能看到冲突
    let status = machine_b.library.sync_status().unwrap();
    assert!(status.conflict.is_some(), "Sync 页应显示冲突");

    // 中止 rebase：仓库回到干净状态
    machine_b.library.abort_rebase().unwrap();
    let git_b2 = GitRepo::new(&repo_b, "git");
    assert!(git_b2.conflicts().unwrap().is_empty());
    assert_eq!(git_b2.repo_state(), aichat_core::sync::RepoState::Clean);
    let status_after = machine_b.library.sync_status().unwrap();
    assert!(status_after.conflict.is_none());
    // 本地提交仍在历史里
    assert!(git_b2.log_oneline(5).unwrap().contains("机器 B 本地改动"));
}

#[test]
fn 设置里保存的远端地址会被自动使用() {
    if !git_available() {
        eprintln!("跳过：环境没有 git");
        return;
    }
    ensure_git_identity();
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();

    let bare = root.join("bare-remote.git");
    std::fs::create_dir_all(&bare).unwrap();
    git(&bare, &["init", "--bare"]);

    let repo_a = root.join("repo-a");
    std::fs::create_dir_all(&repo_a).unwrap();
    let machine_a = Machine::new(root, "a", Some("kimi/normal"), Some(repo_a.clone()));
    // 只写设置，不在同步时显式传远端
    machine_a.configure(|settings| {
        settings.remote_url = Some(bare.display().to_string());
    });

    let report = machine_a.sync(true, None);
    assert!(
        report.pushed,
        "应使用设置里的远端完成推送: {:?}",
        report.steps
    );
    assert_eq!(
        report.remote.as_deref(),
        Some(bare.display().to_string().as_str())
    );

    // 远端确实收到了提交
    let git_bare = GitRepo::new(&bare, "git");
    assert!(git_bare.log_oneline(5).unwrap().contains("sync:"));
}
