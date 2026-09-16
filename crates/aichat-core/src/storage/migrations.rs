//! 索引 schema 与迁移（规格 §29：schema 必须可演进）。
//!
//! 约定：
//! - 版本号保存在 SQLite 的 `user_version`；
//! - 每个版本对应一个 SQL 脚本，按顺序执行，只增不改；
//! - FTS5 使用 **external content** 表（`content='messages'`）+ 触发器同步，
//!   索引里不重复存储正文，节省约一半磁盘空间，也不会出现索引与正文不一致。

use rusqlite::Connection;

use crate::error::{Error, Result};
use crate::model::INDEX_SCHEMA_VERSION;

/// 迁移脚本列表：下标 + 1 即目标版本号。
const MIGRATIONS: &[&str] = &[V1_INITIAL];

/// 执行迁移（幂等，可重复调用）。
pub fn migrate(conn: &mut Connection) -> Result<()> {
    let current: u32 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    if current > INDEX_SCHEMA_VERSION {
        return Err(Error::config(format!(
            "索引版本 {current} 高于当前程序支持的 {INDEX_SCHEMA_VERSION}，请升级应用"
        )));
    }
    for (index, script) in MIGRATIONS.iter().enumerate() {
        let version = (index + 1) as u32;
        if version <= current {
            continue;
        }
        let tx = conn.transaction()?;
        tx.execute_batch(script)?;
        // user_version 不支持参数绑定，这里只拼接受控的常量数字
        tx.execute_batch(&format!("PRAGMA user_version = {version};"))?;
        tx.commit()?;
        tracing::info!(version, "索引 schema 已迁移");
    }
    Ok(())
}

/// v1：初始 schema。
const V1_INITIAL: &str = r#"
-- 数据源：探测结果与用户配置的路径
CREATE TABLE IF NOT EXISTS sources (
    id            TEXT PRIMARY KEY,
    display_name  TEXT NOT NULL,
    root_path     TEXT,
    found         INTEGER NOT NULL DEFAULT 0,
    session_hint  INTEGER NOT NULL DEFAULT 0,
    manual        INTEGER NOT NULL DEFAULT 0,
    notes         TEXT,
    detected_at   TEXT
);

-- 会话（规格 §8 建议字段）
CREATE TABLE IF NOT EXISTS sessions (
    id                  TEXT PRIMARY KEY,
    source              TEXT NOT NULL,
    external_session_id TEXT NOT NULL,
    title               TEXT,
    project_path        TEXT,
    created_at          TEXT,
    updated_at          TEXT,
    machine_id          TEXT,
    content_hash        TEXT,
    sync_status         TEXT NOT NULL DEFAULT 'local',
    message_count       INTEGER NOT NULL DEFAULT 0,
    partial             INTEGER NOT NULL DEFAULT 0,
    archived            INTEGER NOT NULL DEFAULT 0,
    metadata            TEXT,
    source_root         TEXT,
    primary_file        TEXT,
    indexed_at          TEXT,
    UNIQUE (source, external_session_id)
);
CREATE INDEX IF NOT EXISTS idx_sessions_updated   ON sessions (updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_source    ON sessions (source, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_project   ON sessions (project_path, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_machine   ON sessions (machine_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_archived  ON sessions (archived, updated_at DESC);

-- 消息（规格 §8 建议字段）
CREATE TABLE IF NOT EXISTS messages (
    id         TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
    role       TEXT NOT NULL,
    kind       TEXT NOT NULL,
    text       TEXT,
    tool_name  TEXT,
    timestamp  TEXT,
    sequence   INTEGER NOT NULL,
    raw        TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_session_seq ON messages (session_id, sequence);

-- 原始文件与指纹（增量扫描的核心，规格 §9）
CREATE TABLE IF NOT EXISTS raw_files (
    path       TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    source     TEXT NOT NULL,
    role       TEXT NOT NULL,
    size       INTEGER NOT NULL,
    mtime      INTEGER NOT NULL,
    hash       TEXT,
    indexed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_raw_files_session ON raw_files (session_id);

-- 已写入同步仓库的文件（相对路径 → 会话）
CREATE TABLE IF NOT EXISTS sync_files (
    rel_path     TEXT PRIMARY KEY,
    session_id   TEXT,
    source       TEXT,
    machine_id   TEXT,
    content_hash TEXT,
    size         INTEGER,
    synced_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_sync_files_session ON sync_files (session_id);

-- 键值设置（运行状态：上次 pull / push 时间、仓库 id 等）
CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- 全文索引：external content，正文不重复存储
CREATE VIRTUAL TABLE IF NOT EXISTS message_fts USING fts5(
    text,
    session_id UNINDEXED,
    content='messages',
    content_rowid='rowid',
    tokenize='unicode61 remove_diacritics 2'
);

-- 触发器保持 FTS 与 messages 一致
CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages BEGIN
    INSERT INTO message_fts (rowid, text, session_id) VALUES (new.rowid, new.text, new.session_id);
END;

CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages BEGIN
    INSERT INTO message_fts (message_fts, rowid, text, session_id)
    VALUES ('delete', old.rowid, old.text, old.session_id);
END;

CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE ON messages BEGIN
    INSERT INTO message_fts (message_fts, rowid, text, session_id)
    VALUES ('delete', old.rowid, old.text, old.session_id);
    INSERT INTO message_fts (rowid, text, session_id) VALUES (new.rowid, new.text, new.session_id);
END;
"#;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::INDEX_SCHEMA_VERSION;

    #[test]
    fn 迁移可重复执行且版本正确() {
        let mut conn = Connection::open_in_memory().unwrap();
        migrate(&mut conn).unwrap();
        migrate(&mut conn).unwrap(); // 幂等
        let version: u32 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(version, INDEX_SCHEMA_VERSION);
    }

    #[test]
    fn fts5_可用且触发器同步() {
        let mut conn = Connection::open_in_memory().unwrap();
        migrate(&mut conn).unwrap();
        conn.execute(
            "INSERT INTO sessions (id, source, external_session_id) VALUES ('kimi:1','kimi','1')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO messages (id, session_id, role, kind, text, sequence)
             VALUES ('kimi:1#0','kimi:1','user','message','Redisson watchdog TTL lazy deletion',0)",
            [],
        )
        .unwrap();
        let hits: i64 = conn
            .query_row(
                "SELECT count(*) FROM message_fts WHERE message_fts MATCH 'lazy'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(hits, 1, "FTS5 索引应能查到刚插入的消息");

        // 删除消息后索引同步移除
        conn.execute("DELETE FROM messages WHERE id = 'kimi:1#0'", [])
            .unwrap();
        let hits: i64 = conn
            .query_row(
                "SELECT count(*) FROM message_fts WHERE message_fts MATCH 'lazy'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(hits, 0);
    }

    #[test]
    fn insert_or_replace_不会让_fts_残留旧内容() {
        // 回归测试：SQLite 默认在 REPLACE 冲突时**不触发** DELETE 触发器，
        // 会让 FTS5 外部内容表残留旧索引项（索引与正文不一致）。
        // 因此数据库连接必须开启 `recursive_triggers`。
        let mut conn = Connection::open_in_memory().unwrap();
        migrate(&mut conn).unwrap();
        conn.execute_batch("PRAGMA recursive_triggers = ON;")
            .unwrap();
        conn.execute(
            "INSERT INTO sessions (id, source, external_session_id) VALUES ('kimi:r','kimi','r')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO messages (id, session_id, role, kind, text, sequence)
             VALUES ('kimi:r#0','kimi:r','user','message','旧的唯一词 alpha',0)",
            [],
        )
        .unwrap();
        // 同 id 覆盖写入：旧文本必须从索引里消失
        conn.execute(
            "INSERT OR REPLACE INTO messages (id, session_id, role, kind, text, sequence)
             VALUES ('kimi:r#0','kimi:r','user','message','新的唯一词 beta',0)",
            [],
        )
        .unwrap();

        let old_hits: i64 = conn
            .query_row(
                "SELECT count(*) FROM message_fts WHERE message_fts MATCH 'alpha'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let new_hits: i64 = conn
            .query_row(
                "SELECT count(*) FROM message_fts WHERE message_fts MATCH 'beta'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(old_hits, 0, "REPLACE 后旧内容不应残留");
        assert_eq!(new_hits, 1, "REPLACE 后新内容应可检索");

        // 索引完整性检查（不一致时会报错）
        conn.execute_batch("INSERT INTO message_fts (message_fts) VALUES ('integrity-check');")
            .unwrap();
    }

    #[test]
    fn 级联删除会话消息() {
        let mut conn = Connection::open_in_memory().unwrap();
        migrate(&mut conn).unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        conn.execute(
            "INSERT INTO sessions (id, source, external_session_id) VALUES ('codex:1','codex','1')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO messages (id, session_id, role, kind, sequence)
             VALUES ('codex:1#0','codex:1','user','message',0)",
            [],
        )
        .unwrap();
        conn.execute("DELETE FROM sessions WHERE id = 'codex:1'", [])
            .unwrap();
        let left: i64 = conn
            .query_row("SELECT count(*) FROM messages", [], |r| r.get(0))
            .unwrap();
        assert_eq!(left, 0);
    }
}
