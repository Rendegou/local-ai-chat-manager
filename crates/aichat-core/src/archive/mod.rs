//! 归档（规格 §17）：把不再频繁变化的旧会话压缩成 `.tar.zst` / `.tar.gz`。
//!
//! ```text
//! archives/<source>/<machine-id>/<session-id>.tar.zst
//! ```
//!
//! 约定：
//! - **只归档历史数据**，活跃会话保持文本 JSONL（Git 可 diff、可增量）；
//! - 归档成功后移除仓库中的活动快照目录，避免同一份数据占两份空间；
//! - 本地原始文件绝不删除，归档只是「同步仓库层面的冷存储」。

use std::io::Write;
use std::path::{Path, PathBuf};

use crate::error::{display_path, Error, Result};
use crate::model::ArchiveEntry;
use crate::paths;
use crate::settings::Compression;
use crate::storage::db::Database;
use crate::storage::sessions::SessionSummary;
use crate::sync::snapshot::{archive_path, session_dir};

/// 归档报告。
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveReport {
    pub archived: usize,
    pub failed: usize,
    pub bytes_in: u64,
    pub bytes_out: u64,
    pub entries: Vec<String>,
    pub warnings: Vec<String>,
}

/// 归档单个会话，返回归档文件相对路径。
pub fn archive_session(
    db: &Database,
    repo_root: &Path,
    machine_id: &str,
    summary: &SessionSummary,
    compression: Compression,
) -> Result<PathBuf> {
    // ---- 1. 准备 staging 目录（tar 需要已知大小，先落盘再打包）----
    let staging = repo_root
        .join(".aichat")
        .join("tmp")
        .join(paths::sanitize_component(&summary.external_id));
    if staging.is_dir() {
        let _ = std::fs::remove_dir_all(&staging);
    }
    paths::ensure_dir(&staging).map_err(|e| Error::io(&staging, e))?;

    let result = build_staging(db, &staging, summary, repo_root, machine_id);
    if let Err(err) = result {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(err);
    }

    // ---- 2. 打包压缩（临时文件 + 重命名，避免半个归档）----
    let target = archive_path(
        repo_root,
        &summary.source,
        machine_id,
        &summary.external_id,
        compression.extension(),
    );
    if let Some(parent) = target.parent() {
        paths::ensure_dir(parent).map_err(|e| Error::io(parent, e))?;
    }
    let tmp = target.with_extension(format!("{}.tmp", compression.extension()));

    let pack_result = pack(&staging, &tmp, compression);
    let _ = std::fs::remove_dir_all(&staging);
    pack_result?;
    std::fs::rename(&tmp, &target).map_err(|e| Error::io(&target, e))?;

    // ---- 3. 移除活动快照目录 + 更新索引状态 ----
    let active = session_dir(repo_root, &summary.source, machine_id, &summary.external_id);
    if active.is_dir() {
        let _ = std::fs::remove_dir_all(&active);
    }
    db.set_archived(&summary.id, true)?;
    db.set_sync_status(&summary.id, crate::model::SyncStatus::Archived)?;
    Ok(target)
}

/// 归档所有超过阈值天数的会话。
pub fn archive_old_sessions(
    db: &Database,
    repo_root: &Path,
    machine_id: &str,
    older_than_days: u32,
    compression: Compression,
    limit: i64,
) -> Result<ArchiveReport> {
    let cutoff = chrono::Utc::now() - chrono::Duration::days(older_than_days as i64);
    let candidates = db.sessions_to_archive(&cutoff.to_rfc3339(), limit)?;
    let mut report = ArchiveReport::default();
    for summary in candidates {
        let before = session_size(db, &summary.id);
        match archive_session(db, repo_root, machine_id, &summary, compression) {
            Ok(path) => {
                let after = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
                report.archived += 1;
                report.bytes_in += before;
                report.bytes_out += after;
                report.entries.push(
                    paths::relative_posix(repo_root, &path).unwrap_or_else(|| display_path(&path)),
                );
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

/// 列出仓库中的归档文件。
pub fn list_archives(repo_root: &Path) -> Result<Vec<ArchiveEntry>> {
    let root = repo_root.join("archives");
    let mut out = Vec::new();
    if !root.is_dir() {
        return Ok(out);
    }
    for entry in walkdir::WalkDir::new(&root)
        .max_depth(4)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        if !entry.file_type().is_file() || paths::is_forbidden_path(entry.path()) {
            continue;
        }
        let rel = paths::relative_posix(repo_root, entry.path()).unwrap_or_default();
        let compression = if rel.ends_with(".tar.zst") {
            Compression::Zstd
        } else if rel.ends_with(".tar.gz") {
            Compression::Gzip
        } else {
            continue;
        };
        // 相对路径结构：archives/<source>/<machine>/<session>.<ext>
        let parts: Vec<String> = rel.split('/').map(|p| p.to_string()).collect();
        if parts.len() < 4 {
            continue;
        }
        let session_id = parts[parts.len() - 1]
            .trim_end_matches(".tar.zst")
            .trim_end_matches(".tar.gz")
            .to_string();
        let meta = entry.metadata().ok();
        out.push(ArchiveEntry {
            rel_path: rel,
            source: parts[1].clone(),
            machine_id: parts[2].clone(),
            session_id,
            size_bytes: meta.as_ref().map(|m| m.len()).unwrap_or(0),
            created_at: meta
                .as_ref()
                .and_then(|m| m.created().or_else(|_| m.modified()).ok())
                .map(|t| chrono::DateTime::<chrono::Utc>::from(t).to_rfc3339())
                .unwrap_or_default(),
            compression: compression.display_name().to_string(),
            title: None,
        });
    }
    out.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(out)
}

/// 解压归档回活动快照目录（之后重新扫描即可再次浏览）。
pub fn restore_archive(db: &Database, repo_root: &Path, rel_path: &str) -> Result<PathBuf> {
    let archive_file = rel_path
        .split('/')
        .fold(repo_root.to_path_buf(), |acc, p| acc.join(p));
    if !archive_file.is_file() {
        return Err(Error::not_found(format!("归档文件 {rel_path}")));
    }
    let parts: Vec<&str> = rel_path.split('/').collect();
    if parts.len() < 4 {
        return Err(Error::archive("归档路径结构不符合预期".to_string()));
    }
    let source = parts[1];
    let machine_id = parts[2];
    let external_id = parts[3]
        .trim_end_matches(".tar.zst")
        .trim_end_matches(".tar.gz");
    let target = session_dir(repo_root, source, machine_id, external_id);
    if target.is_dir() {
        let _ = std::fs::remove_dir_all(&target);
    }
    paths::ensure_dir(&target).map_err(|e| Error::io(&target, e))?;
    unpack(&archive_file, &target)?;

    // 索引状态回滚为未归档；下次扫描即可重新读取
    // 会话主键为 `<source>:<machine-id>:<external-id>`（见 SessionDescriptor::session_id）
    let session_id = format!("{source}:{machine_id}:{external_id}");
    db.set_archived(&session_id, false)?;
    db.set_sync_status(&session_id, crate::model::SyncStatus::Remote)?;
    Ok(target)
}

// ---------------------------------------------------------------------------
// 内部实现
// ---------------------------------------------------------------------------

/// 把会话内容写入 staging 目录（meta.json / conversation.jsonl / raw）。
fn build_staging(
    db: &Database,
    staging: &Path,
    summary: &SessionSummary,
    repo_root: &Path,
    machine_id: &str,
) -> Result<()> {
    // meta.json：优先复用仓库中已有快照的元信息（含内容哈希）
    let active_dir = session_dir(repo_root, &summary.source, machine_id, &summary.external_id);
    let meta_source = active_dir.join("meta.json");
    if meta_source.is_file() {
        std::fs::copy(&meta_source, staging.join("meta.json"))
            .map_err(|e| Error::io(&meta_source, e))?;
    } else {
        let meta = crate::model::SessionMetaFile {
            schema_version: crate::model::SYNC_SCHEMA_VERSION,
            source: summary.source.clone(),
            external_session_id: summary.external_id.clone(),
            session_id: summary.id.clone(),
            title: summary.title.clone(),
            project_path: summary.project_path.clone(),
            created_at: summary.created_at.clone(),
            updated_at: summary.updated_at.clone(),
            model: None,
            machine_id: machine_id.to_string(),
            content_hash: summary.content_hash.clone().unwrap_or_default(),
            message_count: summary.message_count.max(0) as u64,
            partial: summary.partial,
            has_raw: false,
            source_root: summary.primary_file.clone(),
            metadata: serde_json::json!({ "archivedAt": chrono::Utc::now().to_rfc3339() }),
        };
        std::fs::write(
            staging.join("meta.json"),
            serde_json::to_string_pretty(&meta)?,
        )
        .map_err(|e| Error::io(staging.join("meta.json"), e))?;
    }

    // conversation.jsonl：流式导出，内存恒定
    let conversation = staging.join("conversation.jsonl");
    {
        let file = std::fs::File::create(&conversation).map_err(|e| Error::io(&conversation, e))?;
        let mut writer = std::io::BufWriter::with_capacity(256 * 1024, file);
        db.for_each_message(&summary.id, &mut |row| {
            let line = serde_json::json!({
                "id": row.id,
                "role": row.role,
                "kind": row.kind,
                "timestamp": row.timestamp,
                "text": row.text,
                "toolName": row.tool_name,
            });
            serde_json::to_writer(&mut writer, &line)?;
            writer
                .write_all(b"\n")
                .map_err(|e| Error::io(&conversation, e))?;
            Ok(())
        })?;
        writer.flush().map_err(|e| Error::io(&conversation, e))?;
    }

    // raw/：把已有原始副本一起打包（保持归档自包含）
    let raw_source = active_dir.join("raw");
    if raw_source.is_dir() {
        copy_dir(&raw_source, &staging.join("raw"))?;
    }
    Ok(())
}

/// 递归复制目录（过滤隐私红线路径）。
fn copy_dir(from: &Path, to: &Path) -> Result<()> {
    paths::ensure_dir(to).map_err(|e| Error::io(to, e))?;
    for entry in walkdir::WalkDir::new(from)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        let path = entry.path();
        if paths::is_forbidden_path(path) {
            continue;
        }
        let rel = match paths::relative_posix(from, path) {
            Some(rel) if !rel.is_empty() => rel,
            _ => continue,
        };
        let target = rel.split('/').fold(to.to_path_buf(), |acc, part| {
            acc.join(paths::sanitize_component(part))
        });
        if entry.file_type().is_dir() {
            paths::ensure_dir(&target).map_err(|e| Error::io(&target, e))?;
        } else if entry.file_type().is_file() {
            if let Some(parent) = target.parent() {
                paths::ensure_dir(parent).map_err(|e| Error::io(parent, e))?;
            }
            std::fs::copy(path, &target).map_err(|e| Error::io(path, e))?;
        }
    }
    Ok(())
}

/// 打包 staging 目录为 tar + 压缩。
fn pack(staging: &Path, target: &Path, compression: Compression) -> Result<()> {
    let file = std::fs::File::create(target).map_err(|e| Error::io(target, e))?;
    let writer = std::io::BufWriter::with_capacity(256 * 1024, file);
    match compression {
        Compression::Zstd => {
            // level 3：压缩速度优先（归档属于后台任务，不想占用太多 CPU）
            let encoder = zstd::stream::write::Encoder::new(writer, 3)
                .map_err(|e| Error::archive(format!("zstd 初始化失败: {e}")))?;
            let mut builder = tar::Builder::new(encoder);
            append_dir(&mut builder, staging, staging)?;
            let encoder = builder
                .into_inner()
                .map_err(|e| Error::archive(format!("打包失败: {e}")))?;
            encoder
                .finish()
                .map_err(|e| Error::archive(format!("zstd 收尾失败: {e}")))?;
        }
        Compression::Gzip => {
            let encoder = flate2::write::GzEncoder::new(writer, flate2::Compression::new(6));
            let mut builder = tar::Builder::new(encoder);
            append_dir(&mut builder, staging, staging)?;
            let encoder = builder
                .into_inner()
                .map_err(|e| Error::archive(format!("打包失败: {e}")))?;
            encoder
                .finish()
                .map_err(|e| Error::archive(format!("gzip 收尾失败: {e}")))?;
        }
    }
    Ok(())
}

/// 把目录内容递归加入 tar（条目名使用相对路径）。
fn append_dir<W: Write>(builder: &mut tar::Builder<W>, base: &Path, dir: &Path) -> Result<()> {
    for entry in walkdir::WalkDir::new(dir)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        if entry.file_type().is_dir() {
            continue;
        }
        let path = entry.path();
        if paths::is_forbidden_path(path) {
            continue;
        }
        let rel = match paths::relative_posix(base, path) {
            Some(rel) if !rel.is_empty() => rel,
            _ => continue,
        };
        builder
            .append_path_with_name(path, &rel)
            .map_err(|e| Error::archive(format!("写入归档条目失败: {e}")))?;
    }
    builder
        .finish()
        .map_err(|e| Error::archive(format!("写入归档结束标记失败: {e}")))?;
    Ok(())
}

/// 解压归档。
fn unpack(archive: &Path, target: &Path) -> Result<()> {
    let file = std::fs::File::open(archive).map_err(|e| Error::io(archive, e))?;
    let reader = std::io::BufReader::with_capacity(256 * 1024, file);
    if archive.extension().map(|e| e == "zst").unwrap_or(false) {
        let decoder = zstd::stream::read::Decoder::new(reader)
            .map_err(|e| Error::archive(format!("zstd 解压失败: {e}")))?;
        tar::Archive::new(decoder)
            .unpack(target)
            .map_err(|e| Error::archive(format!("解包失败: {e}")))?;
    } else {
        let decoder = flate2::read::GzDecoder::new(reader);
        tar::Archive::new(decoder)
            .unpack(target)
            .map_err(|e| Error::archive(format!("解包失败: {e}")))?;
    }
    Ok(())
}

/// 会话在索引中的文本体积估算（用于压缩比统计）。
fn session_size(db: &Database, session_id: &str) -> u64 {
    let mut total = 0u64;
    let _ = db.for_each_message(session_id, &mut |row| {
        total += row.text.as_ref().map(|t| t.len() as u64).unwrap_or(0);
        Ok(())
    });
    total
}
