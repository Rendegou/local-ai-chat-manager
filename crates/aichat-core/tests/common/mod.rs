//! 集成测试共用的夹具工具。
//!
//! 存在的唯一理由：**测试不该依赖开发机上装了什么**。
//!
//! 背景：每个测试都在临时目录里合成自己的会话数据，但适配器在「设置里没有该来源的路径」时
//! 会回退到真实用户目录（`~/.codex`、`~/.claude/projects`、`~/.gemini/tmp`…）。
//! 于是装了 Claude Code 的开发机上，`library.scan()` 会把真实会话一起扫进来，
//! `assert_eq!(report.parsed, 2)` 变成 126 —— 测的是环境而不是代码。
#![allow(dead_code)]

use std::path::Path;

use aichat_core::adapters::registry;
use aichat_core::settings::{AppSettings, SourceConfig};

/// 把 catalog 里除 `keep` 之外的每个来源都显式停用；`keep` 里没有显式路径的，
/// 钉到一个空目录。
///
/// 两条规则各治一种污染，缺一不可：
/// - **停用**：`Library::adapters()` 先按 `source_enabled` 过滤，被停用的适配器根本不会构造。
/// - **钉空目录**：光是「不停用」还不够 —— 没有路径的适配器会回退到真实用户目录。
///   所以 `keep` 的语义是「别停用，但你也别真的去读开发机」。
///
/// 遍历 **registry catalog** 而不是写死名单，这样以后新增数据源不必再来逐个补钉。
pub fn isolate_sources(settings: &mut AppSettings, tmp: &Path, keep: &[&str]) {
    for def in registry::catalog() {
        if !keep.contains(&def.id) {
            settings.sources.insert(
                def.id.to_string(),
                SourceConfig { enabled: false, ..Default::default() },
            );
            continue;
        }
        // 调用方给了路径（sources[id].path 或旧版顶层字段）就尊重它；
        // 没给就钉到临时空目录，避免回退到真实主目录。
        if source_path(settings, def.id).is_some() {
            continue;
        }
        settings.sources.insert(
            def.id.to_string(),
            SourceConfig { enabled: true, path: Some(empty_dir(tmp, &format!("empty-{}", def.id))) },
        );
    }
}

/// 读取某来源当前生效的路径（`sources[id].path` 优先，其次旧版顶层字段）。
fn source_path(settings: &AppSettings, id: &str) -> Option<String> {
    if let Some(path) = settings.sources.get(id).and_then(|c| c.path.as_ref()) {
        if !path.trim().is_empty() {
            return Some(path.clone());
        }
    }
    match id {
        "codex" => settings.codex_path.clone(),
        "kimi" => settings.kimi_path.clone(),
        "cursor" => settings.cursor_path.clone(),
        "zcode" => settings.zcode_path.clone(),
        _ => None,
    }
}

/// 在临时目录下建一个空目录，返回可直接写进设置里的路径字符串。
pub fn empty_dir(tmp: &Path, name: &str) -> String {
    let dir = tmp.join(name);
    std::fs::create_dir_all(&dir).unwrap();
    dir.display().to_string()
}
