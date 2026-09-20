//! Git 命令封装（规格 §28）。
//!
//! 设计约束：
//! - **只调用系统 git**，第一版不引入 libgit2（SSH / credential helper / 企业 Git 都由用户本机 git 处理）；
//! - 参数**逐项传递**，绝不拼接 shell 字符串（避免注入与转义问题）；
//! - 完整捕获 stdout / stderr / exit code，失败时给出结构化错误；
//! - 关闭交互式提示（`GIT_TERMINAL_PROMPT=0`），避免 GUI 里等待输入卡死。

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::error::{Error, Result};

/// 一条提交（同步页的提交日志）。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommit {
    pub hash: String,
    pub short_hash: String,
    pub author: String,
    /// ISO 8601（作者时间）
    pub date: String,
    /// 分支 / tag 装饰，例如 `HEAD -> main, origin/main`
    pub refs: String,
    pub subject: String,
    /// 还没推送到远端（没有 upstream 时全部为 true）
    pub unpushed: bool,
}

/// 单次 git 命令结果。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitOutput {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
    pub args: Vec<String>,
}

impl GitOutput {
    /// 命令是否成功。
    pub fn ok(&self) -> bool {
        self.code == 0
    }
}

/// Git 工作区状态（`git status --porcelain=v1 -b` 解析结果）。
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    /// 当前分支（detached 时为 `HEAD`）
    pub branch: String,
    /// 上游分支（如 `origin/main`）
    pub upstream: Option<String>,
    /// 领先上游的提交数
    pub ahead: i32,
    /// 落后上游的提交数
    pub behind: i32,
    /// 变更文件（含未跟踪）
    pub changes: Vec<GitFileChange>,
    /// 是否存在未提交变更
    pub dirty: bool,
}

/// 单个文件变更。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFileChange {
    /// 仓库相对路径
    pub path: String,
    /// 暂存区状态字符（M/A/D/R/? 等）
    pub index: char,
    /// 工作区状态字符
    pub worktree: char,
}

/// 解析 `git status --porcelain=v1 -b` 输出（规格 §25 要求单测覆盖）。
pub fn parse_porcelain(output: &str) -> GitStatus {
    let mut status = GitStatus::default();
    for (line_no, line) in output.lines().enumerate() {
        if line_no == 0 && line.starts_with("## ") {
            parse_branch_header(&line[3..], &mut status);
            continue;
        }
        if line.len() < 3 {
            continue;
        }
        let bytes: Vec<char> = line.chars().collect();
        let index = bytes[0];
        let worktree = bytes[1];
        let path = line[3..].trim().to_string();
        if path.is_empty() {
            continue;
        }
        status.changes.push(GitFileChange {
            path,
            index,
            worktree,
        });
    }
    status.dirty = !status.changes.is_empty();
    status
}

/// 解析 `## main...origin/main [ahead 1, behind 2]`。
fn parse_branch_header(header: &str, status: &mut GitStatus) {
    let (branch_part, tracking) = match header.split_once(" [") {
        Some((b, t)) => (b, Some(t.trim_end_matches(']'))),
        None => (header, None),
    };
    let (branch, upstream) = match branch_part.split_once("...") {
        Some((b, u)) => (b.trim().to_string(), Some(u.trim().to_string())),
        None => (branch_part.trim().to_string(), None),
    };
    status.branch = if branch.starts_with("No commits yet on ") {
        branch.trim_start_matches("No commits yet on ").to_string()
    } else if branch.starts_with("HEAD ") {
        "HEAD".to_string()
    } else {
        branch
    };
    status.upstream = upstream.filter(|u| !u.is_empty());
    if let Some(tracking) = tracking {
        for part in tracking.split(',') {
            let part = part.trim();
            if let Some(n) = part.strip_prefix("ahead ") {
                status.ahead = n.trim().parse().unwrap_or(0);
            } else if let Some(n) = part.strip_prefix("behind ") {
                status.behind = n.trim().parse().unwrap_or(0);
            }
        }
    }
}

/// git 命令执行器。
#[derive(Debug, Clone)]
pub struct GitCommand {
    exe: String,
}

impl GitCommand {
    /// 使用指定可执行文件（默认 `git`，从 PATH 查找）。
    pub fn new(exe: impl Into<String>) -> Self {
        let exe = exe.into();
        GitCommand {
            exe: if exe.trim().is_empty() {
                "git".to_string()
            } else {
                exe
            },
        }
    }

    /// 可执行文件路径。
    pub fn exe(&self) -> &str {
        &self.exe
    }

    /// 检查 git 是否可用，返回版本号。
    pub fn version(&self) -> Result<String> {
        let out = self.run(Path::new("."), &["--version"])?;
        Ok(out.stdout.trim().to_string())
    }

    /// 执行命令并返回结果（**不**因非 0 退出码报错，便于解析分支 / 冲突等场景）。
    pub fn run(&self, cwd: &Path, args: &[&str]) -> Result<GitOutput> {
        let mut command = Command::new(&self.exe);
        command
            .current_dir(cwd)
            .args(args)
            // 关键：非交互，避免 GUI 卡在凭据输入
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_ASKPASS", "echo")
            // 统一输出编码，避免 Windows 下中文乱码
            .env("LC_ALL", "C");
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        let output = command.output().map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                Error::Git {
                    code: -1,
                    args: args.iter().map(|a| a.to_string()).collect(),
                    stdout: String::new(),
                    stderr: format!("找不到 git 可执行文件：{}", self.exe),
                }
            } else {
                Error::io(cwd, e)
            }
        })?;
        Ok(GitOutput {
            code: output.status.code().unwrap_or(-1),
            stdout: String::from_utf8_lossy(&output.stdout).to_string(),
            stderr: String::from_utf8_lossy(&output.stderr).to_string(),
            args: args.iter().map(|a| a.to_string()).collect(),
        })
    }

    /// 执行命令，非 0 退出码视为错误。
    pub fn run_ok(&self, cwd: &Path, args: &[&str]) -> Result<GitOutput> {
        let out = self.run(cwd, args)?;
        if !out.ok() {
            return Err(Error::Git {
                code: out.code,
                args: out.args,
                stdout: out.stdout,
                stderr: out.stderr,
            });
        }
        Ok(out)
    }
}

/// 一个受管理的 Git 同步仓库（规格 §11）。
#[derive(Debug, Clone)]
pub struct GitRepo {
    git: GitCommand,
    root: PathBuf,
}

/// rebase / merge 中间态。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RepoState {
    Clean,
    Rebase,
    Merge,
    CherryPick,
}

impl GitRepo {
    /// 绑定目录与 git 可执行文件。
    pub fn new(root: impl Into<PathBuf>, git_exe: impl Into<String>) -> Self {
        GitRepo {
            git: GitCommand::new(git_exe),
            root: root.into(),
        }
    }

    /// 仓库根目录。
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// git 命令执行器。
    pub fn git(&self) -> &GitCommand {
        &self.git
    }

    /// 目录是否已经是 Git 仓库。
    pub fn is_repo(&self) -> bool {
        self.root.join(".git").exists()
    }

    /// 初始化仓库（幂等），并确保有一个初始提交。
    pub fn init(&self) -> Result<()> {
        crate::paths::ensure_dir(&self.root).map_err(|e| Error::io(&self.root, e))?;
        if !self.is_repo() {
            self.git.run_ok(&self.root, &["init"])?;
        }
        Ok(())
    }

    /// 当前分支名。
    pub fn current_branch(&self) -> Result<String> {
        let out = self
            .git
            .run_ok(&self.root, &["rev-parse", "--abbrev-ref", "HEAD"])?;
        Ok(out.stdout.trim().to_string())
    }

    /// 工作区状态。
    pub fn status(&self) -> Result<GitStatus> {
        let out = self
            .git
            .run_ok(&self.root, &["status", "--porcelain=v1", "-b"])?;
        Ok(parse_porcelain(&out.stdout))
    }

    /// 远端列表。
    pub fn remotes(&self) -> Result<Vec<(String, String)>> {
        if !self.is_repo() {
            return Ok(Vec::new());
        }
        let out = self.git.run(&self.root, &["remote", "-v"])?;
        if !out.ok() {
            return Ok(Vec::new());
        }
        let mut list = Vec::new();
        for line in out.stdout.lines() {
            let mut parts = line.split_whitespace();
            if let (Some(name), Some(url)) = (parts.next(), parts.next()) {
                let entry = (name.to_string(), url.to_string());
                if !list
                    .iter()
                    .any(|existing: &(String, String)| existing.0 == entry.0)
                {
                    list.push(entry);
                }
            }
        }
        Ok(list)
    }

    /// 设置（或新增）origin 远端。
    pub fn set_remote(&self, url: &str) -> Result<()> {
        let existing = self.remotes()?;
        if existing.iter().any(|(name, _)| name == "origin") {
            self.git
                .run_ok(&self.root, &["remote", "set-url", "origin", url])?;
        } else {
            self.git
                .run_ok(&self.root, &["remote", "add", "origin", url])?;
        }
        Ok(())
    }

    /// 是否存在上游分支。
    pub fn has_upstream(&self) -> bool {
        self.git
            .run(
                &self.root,
                &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
            )
            .map(|o| o.ok())
            .unwrap_or(false)
    }

    /// 暂存全部变更（含删除）。
    pub fn add_all(&self) -> Result<()> {
        self.git.run_ok(&self.root, &["add", "-A"])?;
        Ok(())
    }

    /// 提交；没有变更时返回 `false`。
    pub fn commit(&self, message: &str) -> Result<bool> {
        let status = self.status()?;
        if !status.dirty {
            return Ok(false);
        }
        self.git.run_ok(&self.root, &["commit", "-m", message])?;
        Ok(true)
    }

    /// 允许空提交（首次同步时确保仓库有提交历史）。
    pub fn commit_allow_empty(&self, message: &str) -> Result<()> {
        self.git
            .run_ok(&self.root, &["commit", "--allow-empty", "-m", message])?;
        Ok(())
    }

    /// `git pull --rebase`（失败不报错，交由冲突检测处理）。
    pub fn pull_rebase(&self) -> Result<GitOutput> {
        self.git.run(&self.root, &["pull", "--rebase", "--no-edit"])
    }

    /// `git push`。
    pub fn push(&self) -> Result<GitOutput> {
        self.git.run(&self.root, &["push"])
    }

    /// 首次推送并设置上游。
    ///
    /// 远端名由调用方给：写死 `origin` 在远端被改名后会直接失败。
    pub fn push_set_upstream(&self, remote: &str) -> Result<GitOutput> {
        let branch = self.current_branch()?;
        self.git
            .run(&self.root, &["push", "--set-upstream", remote, &branch])
    }

    /// 抓取远端的全部引用（不改工作区）。
    ///
    /// 存在的理由：`git pull` 需要上游跟踪引用，而**有远端但没有上游**是很常见的状态
    /// （远端是后配上的、`.git/config` 里的 branch 段丢了、仓库被重新 init 过）。
    /// 这种时候直接 `push --set-upstream` 会被拒（远端已有本地没有的提交），
    /// 所以先 fetch 把 `refs/remotes/<remote>/<branch>` 建出来。
    pub fn fetch(&self, remote: &str) -> Result<GitOutput> {
        self.git.run(&self.root, &["fetch", remote])
    }

    /// 远端上是否存在同名分支（需先 fetch）。
    pub fn remote_branch_exists(&self, remote: &str, branch: &str) -> bool {
        self.git
            .run(
                &self.root,
                &["rev-parse", "--verify", "--quiet", &format!("refs/remotes/{remote}/{branch}")],
            )
            .map(|o| o.ok())
            .unwrap_or(false)
    }

    /// 把当前分支的上游设为 `<remote>/<branch>`（先 fetch 才有意义）。
    pub fn set_upstream(&self, remote: &str, branch: &str) -> Result<GitOutput> {
        self.git.run(
            &self.root,
            &["branch", &format!("--set-upstream-to={remote}/{branch}"), branch],
        )
    }

    /// 当前 rebase / merge 状态。
    pub fn repo_state(&self) -> RepoState {
        let git_dir = self.root.join(".git");
        if git_dir.join("rebase-merge").is_dir() || git_dir.join("rebase-apply").is_dir() {
            RepoState::Rebase
        } else if git_dir.join("MERGE_HEAD").exists() {
            RepoState::Merge
        } else if git_dir.join("CHERRY_PICK_HEAD").exists() {
            RepoState::CherryPick
        } else {
            RepoState::Clean
        }
    }

    /// 冲突文件列表（`--diff-filter=U`）。
    pub fn conflicts(&self) -> Result<Vec<String>> {
        let out = self
            .git
            .run(&self.root, &["diff", "--name-only", "--diff-filter=U"])?;
        Ok(out
            .stdout
            .lines()
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty())
            .collect())
    }

    /// 中止 rebase（规格 §14 的「Abort Rebase」按钮）。
    pub fn rebase_abort(&self) -> Result<()> {
        self.git.run_ok(&self.root, &["rebase", "--abort"])?;
        Ok(())
    }

    /// 最近 N 条提交（单行格式）。
    /// 最近提交（结构化）。
    ///
    /// 原来是 `--pretty=format:"%h %ad %s"` 直接回一整段文本：没有作者、没有分支/tag
    /// 装饰，也看不出**哪些提交还没推上去**——而对一个同步工具来说，「哪几条是本地
    /// 独有的」恰恰是用户最想知道的一件事。
    ///
    /// 字段用 US（0x1f）分隔：提交主题里可能有空格、竖线甚至制表符，
    /// 用一个几乎不会出现在文本里的控制字符才切得干净。
    pub fn log_commits(&self, limit: usize) -> Result<Vec<GitCommit>> {
        let limit_s = limit.clamp(1, 200).to_string();
        // 空仓库（还没有任何提交）时 git log 会失败——那是正常状态，返回空列表
        let out = match self.git.run(
            &self.root,
            &[
                "log",
                &format!("-{limit_s}"),
                "--pretty=format:%H\u{1f}%h\u{1f}%an\u{1f}%aI\u{1f}%d\u{1f}%s",
            ],
        ) {
            Ok(out) if out.ok() => out,
            _ => return Ok(Vec::new()),
        };

        // 没有 upstream（还没配远端）时，全部提交都算「未推送」而不是报错
        let upstream = self.git.run(&self.root, &["rev-parse", "--abbrev-ref", "@{upstream}"]);
        let has_upstream = upstream.map(|o| o.ok()).unwrap_or(false);
        let unpushed: HashSet<String> = if has_upstream {
            self.git
                .run(&self.root, &["rev-list", "@{upstream}..HEAD"])
                .ok()
                .filter(GitOutput::ok)
                .map(|o| o.stdout.lines().map(|l| l.trim().to_string()).collect())
                .unwrap_or_default()
        } else {
            HashSet::new()
        };

        Ok(out
            .stdout
            .lines()
            .filter_map(|line| {
                let mut parts = line.split('\u{1f}');
                let hash = parts.next()?.trim().to_string();
                if hash.is_empty() {
                    return None;
                }
                Some(GitCommit {
                    short_hash: parts.next().unwrap_or_default().trim().to_string(),
                    author: parts.next().unwrap_or_default().trim().to_string(),
                    date: parts.next().unwrap_or_default().trim().to_string(),
                    refs: parts
                        .next()
                        .unwrap_or_default()
                        .trim()
                        .trim_start_matches('(')
                        .trim_end_matches(')')
                        .trim()
                        .to_string(),
                    subject: parts.next().unwrap_or_default().trim().to_string(),
                    unpushed: !has_upstream || unpushed.contains(&hash),
                    hash,
                })
            })
            .collect())
    }

    /// 仓库是否没有任何提交。
    pub fn is_empty_repo(&self) -> bool {
        self.git
            .run(&self.root, &["rev-parse", "--verify", "HEAD"])
            .map(|o| !o.ok())
            .unwrap_or(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 解析干净状态() {
        let status = parse_porcelain("## main...origin/main\n");
        assert_eq!(status.branch, "main");
        assert_eq!(status.upstream.as_deref(), Some("origin/main"));
        assert!(!status.dirty);
    }

    #[test]
    fn 解析领先落后与变更() {
        let raw = "## main...origin/main [ahead 2, behind 1]\n M kimi/pc-a/ses_x/meta.json\n?? codex/pc-b/new.jsonl\n";
        let status = parse_porcelain(raw);
        assert_eq!(status.ahead, 2);
        assert_eq!(status.behind, 1);
        assert_eq!(status.changes.len(), 2);
        assert!(status.dirty);
        assert_eq!(status.changes[0].path, "kimi/pc-a/ses_x/meta.json");
        assert_eq!(status.changes[1].index, '?');
    }

    #[test]
    fn 解析无上游与空仓库() {
        let status = parse_porcelain("## No commits yet on master\n");
        assert_eq!(status.branch, "master");
        assert!(status.upstream.is_none());
        let detached = parse_porcelain("## HEAD (no branch)\n");
        assert_eq!(detached.branch, "HEAD");
    }

    #[test]
    fn 真实仓库端到端() {
        if Command::new("git").arg("--version").output().is_err() {
            return; // 环境无 git 时跳过
        }
        let dir = tempfile::tempdir().unwrap();
        let repo = GitRepo::new(dir.path(), "git");
        repo.init().unwrap();
        assert!(repo.is_repo());
        repo.commit_allow_empty("init").unwrap();
        assert!(!repo.is_empty_repo());

        std::fs::write(dir.path().join("a.txt"), "hello").unwrap();
        let status = repo.status().unwrap();
        assert!(status.dirty);
        repo.add_all().unwrap();
        assert!(repo.commit("sync: test").unwrap());
        assert!(!repo.commit("sync: test").unwrap(), "无变更时不应重复提交");
        assert_eq!(repo.conflicts().unwrap().len(), 0);
        assert_eq!(repo.repo_state(), RepoState::Clean);
        // 最前面还有一条空提交 "init"，所以这里是两条，最新的在前
        let commits = repo.log_commits(5).unwrap();
        assert_eq!(commits.len(), 2, "init + sync: test");
        assert_eq!(commits[0].subject, "sync: test", "日志要按时间倒序");
        assert!(!commits[0].author.is_empty(), "作者要带上（旧的 log_oneline 丢了这个信息）");
        assert!(commits[0].date.starts_with("20"), "作者时间应是 ISO 8601：{}", commits[0].date);
        // 没有 upstream 时全部算「未推送」，而不是报错
        assert!(commits[0].unpushed, "没有远端时提交应标记为未推送");
    }
}
