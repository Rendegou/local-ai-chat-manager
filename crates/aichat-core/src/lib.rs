//! Local AI Chat Manager —— 核心库。
//!
//! 本库不依赖 Tauri，包含全部业务逻辑，便于快速单元测试与在 CLI 中复用：
//!
//! ```text
//! adapters/  ：把 Codex / Kimi 原生文件翻译成统一模型（含同步仓库适配器）
//! parser/    ：JSONL 流式解析（容错、低内存）
//! scanner/   ：增量扫描（size+mtime → BLAKE3）+ 文件监听（debounce）
//! storage/   ：SQLite + FTS5 索引（可删除可重建）
//! sync/      ：Git 快照同步（无 shell 拼接、冲突不自动合并）
//! archive/   ：zstd / gzip 归档
//! ```
//!
//! 最重要的边界（规格 §4）：
//! 1. Codex / Kimi 的原始文件**只读**；
//! 2. Git 只管理独立同步仓库，绝不直接管理 AI 工具的数据目录；
//! 3. SQLite 只是可重建索引，跨设备数据以仓库中的文本快照为准；
//! 4. 隐私红线（credentials / token 等）永不读取、永不复制、永不提交。

pub mod adapters;
pub mod archive;
pub mod error;
pub mod imports;
pub mod model;
pub mod parser;
pub mod paths;
pub mod scanner;
pub mod settings;
pub mod storage;
pub mod sync;

use std::path::{Path, PathBuf};
use std::sync::RwLock;

pub use error::{Error, ErrorKind, Result};
pub use settings::{AppSettings, Compression, MachineIdentity, Theme};

/// 应用名（写入仓库 meta 文件）。
pub const APP_NAME: &str = "local-ai-chat-manager";
/// 应用版本。
pub const APP_VERSION: &str = env!("CARGO_PKG_VERSION");

/// 初始化日志（规格 §27）：默认写入 stderr，可通过 `RUST_LOG` 调整级别。
///
/// 注意：日志只记录 session id / 路径 / 大小 / 耗时 / 错误类型，
/// **绝不记录 prompt 正文、token、凭证**。
pub fn init_logging(default_level: &str) {
    use tracing_subscriber::{fmt, prelude::*, EnvFilter};
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new(format!("aichat_core={default_level},warn")));
    let _ = tracing_subscriber::registry()
        .with(filter)
        .with(fmt::layer().with_target(false))
        .try_init();
}

/// 应用门面：把适配器、索引、同步、归档串起来给上层（Tauri / CLI）使用。
pub struct Library {
    data_dir: PathBuf,
    settings: RwLock<AppSettings>,
    machine: MachineIdentity,
    db: storage::Database,
    operation_lock: std::sync::Mutex<()>,
    import_previews: std::sync::Mutex<std::collections::HashMap<String, (std::time::Instant, imports::ImportPackage, Vec<String>)>>,
}

impl Library {
    /// 打开（或创建）应用数据目录与索引库。
    pub fn open(data_dir: impl Into<PathBuf>) -> Result<Self> {
        let data_dir = data_dir.into();
        paths::ensure_dir(&data_dir).map_err(|e| Error::io(&data_dir, e))?;
        let settings = AppSettings::load_or_default(&data_dir);
        let machine = MachineIdentity::load_or_create(&data_dir)?;
        let db = storage::Database::open(&AppSettings::db_path(&data_dir))?;
        tracing::info!(
            data_dir = %error::display_path(&data_dir),
            machine_id = %machine.machine_id,
            "核心库已就绪"
        );
        Ok(Library {
            data_dir,
            settings: RwLock::new(settings),
            machine,
            db,
            operation_lock: std::sync::Mutex::new(()),
            import_previews: Default::default(),
        })
    }

    /// 应用数据目录。
    pub fn data_dir(&self) -> &Path {
        &self.data_dir
    }

    /// 本机 machine id。
    pub fn machine_id(&self) -> &str {
        &self.machine.machine_id
    }

    /// 索引数据库。
    pub fn db(&self) -> &storage::Database {
        &self.db
    }

    /// 当前设置的快照。
    pub fn settings(&self) -> AppSettings {
        self.settings.read().map(|s| s.clone()).unwrap_or_default()
    }

    /// 更新设置（校验 → 落盘 → 生效）。
    pub fn update_settings(&self, mut new_settings: AppSettings) -> Result<AppSettings> {
        new_settings.migrate_sources();
        new_settings.validate()?;
        let snapshot_policy_changed = self
            .settings
            .read()
            .map(|current| current.keep_raw_files != new_settings.keep_raw_files)
            .unwrap_or(false);
        if snapshot_policy_changed {
            // 标记操作即使随后保存设置失败也只是导致下次多做一次无害的快照校验。
            self.db
                .mark_synced_sessions_modified(&self.machine.machine_id)?;
        }
        new_settings.save(&self.data_dir)?;
        let mut guard = self
            .settings
            .write()
            .map_err(|_| Error::config("设置状态不可用".to_string()))?;
        *guard = new_settings.clone();
        Ok(new_settings)
    }

    /// 构造当前设置下的适配器集合（含同步仓库适配器）。
    pub fn adapters(&self) -> Vec<Box<dyn adapters::ConversationAdapter>> {
        let settings = self.settings();
        let mut list = adapters::default_adapters(
            settings
                .repo_root()
                .map(|p| error::display_path(&p))
                .filter(|p| !p.is_empty()),
        );
        list.retain(|a| a.is_remote() || settings.source_enabled(a.id()));
        list.push(Box::new(imports::ImportedAdapter { root: self.data_dir.join("imports") }));
        list
    }

    /// 探测所有数据源并写入 `sources` 表。
    pub fn detect_sources(&self) -> Result<Vec<storage::types::SourceRow>> {
        let settings = self.settings();
        let ctx = adapters::AdapterContext {
            settings: &settings,
            machine_id: &self.machine.machine_id,
        };
        let mut rows = Vec::new();
        for adapter in self.adapters() {
            if adapter.is_remote() {
                continue;
            }
            for detection in adapter.detect(&ctx) {
                let row = storage::types::SourceRow {
                    id: detection.source.as_str().to_string(),
                    display_name: detection.source.display_name().to_string(),
                    root_path: detection.root.as_ref().map(|p| error::display_path(p)),
                    found: detection.found,
                    session_hint: detection.session_hint,
                    manual: detection.manual,
                    notes: Some(detection.notes.join("；")),
                    detected_at: Some(chrono::Utc::now().to_rfc3339()),
                };
                self.db.upsert_source(&row)?;
                rows.push(row);
            }
        }
        Ok(rows)
    }

    /// 增量扫描（`force` = 忽略指纹全量重解析）。
    pub fn scan(
        &self,
        force: bool,
        progress: &mut dyn FnMut(scanner::ScanProgress),
    ) -> Result<scanner::ScanReport> {
        let _guard = self.operation_lock.lock().map_err(|_| Error::config("扫描状态不可用"))?;
        self.scan_unlocked(force, progress)
    }

    fn scan_unlocked(&self, force: bool, progress: &mut dyn FnMut(scanner::ScanProgress)) -> Result<scanner::ScanReport> {
        let settings = self.settings();
        let adapters = self.adapters();
        let ctx = adapters::AdapterContext {
            settings: &settings,
            machine_id: &self.machine.machine_id,
        };
        let options = scanner::ScanOptions {
            force,
            batch_limit: if force { 0 } else { settings.scan_batch_limit },
            batch_size: 512,
        };
        scanner::scan(&self.db, &adapters, &ctx, &options, progress)
    }

    /// 启动文件监听（规格 §23）。回调通常用于触发一次增量扫描。
    pub fn watch<F>(&self, on_change: F) -> Result<scanner::watcher::WatcherHandle>
    where
        F: FnMut() + Send + 'static,
    {
        let settings = self.settings();
        let adapters = self.adapters();
        let ctx = adapters::AdapterContext {
            settings: &settings,
            machine_id: &self.machine.machine_id,
        };
        let roots: Vec<scanner::watcher::WatchSpec> = adapters.iter().filter(|a| !a.is_remote()).flat_map(|a| {
            a.detect(&ctx).into_iter().filter_map(|d| d.root).map(|root| scanner::watcher::WatchSpec { root, extensions: a.watch_extensions() }).collect::<Vec<_>>()
        }).collect();
        if roots.is_empty() {
            return Err(Error::adapter("没有可监听的会话目录".to_string()));
        }
        scanner::watcher::start_filtered(
            roots,
            std::time::Duration::from_millis(scanner::watcher::DEFAULT_DEBOUNCE_MS),
            on_change,
        )
    }

    // ------------------------------------------------------------------
    // 查询
    // ------------------------------------------------------------------

    /// 会话列表。
    pub fn list_sessions(
        &self,
        filter: &storage::sessions::SessionFilter,
        limit: i64,
        offset: i64,
    ) -> Result<Vec<storage::sessions::SessionSummary>> {
        self.db.list_sessions(filter, limit, offset)
    }

    /// 会话总数。
    pub fn count_sessions(&self, filter: &storage::sessions::SessionFilter) -> Result<i64> {
        self.db.count_sessions(filter)
    }

    /// 会话详情。
    pub fn session_detail(&self, id: &str) -> Result<Option<storage::sessions::SessionDetail>> {
        self.db.get_session_detail(id)
    }

    /// 消息分页（虚拟列表按需加载）。
    pub fn messages_page(
        &self,
        session_id: &str,
        offset: i64,
        limit: i64,
    ) -> Result<Vec<storage::sessions::MessageRow>> {
        self.db.messages_page(session_id, offset, limit)
    }

    /// 某条消息前后文（搜索结果跳转）。
    pub fn messages_around(
        &self,
        session_id: &str,
        sequence: i64,
        before: i64,
        after: i64,
    ) -> Result<Vec<storage::sessions::MessageRow>> {
        self.db.messages_around(session_id, sequence, before, after)
    }

    /// 项目聚合。
    pub fn list_projects(&self) -> Result<Vec<storage::types::ProjectSummary>> {
        let include_archived = self.settings().show_archived;
        self.db.list_projects(include_archived)
    }

    /// 机器列表。
    pub fn list_machines(&self) -> Result<Vec<String>> {
        self.db.list_machines()
    }

    /// 数据源探测结果（缓存于 sources 表）。
    pub fn list_sources(&self) -> Result<Vec<storage::types::SourceRow>> {
        let mut rows = self.db.list_sources()?;
        let counts: Vec<(String, usize)> = self.db.with_conn(|c| {
            let mut s = c.prepare("SELECT source, COUNT(*) FROM sessions GROUP BY source")?;
            let values = s.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<std::result::Result<Vec<_>,_>>()?;
            Ok(values)
        })?;
        for def in adapters::registry::catalog() {
            if !rows.iter().any(|r| r.id == def.id) {
                rows.push(storage::types::SourceRow { id: def.id.into(), display_name: def.display_name.into(), root_path: None, found: false, session_hint: 0, manual: false, notes: Some(def.description.into()), detected_at: None });
            }
        }
        for (id,count) in counts {
            if let Some(row) = rows.iter_mut().find(|r| r.id == id) { row.session_hint = count; }
            else { rows.push(storage::types::SourceRow { display_name: id.clone(), id, root_path: None, found: true, session_hint: count, manual: true, notes: Some("导入或同步历史".into()), detected_at: None }); }
        }
        Ok(rows)
    }

    pub fn source_catalog(&self) -> Result<Vec<adapters::registry::SourceCatalogEntry>> {
        let rows = self.list_sources()?;
        let settings = self.settings();
        adapters::registry::catalog().iter().map(|def| {
            let row = rows.iter().find(|r| r.id == def.id);
            let partial: bool = self.db.with_conn(|c| Ok(c.query_row("SELECT EXISTS(SELECT 1 FROM sessions WHERE source=?1 AND partial=1)",[def.id],|r| r.get(0))?))?;
            let notes = row.and_then(|r| r.notes.clone());
            let status = if notes.as_deref().map(|s| s.contains("失败")).unwrap_or(false) { "error" }
                else if partial || notes.as_deref().map(|s| s.contains("仅发现索引")).unwrap_or(false) { "partial" }
                else if row.map(|r| r.found).unwrap_or(false) || (def.access == "import" && row.map(|r| r.session_hint > 0).unwrap_or(false)) { "available" }
                else { "missing" };
            Ok(adapters::registry::SourceCatalogEntry { definition: def.clone(), status: status.into(), enabled: settings.source_enabled(def.id), notes })
        }).collect()
    }

    /// 全文搜索。
    pub fn search(
        &self,
        query: &storage::search::SearchQuery,
    ) -> Result<storage::search::SearchResponse> {
        self.db.search(query)
    }

    /// 索引统计。
    pub fn stats(&self) -> Result<storage::sessions::StorageStats> {
        self.db.stats()
    }

    /// 重建索引：清空后强制全量解析。
    pub fn rebuild_index(
        &self,
        progress: &mut dyn FnMut(scanner::ScanProgress),
    ) -> Result<scanner::ScanReport> {
        let _guard = self.operation_lock.lock().map_err(|_| Error::config("扫描状态不可用"))?;
        self.db.reset()?;
        self.scan_unlocked(true, progress)
    }

    // ------------------------------------------------------------------
    // 同步
    // ------------------------------------------------------------------

    /// 构造同步上下文。
    fn sync_context<'a>(
        &'a self,
        settings: &'a AppSettings,
        adapters: &'a [Box<dyn adapters::ConversationAdapter>],
    ) -> sync::SyncContext<'a> {
        sync::SyncContext {
            db: &self.db,
            settings,
            machine_id: &self.machine.machine_id,
            app_version: APP_VERSION,
            adapters,
            adapter_ctx: adapters::AdapterContext {
                settings,
                machine_id: &self.machine.machine_id,
            },
        }
    }

    /// 同步状态（Sync 页展示）。
    pub fn sync_status(&self) -> Result<sync::SyncStatusDto> {
        let settings = self.settings();
        let adapters = self.adapters();
        sync::status(&self.sync_context(&settings, &adapters))
    }

    /// 执行一次同步。
    pub fn sync_now(
        &self,
        options: &sync::SyncOptions,
        progress: &mut dyn FnMut(String),
    ) -> Result<sync::SyncReport> {
        let _guard = self.operation_lock.lock().map_err(|_| Error::config("扫描状态不可用"))?;
        let settings = self.settings();
        let adapters = self.adapters();
        sync::sync_now(&self.sync_context(&settings, &adapters), options, progress)
    }

    pub fn preview_import(&self, source: &str, text: &str) -> Result<imports::ImportPreview> {
        if !self.settings().source_enabled(source) { return Err(Error::config("请先在设置中启用此数据源")); }
        let (package,warnings,format) = imports::parse_input(source,text)?;
        let token = uuid::Uuid::new_v4().to_string();
        let preview = imports::preview(&package,warnings.clone(),token.clone(),format);
        let mut pending = self.import_previews.lock().map_err(|_| Error::config("导入状态不可用"))?;
        pending.retain(|_,(t,_,_)| t.elapsed().as_secs() < 1800);
        if pending.len() >= 8 { return Err(Error::config("待确认导入过多，请取消已有预览")); }
        pending.insert(token,(std::time::Instant::now(),package,warnings));
        Ok(preview)
    }

    pub fn cancel_import(&self, token: &str) -> Result<()> {
        self.import_previews.lock().map_err(|_| Error::config("导入状态不可用"))?.remove(token);
        Ok(())
    }

    pub fn confirm_import(&self, token: &str) -> Result<imports::ImportReport> {
        let _guard = self.operation_lock.lock().map_err(|_| Error::config("扫描状态不可用"))?;
        let (created,package,warnings) = self.import_previews.lock().map_err(|_| Error::config("导入状态不可用"))?
            .remove(token).ok_or_else(|| Error::config("预览已失效，请重新预览"))?;
        if created.elapsed().as_secs() >= 1800 { return Err(Error::config("预览已过期，请重新预览")); }
        let root = self.data_dir.join("imports");
        let mut report = imports::ImportReport { failed: warnings.len(), warnings, ..Default::default() };
        let mut written = Vec::new();
        let settings = self.settings();
        for s in package.sessions {
            if !settings.source_enabled(s.source.as_str()) { report.failed += 1; report.warnings.push("来源已停用，请启用后重试".into()); continue; }
            let path = imports::managed_path(&root,&s);
            let id = format!("{}:{}:{}",s.source.as_str(),self.machine_id(),s.external_id.as_deref().unwrap_or_default());
            let bytes = serde_json::to_vec_pretty(&s)?;
            if let Some(existing) = self.db.get_session(&id)? {
                if existing.primary_file.as_deref() != Some(error::display_path(&path).as_str()) {
                    report.duplicates += 1; report.warnings.push("已存在同 ID 原生会话，保留原生记录".into()); continue;
                }
                if std::fs::read(&path).ok().as_deref() == Some(bytes.as_slice()) {
                    report.duplicates += 1; continue;
                }
            }
            let result = (|| -> Result<()> {
                let parent = path.parent().ok_or_else(|| Error::config("导入路径无效"))?;
                std::fs::create_dir_all(parent).map_err(|e| Error::io(parent,e))?;
                let temp = path.with_extension(format!("{}.tmp",uuid::Uuid::new_v4()));
                std::fs::write(&temp,&bytes).map_err(|e| Error::io(&temp,e))?;
                if let Err(e) = std::fs::rename(&temp,&path) { let _ = std::fs::remove_file(&temp); return Err(Error::io(&path,e)); }
                Ok(())
            })();
            match result {
                Ok(()) => written.push((id, blake3::hash(&bytes).to_hex().to_string(), imports::partial(&s))),
                Err(e) => { report.failed += 1; report.warnings.push(e.user_message()); }
            }
        }
        if !written.is_empty() {
            let adapters: Vec<Box<dyn adapters::ConversationAdapter>> = vec![Box::new(imports::ImportedAdapter { root })];
            let ctx = adapters::AdapterContext { settings: &settings, machine_id: self.machine_id() };
            let scan = scanner::scan(&self.db,&adapters,&ctx,&scanner::ScanOptions::default(),&mut |_| {})?;
            report.warnings.extend(scan.warnings);
            for (id,hash,partial) in written {
                if self.db.get_session(&id)?.and_then(|s| s.content_hash).as_deref() == Some(&hash) { report.success += 1; report.partial += usize::from(partial); }
                else { report.failed += 1; report.warnings.push("副本已保存但索引失败，可重新扫描恢复".into()); }
            }
        }
        Ok(report)
    }

    /// git 日志。
    pub fn git_log(&self, limit: usize) -> Result<String> {
        let settings = self.settings();
        let adapters = self.adapters();
        sync::git_log(&self.sync_context(&settings, &adapters), limit)
    }

    /// 中止 rebase。
    pub fn abort_rebase(&self) -> Result<()> {
        let settings = self.settings();
        let adapters = self.adapters();
        sync::abort_rebase(&self.sync_context(&settings, &adapters))
    }

    // ------------------------------------------------------------------
    // 归档
    // ------------------------------------------------------------------

    /// 归档指定会话。
    pub fn archive_sessions(&self, session_ids: &[String]) -> Result<archive::ArchiveReport> {
        let settings = self.settings();
        let repo = settings
            .repo_root()
            .ok_or_else(|| Error::config("尚未配置同步仓库目录，无法归档".to_string()))?;
        let compression = settings.archive_compression;
        let mut report = archive::ArchiveReport::default();
        for id in session_ids {
            let Some(summary) = self.db.get_session(id)? else {
                report.failed += 1;
                report.warnings.push(format!("未找到会话 {id}"));
                continue;
            };
            match archive::archive_session(
                &self.db,
                &repo,
                &self.machine.machine_id,
                &summary,
                compression,
            ) {
                Ok(path) => {
                    report.archived += 1;
                    report.bytes_out += std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
                    report.entries.push(error::display_path(
                        path.strip_prefix(&repo).unwrap_or(&path),
                    ));
                }
                Err(err) => {
                    report.failed += 1;
                    report.warnings.push(format!(
                        "会话 {} 归档失败：{}",
                        summary.external_id,
                        err.user_message()
                    ));
                }
            }
        }
        Ok(report)
    }

    /// 按天数批量归档旧会话。
    pub fn archive_old_sessions(&self) -> Result<archive::ArchiveReport> {
        let settings = self.settings();
        let repo = settings
            .repo_root()
            .ok_or_else(|| Error::config("尚未配置同步仓库目录，无法归档".to_string()))?;
        archive::archive_old_sessions(
            &self.db,
            &repo,
            &self.machine.machine_id,
            settings.archive_after_days,
            settings.archive_compression,
            200,
        )
    }

    /// 列出仓库中的归档。
    pub fn list_archives(&self) -> Result<Vec<model::ArchiveEntry>> {
        let Some(repo) = self.settings().repo_root() else {
            return Ok(Vec::new());
        };
        let mut entries = archive::list_archives(&repo)?;
        // 补充标题：归档会话在索引里仍有记录
        for entry in entries.iter_mut() {
            let session_id = format!("{}:{}", entry.source, entry.session_id);
            if let Ok(Some(summary)) = self.db.get_session(&session_id) {
                entry.title = summary.title;
            }
        }
        Ok(entries)
    }

    /// 从归档恢复。
    pub fn restore_archive(&self, rel_path: &str) -> Result<PathBuf> {
        let repo = self
            .settings()
            .repo_root()
            .ok_or_else(|| Error::config("尚未配置同步仓库目录".to_string()))?;
        let target = archive::restore_archive(&self.db, &repo, rel_path)?;
        // 立刻重建索引，让恢复的会话出现在列表中
        let _ = self.scan(false, &mut |_| {});
        Ok(target)
    }
}
