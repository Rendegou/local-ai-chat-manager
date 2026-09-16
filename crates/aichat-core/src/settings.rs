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

/// 应用设置。字段名以 camelCase 序列化，前端可直接使用。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AppSettings {
    /// Codex 数据目录手工覆盖（为空则自动探测，规格 §6）
    pub codex_path: Option<String>,
    /// Kimi Code 数据目录手工覆盖
    pub kimi_path: Option<String>,
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
    /// 是否在快照时复制原始会话文件（默认开启，规格 §15）
    pub keep_raw_files: bool,
    /// 启动后自动增量扫描
    pub auto_scan_on_start: bool,
    /// 是否开启文件监听（规格 §23）
    pub watch_enabled: bool,
    /// 主题
    pub theme: Theme,
    /// 单次扫描最多解析的会话数（保护首次全量扫描时的资源占用；0 表示不限制）
    pub scan_batch_limit: usize,
    /// 会话列表中是否显示已归档会话
    pub show_archived: bool,
}

impl Default for AppSettings {
    fn default() -> Self {
        AppSettings {
            codex_path: None,
            kimi_path: None,
            sync_repo: None,
            git_exe: "git".to_string(),
            remote_url: None,
            archive_compression: Compression::Zstd,
            archive_after_days: 90,
            keep_raw_files: true,
            auto_scan_on_start: true,
            watch_enabled: true,
            theme: Theme::System,
            // 首批扫描 2000 个会话，避免第一次打开超大数据集时长时间占用磁盘
            scan_batch_limit: 2000,
            show_archived: false,
        }
    }
}

impl AppSettings {
    /// 从数据目录加载设置（不存在则返回默认值）。
    pub fn load(data_dir: &Path) -> Result<Self> {
        let path = Self::file_path(data_dir);
        if !paths::is_file(&path) {
            return Ok(AppSettings::default());
        }
        let raw = std::fs::read_to_string(&path).map_err(|e| Error::io(&path, e))?;
        match serde_json::from_str::<AppSettings>(&raw) {
            Ok(s) => Ok(s),
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
    pub fn codex_root(&self) -> Option<PathBuf> {
        self.codex_path
            .as_deref()
            .map(paths::expand_home)
            .filter(|p| !p.as_os_str().is_empty())
    }

    /// Kimi 数据目录：手工配置优先。
    pub fn kimi_root(&self) -> Option<PathBuf> {
        self.kimi_path
            .as_deref()
            .map(paths::expand_home)
            .filter(|p| !p.as_os_str().is_empty())
    }

    /// 同步仓库目录。
    pub fn repo_root(&self) -> Option<PathBuf> {
        self.sync_repo
            .as_deref()
            .map(paths::expand_home)
            .filter(|p| !p.as_os_str().is_empty())
    }

    /// 校验设置：同步仓库不得指向 AI 工具自己的数据目录（规格 §4.3）。
    pub fn validate(&self) -> Result<()> {
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
        assert!(s.keep_raw_files);
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
