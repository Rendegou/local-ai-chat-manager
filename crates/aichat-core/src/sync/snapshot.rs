//! 会话快照（规格 §15）：把本地会话按统一结构写入同步仓库。
//!
//! ```text
//! <repo>/<source>/<machine-id>/<session-id>/
//! ├── meta.json           # 会话元信息（带 schemaVersion）
//! ├── conversation.jsonl  # 归一化消息流（Git 可 diff 的文本）
//! └── raw/                # 可选：原始会话文件副本（Keep Raw Session Files）
//! <repo>/.aichat/blobs/<hash前2位>/<hash>.txt   # ≥ BLOB_THRESHOLD 文本的内容寻址存储（schema v2）
//! ```
//!
//! 关键点：
//! - 写入采用「临时文件 + 重命名」，避免中断留下半截文件；
//! - 内容哈希一致则跳过写入（`git add` 时不会有变更，减少提交噪声）；
//! - ≥ [`BLOB_THRESHOLD`] 的消息文本按 blake3 内容寻址去重：相同文本全仓库只存一份，
//!   jsonl 行改写为 `textRef` / `textBytes`；外置失败时该行降级为内联，绝不丢内容；
//! - 复制原始文件时过滤隐私红线目录（credentials 等），绝不提交凭证。

use std::io::Write;
use std::path::{Path, PathBuf};

use crate::error::{display_path, Error, Result};
use crate::model::{
    MachineRecord, RepoManifest, RepoVersionFile, SessionMetaFile, SyncStatus, SYNC_SCHEMA_VERSION,
};
use crate::paths;
use crate::storage::db::Database;
use crate::storage::sessions::{MessageRow, SessionSummary};

/// 文本外置阈值（字节）：达到该长度的消息文本存入 `.aichat/blobs/`，jsonl 只留引用。
pub const BLOB_THRESHOLD: usize = 4096;

/// blob 文件路径：`<repo>/.aichat/blobs/<hash前2位>/<hash>.txt`。
pub fn blob_path(repo_root: &Path, hash: &str) -> PathBuf {
    repo_root
        .join(".aichat")
        .join("blobs")
        .join(&hash[..hash.len().min(2)])
        .join(format!("{hash}.txt"))
}

/// 单个写入会话的快照记录。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotEntry {
    /// 仓库内相对路径（会话目录）
    pub rel_path: String,
    /// 该会话快照目录的总字节数
    pub bytes: u64,
}

/// 快照写入结果。
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotReport {
    pub written: usize,
    pub skipped: usize,
    pub failed: usize,
    pub bytes: u64,
    /// 写入的会话（相对路径 + 大小，用于日志与 UI 展示）
    pub files: Vec<SnapshotEntry>,
    pub warnings: Vec<String>,
}

/// 单个会话的快照结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SnapshotOutcome {
    /// 写入成功（相对路径）
    Written(String),
    /// 内容未变，跳过
    Skipped,
}

/// 计算会话在仓库中的目录：`<repo>/<source>/<machine-id>/<session-id>`。
pub fn session_dir(repo_root: &Path, source: &str, machine_id: &str, external_id: &str) -> PathBuf {
    repo_root
        .join(paths::sanitize_component(source))
        .join(paths::sanitize_component(machine_id))
        .join(paths::sanitize_component(external_id))
}

/// 归档文件路径：`<repo>/archives/<source>/<machine-id>/<session-id>.<ext>`。
pub fn archive_path(
    repo_root: &Path,
    source: &str,
    machine_id: &str,
    external_id: &str,
    extension: &str,
) -> PathBuf {
    repo_root
        .join("archives")
        .join(paths::sanitize_component(source))
        .join(paths::sanitize_component(machine_id))
        .join(format!(
            "{}.{extension}",
            paths::sanitize_component(external_id)
        ))
}

/// 写入会话快照；内容未变化时返回 [`SnapshotOutcome::Skipped`]。
pub fn snapshot_session(
    db: &Database,
    repo_root: &Path,
    machine_id: &str,
    summary: &SessionSummary,
    keep_raw: bool,
) -> Result<SnapshotOutcome> {
    let dir = session_dir(repo_root, &summary.source, machine_id, &summary.external_id);
    paths::ensure_dir(&dir).map_err(|e| Error::io(&dir, e))?;

    // ---- 1. 归一化消息 → 临时文件（流式，顺便算内容哈希）----
    let conversation_tmp = dir.join("conversation.jsonl.tmp");
    let mut hasher = blake3::Hasher::new();
    {
        let file = std::fs::File::create(&conversation_tmp)
            .map_err(|e| Error::io(&conversation_tmp, e))?;
        let mut writer = std::io::BufWriter::with_capacity(256 * 1024, file);
        // 流式导出：一次只持有一条消息，100MB 级会话也不会整体进内存
        let written = db.for_each_message(&summary.id, &mut |row| {
            let line = match row.text.as_deref() {
                // 大文本外置为内容寻址 blob；失败时降级为内联，绝不因去重丢内容
                Some(text) if text.len() >= BLOB_THRESHOLD => match write_blob(repo_root, text) {
                    Ok(hash) => serde_json::json!({
                        "id": row.id,
                        "role": row.role,
                        "kind": row.kind,
                        "timestamp": row.timestamp,
                        "toolName": row.tool_name,
                        "textRef": format!("blake3:{hash}"),
                        "textBytes": text.len(),
                    }),
                    Err(err) => {
                        tracing::warn!(error = %err, "外置大文本失败，该行降级为内联存储");
                        inline_line(row)
                    }
                },
                _ => inline_line(row),
            };
            let mut bytes = serde_json::to_vec(&line)?;
            bytes.push(b'\n');
            hasher.update(&bytes);
            writer
                .write_all(&bytes)
                .map_err(|e| Error::io(&conversation_tmp, e))?;
            Ok(())
        });
        if let Err(err) = written {
            let _ = std::fs::remove_file(&conversation_tmp);
            return Err(err);
        }
        writer
            .flush()
            .map_err(|e| Error::io(&conversation_tmp, e))?;
    }
    let content_hash = hasher.finalize().to_hex().to_string();

    // 关闭原始副本后，清理仓库中该会话已有的 raw/。
    // 这只操作独立同步仓库，不会触碰 Codex / Kimi 的源文件。
    let raw_dir = dir.join("raw");
    if !keep_raw && raw_dir.is_dir() {
        std::fs::remove_dir_all(&raw_dir).map_err(|e| Error::io(&raw_dir, e))?;
    }

    // ---- 2. 内容与仓库一致 → 跳过 ----
    let meta_path = dir.join("meta.json");
    if let Some(existing) = read_meta(&meta_path) {
        if existing.content_hash == content_hash && existing.has_raw == keep_raw {
            let _ = std::fs::remove_file(&conversation_tmp);
            return Ok(SnapshotOutcome::Skipped);
        }
    }

    // ---- 3. 原始文件副本（可选）----
    let mut has_raw = false;
    if keep_raw {
        // 原始目录来自索引（会话是从哪个目录发现的），用于保持 raw/ 内的相对结构
        let source_root = db.session_source_root(&summary.id)?;
        has_raw = copy_raw_files(db, &summary.id, &dir, source_root.as_deref())?;
    }

    // ---- 4. meta.json（临时文件 + 重命名，保证原子性）----
    let meta = SessionMetaFile {
        schema_version: SYNC_SCHEMA_VERSION,
        source: summary.source.clone(),
        external_session_id: summary.external_id.clone(),
        session_id: summary.id.clone(),
        title: summary.title.clone(),
        project_path: summary.project_path.clone(),
        created_at: summary.created_at.clone(),
        updated_at: summary.updated_at.clone(),
        model: None,
        machine_id: machine_id.to_string(),
        content_hash: content_hash.clone(),
        message_count: summary.message_count.max(0) as u64,
        partial: summary.partial,
        has_raw,
        source_root: summary.primary_file.clone(),
        metadata: serde_json::json!({}),
    };
    let meta_tmp = dir.join("meta.json.tmp");
    std::fs::write(&meta_tmp, serde_json::to_string_pretty(&meta)?)
        .map_err(|e| Error::io(&meta_tmp, e))?;
    std::fs::rename(&meta_tmp, &meta_path).map_err(|e| Error::io(&meta_path, e))?;

    // ---- 5. conversation.jsonl 落位 ----
    let conversation = dir.join("conversation.jsonl");
    std::fs::rename(&conversation_tmp, &conversation).map_err(|e| Error::io(&conversation, e))?;

    let rel = paths::relative_posix(repo_root, &dir).unwrap_or_else(|| display_path(&dir));
    Ok(SnapshotOutcome::Written(rel))
}

/// 单条消息的内联 jsonl 行（< [`BLOB_THRESHOLD`] 或外置失败降级时使用）。
fn inline_line(row: &MessageRow) -> serde_json::Value {
    serde_json::json!({
        "id": row.id,
        "role": row.role,
        "kind": row.kind,
        "timestamp": row.timestamp,
        "text": row.text,
        "toolName": row.tool_name,
    })
}

/// 把大文本写入内容寻址 blob，返回 blake3 hex；相同文本已存在时直接复用。
fn write_blob(repo_root: &Path, text: &str) -> std::io::Result<String> {
    let hash = blake3::hash(text.as_bytes()).to_hex().to_string();
    let path = blob_path(repo_root, &hash);
    if !path.is_file() {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let tmp = path.with_extension("txt.tmp");
        std::fs::write(&tmp, text.as_bytes())?;
        std::fs::rename(&tmp, &path)?;
    }
    Ok(hash)
}

/// 复制原始会话文件到 `raw/`；返回是否复制了任何文件。
///
/// 只复制索引中登记过的文件（主文件、state.json、子 Agent wire 等），
/// 且强制过滤隐私红线路径。
fn copy_raw_files(
    db: &Database,
    session_id: &str,
    session_dir: &Path,
    source_dir: Option<&str>,
) -> Result<bool> {
    let files = db.raw_files_for(session_id)?;
    if files.is_empty() {
        return Ok(false);
    }
    let raw_dir = session_dir.join("raw");
    // 清理旧的 raw 内容，避免残留已被删除的文件
    if raw_dir.is_dir() {
        let _ = std::fs::remove_dir_all(&raw_dir);
    }
    paths::ensure_dir(&raw_dir).map_err(|e| Error::io(&raw_dir, e))?;

    let base = source_dir.map(PathBuf::from);
    let mut copied = false;
    for file in files {
        let source_path = PathBuf::from(&file.path);
        if paths::is_forbidden_path(&source_path) {
            tracing::warn!(path = %file.path, "跳过隐私目录中的文件");
            continue;
        }
        if !source_path.is_file() {
            continue;
        }
        // 保持相对结构：能算相对路径就保留，否则退化为文件名
        let rel = base
            .as_deref()
            .and_then(|b| paths::relative_posix(b, &source_path))
            .filter(|r| !r.is_empty() && !r.starts_with("../"))
            .unwrap_or_else(|| {
                source_path
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_else(|| "raw.bin".to_string())
            });
        let target = rel.split('/').fold(raw_dir.clone(), |acc, part| {
            acc.join(paths::sanitize_component(part))
        });
        if let Some(parent) = target.parent() {
            paths::ensure_dir(parent).map_err(|e| Error::io(parent, e))?;
        }
        if let Err(e) = std::fs::copy(&source_path, &target) {
            tracing::warn!(path = %file.path, error = %e, "复制原始文件失败，已跳过");
            continue;
        }
        copied = true;
    }
    Ok(copied)
}

/// 读取已有快照的 meta.json（不存在或损坏返回 None）。
pub fn read_meta(path: &Path) -> Option<SessionMetaFile> {
    let raw = std::fs::read_to_string(path).ok()?;
    serde_json::from_str::<SessionMetaFile>(&raw).ok()
}

/// 确保仓库级元文件存在（`manifest.json`、`.aichat/version.json`、`.aichat/machines.json`）。
pub fn ensure_repo_files(repo_root: &Path, machine_id: &str, app_version: &str) -> Result<()> {
    let meta_dir = repo_root.join(".aichat");
    paths::ensure_dir(&meta_dir).map_err(|e| Error::io(&meta_dir, e))?;
    let now = chrono::Utc::now().to_rfc3339();

    // version.json
    let version_path = meta_dir.join("version.json");
    if !version_path.is_file() {
        let version = RepoVersionFile {
            schema_version: SYNC_SCHEMA_VERSION,
            app: "local-ai-chat-manager".to_string(),
            app_version: app_version.to_string(),
            created_at: now.clone(),
        };
        std::fs::write(&version_path, serde_json::to_string_pretty(&version)?)
            .map_err(|e| Error::io(&version_path, e))?;
    }

    // machines.json：登记本机（保留其他机器的记录，规格 §11 / §12）
    let machines_path = meta_dir.join("machines.json");
    let mut machines: Vec<MachineRecord> = std::fs::read_to_string(&machines_path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default();
    match machines.iter_mut().find(|m| m.machine_id == machine_id) {
        Some(record) => record.last_sync_at = now.clone(),
        None => machines.push(MachineRecord {
            machine_id: machine_id.to_string(),
            hostname: crate::settings::hostname(),
            platform: std::env::consts::OS.to_string(),
            first_seen_at: now.clone(),
            last_sync_at: now.clone(),
        }),
    }
    std::fs::write(&machines_path, serde_json::to_string_pretty(&machines)?)
        .map_err(|e| Error::io(&machines_path, e))?;

    // manifest.json（规格 §4.3）
    let manifest = RepoManifest {
        schema_version: SYNC_SCHEMA_VERSION,
        app: "local-ai-chat-manager".to_string(),
        app_version: app_version.to_string(),
        machine_ids: machines.iter().map(|m| m.machine_id.clone()).collect(),
        updated_at: now,
    };
    let manifest_path = repo_root.join("manifest.json");
    std::fs::write(&manifest_path, serde_json::to_string_pretty(&manifest)?)
        .map_err(|e| Error::io(&manifest_path, e))?;

    // .gitignore：忽略临时文件（保留仓库干净）
    let gitignore = repo_root.join(".gitignore");
    if !gitignore.is_file() {
        std::fs::write(&gitignore, "*.tmp\n.DS_Store\nThumbs.db\n")
            .map_err(|e| Error::io(&gitignore, e))?;
    }
    Ok(())
}

/// 标记会话为已同步（写入仓库成功后调用）。
pub fn mark_synced(
    db: &Database,
    summary: &SessionSummary,
    rel_path: &str,
    machine_id: &str,
) -> Result<()> {
    db.upsert_sync_file(
        rel_path,
        &summary.id,
        &summary.source,
        machine_id,
        summary.content_hash.as_deref().unwrap_or(""),
        summary.message_count.max(0) as u64,
    )?;
    db.set_sync_status(&summary.id, SyncStatus::Synced)?;
    Ok(())
}
