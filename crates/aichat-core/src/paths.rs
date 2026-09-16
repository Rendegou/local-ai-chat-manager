//! 路径工具与隐私红线（规格 §5、§16、§3.3）。
//!
//! 关键约定：
//! - 默认目录推导不依赖额外 crate（跨平台：Windows / macOS / Linux）；
//! - [`is_forbidden_path`] 是硬性隐私边界：credentials / token 相关目录永不读取、永不复制、永不提交；
//! - 所有写入同步仓库的路径都必须经过 [`sanitize_component`] 清洗。

use std::path::{Component, Path, PathBuf};

/// 绝对禁止访问的目录 / 文件名（大小写不敏感）。
///
/// 这些内容可能包含 API Key、OAuth 凭证、Cookie，属于隐私红线。
/// 例如 Codex 的 `~/.codex/auth.json`、Kimi 的 `~/.kimi-code/credentials/`。
const FORBIDDEN_NAMES: &[&str] = &[
    "credentials",
    "credential",
    "auth",
    "oauth",
    "tokens",
    "token",
    ".env",
    "secrets",
    "secret",
    ".ssh",
    "cookies",
    "cookie",
    "keychain",
    "server.token",
    ".sandbox-secrets",
    "id_rsa",
    "id_ed25519",
];

/// 禁止的扩展名（私钥 / 证书类）。
const FORBIDDEN_EXTENSIONS: &[&str] = &["pem", "key", "p12", "pfx", "keystore"];

/// 判断路径是否命中隐私红线。
///
/// 规则：路径中任意一段（目录名或文件名）命中以下任一条件即判定为禁止访问：
/// 1. 名字本身在禁止名单中（`credentials` / `secrets` / `.ssh` …）；
/// 2. 名字以 `auth.` 开头（`auth.json` 保存 API Key）或以 `.token` 结尾；
/// 3. 名字包含 `credential`；
/// 4. 扩展名属于私钥类（`pem` / `key` / `p12` …）。
pub fn is_forbidden_path(path: &Path) -> bool {
    for comp in path.components() {
        let name = match comp {
            Component::Normal(os) => os.to_string_lossy().to_ascii_lowercase(),
            _ => continue,
        };
        if FORBIDDEN_NAMES.iter().any(|f| name == *f) {
            return true;
        }
        if name.starts_with("auth.") || name.ends_with(".token") || name.ends_with(".credentials") {
            return true;
        }
        if name.contains("credential") {
            return true;
        }
        if let Some((_, ext)) = name.rsplit_once('.') {
            if FORBIDDEN_EXTENSIONS.contains(&ext) {
                return true;
            }
        }
    }
    false
}

/// 默认应用数据目录（索引库、设置、machine id 存放地）。
///
/// - Windows: `%LOCALAPPDATA%/LocalAIChatManager`
/// - macOS: `~/Library/Application Support/LocalAIChatManager`
/// - Linux: `$XDG_DATA_HOME/local-ai-chat-manager` 或 `~/.local/share/...`
pub fn default_data_dir() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        if let Some(dir) = std::env::var_os("LOCALAPPDATA") {
            return PathBuf::from(dir).join("LocalAIChatManager");
        }
        if let Some(profile) = std::env::var_os("USERPROFILE") {
            return PathBuf::from(profile)
                .join("AppData")
                .join("Local")
                .join("LocalAIChatManager");
        }
    }

    #[cfg(target_os = "macos")]
    {
        if let Some(home) = home_dir() {
            return home
                .join("Library")
                .join("Application Support")
                .join("LocalAIChatManager");
        }
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        if let Some(dir) = std::env::var_os("XDG_DATA_HOME") {
            return PathBuf::from(dir).join("local-ai-chat-manager");
        }
        if let Some(home) = home_dir() {
            return home.join(".local/share/local-ai-chat-manager");
        }
    }

    PathBuf::from(".local-ai-chat-manager")
}

/// 用户 Home 目录（不引入额外依赖）。
pub fn home_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        std::env::var_os("USERPROFILE")
            .map(PathBuf::from)
            .or_else(|| {
                let drive = std::env::var_os("HOMEDRIVE")?;
                let path = std::env::var_os("HOMEPATH")?;
                let mut p = PathBuf::from(drive);
                p.push(path);
                Some(p)
            })
    }
    #[cfg(not(windows))]
    {
        std::env::var_os("HOME").map(PathBuf::from)
    }
}

/// 展开 `~` 前缀并做词法规范化（不解析符号链接，避免跨机器路径错乱）。
pub fn expand_home(input: &str) -> PathBuf {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return PathBuf::new();
    }
    let path = if let Some(rest) = trimmed
        .strip_prefix("~/")
        .or_else(|| trimmed.strip_prefix("~\\"))
    {
        match home_dir() {
            Some(home) => home.join(rest),
            None => PathBuf::from(rest),
        }
    } else if trimmed == "~" {
        home_dir().unwrap_or_default()
    } else {
        PathBuf::from(trimmed)
    };
    normalize_lexical(&path)
}

/// 词法规范化：消除 `.`、多余分隔符与可安全抵消的 `..`（不触碰文件系统）。
pub fn normalize_lexical(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for comp in path.components() {
        match comp {
            Component::CurDir => {}
            Component::ParentDir => {
                // 仅在已有普通目录段时抵消，否则保留（可能是有意的相对路径）
                if out
                    .components()
                    .next_back()
                    .map(|c| matches!(c, Component::Normal(_)))
                    .unwrap_or(false)
                {
                    out.pop();
                } else {
                    out.push("..");
                }
            }
            other => out.push(other.as_os_str()),
        }
    }
    if out.as_os_str().is_empty() {
        PathBuf::from(".")
    } else {
        out
    }
}

/// 默认 Kimi Code 数据根目录：`KIMI_CODE_HOME` 优先，其次 `~/.kimi-code`（规格 §5）。
pub fn default_kimi_root() -> PathBuf {
    if let Some(dir) = std::env::var_os("KIMI_CODE_HOME") {
        let p = PathBuf::from(dir);
        if !p.as_os_str().is_empty() {
            return normalize_lexical(&p);
        }
    }
    home_dir()
        .map(|h| h.join(".kimi-code"))
        .unwrap_or_else(|| PathBuf::from(".kimi-code"))
}

/// Kimi 数据根目录候选清单：手工配置 > 环境变量 > 常见位置。
pub fn kimi_root_candidates(manual: Option<&Path>) -> Vec<PathBuf> {
    let mut list = Vec::new();
    if let Some(m) = manual {
        list.push(normalize_lexical(m));
    }
    list.push(default_kimi_root());
    if let Some(home) = home_dir() {
        // 少数环境使用 `.kimi` 或 `kimi-code`
        list.push(home.join(".kimi"));
        list.push(home.join(".kimi-code-data"));
    }
    dedup_paths(list)
}

/// 默认 Codex 数据根目录：`CODEX_HOME` 优先，其次 `~/.codex`（规格 §6）。
pub fn default_codex_root() -> PathBuf {
    if let Some(dir) = std::env::var_os("CODEX_HOME") {
        let p = PathBuf::from(dir);
        if !p.as_os_str().is_empty() {
            return normalize_lexical(&p);
        }
    }
    home_dir()
        .map(|h| h.join(".codex"))
        .unwrap_or_else(|| PathBuf::from(".codex"))
}

/// Codex 数据根目录候选清单：**不把单一版本路径写死**，而是按优先级探测（规格 §6）。
pub fn codex_root_candidates(manual: Option<&Path>) -> Vec<PathBuf> {
    let mut list = Vec::new();
    if let Some(m) = manual {
        list.push(normalize_lexical(m));
    }
    list.push(default_codex_root());
    if let Some(home) = home_dir() {
        list.push(home.join(".codex"));
        list.push(home.join(".config").join("codex"));
        list.push(home.join(".openai").join("codex"));
        // 部分版本把数据放在 Documents / AppData
        list.push(home.join("AppData").join("Roaming").join("codex"));
    }
    dedup_paths(list)
}

/// 去重并保持顺序。
pub fn dedup_paths(list: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut seen: Vec<String> = Vec::with_capacity(list.len());
    let mut out = Vec::with_capacity(list.len());
    for p in list {
        let key = canonical_key(&p);
        if !seen.iter().any(|s| s == &key) {
            seen.push(key);
            out.push(p);
        }
    }
    out
}

/// 用于去重比对的 key：Windows 大小写不敏感。
pub fn canonical_key(path: &Path) -> String {
    let s = path.to_string_lossy().replace('\\', "/");
    if cfg!(windows) {
        s.to_ascii_lowercase()
    } else {
        s
    }
}

/// 两个路径是否指向同一位置（词法比较，不做 IO）。
pub fn same_path(a: &Path, b: &Path) -> bool {
    canonical_key(a) == canonical_key(b)
}

/// 计算 `target` 相对 `root` 的仓库内相对路径（正斜杠）；不在 root 下返回 `None`。
pub fn relative_posix(root: &Path, target: &Path) -> Option<String> {
    let root_norm = normalize_lexical(root);
    let target_norm = normalize_lexical(target);
    let root_key = canonical_key(&root_norm);
    let target_key = canonical_key(&target_norm);
    let rel = if target_key == root_key {
        String::new()
    } else {
        let prefix = if root_key.ends_with('/') {
            root_key.clone()
        } else {
            format!("{root_key}/")
        };
        if !target_key.starts_with(&prefix) {
            return None;
        }
        target_key[prefix.len()..].to_string()
    };
    Some(rel)
}

/// 清洗文件 / 目录名：去除路径分隔符与危险字符，保证可安全拼接到仓库路径。
pub fn sanitize_component(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    for ch in name.chars() {
        match ch {
            'a'..='z' | 'A'..='Z' | '0'..='9' | '-' | '_' | '.' | '@' => out.push(ch),
            _ => out.push('_'),
        }
    }
    // 规避 `.` / `..` 这类危险名
    if out.is_empty() || out == "." || out == ".." {
        out = format!("s_{}", short_random_suffix());
    }
    out
}

/// 短随机后缀（用于兜底命名，避免空名冲突）。
fn short_random_suffix() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    format!("{:08x}", nanos)
}

/// 目录是否实际存在且为目录。
pub fn is_dir(path: &Path) -> bool {
    std::fs::metadata(path).map(|m| m.is_dir()).unwrap_or(false)
}

/// 文件是否实际存在且为文件。
pub fn is_file(path: &Path) -> bool {
    std::fs::metadata(path)
        .map(|m| m.is_file())
        .unwrap_or(false)
}

/// 目录下的直接子目录名（升序，跳过隐藏目录与隐私红线）。
pub fn sub_dirs(path: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let entries = match std::fs::read_dir(path) {
        Ok(e) => e,
        Err(_) => return out,
    };
    for entry in entries.flatten() {
        let p = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        if is_forbidden_path(&p) {
            continue;
        }
        if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            out.push(p);
        }
    }
    out.sort();
    out
}

/// 确保目录存在（递归创建）。
pub fn ensure_dir(path: &Path) -> std::io::Result<()> {
    if path.as_os_str().is_empty() {
        return Ok(());
    }
    std::fs::create_dir_all(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 隐私目录被拦截() {
        assert!(is_forbidden_path(Path::new(
            "/home/u/.kimi-code/credentials/token.json"
        )));
        assert!(is_forbidden_path(Path::new(
            r"C:\Users\u\.kimi-code\server.token"
        )));
        assert!(is_forbidden_path(Path::new("/x/.codex/auth.json")));
        assert!(is_forbidden_path(Path::new("/x/secrets/foo")));
        // 正常会话文件不受影响
        assert!(!is_forbidden_path(Path::new(
            r"C:\Users\u\.kimi-code\sessions\wd_a\ses_b\agents\main\wire.jsonl"
        )));
        assert!(!is_forbidden_path(Path::new(
            r"C:\Users\u\.codex\sessions\2026\09\01\rollout-x.jsonl"
        )));
    }

    #[test]
    fn 词法规范化处理相对段() {
        assert_eq!(
            normalize_lexical(Path::new("/a/b/../c/./d")),
            PathBuf::from("/a/c/d")
        );
        assert_eq!(normalize_lexical(Path::new("a/b/")), PathBuf::from("a/b"));
    }

    #[test]
    fn 相对路径统一正斜杠() {
        let rel = relative_posix(Path::new("/repo"), Path::new("/repo/kimi/pc-a/x/meta.json"));
        assert_eq!(rel.as_deref(), Some("kimi/pc-a/x/meta.json"));
        assert!(relative_posix(Path::new("/repo"), Path::new("/other/x")).is_none());
    }

    #[test]
    fn 组件名清洗() {
        assert_eq!(sanitize_component("ses_abc-123"), "ses_abc-123");
        assert_eq!(sanitize_component("../etc/passwd"), ".._etc_passwd");
        // 危险 / 空名字替换为随机兜底名，保证可以安全拼路径
        let empty = sanitize_component("");
        assert!(empty.starts_with("s_"), "空名应生成兜底名: {empty}");
        let dotdot = sanitize_component("..");
        assert!(dotdot.starts_with("s_"), "`..` 应生成兜底名: {dotdot}");
    }

    #[test]
    fn 展开_home_前缀() {
        let expanded = expand_home("~/x/y");
        if let Some(home) = home_dir() {
            assert!(canonical_key(&expanded).contains(&canonical_key(&home)));
        }
    }
}
