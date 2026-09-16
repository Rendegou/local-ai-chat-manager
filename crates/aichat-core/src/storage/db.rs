//! 数据库连接与基础设施（PRAGMA、迁移、指纹、设置键值）。

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension};

use crate::error::{Error, Result};
use crate::paths;
use crate::storage::migrations;

/// 索引数据库。
///
/// 采用「单连接 + Mutex」：桌面端写入量可控，WAL 模式保证读多写少场景下的并发体验，
/// 同时避免连接池带来的额外复杂度。
pub struct Database {
    conn: Mutex<Connection>,
    path: PathBuf,
}

/// 文件指纹行（增量扫描核心，规格 §9）。
#[derive(Debug, Clone)]
pub struct FingerprintRow {
    pub path: String,
    pub session_id: String,
    /// 文件角色：wire / rollout / state / subagent_wire / conversation / meta
    pub role: String,
    pub size: u64,
    pub mtime: i64,
    pub hash: Option<String>,
}

impl Database {
    /// 打开（或创建）索引数据库。
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            paths::ensure_dir(parent).map_err(|e| Error::io(parent, e))?;
        }
        let conn = Connection::open(path).map_err(Error::Database)?;
        Self::prepare(conn, path.to_path_buf())
    }

    /// 内存数据库（单元测试用）。
    pub fn open_in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory().map_err(Error::Database)?;
        Self::prepare(conn, PathBuf::from(":memory:"))
    }

    /// 统一初始化：PRAGMA + 迁移。
    fn prepare(conn: Connection, path: PathBuf) -> Result<Self> {
        let mut conn = conn;
        // WAL：读写并发更好；NORMAL：兼顾性能与安全；foreign_keys：保证级联删除。
        //
        // `recursive_triggers = ON` 是**必须**的：
        // SQLite 默认在执行 `INSERT OR REPLACE` 时不触发 DELETE 触发器，而 FTS5 的
        // external content 表依赖 DELETE 触发器清除旧索引项；否则索引与正文会不一致，
        // 实测会出现 rowid 错乱，甚至报 "database disk image is malformed"。
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             PRAGMA foreign_keys = ON;
             PRAGMA recursive_triggers = ON;
             PRAGMA temp_store = MEMORY;
             PRAGMA cache_size = -16000;",
        )?;
        migrations::migrate(&mut conn)?;
        Ok(Database {
            conn: Mutex::new(conn),
            path,
        })
    }

    /// 数据库文件路径。
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// 只读访问连接。
    pub fn with_conn<T>(&self, f: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
        let guard = self
            .conn
            .lock()
            .map_err(|_| Error::Database(rusqlite::Error::InvalidQuery))?;
        f(&guard)
    }

    /// 事务访问连接（自动提交 / 回滚）。
    pub fn with_tx<T>(&self, f: impl FnOnce(&rusqlite::Transaction<'_>) -> Result<T>) -> Result<T> {
        let mut guard = self
            .conn
            .lock()
            .map_err(|_| Error::Database(rusqlite::Error::InvalidQuery))?;
        let tx = guard.transaction()?;
        let out = f(&tx)?;
        tx.commit()?;
        Ok(out)
    }

    // ------------------------------------------------------------------
    // 键值设置（运行状态）
    // ------------------------------------------------------------------

    /// 读取字符串设置。
    pub fn get_setting(&self, key: &str) -> Result<Option<String>> {
        self.with_conn(|conn| {
            let value = conn
                .query_row(
                    "SELECT value FROM settings WHERE key = ?1",
                    params![key],
                    |r| r.get::<_, String>(0),
                )
                .optional()?;
            Ok(value)
        })
    }

    /// 写入字符串设置。
    pub fn set_setting(&self, key: &str, value: &str) -> Result<()> {
        self.with_conn(|conn| {
            conn.execute(
                "INSERT INTO settings (key, value) VALUES (?1, ?2)
                 ON CONFLICT (key) DO UPDATE SET value = excluded.value",
                params![key, value],
            )?;
            Ok(())
        })
    }

    // ------------------------------------------------------------------
    // 数据源登记
    // ------------------------------------------------------------------

    /// 覆盖写入某个数据源的探测结果。
    pub fn upsert_source(&self, row: &crate::storage::types::SourceRow) -> Result<()> {
        self.with_conn(|conn| {
            conn.execute(
                "INSERT INTO sources (id, display_name, root_path, found, session_hint, manual, notes, detected_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                 ON CONFLICT (id) DO UPDATE SET
                   display_name = excluded.display_name,
                   root_path    = excluded.root_path,
                   found        = excluded.found,
                   session_hint = excluded.session_hint,
                   manual       = excluded.manual,
                   notes        = excluded.notes,
                   detected_at  = excluded.detected_at",
                params![
                    row.id,
                    row.display_name,
                    row.root_path,
                    row.found as i64,
                    row.session_hint as i64,
                    row.manual as i64,
                    row.notes,
                    row.detected_at
                ],
            )?;
            Ok(())
        })
    }

    /// 读取全部数据源登记。
    pub fn list_sources(&self) -> Result<Vec<crate::storage::types::SourceRow>> {
        self.with_conn(|conn| {
            let mut stmt = conn.prepare_cached(
                "SELECT id, display_name, root_path, found, session_hint, manual, notes, detected_at
                 FROM sources ORDER BY id",
            )?;
            let rows = stmt
                .query_map([], |r| {
                    Ok(crate::storage::types::SourceRow {
                        id: r.get(0)?,
                        display_name: r.get(1)?,
                        root_path: r.get(2)?,
                        found: r.get::<_, i64>(3)? != 0,
                        session_hint: r.get::<_, i64>(4)? as usize,
                        manual: r.get::<_, i64>(5)? != 0,
                        notes: r.get(6)?,
                        detected_at: r.get(7)?,
                    })
                })?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            Ok(rows)
        })
    }

    // ------------------------------------------------------------------
    // 文件指纹（增量扫描）
    // ------------------------------------------------------------------

    /// 读取某个会话的文件指纹。
    pub fn fingerprints_for_session(&self, session_id: &str) -> Result<Vec<FingerprintRow>> {
        self.with_conn(|conn| {
            let mut stmt = conn.prepare_cached(
                "SELECT path, session_id, role, size, mtime, hash FROM raw_files WHERE session_id = ?1",
            )?;
            let rows = stmt
                .query_map(params![session_id], |r| {
                    Ok(FingerprintRow {
                        path: r.get(0)?,
                        session_id: r.get(1)?,
                        role: r.get(2)?,
                        size: r.get::<_, i64>(3)? as u64,
                        mtime: r.get(4)?,
                        hash: r.get(5)?,
                    })
                })?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            Ok(rows)
        })
    }

    /// 批量读取指纹（一次扫描只查一次，避免 N+1）。
    pub fn fingerprints_by_paths(
        &self,
        paths: &[String],
    ) -> Result<std::collections::HashMap<String, FingerprintRow>> {
        let mut map = std::collections::HashMap::new();
        if paths.is_empty() {
            return Ok(map);
        }
        self.with_conn(|conn| {
            let mut stmt = conn.prepare_cached(
                "SELECT path, session_id, role, size, mtime, hash FROM raw_files WHERE path = ?1",
            )?;
            for path in paths {
                if let Some(row) = stmt
                    .query_row(params![path], |r| {
                        Ok(FingerprintRow {
                            path: r.get(0)?,
                            session_id: r.get(1)?,
                            role: r.get(2)?,
                            size: r.get::<_, i64>(3)? as u64,
                            mtime: r.get(4)?,
                            hash: r.get(5)?,
                        })
                    })
                    .optional()?
                {
                    map.insert(path.clone(), row);
                }
            }
            Ok(())
        })?;
        Ok(map)
    }

    /// 覆盖写入会话的文件指纹（解析成功后调用）。
    pub fn replace_fingerprints(
        &self,
        session_id: &str,
        source: &str,
        rows: &[FingerprintRow],
    ) -> Result<()> {
        let now = chrono::Utc::now().to_rfc3339();
        self.with_tx(|tx| {
            tx.execute("DELETE FROM raw_files WHERE session_id = ?1", params![session_id])?;
            let mut stmt = tx.prepare_cached(
                "INSERT INTO raw_files (path, session_id, source, role, size, mtime, hash, indexed_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            )?;
            for row in rows {
                stmt.execute(params![
                    row.path,
                    session_id,
                    source,
                    row.role,
                    row.size as i64,
                    row.mtime,
                    row.hash,
                    now
                ])?;
            }
            Ok(())
        })
    }

    /// 仅更新指纹的 size/mtime（内容哈希未变时使用，避免重复解析）。
    pub fn touch_fingerprint(
        &self,
        path: &str,
        size: u64,
        mtime: i64,
        hash: Option<&str>,
    ) -> Result<()> {
        self.with_conn(|conn| {
            conn.execute(
                "UPDATE raw_files SET size = ?2, mtime = ?3, hash = COALESCE(?4, hash) WHERE path = ?1",
                params![path, size as i64, mtime, hash],
            )?;
            Ok(())
        })
    }

    /// 根据主文件路径找到会话 id。
    pub fn session_by_primary_file(&self, path: &str) -> Result<Option<String>> {
        self.with_conn(|conn| {
            let id = conn
                .query_row(
                    "SELECT session_id FROM raw_files WHERE path = ?1",
                    params![path],
                    |r| r.get::<_, String>(0),
                )
                .optional()?;
            Ok(id)
        })
    }

    // ------------------------------------------------------------------
    // 同步文件登记
    // ------------------------------------------------------------------

    /// 记录（或更新）一个已写入同步仓库的文件。
    pub fn upsert_sync_file(
        &self,
        rel_path: &str,
        session_id: &str,
        source: &str,
        machine_id: &str,
        content_hash: &str,
        size: u64,
    ) -> Result<()> {
        let now = chrono::Utc::now().to_rfc3339();
        self.with_conn(|conn| {
            conn.execute(
                "INSERT INTO sync_files (rel_path, session_id, source, machine_id, content_hash, size, synced_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                 ON CONFLICT (rel_path) DO UPDATE SET
                   session_id   = excluded.session_id,
                   content_hash = excluded.content_hash,
                   size         = excluded.size,
                   synced_at    = excluded.synced_at",
                params![rel_path, session_id, source, machine_id, content_hash, size as i64, now],
            )?;
            Ok(())
        })
    }

    /// 某个会话上次写入仓库的内容哈希。
    pub fn sync_hash_for_session(&self, session_id: &str) -> Result<Option<String>> {
        self.with_conn(|conn| {
            let hash = conn
                .query_row(
                    "SELECT content_hash FROM sync_files WHERE session_id = ?1 ORDER BY synced_at DESC LIMIT 1",
                    params![session_id],
                    |r| r.get::<_, String>(0),
                )
                .optional()?;
            Ok(hash)
        })
    }

    /// 清理同步文件登记（仓库被移除或会话删除后）。
    pub fn clear_sync_files(&self) -> Result<usize> {
        self.with_conn(|conn| {
            let n = conn.execute("DELETE FROM sync_files", [])?;
            Ok(n)
        })
    }

    // ------------------------------------------------------------------
    // 维护
    // ------------------------------------------------------------------

    /// 统计信息（用于 Sync 页与日志）。
    pub fn stats(&self) -> Result<crate::storage::StorageStats> {
        self.with_conn(|conn| {
            let sessions: i64 =
                conn.query_row("SELECT count(*) FROM sessions", [], |r| r.get(0))?;
            let messages: i64 =
                conn.query_row("SELECT count(*) FROM messages", [], |r| r.get(0))?;
            let archived: i64 = conn.query_row(
                "SELECT count(*) FROM sessions WHERE archived = 1",
                [],
                |r| r.get(0),
            )?;
            let projects: i64 = conn.query_row(
                "SELECT count(DISTINCT project_path) FROM sessions WHERE project_path IS NOT NULL",
                [],
                |r| r.get(0),
            )?;
            let bytes_on_disk = page_count_bytes(conn)?;
            Ok(crate::storage::StorageStats {
                sessions,
                messages,
                archived_sessions: archived,
                projects,
                bytes_on_disk,
            })
        })
    }

    /// 删除整个索引文件（「重建索引」功能）：关闭连接后由调用方删除文件。
    pub fn reset(&self) -> Result<()> {
        self.with_tx(|tx| {
            tx.execute_batch(
                "DELETE FROM messages;
                 DELETE FROM sessions;
                 DELETE FROM raw_files;
                 DELETE FROM sync_files;
                 INSERT INTO message_fts (message_fts) VALUES ('rebuild');",
            )?;
            Ok(())
        })
    }

    /// 把 WAL 落盘并截断。
    ///
    /// 大批量写入（首次全量扫描 / 重建索引）后 WAL 会膨胀到几百 MB，
    /// 之后的每次查询都要穿过 WAL 索引，实测会让搜索从 2ms 退化到 500ms+。
    /// 因此在批量写入结束后主动 checkpoint。
    pub fn checkpoint(&self) -> Result<()> {
        self.with_conn(|conn| {
            conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")?;
            Ok(())
        })
    }

    /// 优化索引（VACUUM），在大量删除后调用。
    pub fn vacuum(&self) -> Result<()> {
        self.with_conn(|conn| {
            conn.execute_batch("VACUUM;")?;
            Ok(())
        })
    }
}

/// 计算数据库占用字节数（page_count × page_size）。
fn page_count_bytes(conn: &Connection) -> Result<i64> {
    let page_count: i64 = conn.query_row("PRAGMA page_count", [], |r| r.get(0))?;
    let page_size: i64 = conn.query_row("PRAGMA page_size", [], |r| r.get(0))?;
    Ok(page_count * page_size)
}
