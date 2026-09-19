//! 应用设置与 machine id 管理（规格 §11、§19）。
//!
//! - 设置保存在应用数据目录的 `settings.json`，与同步仓库解耦；
//! - `machine.json` 保存稳定的 machine id（UUID），**绝不使用 Windows 用户名**；
//! - 所有路径统一走 [`crate::paths::expand_home`]，支持 `~` 前缀。

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};
use crate::paths;

/// 归档压缩格式（规格 §17：优先 zstd）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
#[derive(Default)]
pub enum Compression {
    /// zstd（推荐：压缩率高、解压快）
    #[default]
    Zstd,
    /// gzip（兼容性兜底）
    Gzip,
}

impl Compression {
    /// 文件扩展名。
    pub const fn extension(self) -> &'static str {
        match self {
            Compression::Zstd => "tar.zst",
            Compression::Gzip => "tar.gz",
        }
    }

    /// 展示名。
    pub const fn display_name(self) -> &'static str {
        match self {
            Compression::Zstd => "zstd",
            Compression::Gzip => "gzip",
        }
    }
}

/// 主题偏好。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
#[derive(Default)]
pub enum Theme {
    #[default]
    System,
    Light,
    Dark,
}

/// 界面语言偏好。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
#[derive(Default)]
pub enum Language {
    /// 跟随系统（前端按 navigator.language 判断）
    #[default]
    System,
    /// 中文
    Zh,
    /// English
    En,
}

/// 用户自定义数据源的字段映射：把任意 JSONL / JSON 翻译成会话。
///
/// 存在的理由是「满足所有人」：给每个工具写一个 Rust 适配器追不上生态，
/// 而这类工具几乎都往 `~/.xxx/` 写 JSONL 或 JSON。与其等我们写适配器，
/// 不如让用户自己填一份映射——**不需要写代码**。
///
/// 映射填错不会静默成功：解析出 0 条消息时适配器返回明确错误，
/// 而且界面上的「试解析」能在保存前就告诉你这个目录能读出什么。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct FieldMapping {
    /// 文件布局：`jsonl`（一行一条消息）或 `json`（一个文件一个会话对象）
    pub layout: String,
    /// `json` 布局下消息数组的路径，用 `.` 分隔，例如 `data.items`
    pub messages_path: String,
    /// 角色字段（相对每条消息），例如 `role` / `author.role` / `type`
    pub role_field: String,
    /// 正文字段，例如 `content` / `text`
    pub text_field: String,
    /// 时间字段。留空表示不读时间。
    pub time_field: String,
    /// 工具名字段（仅角色为 `tool` 时使用）。留空表示不读。
    pub tool_field: String,
    /// 标题字段。`json` 布局从文件根对象读，`jsonl` 布局从第一条记录读。
    pub title_field: String,
    /// 项目路径字段。读取位置同 `title_field`。
    pub project_field: String,
    /// 非标准角色名的映射，例如 `{"bot": "assistant", "human": "user"}`
    pub role_map: std::collections::BTreeMap<String, String>,
    /// 参与索引的文件扩展名（不含点）
    pub extensions: Vec<String>,
    /// 目录递归深度上限
    pub max_depth: usize,
}

impl Default for FieldMapping {
    fn default() -> Self {
        FieldMapping {
            layout: "jsonl".to_string(),
            messages_path: "messages".to_string(),
            role_field: "role".to_string(),
            text_field: "content".to_string(),
            // timestamp 是最常见的键名。文件里没有它只是读不到时间，不影响消息本身，
            // 所以给一个有用的默认值比留空更合适（试解析里能立刻看出时间没读上）。
            time_field: "timestamp".to_string(),
            tool_field: String::new(),
            title_field: String::new(),
            project_field: String::new(),
            role_map: Default::default(),
            extensions: vec!["jsonl".to_string()],
            max_depth: 8,
        }
    }
}

impl FieldMapping {
    /// 是否为「一行一条消息」布局。
    pub fn is_jsonl(&self) -> bool {
        !self.layout.eq_ignore_ascii_case("json")
    }

    /// 校验并给出人话错误（保存设置时调用）。
    ///
    /// 这里刻意严格：一份写错的映射会让用户以为「已经接上了」，
    /// 结果扫描完什么都没有。能在保存时发现的问题不要留到扫描之后。
    pub fn validate(&self) -> Result<()> {
        if !matches!(self.layout.as_str(), "jsonl" | "json") {
            return Err(Error::config("自定义来源的布局必须是 jsonl 或 json"));
        }
        for (label, value) in [
            ("消息数组路径", &self.messages_path),
            ("角色字段", &self.role_field),
            ("正文字段", &self.text_field),
        ] {
            if value.trim().is_empty() {
                return Err(Error::config(format!("自定义来源的{label}不能为空")));
            }
            if value.contains("..") || value.starts_with('.') || value.ends_with('.') {
                return Err(Error::config(format!("自定义来源的{label}路径格式不正确：{value}")));
            }
        }
        if self.extensions.is_empty() {
            return Err(Error::config("自定义来源至少要指定一个文件扩展名"));
        }
        for ext in &self.extensions {
            let clean = ext.trim().trim_start_matches('.');
            if clean.is_empty() || clean.len() > 12 || !clean.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') {
                return Err(Error::config(format!("文件扩展名不合法：{ext}")));
            }
        }
        if self.max_depth == 0 || self.max_depth > 32 {
            return Err(Error::config("自定义来源的目录深度须为 1–32"));
        }
        for (from, to) in &self.role_map {
            if from.trim().is_empty() {
                return Err(Error::config("角色映射里的原名不能为空"));
            }
            if crate::model::Role::parse(to) == crate::model::Role::Unknown {
                return Err(Error::config(format!("角色映射的目标无法识别：{to}")));
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SourceConfig {
    pub enabled: bool,
    pub path: Option<String>,
    /// 用户自定义来源的显示名（缺省时用 id）
    pub display_name: Option<String>,
    /// 存在即为「用户自定义来源」：由 GenericJsonAdapter 按这份映射读取 `path` 目录
    pub mapping: Option<FieldMapping>,
}
impl Default for SourceConfig {
    fn default() -> Self { Self { enabled: true, path: None, display_name: None, mapping: None } }
}

/// 应用设置。字段名以 camelCase 序列化，前端可直接使用。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AppSettings {
    pub sources: std::collections::BTreeMap<String, SourceConfig>,
    /// Codex 数据目录手工覆盖（为空则自动探测，规格 §6）
    pub codex_path: Option<String>,
    /// Kimi Code 数据目录手工覆盖
    pub kimi_path: Option<String>,
    /// Cursor 数据目录手工覆盖（指向 globalStorage，内含 state.vscdb）
    pub cursor_path: Option<String>,
    /// ZCode 会话目录手工覆盖（指向 `v2/sessions`）
    pub zcode_path: Option<String>,
    /// 同步仓库根目录（独立于 AI 工具数据目录，规格 §4.3）
    pub sync_repo: Option<String>,
    /// git 可执行文件（默认 `git`，从 PATH 查找）
    pub git_exe: String,
    /// 远端地址（可选，支持任意标准 Git 服务）
    pub remote_url: Option<String>,
    /// 归档压缩格式
    pub archive_compression: Compression,
    /// 归档阈值天数（默认 90 天未更新，规格 §17）
    pub archive_after_days: u32,
    /// 是否在快照时复制原始会话文件（默认关闭，避免与归一化消息重复占用 Git 空间）
    pub keep_raw_files: bool,
    /// 启动后自动增量扫描
    pub auto_scan_on_start: bool,
    /// 是否开启文件监听（规格 §23）
    pub watch_enabled: bool,
    /// 主题
    pub theme: Theme,
    /// 界面语言（默认跟随系统）
    pub language: Language,
    /// 单次扫描最多解析的会话数（保护首次全量扫描时的资源占用；0 表示不限制）
    pub scan_batch_limit: usize,
    /// 会话列表中是否显示已归档会话
    pub show_archived: bool,
}

impl Default for AppSettings {
    fn default() -> Self {
        AppSettings {
            sources: Default::default(),
            codex_path: None,
            kimi_path: None,
            cursor_path: None,
            zcode_path: None,
            sync_repo: None,
            git_exe: "git".to_string(),
            remote_url: None,
            archive_compression: Compression::Zstd,
            archive_after_days: 90,
            keep_raw_files: false,
            auto_scan_on_start: true,
            watch_enabled: true,
            theme: Theme::System,
            language: Language::System,
            // 首批扫描 2000 个会话，避免第一次打开超大数据集时长时间占用磁盘
            scan_batch_limit: 2000,
            show_archived: false,
        }
    }
}

impl AppSettings {
    pub fn migrate_sources(&mut self) {
        for (id, path) in [("codex", &self.codex_path), ("kimi", &self.kimi_path), ("cursor", &self.cursor_path), ("zcode", &self.zcode_path)] {
            self.sources
                .entry(id.into())
                .or_insert_with(|| SourceConfig { enabled: true, path: path.clone(), ..Default::default() });
        }
    }
    pub fn source_enabled(&self, id: &str) -> bool {
        self.sources.get(id).map(|s| s.enabled).unwrap_or(true)
    }
    /// 用户给某个来源起的显示名（自定义来源用；内置来源返回 None，由 catalog 决定）。
    pub fn source_display_name(&self, id: &str) -> Option<&str> {
        self.sources
            .get(id)
            .and_then(|c| c.display_name.as_deref())
            .map(str::trim)
            .filter(|s| !s.is_empty())
    }
    /// 全部用户自定义来源（有字段映射的那些），按 id 排序保证 UI 顺序稳定。
    pub fn custom_sources(&self) -> impl Iterator<Item = (&str, &SourceConfig)> {
        self.sources
            .iter()
            .filter(|(_, c)| c.mapping.is_some())
            .map(|(id, c)| (id.as_str(), c))
    }
    pub fn source_root(&self, id: &str) -> Option<PathBuf> {
        let path = if let Some(config) = self.sources.get(id) { config.path.as_deref() } else {
            match id { "codex" => self.codex_path.as_deref(), "kimi" => self.kimi_path.as_deref(), "cursor" => self.cursor_path.as_deref(), "zcode" => self.zcode_path.as_deref(), _ => None }
        };
        path.filter(|s| !s.trim().is_empty()).map(paths::expand_home)
    }
    /// 从数据目录加载设置（不存在则返回默认值）。
    pub fn load(data_dir: &Path) -> Result<Self> {
        let path = Self::file_path(data_dir);
        if !paths::is_file(&path) {
            return Ok(AppSettings::default());
        }
        let raw = std::fs::read_to_string(&path).map_err(|e| Error::io(&path, e))?;
        match serde_json::from_str::<AppSettings>(&raw) {
            Ok(mut s) => { s.migrate_sources(); Ok(s) },
            Err(e) => {
                // 设置文件损坏不应导致应用无法启动：退回默认值并给出提示
                tracing::warn!(error = %e, "settings.json 解析失败，使用默认设置");
                Err(Error::config(format!("settings.json 解析失败: {e}")))
            }
        }
    }

    /// 加载设置，失败时退回默认值（启动路径专用，永不失败）。
    pub fn load_or_default(data_dir: &Path) -> Self {
        Self::load(data_dir).unwrap_or_default()
    }

    /// 保存设置（原子写：先写临时文件再替换）。
    pub fn save(&self, data_dir: &Path) -> Result<()> {
        let path = Self::file_path(data_dir);
        paths::ensure_dir(data_dir).map_err(|e| Error::io(data_dir, e))?;
        let json = serde_json::to_string_pretty(self)?;
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, json).map_err(|e| Error::io(&tmp, e))?;
        std::fs::rename(&tmp, &path).map_err(|e| Error::io(&path, e))?;
        Ok(())
    }

    /// 设置文件路径。
    pub fn file_path(data_dir: &Path) -> PathBuf {
        data_dir.join("settings.json")
    }

    /// 索引数据库路径。
    pub fn db_path(data_dir: &Path) -> PathBuf {
        data_dir.join("index.db")
    }

    /// Codex 数据目录：手工配置优先。
    pub fn codex_root(&self) -> Option<PathBuf> { self.source_root("codex") }

    /// Kimi 数据目录：手工配置优先。
    pub fn kimi_root(&self) -> Option<PathBuf> { self.source_root("kimi") }

    /// Cursor 数据目录：手工配置优先。
    pub fn cursor_root(&self) -> Option<PathBuf> { self.source_root("cursor") }

    /// ZCode 会话目录：手工配置优先。
    pub fn zcode_root(&self) -> Option<PathBuf> { self.source_root("zcode") }

    /// 同步仓库目录。
    pub fn repo_root(&self) -> Option<PathBuf> {
        self.sync_repo
            .as_deref()
            .map(paths::expand_home)
            .filter(|p| !p.as_os_str().is_empty())
    }

    /// 校验设置：同步仓库不得指向 AI 工具自己的数据目录（规格 §4.3）。
    pub fn validate(&self) -> Result<()> {
        for id in self.sources.keys() { if crate::model::SourceKind::parse(id).is_none() { return Err(Error::config("数据源标识无效")); } }
        // 自定义来源：映射写错必须在这里就报出来，而不是等扫描完发现一条会话都没有
        for (id, config) in self.sources.iter().filter(|(_, c)| c.mapping.is_some()) {
            let mapping = config.mapping.as_ref().expect("已按 mapping 过滤");
            if config.path.as_deref().map(str::trim).unwrap_or("").is_empty() {
                return Err(Error::config(format!("自定义来源「{id}」必须指定一个目录")));
            }
            // 不能占用已有内置来源的标识：那会让两个适配器同 id 抢同一批会话。
            // 但 pending 例外——「把还没适配的工具自己接上」正是自定义来源的用途之一。
            if let Some(def) = crate::adapters::registry::catalog().iter().find(|d| d.id == id) {
                if def.access != "pending" {
                    return Err(Error::config(format!(
                        "来源标识「{id}」已被内置来源「{}」占用，请换一个",
                        def.display_name
                    )));
                }
            }
            mapping.validate()?;
        }
        if let Some(repo) = self.repo_root() {
            for (label, root) in [
                ("Codex", paths::default_codex_root()),
                ("Kimi Code", paths::default_kimi_root()),
            ] {
                if paths::same_path(&repo, &root) {
                    return Err(Error::config(format!(
                        "同步仓库不能直接指向 {label} 的数据目录，请另选一个独立目录"
                    )));
                }
            }
            if paths::is_forbidden_path(&repo) {
                return Err(Error::config(
                    "同步仓库路径包含凭证类目录名，请另选目录".to_string(),
                ));
            }
        }
        if self.git_exe.trim().is_empty() {
            return Err(Error::config("git 可执行文件不能为空".to_string()));
        }
        Ok(())
    }
}

/// 稳定机器标识（规格 §11）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MachineIdentity {
    /// 稳定 UUID（不用用户名、不用主机名）
    pub machine_id: String,
    /// 主机名，仅用于展示
    pub hostname: String,
    /// 平台标识，如 windows / macos / linux
    pub platform: String,
    /// 首次创建时间
    pub created_at: String,
}

impl MachineIdentity {
    /// 读取或创建 machine.json。
    pub fn load_or_create(data_dir: &Path) -> Result<Self> {
        let path = Self::file_path(data_dir);
        if paths::is_file(&path) {
            if let Ok(raw) = std::fs::read_to_string(&path) {
                if let Ok(identity) = serde_json::from_str::<MachineIdentity>(&raw) {
                    if !identity.machine_id.trim().is_empty() {
                        return Ok(identity);
                    }
                }
            }
        }
        let identity = MachineIdentity {
            machine_id: uuid::Uuid::new_v4().to_string(),
            hostname: hostname(),
            platform: std::env::consts::OS.to_string(),
            created_at: chrono::Utc::now().to_rfc3339(),
        };
        identity.save(data_dir)?;
        Ok(identity)
    }

    /// 写入 machine.json。
    pub fn save(&self, data_dir: &Path) -> Result<()> {
        paths::ensure_dir(data_dir).map_err(|e| Error::io(data_dir, e))?;
        let path = Self::file_path(data_dir);
        let json = serde_json::to_string_pretty(self)?;
        std::fs::write(&path, json).map_err(|e| Error::io(&path, e))?;
        Ok(())
    }

    /// machine.json 路径。
    pub fn file_path(data_dir: &Path) -> PathBuf {
        data_dir.join("machine.json")
    }
}

/// 主机名（取不到时返回 "unknown"）。
pub fn hostname() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "unknown".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 设置往返读写() {
        let dir = tempfile::tempdir().unwrap();
        let s = AppSettings {
            codex_path: Some("~/codex-data".to_string()),
            archive_compression: Compression::Gzip,
            keep_raw_files: false,
            ..Default::default()
        };
        s.save(dir.path()).unwrap();

        let loaded = AppSettings::load(dir.path()).unwrap();
        assert_eq!(loaded.codex_path.as_deref(), Some("~/codex-data"));
        assert_eq!(loaded.archive_compression, Compression::Gzip);
        assert!(!loaded.keep_raw_files);
    }

    #[test]
    fn 缺失设置为默认值() {
        let dir = tempfile::tempdir().unwrap();
        let s = AppSettings::load_or_default(dir.path());
        assert_eq!(s.git_exe, "git");
        assert_eq!(s.archive_after_days, 90);
        assert!(!s.keep_raw_files);
    }

    #[test]
    fn 拒绝把同步仓库指向工具数据目录() {
        let s = AppSettings {
            sync_repo: Some(paths::default_kimi_root().display().to_string()),
            ..Default::default()
        };
        assert!(s.validate().is_err());
    }

    #[test]
    fn machine_id_稳定且非用户名() {
        let dir = tempfile::tempdir().unwrap();
        let a = MachineIdentity::load_or_create(dir.path()).unwrap();
        let b = MachineIdentity::load_or_create(dir.path()).unwrap();
        assert_eq!(a.machine_id, b.machine_id);
        assert!(uuid::Uuid::parse_str(&a.machine_id).is_ok());
    }
}
