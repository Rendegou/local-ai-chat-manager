//! `aichat-cli`：本机自检与性能测试工具。
//!
//! 用途：
//! - 在没有 GUI 的环境（CI / 服务器 / 首次排障）验证适配器与索引是否正常；
//! - 对真实本机数据做端到端验证：`detect → scan → list → search`；
//! - 性能验证：`bench`（索引与搜索）、`bench-session`（大 JSONL 流式解析 + 峰值内存）。
//!
//! 示例：
//! ```text
//! aichat-cli detect
//! aichat-cli scan --force
//! aichat-cli list --limit 20
//! aichat-cli search "lazy deletion"
//! aichat-cli bench --sessions 10000 --messages 100
//! aichat-cli bench-session --size-mb 100
//! ```

use std::path::PathBuf;
use std::time::Instant;

use aichat_core::adapters::AdapterContext;
use aichat_core::scanner::ScanOptions;
use aichat_core::storage::search::{SearchOrder, SearchQuery};
use aichat_core::storage::sessions::SessionFilter;
use aichat_core::{error, Library};

fn main() {
    aichat_core::init_logging("info");
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.is_empty() {
        print_usage();
        return;
    }
    if let Err(err) = run(&args) {
        eprintln!("错误：{}", err.user_message());
        eprintln!("（详细：{}）", err);
        std::process::exit(1);
    }
}

/// 解析并执行子命令。
fn run(args: &[String]) -> aichat_core::Result<()> {
    let command = args[0].as_str();
    let rest = &args[1..];
    let data_dir = data_dir(rest);

    match command {
        "detect" => {
            let library = Library::open(data_dir)?;
            let rows = library.detect_sources()?;
            for row in rows {
                println!(
                    "{:<10} found={:<5} sessions≈{:<6} root={}",
                    row.display_name,
                    row.found,
                    row.session_hint,
                    row.root_path.unwrap_or_else(|| "-".to_string())
                );
                if let Some(notes) = row.notes {
                    println!("           {notes}");
                }
            }
        }
        "scan" => {
            let library = Library::open(data_dir)?;
            let force = has_flag(rest, "--force");
            let report = library.scan(force, &mut |p| {
                if p.total > 0 && (p.done % 200 == 0 || p.done + 1 == p.total) {
                    eprintln!("  扫描 {}/{}", p.done + 1, p.total);
                }
            })?;
            println!(
                "扫描完成：会话 {}，解析 {}，跳过 {}，删除 {}，失败 {}，待处理 {}，耗时 {} ms",
                report.scanned,
                report.parsed,
                report.skipped,
                report.removed,
                report.failed,
                report.pending,
                report.duration_ms
            );
            for warning in &report.warnings {
                println!("  告警：{warning}");
            }
            let stats = library.stats()?;
            println!(
                "索引规模：会话 {}，消息 {}，项目 {}，占用 {:.1} MB",
                stats.sessions,
                stats.messages,
                stats.projects,
                stats.bytes_on_disk as f64 / 1024.0 / 1024.0
            );
        }
        "list" => {
            let library = Library::open(data_dir)?;
            let filter = filter_from(rest);
            let limit = number_arg(rest, "--limit").unwrap_or(20);
            let rows = library.list_sessions(&filter, limit as i64, 0)?;
            for row in rows {
                println!(
                    "[{}] {:<22} {} ({} 条消息){}{}",
                    row.source,
                    short(&row.updated_at.clone().unwrap_or_default(), 19),
                    row.title.unwrap_or_else(|| "(无标题)".to_string()),
                    row.message_count,
                    row.project_path
                        .as_deref()
                        .map(|p| format!("  @{p}"))
                        .unwrap_or_default(),
                    if row.partial { "  [partial]" } else { "" }
                );
            }
        }
        "show" => {
            let library = Library::open(data_dir)?;
            let session_id = rest
                .iter()
                .find(|a| !a.starts_with("--"))
                .ok_or_else(|| error::Error::config("缺少 session id".to_string()))?;
            let Some(detail) = library.session_detail(session_id)? else {
                return Err(error::Error::not_found(format!("会话 {session_id}")));
            };
            println!(
                "会话：{}（{}，{} 条消息）",
                detail.summary.title.clone().unwrap_or_default(),
                detail.summary.source,
                detail.summary.message_count
            );
            let messages = library.messages_page(
                session_id,
                0,
                number_arg(rest, "--limit").unwrap_or(20) as i64,
            )?;
            for message in messages {
                println!(
                    "  #{} [{}:{}] {}",
                    message.sequence,
                    message.role,
                    message.kind,
                    short(&message.text.unwrap_or_default().replace('\n', " "), 140)
                );
            }
        }
        "search" => {
            let library = Library::open(data_dir)?;
            let text = rest
                .iter()
                .find(|a| !a.starts_with("--"))
                .cloned()
                .unwrap_or_default();
            let query = SearchQuery {
                text,
                filter: filter_from(rest),
                order: SearchOrder::Relevance,
                messages_only: has_flag(rest, "--messages-only"),
                limit: number_arg(rest, "--limit").unwrap_or(20) as i64,
                offset: 0,
            };
            let started = Instant::now();
            let response = library.search(&query)?;
            println!(
                "命中 {} 条（{} ms，FTS：{}）",
                response.hits.len(),
                response.took_ms,
                response.match_query
            );
            for hit in response.hits {
                println!(
                    "  [{}] {} — {}",
                    hit.source,
                    hit.title.unwrap_or_else(|| hit.session_id.clone()),
                    short(&hit.snippet.replace('\n', " "), 160)
                );
            }
            let _ = started;
        }
        "stats" => {
            let library = Library::open(data_dir)?;
            let stats = library.stats()?;
            println!("{stats:#?}");
        }
        "status" => {
            let library = Library::open(data_dir)?;
            let status = library.sync_status()?;
            println!("{status:#?}");
        }
        "sync" => {
            let library = Library::open(data_dir)?;
            let options = aichat_core::sync::SyncOptions {
                push: !has_flag(rest, "--no-push"),
                commit_message: None,
                set_remote: string_arg(rest, "--remote"),
                skip_scan: has_flag(rest, "--skip-scan"),
            };
            let report = library.sync_now(&options, &mut |step| eprintln!("  {step}"))?;
            for step in &report.steps {
                println!(
                    "{} {:<20} {} ({} ms)",
                    if step.ok { "✓" } else { "✗" },
                    step.name,
                    step.detail,
                    step.duration_ms
                );
            }
            if let Some(conflict) = report.conflict {
                println!("冲突：{} -> {:?}", conflict.message, conflict.files);
            }
        }
        "log" => {
            let library = Library::open(data_dir)?;
            println!(
                "{}",
                library.git_log(number_arg(rest, "--limit").unwrap_or(20))?
            );
        }
        "abort-rebase" => {
            let library = Library::open(data_dir)?;
            library.abort_rebase()?;
            println!("已中止 rebase");
        }
        "archive" => {
            let library = Library::open(data_dir)?;
            let report = if has_flag(rest, "--days") {
                library.archive_old_sessions()?
            } else {
                let ids: Vec<String> = rest
                    .iter()
                    .filter(|a| !a.starts_with("--"))
                    .cloned()
                    .collect();
                library.archive_sessions(&ids)?
            };
            println!(
                "归档 {} 个，失败 {}，压缩前 {} 字节 → 压缩后 {} 字节",
                report.archived, report.failed, report.bytes_in, report.bytes_out
            );
            for entry in report.entries {
                println!("  {entry}");
            }
            for warning in report.warnings {
                println!("  告警：{warning}");
            }
        }
        "archives" => {
            let library = Library::open(data_dir)?;
            for entry in library.list_archives()? {
                println!(
                    "{:<60} {:<6} {:>10} 字节  {}",
                    entry.rel_path,
                    entry.compression,
                    entry.size_bytes,
                    entry.title.unwrap_or_default()
                );
            }
        }
        "restore" => {
            let library = Library::open(data_dir)?;
            let rel = rest
                .iter()
                .find(|a| !a.starts_with("--"))
                .ok_or_else(|| error::Error::config("缺少归档相对路径".to_string()))?;
            let path = library.restore_archive(rel)?;
            println!("已恢复到 {}", error::display_path(&path));
        }
        "watch" => {
            let library = Library::open(data_dir)?;
            let secs = number_arg(rest, "--seconds").unwrap_or(30);
            let count = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
            let counter = std::sync::Arc::clone(&count);
            let mut handle = library.watch(move || {
                counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            })?;
            println!("监听中（{secs} 秒），修改会话文件会触发重新索引…");
            std::thread::sleep(std::time::Duration::from_secs(secs as u64));
            handle.stop();
            println!(
                "监听结束，共触发 {} 次变更回调",
                count.load(std::sync::atomic::Ordering::SeqCst)
            );
        }
        "bench" => bench(rest)?,
        "bench-session" => bench_session(rest)?,
        other => {
            eprintln!("未知命令：{other}");
            print_usage();
            std::process::exit(2);
        }
    }
    Ok(())
}

/// 索引与搜索性能测试：生成 N 会话 × M 消息，测量写入与查询耗时。
fn bench(args: &[String]) -> aichat_core::Result<()> {
    let sessions = number_arg(args, "--sessions").unwrap_or(10_000);
    let per_session = number_arg(args, "--messages").unwrap_or(100);
    let queries = number_arg(args, "--queries").unwrap_or(20);

    // --keep：把索引写进 --data-dir（便于用 SQL 直接剖析性能），否则用临时目录
    let keep = has_flag(args, "--keep");
    let tmp = tempfile::tempdir().map_err(|e| error::Error::io("temp", e))?;
    let library = Library::open(if keep {
        data_dir(args)
    } else {
        tmp.path().to_path_buf()
    })?;
    let total = sessions * per_session;
    println!("生成索引：{sessions} 个会话 × {per_session} 条消息 = {total} 条消息");

    let started = Instant::now();
    let projects = ["demo-project", "web-service", "thesis", "blog-site"];
    let mut inserted = 0usize;
    for s in 0..sessions {
        let session_id = format!("kimi:bench-{s}");
        let project = projects[s % projects.len()];
        library
            .db()
            .upsert_session_stub(&aichat_core::storage::types::SessionStub {
                id: session_id.clone(),
                source: "kimi".into(),
                external_id: format!("bench-{s}"),
                machine_id: Some("bench-machine".into()),
                source_root: Some(format!("/bench/{s}")),
                primary_file: Some(format!("/bench/{s}/wire.jsonl")),
                sync_status: aichat_core::model::SyncStatus::Local,
            })?;
        let mut batch = Vec::with_capacity(per_session);
        for m in 0..per_session {
            let text = match m % 5 {
                0 => format!(
                    "Redisson watchdog 续期失败，怀疑 TTL lazy deletion 逻辑 (s={s}, m={m})"
                ),
                1 => format!("Agent Goal 规划：把 RESP parser 拆成 tokenizer 与 decoder (s={s})"),
                2 => format!("Redis benchmark 结果：GET 120k ops/s, SET 98k ops/s (s={s})"),
                3 => format!("修复完这个问题后补充单元测试 (s={s}, m={m})"),
                _ => format!("普通对话内容，用于填充索引规模 (s={s}, m={m})"),
            };
            batch.push(aichat_core::storage::sessions::MessageRow {
                id: format!("{session_id}#{m}"),
                session_id: session_id.clone(),
                sequence: m as i64,
                role: if m % 2 == 0 {
                    "user".into()
                } else {
                    "assistant".into()
                },
                kind: "message".into(),
                text: Some(text),
                tool_name: None,
                timestamp: Some(format!("2026-09-{:02}T10:00:00+00:00", (s % 28) + 1)),
                raw: None,
            });
        }
        library.db().insert_messages(&batch)?;
        library.db().finalize_session(
            &session_id,
            &aichat_core::model::ParsedSessionInfo {
                title: Some(format!("{project} 会话 #{s}")),
                project_path: Some(format!("D:/work/{project}")),
                created_at: Some("2026-09-01T10:00:00+00:00".into()),
                updated_at: Some(format!("2026-09-{:02}T10:00:00+00:00", (s % 28) + 1)),
                message_count: per_session as u64,
                ..Default::default()
            },
            Some("bench-hash"),
        )?;
        inserted += per_session;
    }
    let insert_elapsed = started.elapsed();
    println!(
        "写入 {inserted} 条消息耗时 {:.2}s（{:.0} 条/秒）",
        insert_elapsed.as_secs_f64(),
        inserted as f64 / insert_elapsed.as_secs_f64().max(0.001)
    );

    let stats = library.stats()?;
    println!(
        "索引体积：{:.1} MB",
        stats.bytes_on_disk as f64 / 1024.0 / 1024.0
    );

    // 大规模写入后先把 WAL 落盘，再测搜索（这才是用户日常的稳态延迟）
    library.db().checkpoint()?;
    println!("WAL 已 checkpoint（{}）", has_flag(args, "--keep"));

    // 搜索延迟：目标 < 300ms
    let keywords = [
        "lazy deletion",
        "Redisson watchdog",
        "RESP parser",
        "benchmark",
        "Agent Goal",
    ];
    let mut samples = Vec::new();
    for i in 0..queries {
        let query = SearchQuery {
            text: keywords[i % keywords.len()].to_string(),
            filter: SessionFilter::default(),
            order: SearchOrder::Relevance,
            messages_only: false,
            limit: 50,
            offset: 0,
        };
        let t = Instant::now();
        let response = library.search(&query)?;
        let elapsed = t.elapsed().as_millis() as u64;
        if i == 0 {
            println!("首查命中 {} 条，耗时 {} ms", response.hits.len(), elapsed);
        }
        samples.push(elapsed);
    }
    samples.sort_unstable();
    let p50 = samples[samples.len() / 2];
    let p95 = samples[(samples.len() * 95 / 100).min(samples.len() - 1)];
    println!("搜索延迟：p50 = {p50} ms，p95 = {p95} ms（目标 < 300 ms）");
    Ok(())
}

/// 大文件流式解析测试：生成 ~N MB 的 wire.jsonl，测量解析耗时与峰值内存。
fn bench_session(args: &[String]) -> aichat_core::Result<()> {
    let size_mb = number_arg(args, "--size-mb").unwrap_or(100);
    let tmp = tempfile::tempdir().map_err(|e| error::Error::io("temp", e))?;
    let root = tmp.path().join("kimi-home");
    let session_dir = root
        .join("sessions")
        .join("wd_bench_000000000000")
        .join("ses_bench0000-0000-0000-0000-000000000000");
    std::fs::create_dir_all(session_dir.join("agents/main"))
        .map_err(|e| error::Error::io(&session_dir, e))?;
    std::fs::write(
        session_dir.join("state.json"),
        serde_json::json!({
            "id": "ses_bench0000-0000-0000-0000-000000000000",
            "version": 1,
            "cwd": "D:/bench",
            "createdAt": 1757937000000i64,
            "updatedAt": 1757937600000i64,
            "title": "超大 JSONL 流式解析测试",
            "agents": { "main": { "type": "main" } }
        })
        .to_string(),
    )
    .map_err(|e| error::Error::io("state.json", e))?;

    // 生成数据：交替输出文本分片与工具调用，尽量贴近真实 wire.jsonl 结构
    let target_bytes = size_mb as u64 * 1024 * 1024;
    let wire = session_dir.join("agents/main/wire.jsonl");
    let mut written = 0u64;
    let filler: String =
        "Redis lazy deletion benchmark with Redisson watchdog and RESP parser ".repeat(6);
    {
        let file = std::fs::File::create(&wire).map_err(|e| error::Error::io(&wire, e))?;
        let mut writer = std::io::BufWriter::with_capacity(1 << 20, file);
        use std::io::Write;
        let mut index = 0u64;
        while written < target_bytes {
            index += 1;
            // 每次内容都不同：避免被「相邻重复消息」去重合并，从而真实反映解析成本
            let body = format!("{filler}#{index}");
            let prompt = serde_json::json!({
                "type": "prompt.accepted",
                "agentId": "main",
                "promptId": format!("p{index}"),
                "content": body,
                "time": "2026-09-15T10:00:00Z"
            });
            let event = serde_json::json!({
                "type": "context.append_loop_event",
                "agentId": "main",
                "time": "2026-09-15T10:00:01Z",
                "event": {
                    "type": "content.part",
                    "uuid": format!("u{index}"),
                    "turnId": "t1",
                    "step": 1,
                    // 每个 step 独立，避免不同分片被合并成一条消息
                    "stepUuid": format!("s{index}"),
                    "part": { "type": "text", "text": body }
                }
            });
            let line = serde_json::to_string(&prompt)?;
            let line2 = serde_json::to_string(&event)?;
            writeln!(writer, "{line}").map_err(|e| error::Error::io(&wire, e))?;
            writeln!(writer, "{line2}").map_err(|e| error::Error::io(&wire, e))?;
            written += (line.len() + line2.len() + 2) as u64;
        }
        writer.flush().map_err(|e| error::Error::io(&wire, e))?;
    }
    let file_size = std::fs::metadata(&wire).map(|m| m.len()).unwrap_or(0);
    println!("生成会话文件：{:.1} MB", file_size as f64 / 1024.0 / 1024.0);

    // --keep：索引写到 --data-dir（便于复用分析），否则用临时目录
    let keep = has_flag(args, "--keep");
    let library = Library::open(if keep {
        data_dir(args)
    } else {
        tmp.path().join("data")
    })?;
    // 数据源只保留合成的 kimi 根目录，其余来源显式停用。
    // 停用必须同时体现在两处：设置的 enabled 标志（下面过滤适配器时用），
    // 否则 default_adapters() 会把 Claude / Gemini / WorkBuddy 的默认目录
    // （真实用户主目录）一起扫进来，基准结果就被开发机上的历史污染了。
    let mut settings = aichat_core::AppSettings {
        kimi_path: Some(root.display().to_string()),
        ..Default::default()
    };
    for def in aichat_core::adapters::registry::catalog() {
        if def.id == "kimi" {
            continue;
        }
        settings.sources.insert(
            def.id.to_string(),
            aichat_core::settings::SourceConfig { enabled: false, ..Default::default() },
        );
    }
    let adapters: Vec<_> = aichat_core::adapters::default_adapters(None)
        .into_iter()
        .filter(|a| settings.source_enabled(a.id()))
        .collect();
    let ctx = AdapterContext {
        settings: &settings,
        machine_id: "bench",
    };
    let started = Instant::now();
    let options = ScanOptions::default();
    let report = aichat_core::scanner::scan(library.db(), &adapters, &ctx, &options, &mut |_| {})
        .unwrap_or_else(|e| panic!("扫描失败: {e}"));
    let elapsed = started.elapsed();
    println!(
        "解析 {} 条消息，耗时 {:.2}s（{:.1} MB/s），峰值内存 {}",
        library.stats()?.messages,
        elapsed.as_secs_f64(),
        file_size as f64 / 1024.0 / 1024.0 / elapsed.as_secs_f64().max(0.001),
        peak_memory_mb()
            .map(|mb| format!("{mb:.0} MB"))
            .unwrap_or_else(|| "未知".to_string())
    );
    println!(
        "扫描报告：解析 {}，跳过 {}，失败 {}",
        report.parsed, report.skipped, report.failed
    );
    Ok(())
}

/// 读取当前进程峰值内存（Windows / Linux 支持，其他平台返回 None）。
fn peak_memory_mb() -> Option<f64> {
    #[cfg(target_os = "windows")]
    {
        let pid = std::process::id().to_string();
        let mut command = std::process::Command::new("powershell");
        command.args([
            "-NoProfile",
            "-Command",
            &format!("(Get-Process -Id {pid}).PeakWorkingSet64"),
        ]);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000);
        }
        let output = command.output().ok()?;
        let text = String::from_utf8_lossy(&output.stdout);
        let bytes: f64 = text.trim().parse().ok()?;
        Some(bytes / 1024.0 / 1024.0)
    }
    #[cfg(target_os = "linux")]
    {
        let status = std::fs::read_to_string("/proc/self/status").ok()?;
        for line in status.lines() {
            if let Some(rest) = line.strip_prefix("VmHWM:") {
                let kb: f64 = rest.trim().trim_end_matches(" kB").trim().parse().ok()?;
                return Some(kb / 1024.0);
            }
        }
        None
    }
    #[cfg(not(any(target_os = "windows", target_os = "linux")))]
    {
        None
    }
}

// ---------------------------------------------------------------------------
// 参数解析辅助（保持零依赖）
// ---------------------------------------------------------------------------

/// 数据目录：`--data-dir` > 环境变量 > 默认目录。
fn data_dir(args: &[String]) -> PathBuf {
    if let Some(dir) = string_arg(args, "--data-dir") {
        return aichat_core::paths::expand_home(&dir);
    }
    if let Some(dir) = std::env::var_os("AICHAT_DATA_DIR") {
        return PathBuf::from(dir);
    }
    aichat_core::paths::default_data_dir()
}

/// 读取 `--key value` 形式的字符串参数。
fn string_arg(args: &[String], key: &str) -> Option<String> {
    let index = args.iter().position(|a| a == key)?;
    args.get(index + 1).cloned()
}

/// 读取 `--key N` 形式的数字参数。
fn number_arg(args: &[String], key: &str) -> Option<usize> {
    string_arg(args, key).and_then(|v| v.parse().ok())
}

/// 是否存在布尔开关。
fn has_flag(args: &[String], key: &str) -> bool {
    args.iter().any(|a| a == key)
}

/// 从命令行构造会话筛选条件。
fn filter_from(args: &[String]) -> SessionFilter {
    SessionFilter {
        source: string_arg(args, "--source"),
        project_path: string_arg(args, "--project"),
        machine_id: string_arg(args, "--machine"),
        from: string_arg(args, "--from"),
        to: string_arg(args, "--to"),
        include_archived: has_flag(args, "--include-archived"),
        only_archived: has_flag(args, "--archived"),
        text: None,
    }
}

/// 截断字符串用于终端展示。
fn short(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let mut out: String = text.chars().take(max).collect();
    out.push('…');
    out
}

/// 打印用法。
fn print_usage() {
    println!(
        "Local AI Chat Manager CLI\n\
         用法：aichat-cli <命令> [选项]\n\n\
         命令：\n\
         \x20 detect                     探测 Codex / Kimi 数据源\n\
         \x20 scan [--force]             增量扫描（--force 全量重建）\n\
         \x20 list [--limit N] [--source codex|kimi] [--project P]\n\
         \x20 show <session-id> [--limit N]\n\
         \x20 search <关键词> [--source S] [--limit N] [--messages-only]\n\
         \x20 stats | status | log [--limit N] | abort-rebase\n\
         \x20 sync [--no-push] [--remote URL] [--skip-scan]\n\
         \x20 archive <session-id...> | archive --days | archives | restore <相对路径>\n\
         \x20 watch [--seconds N]\n\
         \x20 bench [--sessions N] [--messages M]      索引/搜索性能测试\n\
         \x20 bench-session [--size-mb N]              大 JSONL 流式解析与内存测试\n\n\
         全局：--data-dir <目录>（默认 {}）",
        error::display_path(&aichat_core::paths::default_data_dir())
    );
}
