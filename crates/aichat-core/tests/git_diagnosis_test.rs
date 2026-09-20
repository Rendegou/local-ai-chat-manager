//! git 失败诊断：把真实的报错文本映射成可执行的建议。
//!
//! 这些样例是照着**真实见过的报错**写的（国内连 GitHub 的几种典型失败）。
//! 它们的作用不是「跑通流程」，而是保证分类不会因为改一个关键词就悄悄失效——
//! 给错了建议比不给更糟：用户会照着去改代理，而真正的问题是凭据。

use aichat_core::error::first_cause;
use aichat_core::sync::git_failure_hint;

/// 断言某段 stderr 会给出指定的建议 code。
fn assert_hint(stderr: &str, expected: &str) {
    let hint = git_failure_hint(stderr).unwrap_or_else(|| panic!("没有给出建议：{stderr}"));
    assert_eq!(hint.code, expected, "分类错误：{stderr}");
    assert!(!hint.fallback.is_empty(), "建议要有中文原文（日志用）");
}

#[test]
fn 直连不通与_dns_分别给出对应建议() {
    assert_hint(
        "fatal: unable to access 'https://github.com/x/y.git/': Could not resolve host: github.com",
        "sync.hint.dns",
    );
    assert_hint(
        "fatal: unable to access 'https://github.com/x/y.git/': Failed to connect to github.com port 443 after 21000 ms: Timed out",
        "sync.hint.connect",
    );
    assert_hint("fatal: unable to access '...': Connection reset by peer", "sync.hint.reset");
    assert_hint("fatal: unable to access '...': Failed to connect to 127.0.0.1 port 7890: Connection refused", "sync.hint.reset");
}

#[test]
fn 证书与凭据分别给出对应建议() {
    assert_hint(
        "fatal: unable to access '...': SSL certificate problem: unable to get local issuer certificate",
        "sync.hint.tls",
    );
    assert_hint(
        "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
        "sync.hint.credentials",
    );
    assert_hint("remote: Invalid username or password.\nfatal: Authentication failed for 'https://github.com/x/y.git/'", "sync.hint.credentials");
}

#[test]
fn ssh_仓库不存在与推送被截断分别给出对应建议() {
    assert_hint("git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.", "sync.hint.ssh");
    assert_hint("remote: Repository not found.\nfatal: repository 'https://github.com/x/y.git/' not found", "sync.hint.notFound");
    assert_hint("error: RPC failed; curl 56 Recv failure: Connection was reset\nfatal: the remote end hung up unexpectedly", "sync.hint.truncated");
    assert_hint("error: RPC failed; curl 92 HTTP/2 stream 0 was not closed cleanly: INTERNAL_ERROR", "sync.hint.truncated");
}

#[test]
fn 仓库侧问题与网络问题要分得开() {
    assert_hint("fatal: Unable to create 'D:/repo/.git/index.lock': File exists.", "sync.hint.lock");
    assert_hint("fatal: not a git repository (or any of the parent directories): .git", "sync.hint.notRepo");
    assert_hint(
        "error: Your local changes to the following files would be overwritten by merge:",
        "sync.hint.diverged",
    );
}

#[test]
fn 非快进拒绝给出拉取建议() {
    // 用户实测的原文：远端已有本地没有的提交，push 被拒。
    // 这条以前识别不出来——界面只给了英文报错，没有任何可执行建议。
    assert_hint(
        "To https://github.com/x/y.git\n ! [rejected]        master -> master (fetch first)\nerror: failed to push some refs to 'https://github.com/x/y.git'\nhint: Updates were rejected because the remote contains work that you do not\nhint: have locally. This is usually caused by another repository pushing to\nhint: the same ref. If you want to integrate the remote changes, use\nhint: 'git pull' before pushing again.",
        "sync.hint.nonFastForward",
    );
    // 变体：远端被 force-push 过或历史分叉
    assert_hint(
        "! [rejected]        main -> main (non-fast-forward)",
        "sync.hint.nonFastForward",
    );
}

#[test]
fn 认不出的报错不硬塞建议() {
    // 给不出靠谱建议时宁可什么都不说，也不要乱猜让用户白折腾
    assert!(git_failure_hint("fatal: something we have never seen before").is_none());
    assert!(git_failure_hint("").is_none());
}

#[test]
fn first_cause_跳过外层包装行() {
    // git 的 stderr 第一行常是 "fatal: unable to access '...'"，
    // 真正的原因（curl 的报错）在后面 —— 只显示第一行正是「日志不够详细」的直接原因
    let stderr = "fatal: unable to access 'https://github.com/x/y.git/': Failed to connect to github.com port 443: Timed out";
    assert!(
        first_cause(stderr).contains("Failed to connect"),
        "应挑出带原因的那一行，实际：{}",
        first_cause(stderr)
    );

    let multiline = "Cloning into 'x'...\nfatal: unable to access 'https://github.com/x/y.git/': SSL certificate problem: self-signed certificate\n";
    assert!(
        first_cause(multiline).contains("SSL certificate problem"),
        "应挑出带原因的那一行，实际：{}",
        first_cause(multiline)
    );
}

#[test]
fn 命令行的失败信息要说清是哪条命令() {
    let error = aichat_core::Error::Git {
        code: 128,
        args: vec!["push".into(), "origin".into(), "main".into()],
        stdout: String::new(),
        stderr: "fatal: Authentication failed".into(),
    };
    let message = error.user_message();
    assert!(message.contains("git push origin main"), "要指出是哪条命令：{message}");
    assert!(message.contains("Authentication failed"), "要带上原因：{message}");
}
