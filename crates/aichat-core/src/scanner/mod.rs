//! 扫描编排（规格 §9）：探测 → 扫描 → 增量判定 → 按需解析 → 更新索引。
//!
//! 关键性能约束：
//! - 只解析「新增或内容变化」的会话，未变化会话完全不读文件内容；
//! - 解析走流式写入（[`DatabaseSink`]），内存与批次大小成正比；
//! - 单个会话解析失败不影响其他会话，只计入报告。

use std::time::Instant;

use crate::adapters::{AdapterContext, ConversationAdapter};
use crate::error::Result;
use crate::model::{DetectionResult, RawFileRef, SessionDescriptor, SyncStatus};
use crate::scanner::fingerprint::Decision;
use crate::storage::db::{Database, FingerprintRow};
use crate::storage::sessions::DatabaseSink;
use crate::storage::types::{SessionStub, SourceRow};

pub mod fingerprint;
pub mod watcher;

/// 扫描选项。
#[derive(Debug, Clone)]
pub struct ScanOptions {
    /// 忽略指纹，强制重新解析全部会话（「重建索引」）
    pub force: bool,
    /// 单次扫描最多解析多少个会话（保护首次全量扫描；0 表示不限制）
    pub batch_limit: usize,
    /// 消息写入批次大小
    pub batch_size: usize,
}

impl Default for ScanOptions {
    fn default() -> Self {
        ScanOptions {
            force: false,
            batch_limit: 0,
            batch_size: 512,
        }
    }
}

/// 扫描进度（供 Tauri 事件 / CLI 输出）。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanProgress {
    pub phase: String,
    pub done: usize,
    pub total: usize,
    pub current: Option<String>,
}

/// 扫描报告。
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanReport {
    pub scanned: usize,
    pub parsed: usize,
    pub skipped: usize,
    pub removed: usize,
    pub failed: usize,
    /// 因批次上限未在本轮解析的会话数
    pub pending: usize,
    /// 同步仓库中与本地重复（同一台机器的同一会话）而跳过的数量
    pub skipped_duplicates: usize,
    pub duration_ms: u64,
    /// 用户可读的告警（例如「发现 3 条无法解析的会话」）
    pub warnings: Vec<String>,
    pub sources: Vec<DetectionResult>,
}

/// 执行一次增量扫描。
///
/// `progress`：进度回调，每处理一个会话调用一次（用于 UI 进度条 / CLI 输出）。
pub fn scan(
    db: &Database,
    adapters: &[Box<dyn ConversationAdapter>],
    ctx: &AdapterContext<'_>,
    options: &ScanOptions,
    progress: &mut dyn FnMut(ScanProgress),
) -> Result<ScanReport> {
    let started = Instant::now();
    let mut report = ScanReport::default();
    let mut warnings: Vec<String> = Vec::new();

    // ---- 1. 探测 + 登记数据源 ----
    // (是否为同步仓库来源, 适配器, 描述符)
    let mut work: Vec<(bool, &Box<dyn ConversationAdapter>, SessionDescriptor)> = Vec::new();
    for adapter in adapters {
        let remote = adapter.is_remote();
        for detection in adapter.detect(ctx) {
            if !remote {
                db.upsert_source(&SourceRow {
                    id: detection.source.as_str().to_string(),
                    display_name: detection.source.display_name().to_string(),
                    root_path: detection
                        .root
                        .as_ref()
                        .map(|p| crate::error::display_path(p)),
                    found: detection.found,
                    session_hint: detection.session_hint,
                    manual: detection.manual,
                    notes: Some(detection.notes.join("；")),
                    detected_at: Some(chrono::Utc::now().to_rfc3339()),
                })?;
            }
            report.sources.push(detection);
        }
        match adapter.scan(ctx) {
            Ok(list) => {
                work.extend(list.into_iter().map(|d| (remote, adapter, d)));
            }
            Err(err) => warnings.push(format!("{} 扫描失败：{}", adapter.id(), err.user_message())),
        }
    }
    report.scanned = work.len();

    // ---- 2. 本机优先：同步仓库中属于本机的同一会话不再重复索引 ----
    // 本机会话与它在仓库里的快照 session id 相同（source+machine+external 三元组），
    // 这里让本地文件作为权威来源，仓库副本只服务其他机器（规格 §12）。
    let local_ids: std::collections::HashSet<String> = work
        .iter()
        .filter(|(remote, _, _)| !remote)
        .map(|(_, _, d)| d.session_id())
        .collect();
    let before = work.len();
    work.retain(|(remote, _, d)| !remote || !local_ids.contains(&d.session_id()));

    // 同一个会话可能对应多个本地文件（Codex 续写会为同一 session 再写一个 rollout，
    // 文件名形如 `...-<uuid>_<uuid>.jsonl`）。若两个文件都参与解析，会互相清空并
    // 交替覆盖，导致每次扫描都重复解析。这里确定性地只保留「最新」的那份作为内容来源，
    // 其余文件只登记为 raw 附件（快照时照样备份，不丢数据）。
    let mut kept: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    let mut dropped: Vec<usize> = Vec::new();
    for (index, (remote, _, descriptor)) in work.iter().enumerate() {
        if *remote {
            continue;
        }
        let id = descriptor.session_id();
        match kept.get(&id).copied() {
            None => {
                kept.insert(id, index);
            }
            Some(current) => {
                let newer = file_recency(&descriptor.primary_file)
                    > file_recency(&work[current].2.primary_file);
                let (keep, drop) = if newer {
                    (index, current)
                } else {
                    (current, index)
                };
                kept.insert(id, keep);
                dropped.push(drop);
            }
        }
    }
    if !dropped.is_empty() {
        // 把被丢弃文件登记到保留描述符的 files（用于「保留原始文件」快照）
        let extras: Vec<(usize, RawFileRef)> = dropped
            .iter()
            .filter_map(|&drop_index| {
                let descriptor = &work[drop_index].2;
                let keep_index = *kept.get(&descriptor.session_id())?;
                let extra = RawFileRef {
                    role: "extra_file".to_string(),
                    path: descriptor.primary_file.clone(),
                    size: std::fs::metadata(&descriptor.primary_file)
                        .map(|m| m.len())
                        .unwrap_or(0),
                };
                Some((keep_index, extra))
            })
            .collect();
        for (keep_index, extra) in extras {
            work[keep_index].2.files.push(extra);
        }
        dropped.sort_unstable();
        for &drop_index in dropped.iter().rev() {
            work.remove(drop_index);
        }
    }

    report.skipped_duplicates = before - work.len();
    report.scanned -= report.skipped_duplicates;

    // ---- 3. 一次性载入指纹（避免逐条查询）----
    let paths: Vec<String> = work
        .iter()
        .map(|(_, _, d)| crate::error::display_path(&d.primary_file))
        .collect();
    let fingerprints = db.fingerprints_by_paths(&paths)?;

    // ---- 4. 逐个会话增量处理 ----
    let total = work.len();
    let mut parsed_this_run = 0usize;
    let mut pending = 0usize;

    for (position, (remote, adapter, descriptor)) in work.iter().enumerate() {
        let session_id = descriptor.session_id();
        let primary_path = crate::error::display_path(&descriptor.primary_file);

        progress(ScanProgress {
            phase: "scan".to_string(),
            done: position,
            total,
            current: Some(session_id.clone()),
        });

        let existing = db.get_session(&session_id)?;
        // 强制解析或首次见到 → 直接算哈希并解析；否则先比 size+mtime
        let (decision, content_hash) = if options.force || existing.is_none() {
            match fingerprint::hash_file(&descriptor.primary_file) {
                Ok(hash) => (Decision::Changed, Some(hash)),
                Err(err) => {
                    report.failed += 1;
                    warnings.push(format!(
                        "会话 {} 无法读取：{}",
                        descriptor.external_id,
                        err.user_message()
                    ));
                    continue;
                }
            }
        } else {
            match fingerprint::decide(&descriptor.primary_file, fingerprints.get(&primary_path)) {
                Ok(result) => result,
                Err(err) => {
                    report.failed += 1;
                    warnings.push(format!(
                        "会话 {} 读取失败：{}",
                        descriptor.external_id,
                        err.user_message()
                    ));
                    continue;
                }
            }
        };

        match decision {
            Decision::Unchanged => {
                report.skipped += 1;
                continue;
            }
            Decision::SameContent => {
                // 内容未变（例如文件被重写）：只刷新指纹，跳过解析
                if let Some((size, mtime)) = fingerprint::quick_stat(&descriptor.primary_file) {
                    db.touch_fingerprint(&primary_path, size, mtime, content_hash.as_deref())?;
                }
                report.skipped += 1;
                continue;
            }
            Decision::Changed => {
                if options.batch_limit > 0 && parsed_this_run >= options.batch_limit {
                    pending += 1;
                    continue;
                }
            }
        }

        match parse_one(
            db,
            adapter.as_ref(),
            ctx,
            descriptor,
            *remote,
            content_hash.as_deref(),
            options,
        ) {
            Ok(()) => {
                // 解析成功后再落指纹：中途失败下次仍会重试
                // 主文件带内容哈希；其余文件（state.json / 子 Agent wire 等）只记 size+mtime，
                // 它们参与「保留原始文件」快照复制，但不参与增量判定。
                let mut rows = vec![FingerprintRow {
                    path: primary_path.clone(),
                    session_id: session_id.clone(),
                    role: "primary".to_string(),
                    size: 0,
                    mtime: 0,
                    hash: content_hash.clone(),
                }];
                if let Some((size, mtime)) = fingerprint::quick_stat(&descriptor.primary_file) {
                    rows[0].size = size;
                    rows[0].mtime = mtime;
                }
                for file in descriptor.files.iter().skip(1) {
                    if crate::paths::is_forbidden_path(&file.path) {
                        continue;
                    }
                    let Some((size, mtime)) = fingerprint::quick_stat(&file.path) else {
                        continue;
                    };
                    rows.push(FingerprintRow {
                        path: crate::error::display_path(&file.path),
                        session_id: session_id.clone(),
                        role: file.role.clone(),
                        size,
                        mtime,
                        hash: None,
                    });
                }
                db.replace_fingerprints(&session_id, descriptor.source.as_str(), &rows)?;
                // 同步状态：曾同步过 → modified
                let status = if *remote {
                    let ours = descriptor.machine_id.as_deref() == Some(ctx.machine_id);
                    if ours {
                        SyncStatus::Synced
                    } else {
                        SyncStatus::Remote
                    }
                } else {
                    match existing.as_ref().map(|s| SyncStatus::parse(&s.sync_status)) {
                        Some(SyncStatus::Synced) => SyncStatus::Modified,
                        Some(other) => other,
                        None => SyncStatus::Local,
                    }
                };
                db.set_sync_status(&session_id, status)?;
                report.parsed += 1;
                parsed_this_run += 1;
            }
            Err(err) => {
                report.failed += 1;
                warnings.push(format!(
                    "会话 {} 解析失败：{}",
                    descriptor.external_id,
                    err.user_message()
                ));
            }
        }
    }

    // ---- 5. 清理：原始文件已消失的本机会话 ----
    // 仅当该会话属于本轮扫描过的本地数据源时才删除，避免误删仓库来源的会话
    for (id, primary_file, source, status) in db.local_session_files()? {
        let managed_locally = adapters.iter().any(|a| !a.is_remote() && a.id() == source);
        // 只清理本机拥有且仍在索引中的会话；仓库来源 / 已归档的不动
        let owned = matches!(
            status,
            SyncStatus::Local | SyncStatus::Synced | SyncStatus::Modified
        );
        if !managed_locally || !owned || !local_ids.contains(&id) {
            continue;
        }
        if let Some(path) = primary_file {
            if !std::path::Path::new(&path).is_file() {
                db.delete_sessions(&[id])?;
                report.removed += 1;
            }
        }
    }

    // 批量写入后立刻 checkpoint：避免 WAL 膨胀拖慢后续搜索
    if report.parsed > 0 {
        if let Err(err) = db.checkpoint() {
            tracing::warn!(error = %err, "WAL checkpoint 失败");
        }
    }

    report.pending = pending;
    report.duration_ms = started.elapsed().as_millis() as u64;
    report.warnings = warnings;

    progress(ScanProgress {
        phase: "done".to_string(),
        done: total,
        total,
        current: None,
    });
    Ok(report)
}

/// 解析单个会话并写入索引。
fn parse_one(
    db: &Database,
    adapter: &dyn ConversationAdapter,
    ctx: &AdapterContext<'_>,
    descriptor: &SessionDescriptor,
    remote: bool,
    content_hash: Option<&str>,
    options: &ScanOptions,
) -> Result<()> {
    let session_id = descriptor.session_id();

    // 外键依赖：先写会话占位行，再写消息
    db.upsert_session_stub(&SessionStub {
        id: session_id.clone(),
        source: descriptor.source.as_str().to_string(),
        external_id: descriptor.external_id.clone(),
        machine_id: descriptor
            .machine_id
            .clone()
            .or_else(|| Some(ctx.machine_id.to_string())),
        source_root: Some(crate::error::display_path(&descriptor.session_dir)),
        primary_file: Some(crate::error::display_path(&descriptor.primary_file)),
        sync_status: if remote {
            SyncStatus::Remote
        } else {
            SyncStatus::Local
        },
    })?;
    db.clear_messages(&session_id)?;

    let mut sink = DatabaseSink::new(db, &session_id, options.batch_size);
    let info = adapter.parse_streaming(ctx, descriptor, &mut sink)?;
    sink.flush()?;
    db.finalize_session(&session_id, &info, content_hash)?;
    Ok(())
}

/// 文件「新旧」排序键：修改时间优先，其次大小（用于同一会话多文件时挑最新的一份）。
fn file_recency(path: &std::path::Path) -> (i64, u64) {
    match std::fs::metadata(path) {
        Ok(meta) => {
            let mtime = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_nanos() as i64)
                .unwrap_or(0);
            (mtime, meta.len())
        }
        Err(_) => (0, 0),
    }
}

/// 汇总各适配器的数据源路径，供文件监听使用。
pub fn watch_roots(
    adapters: &[Box<dyn ConversationAdapter>],
    ctx: &AdapterContext<'_>,
) -> Vec<std::path::PathBuf> {
    let mut roots = Vec::new();
    for adapter in adapters {
        if adapter.is_remote() {
            continue;
        }
        for detection in adapter.detect(ctx) {
            if let Some(root) = detection.root {
                let sessions = root.join("sessions");
                roots.push(if sessions.is_dir() { sessions } else { root });
            }
        }
    }
    roots.sort();
    roots.dedup();
    roots
}
