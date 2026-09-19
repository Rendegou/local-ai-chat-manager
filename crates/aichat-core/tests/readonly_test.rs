//! 只读保证测试（规格 §4.1 / §30 场景 E）：
//! 扫描、解析、归档都**不得修改** Codex / Kimi 的原始会话文件。

use std::path::{Path, PathBuf};

use aichat_core::storage::sessions::SessionFilter;
mod common;
use common::isolate_sources;

use aichat_core::{AppSettings, Library};

/// fixtures 根目录。
fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/fixtures")
        .canonicalize()
        .expect("fixtures 目录存在")
}

/// 递归收集文件 → (相对路径, 大小, 修改时间, BLAKE3)。
fn snapshot_tree(root: &Path) -> Vec<(String, u64, i64, String)> {
    let mut out = Vec::new();
    for entry in walkdir_like(root) {
        let relative = entry
            .strip_prefix(root)
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or_default();
        let meta = std::fs::metadata(&entry).expect("元信息");
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_nanos() as i64)
            .unwrap_or(0);
        out.push((relative, meta.len(), mtime, hash(&entry)));
    }
    out.sort();
    out
}

/// 手写目录遍历（避免测试里再引入其它依赖）。
fn walkdir_like(root: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else if path.is_file() {
                files.push(path);
            }
        }
    }
    files
}

/// 文件内容哈希（BLAKE3，与生产代码同算法）。
fn hash(path: &Path) -> String {
    let bytes = std::fs::read(path).unwrap_or_default();
    blake3::hash(&bytes).to_hex().to_string()
}

/// 把一个 fixture 目录复制到临时目录，方便比较「扫描前后」。
fn copy_dir(from: &Path, to: &Path) {
    for file in walkdir_like(from) {
        let relative = file.strip_prefix(from).expect("相对路径");
        let target = to.join(relative);
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).expect("创建目录");
        }
        std::fs::copy(&file, &target).expect("复制文件");
    }
}

#[test]
fn 扫描与归档都不修改原始文件() {
    let tmp = tempfile::tempdir().expect("临时目录");
    // 复制两份 fixture：分别作为 Kimi / Codex 数据源
    let kimi_root = tmp.path().join("kimi-home");
    let codex_root = tmp.path().join("codex-home");
    copy_dir(&fixtures().join("kimi/normal"), &kimi_root);
    copy_dir(&fixtures().join("codex/normal"), &codex_root);

    let before_kimi = snapshot_tree(&kimi_root);
    let before_codex = snapshot_tree(&codex_root);
    assert!(!before_kimi.is_empty() && !before_codex.is_empty());

    // ---- 扫描（解析 + 建索引）----
    let data_dir = tmp.path().join("data");
    let mut settings = AppSettings {
        kimi_path: Some(kimi_root.display().to_string()),
        codex_path: Some(codex_root.display().to_string()),
        sync_repo: Some(tmp.path().join("repo").display().to_string()),
        ..Default::default()
    };
    // 只有 kimi / codex 参与本用例，其余来源停用
    isolate_sources(&mut settings, tmp.path(), &["kimi", "codex"]);
    settings.save(&data_dir).expect("保存设置");
    let library = Library::open(&data_dir).expect("打开核心库");

    let report = library.scan(false, &mut |_| {}).expect("扫描");
    assert_eq!(report.parsed, 2);
    // 再扫描一次（走「未变化」路径）
    library.scan(false, &mut |_| {}).expect("二次扫描");

    assert_eq!(
        before_kimi,
        snapshot_tree(&kimi_root),
        "Kimi 原始文件被修改了"
    );
    assert_eq!(
        before_codex,
        snapshot_tree(&codex_root),
        "Codex 原始文件被修改了"
    );

    // ---- 同步（写快照 + 归档）也不得触碰原始文件 ----
    library
        .sync_now(
            &aichat_core::sync::SyncOptions {
                push: false,
                ..Default::default()
            },
            &mut |_| {},
        )
        .expect("同步");
    assert_eq!(
        before_kimi,
        snapshot_tree(&kimi_root),
        "同步修改了 Kimi 原始文件"
    );
    assert_eq!(
        before_codex,
        snapshot_tree(&codex_root),
        "同步修改了 Codex 原始文件"
    );

    let session = library
        .list_sessions(&SessionFilter::default(), 10, 0)
        .expect("列表")
        .into_iter()
        .next()
        .expect("至少一个会话");
    library.archive_sessions(&[session.id]).expect("归档");
    assert_eq!(
        before_kimi,
        snapshot_tree(&kimi_root),
        "归档修改了 Kimi 原始文件"
    );
    assert_eq!(
        before_codex,
        snapshot_tree(&codex_root),
        "归档修改了 Codex 原始文件"
    );
}

#[test]
fn 凭证目录不会被读取或同步() {
    let tmp = tempfile::tempdir().expect("临时目录");
    let kimi_root = tmp.path().join("kimi-home");
    copy_dir(&fixtures().join("kimi/normal"), &kimi_root);
    // fixture 里带 credentials/token.json：确认它没有被登记为原始文件
    assert!(kimi_root.join("credentials/token.json").is_file());

    let data_dir = tmp.path().join("data");
    let repo = tmp.path().join("repo");
    let mut settings = AppSettings {
        kimi_path: Some(kimi_root.display().to_string()),
        sync_repo: Some(repo.display().to_string()),
        ..Default::default()
    };
    // 本用例只关心 kimi 的凭证/只读行为，其余来源停用
    isolate_sources(&mut settings, tmp.path(), &["kimi"]);
    settings.save(&data_dir).expect("保存设置");
    let library = Library::open(&data_dir).expect("打开核心库");
    library.scan(false, &mut |_| {}).expect("扫描");
    library
        .sync_now(
            &aichat_core::sync::SyncOptions {
                push: false,
                ..Default::default()
            },
            &mut |_| {},
        )
        .expect("同步");

    // 索引里不应出现凭证文件
    let sessions = library
        .list_sessions(&SessionFilter::default(), 10, 0)
        .expect("列表");
    for session in &sessions {
        let detail = library
            .session_detail(&session.id)
            .expect("详情")
            .expect("存在");
        for file in &detail.raw_files {
            assert!(
                !file.path.replace('\\', "/").contains("credentials"),
                "凭证目录被登记进索引：{}",
                file.path
            );
        }
    }

    // 同步仓库里也不应出现凭证内容
    let mut found_token = false;
    for file in walkdir_like(&repo) {
        let text = std::fs::read_to_string(&file).unwrap_or_default();
        if text.contains("REDACTED-FIXTURE-TOKEN") {
            found_token = true;
        }
    }
    assert!(!found_token, "同步仓库中出现了凭证内容");
}
