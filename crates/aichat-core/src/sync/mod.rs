//! Git 同步编排（规格 §13、§14）。
//!
//! 一次 `Sync Now` 的完整流程：
//!
//! ```text
//! 1. 扫描本机变化（增量）
//! 2. Copy changed sessions → Sync Repo（快照）
//! 3. git status
//! 4. git add
//! 5. git commit   （sync: <machine> <ISO 时间>）
//! 6. git pull --rebase
//! 7. 无冲突 → git push
//! 8. 扫描拉取下来的其他机器 session
//! 9. 更新 SQLite 索引
//! ```
//!
//! 冲突策略：**不自动合并、不丢弃任何一边**，返回结构化 [`GitConflict`] 交给 UI。

pub mod git;
pub mod snapshot;

use std::path::Path;

use crate::adapters::{AdapterContext, ConversationAdapter};
use crate::error::{display_path, Error, Result};
use crate::model::GitConflict;
use crate::scanner::{scan, ScanOptions, ScanReport};
use crate::settings::AppSettings;
use crate::storage::db::Database;

pub use git::{GitCommand, GitFileChange, GitOutput, GitRepo, GitStatus, RepoState};
pub use snapshot::{SnapshotEntry, SnapshotOutcome, SnapshotReport};

/// 同步步骤记录（UI 上按顺序展示）。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStep {
    pub name: String,
    pub ok: bool,
    pub detail: String,
    pub duration_ms: u64,
}

/// 同步选项。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SyncOptions {
    /// 是否推送到远端
    pub push: bool,
    /// 自定义提交信息（默认 `sync: <machine> <ISO>`）
    pub commit_message: Option<String>,
    /// 本次设置的远端地址（可选）
    pub set_remote: Option<String>,
    /// 是否跳过同步前的增量扫描
    pub skip_scan: bool,
}

impl Default for SyncOptions {
    fn default() -> Self {
        SyncOptions {
            push: true,
            commit_message: None,
            set_remote: None,
            skip_scan: false,
        }
    }
}

/// 同步报告。
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncReport {
    pub steps: Vec<SyncStep>,
    pub branch: String,
    pub remote: Option<String>,
    pub committed: bool,
    pub pushed: bool,
    pub pulled: bool,
    pub snapshot: SnapshotReport,
    /// 拉取后重新索引的结果
    pub scan: Option<ScanReport>,
    pub conflict: Option<GitConflict>,
    pub duration_ms: u64,
}

/// Sync 页展示的状态。
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatusDto {
    /// 仓库路径（未配置时为 None）
    pub repo: Option<String>,
    pub exists: bool,
    pub is_repo: bool,
    pub branch: String,
    pub remote: Option<String>,
    /// 设置里保存的远端地址（仓库 git config 未配置时，同步会自动应用它）
    pub settings_remote: Option<String>,
    pub last_pull: Option<String>,
    pub last_push: Option<String>,
    /// 本地未提交变更文件数
    pub local_changes: usize,
    /// 远端领先的提交数（需要拉取）
    pub incoming_changes: i32,
    pub ahead: i32,
    pub behind: i32,
    /// 待同步的会话数（本机新增 / 修改）
    pub pending_sessions: usize,
    /// 待同步会话源文件的总字节数（写入仓库量的估算）
    pub pending_bytes: u64,
    pub conflict: Option<GitConflict>,
    pub git_version: Option<String>,
    pub changes: Vec<GitFileChange>,
    /// 最近提交（单行）
    pub recent_commits: Vec<String>,
    pub error: Option<String>,
}

/// 同步上下文：把所需依赖一次性传入，避免函数参数爆炸。
pub struct SyncContext<'a> {
    pub db: &'a Database,
    pub settings: &'a AppSettings,
    pub machine_id: &'a str,
    pub app_version: &'a str,
    pub adapters: &'a [Box<dyn ConversationAdapter>],
    pub adapter_ctx: AdapterContext<'a>,
}

impl SyncContext<'_> {
    /// 解析同步仓库路径（未配置时报错）。
    fn require_repo(&self) -> Result<std::path::PathBuf> {
        self.settings
            .repo_root()
            .ok_or_else(|| Error::config("尚未配置同步仓库目录".to_string()))
    }

    /// 构造 Git 仓库句柄。
    fn repo(&self, root: &Path) -> GitRepo {
        GitRepo::new(root, self.settings.git_exe.clone())
    }
}

/// 追加一条同步步骤记录（用函数而不是闭包，避免同时借用 `report`）。
fn push_step(report: &mut SyncReport, name: &str, ok: bool, detail: String, elapsed_ms: u128) {
    report.steps.push(SyncStep {
        name: name.to_string(),
        ok,
        detail,
        duration_ms: elapsed_ms as u64,
    });
}

/// 读取设置中记录的同步状态键。
const KEY_LAST_PULL: &str = "sync.last_pull";
const KEY_LAST_PUSH: &str = "sync.last_push";

/// 执行一次完整同步。
pub fn sync_now(
    ctx: &SyncContext<'_>,
    options: &SyncOptions,
    progress: &mut dyn FnMut(String),
) -> Result<SyncReport> {
    let started = std::time::Instant::now();
    let mut report = SyncReport::default();
    let root = ctx.require_repo()?;
    let repo = ctx.repo(&root);

    // ---- 0. 仓库初始化 / 远端配置 ----
    let t0 = std::time::Instant::now();
    let existed = repo.is_repo();
    repo.init()?;
    snapshot::ensure_repo_files(&root, ctx.machine_id, ctx.app_version)?;
    // 远端地址优先级：本次同步显式传入 > 设置里保存的 remoteUrl
    let remote_url = options
        .set_remote
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .or_else(|| {
            ctx.settings
                .remote_url
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string())
        });
    if let Some(url) = remote_url.as_deref() {
        repo.set_remote(url)?;
    }
    push_step(
        &mut report,
        if existed {
            "打开同步仓库"
        } else {
            "初始化同步仓库"
        },
        true,
        display_path(&root),
        t0.elapsed().as_millis(),
    );

    // ---- 1. 扫描本机变化 ----
    if !options.skip_scan {
        let t1 = std::time::Instant::now();
        let scan_report = scan(
            ctx.db,
            ctx.adapters,
            &ctx.adapter_ctx,
            &ScanOptions::default(),
            &mut |p| {
                if p.total > 0 {
                    progress(format!("扫描会话 {}/{}", p.done + 1, p.total));
                }
            },
        )?;
        push_step(
            &mut report,
            "扫描本机会话",
            true,
            format!(
                "解析 {}，跳过 {}，删除 {}，失败 {}",
                scan_report.parsed, scan_report.skipped, scan_report.removed, scan_report.failed
            ),
            t1.elapsed().as_millis(),
        );
    }

    // ---- 2. 快照写入仓库 ----
    let t2 = std::time::Instant::now();
    report.snapshot = write_snapshots(ctx, &root)?;
    let snapshot = &report.snapshot;
    let (written, skipped, failed) = (snapshot.written, snapshot.skipped, snapshot.failed);
    let mut detail = format!("新增/更新 {written}，未变化 {skipped}，失败 {failed}");
    if written > 0 {
        detail.push_str(&format!("，写入 {}", human_bytes(snapshot.bytes)));
    }
    push_step(
        &mut report,
        "写会话快照",
        failed == 0,
        detail,
        t2.elapsed().as_millis(),
    );

    // ---- 3~5. status / add / commit ----
    let t3 = std::time::Instant::now();
    let status = repo.status()?;
    report.branch = status.branch.clone();
    let message = options
        .commit_message
        .clone()
        .unwrap_or_else(|| default_commit_message(ctx.machine_id, &status.branch));
    if status.dirty {
        repo.add_all()?;
        repo.commit(&message)?;
        report.committed = true;
    } else if repo.is_empty_repo() {
        // 全新仓库：至少留下一个提交，后续 pull --rebase 才有意义
        repo.commit_allow_empty(&message)?;
        report.committed = true;
    }
    let commit_detail = if report.committed {
        message.clone()
    } else {
        "没有需要提交的变更".to_string()
    };
    push_step(
        &mut report,
        "提交本地变更",
        true,
        commit_detail,
        t3.elapsed().as_millis(),
    );

    // ---- 6. pull --rebase ----
    let t4 = std::time::Instant::now();
    let remotes = repo.remotes()?;
    report.remote = remotes.first().map(|(_, url)| url.clone());
    let has_remote = !remotes.is_empty();
    if has_remote && repo.has_upstream() {
        let pull = repo.pull_rebase()?;
        report.pulled = pull.ok();
        let conflict = detect_conflict(&repo, &pull.stdout, &pull.stderr)?;
        if let Some(conflict) = conflict {
            push_step(
                &mut report,
                "拉取远端（rebase）",
                false,
                conflict.message.clone(),
                t4.elapsed().as_millis(),
            );
            report.conflict = Some(conflict);
            // 冲突时不推送、不继续，等待用户处理（规格 §14）
            report.duration_ms = started.elapsed().as_millis() as u64;
            return Ok(report);
        }
        push_step(
            &mut report,
            "拉取远端（rebase）",
            pull.ok(),
            if pull.ok() {
                "已同步远端提交".to_string()
            } else {
                first_line(&pull.stderr)
            },
            t4.elapsed().as_millis(),
        );
    } else {
        push_step(
            &mut report,
            "拉取远端（rebase）",
            true,
            "未配置远端或上游分支，已跳过".to_string(),
            t4.elapsed().as_millis(),
        );
    }

    // ---- 7. push ----
    let t5 = std::time::Instant::now();
    if options.push && has_remote {
        let push = if repo.has_upstream() {
            repo.push()?
        } else {
            repo.push_set_upstream()?
        };
        report.pushed = push.ok();
        push_step(
            &mut report,
            "推送到远端",
            push.ok(),
            if push.ok() {
                "已推送".to_string()
            } else {
                first_line(&push.stderr)
            },
            t5.elapsed().as_millis(),
        );
        if push.ok() {
            ctx.db
                .set_setting(KEY_LAST_PUSH, &chrono::Utc::now().to_rfc3339())?;
        }
    }
    if report.pulled {
        ctx.db
            .set_setting(KEY_LAST_PULL, &chrono::Utc::now().to_rfc3339())?;
    }

    // ---- 8~9. 重新扫描（索引其他机器拉取下来的会话）----
    let t6 = std::time::Instant::now();
    let rescan = scan(
        ctx.db,
        ctx.adapters,
        &ctx.adapter_ctx,
        &ScanOptions::default(),
        &mut |_| {},
    )?;
    push_step(
        &mut report,
        "重建索引",
        true,
        format!("解析 {} 个会话", rescan.parsed),
        t6.elapsed().as_millis(),
    );
    report.scan = Some(rescan);
    report.duration_ms = started.elapsed().as_millis() as u64;
    Ok(report)
}

/// 读取同步状态（供 Sync 页展示）。
pub fn status(ctx: &SyncContext<'_>) -> Result<SyncStatusDto> {
    let mut dto = SyncStatusDto::default();
    let Some(root) = ctx.settings.repo_root() else {
        dto.error = Some("尚未配置同步仓库目录".to_string());
        return Ok(dto);
    };
    dto.repo = Some(display_path(&root));
    dto.settings_remote = ctx
        .settings
        .remote_url
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    dto.exists = root.is_dir();
    if !dto.exists {
        dto.error = Some("同步仓库目录不存在".to_string());
        return Ok(dto);
    }
    let repo = ctx.repo(&root);
    dto.is_repo = repo.is_repo();
    dto.pending_sessions = ctx.db.sessions_pending_sync(ctx.machine_id)?.len();
    dto.pending_bytes = ctx.db.pending_sync_bytes(ctx.machine_id)?;
    dto.last_pull = ctx.db.get_setting(KEY_LAST_PULL)?;
    dto.last_push = ctx.db.get_setting(KEY_LAST_PUSH)?;
    dto.git_version = repo.git().version().ok();

    if !dto.is_repo {
        dto.error = Some("该目录还不是 Git 仓库，点击「立即同步」会自动初始化".to_string());
        return Ok(dto);
    }

    if let Ok(status) = repo.status() {
        dto.branch = status.branch;
        dto.ahead = status.ahead;
        dto.behind = status.behind;
        dto.local_changes = status.changes.len();
        dto.incoming_changes = status.behind;
        dto.changes = status.changes;
    }
    if let Ok(remotes) = repo.remotes() {
        dto.remote = remotes.first().map(|(_, url)| url.clone());
    }
    if let Ok(commits) = repo.log_commits(10) {
        dto.recent_commits = commits.iter().map(|c| format!("{} {}", c.short_hash, c.subject)).collect();
    }
    // 冲突检测：未合并文件或处于 rebase 中间态
    let conflicts = repo.conflicts().unwrap_or_default();
    let state = repo.repo_state();
    if !conflicts.is_empty() || state != RepoState::Clean {
        dto.conflict = Some(GitConflict {
            in_rebase: state == RepoState::Rebase,
            files: conflicts,
            message: "当前仓库存在冲突，请手动处理后重试".to_string(),
            stdout: String::new(),
            stderr: String::new(),
        });
    }
    Ok(dto)
}

/// 读取 git 日志（`View Git Log`）。
pub fn git_log(ctx: &SyncContext<'_>, limit: usize) -> Result<Vec<git::GitCommit>> {
    let root = ctx.require_repo()?;
    let repo = ctx.repo(&root);
    if !repo.is_repo() {
        return Ok(Vec::new());
    }
    repo.log_commits(limit.clamp(1, 200))
}

/// 中止 rebase（规格 §14）。
pub fn abort_rebase(ctx: &SyncContext<'_>) -> Result<()> {
    let root = ctx.require_repo()?;
    ctx.repo(&root).rebase_abort()
}

/// 把「本机待同步 + 已变化」的会话写入仓库。
fn write_snapshots(ctx: &SyncContext<'_>, root: &Path) -> Result<SnapshotReport> {
    let pending = ctx.db.sessions_pending_sync(ctx.machine_id)?;
    let mut report = SnapshotReport::default();
    for summary in pending {
        match snapshot::snapshot_session(
            ctx.db,
            root,
            ctx.machine_id,
            &summary,
            ctx.settings.keep_raw_files,
        ) {
            Ok(SnapshotOutcome::Written(rel)) => {
                let bytes = snapshot_size(root, &rel);
                report.written += 1;
                report.bytes += bytes;
                report.files.push(SnapshotEntry {
                    rel_path: rel.clone(),
                    bytes,
                });
                snapshot::mark_synced(ctx.db, &summary, &rel, ctx.machine_id)?;
            }
            Ok(SnapshotOutcome::Skipped) => {
                report.skipped += 1;
                // 内容一致：状态标记为已同步即可
                snapshot::mark_synced(ctx.db, &summary, "", ctx.machine_id)?;
            }
            Err(err) => {
                report.failed += 1;
                report.warnings.push(format!(
                    "会话 {} 快照失败：{}",
                    summary.external_id,
                    err.user_message()
                ));
            }
        }
    }
    Ok(report)
}

/// 估算快照目录大小（写报告用，失败返回 0）。
fn snapshot_size(root: &Path, rel: &str) -> u64 {
    let dir = rel
        .split('/')
        .fold(root.to_path_buf(), |acc, part| acc.join(part));
    walkdir::WalkDir::new(dir)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
        .map(|e| e.metadata().map(|m| m.len()).unwrap_or(0))
        .sum()
}

/// 冲突检测：合并未完成或存在未合并文件。
fn detect_conflict(repo: &GitRepo, stdout: &str, stderr: &str) -> Result<Option<GitConflict>> {
    let files = repo.conflicts()?;
    let state = repo.repo_state();
    if files.is_empty() && state == RepoState::Clean {
        return Ok(None);
    }
    let message = if state == RepoState::Rebase {
        format!(
            "git pull --rebase 遇到冲突（{} 个文件），已暂停 rebase",
            files.len()
        )
    } else {
        format!("合并过程中存在冲突（{} 个文件）", files.len())
    };
    Ok(Some(GitConflict {
        in_rebase: state == RepoState::Rebase,
        files,
        message,
        stdout: stdout.to_string(),
        stderr: stderr.to_string(),
    }))
}

/// 默认提交信息（规格 §13）：`sync: <machine> <ISO 时间>`。
pub fn default_commit_message(machine_id: &str, _branch: &str) -> String {
    let host = crate::settings::hostname();
    let label = if host == "unknown" || host.is_empty() {
        // 主机名拿不到时退回 machine id 前 8 位，保证日志可读
        machine_id.chars().take(8).collect::<String>()
    } else {
        host
    };
    format!("sync: {} {}", label, chrono::Utc::now().to_rfc3339())
}

/// 取多行输出的第一行（用于 UI 简短提示）。
fn first_line(text: &str) -> String {
    text.lines()
        .find(|l| !l.trim().is_empty())
        .unwrap_or("")
        .trim()
        .to_string()
}

/// 人类可读的字节数（同步步骤详情用）。
fn human_bytes(bytes: u64) -> String {
    const KB: u64 = 1024;
    const MB: u64 = KB * 1024;
    const GB: u64 = MB * 1024;
    if bytes >= GB {
        format!("{:.1} GB", bytes as f64 / GB as f64)
    } else if bytes >= MB {
        format!("{:.1} MB", bytes as f64 / MB as f64)
    } else if bytes >= KB {
        format!("{:.1} KB", bytes as f64 / KB as f64)
    } else {
        format!("{bytes} B")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 提交信息格式符合规格() {
        let msg = default_commit_message("0f4a1c2e-1111-2222-3333-444455556666", "main");
        assert!(msg.starts_with("sync: "));
        // 形如 sync: <machine> 2026-09-15T22:30:00+00:00
        let parts: Vec<&str> = msg.splitn(3, ' ').collect();
        assert_eq!(parts[0], "sync:");
        assert!(parts.len() == 3);
        assert!(parts[2].contains('T'), "应包含 ISO 时间戳: {msg}");
    }
}
