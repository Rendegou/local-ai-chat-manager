//! 搜索性能剖析（规格 §22：100 万条消息 < 300ms）。
//!
//! 该测试依赖 `aichat-cli bench --keep` 生成的索引（默认 `.bench/index.db`）；
//! 索引不存在时自动跳过，因此可以直接放进常规测试流程。
//!
//! 运行：
//! ```text
//! cargo test -p aichat-core --test search_perf -- --nocapture
//! ```

use std::path::Path;
use std::time::Instant;

use aichat_core::storage::Database;

/// 两阶段查询：先在 FTS 索引上取候选 rowid（不排序，可提前终止，很快），
/// 再对候选集计算 bm25 与 snippet 并排序截断。
fn two_phase(match_expr: &str, candidates: usize) -> String {
    format!(
        "WITH cand(rowid) AS (SELECT rowid FROM message_fts WHERE message_fts MATCH '{match_expr}' LIMIT {candidates}) \
         SELECT m.id, snippet(message_fts, 0, '<mark>', '</mark>', '…', 18) AS snippet, bm25(message_fts) AS score \
         FROM cand \
         JOIN message_fts ON message_fts.rowid = cand.rowid \
         JOIN messages m ON m.rowid = cand.rowid \
         JOIN sessions s ON s.id = m.session_id \
         WHERE s.archived = 0 \
         ORDER BY score ASC LIMIT 51"
    )
}

/// 待剖析的 FTS5 查询（同一组匹配结果的多种写法）。
fn variants(match_expr: &str) -> Vec<(String, String)> {
    let select = "SELECT m.id, snippet(message_fts, 0, '<mark>', '</mark>', '…', 18) AS snippet, bm25(message_fts) AS score
         FROM message_fts
         JOIN messages m ON m.rowid = message_fts.rowid
         JOIN sessions s ON s.id = m.session_id
         WHERE message_fts MATCH ".to_string();
    let filter = " AND s.archived = 0";
    vec![
        (
            "ORDER BY score ASC LIMIT 51 OFFSET 0".to_string(),
            format!("{select}'{match_expr}'{filter} ORDER BY score ASC LIMIT 51 OFFSET 0"),
        ),
        (
            "ORDER BY bm25() ASC LIMIT 51".to_string(),
            format!("{select}'{match_expr}'{filter} ORDER BY bm25(message_fts) ASC LIMIT 51"),
        ),
        (
            "ORDER BY rank LIMIT 51".to_string(),
            format!("{select}'{match_expr}'{filter} ORDER BY rank LIMIT 51"),
        ),
        (
            "无排序 LIMIT 51".to_string(),
            format!("{select}'{match_expr}'{filter} LIMIT 51"),
        ),
        (
            "仅 rowid（无 join / 无 snippet）".to_string(),
            format!("SELECT rowid FROM message_fts WHERE message_fts MATCH '{match_expr}' LIMIT 51"),
        ),
        (
            "rowid + ORDER BY rank LIMIT".to_string(),
            format!("SELECT rowid FROM message_fts WHERE message_fts MATCH '{match_expr}' ORDER BY rank LIMIT 51"),
        ),
        (
            "两阶段：候选 5k → 打分排序".to_string(),
            two_phase(match_expr, 5_000),
        ),
        (
            "两阶段：候选 20k → 打分排序".to_string(),
            two_phase(match_expr, 20_000),
        ),
        (
            "两阶段：候选 50k → 打分排序".to_string(),
            two_phase(match_expr, 50_000),
        ),
        (
            "子查询先排好名次，再 join 取详情".to_string(),
            format!(
                "SELECT m.id, snippet(message_fts, 0, '<mark>', '</mark>', '…', 18) AS snippet, bm25(message_fts) AS score                  FROM (SELECT rowid AS rid FROM message_fts WHERE message_fts MATCH '{match_expr}' ORDER BY rank LIMIT 51) c                  JOIN message_fts ON message_fts.rowid = c.rid                  JOIN messages m ON m.rowid = c.rid JOIN sessions s ON s.id = m.session_id WHERE 1 {filter} ORDER BY score ASC"
            ),
        ),
    ]
}

#[test]
fn 剖析_百万消息搜索() {
    let path = Path::new("../../.bench/index.db");
    if !path.is_file() {
        eprintln!(
            "跳过：未找到 {}（先运行 aichat-cli bench --keep）",
            path.display()
        );
        return;
    }
    let db = Database::open(path).expect("打开索引");
    let (count, total) = db
        .with_conn(|conn| {
            let matched: i64 = conn.query_row(
                "SELECT count(*) FROM message_fts WHERE message_fts MATCH '\"lazy\" \"deletion\"*'",
                [],
                |r| r.get(0),
            )?;
            let total: i64 = conn.query_row("SELECT count(*) FROM messages", [], |r| r.get(0))?;
            Ok((matched, total))
        })
        .expect("统计");
    println!("索引消息总数：{total}，当前关键词匹配：{count}");

    for (label, sql) in variants("\"lazy\" \"deletion\"*") {
        // 每个变体跑两次：第一次预热页缓存，第二次才是可比的热查询
        let started = Instant::now();
        let rows = db
            .with_conn(|conn| {
                let mut stmt = conn.prepare(&sql)?;
                // 第 1 列在不同变体里分别是 TEXT（id）与 INTEGER（rowid），统一按值取
                let rows = stmt
                    .query_map([], |r| {
                        r.get_ref(0).map(|v| v.as_str().unwrap_or("?").to_string())
                    })?
                    .collect::<std::result::Result<Vec<_>, _>>()?;
                Ok(rows)
            })
            .expect("查询");
        let cold = started.elapsed().as_micros() as f64 / 1000.0;
        let warm_started = Instant::now();
        let _ = db.with_conn(|conn| {
            let mut stmt = conn.prepare(&sql)?;
            let rows = stmt.query_map([], |r| r.get::<_, i64>(0))?.count();
            Ok(rows)
        });
        let warm = warm_started.elapsed().as_micros() as f64 / 1000.0;
        println!(
            "  {:<34} cold={:>7.1} ms  warm={:>7.1} ms  rows={}",
            label,
            cold,
            warm,
            rows.len()
        );
    }
}
