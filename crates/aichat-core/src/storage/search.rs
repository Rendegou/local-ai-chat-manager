//! 全文搜索（规格 §18）：SQLite FTS5 + 结构化筛选，目标 100 万条消息 < 300ms。

use rusqlite::{params_from_iter, ToSql};

use crate::error::Result;
use crate::storage::db::Database;
use crate::storage::sessions::SessionFilter;

/// 搜索排序方式。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
#[derive(Default)]
pub enum SearchOrder {
    /// 相关度（bm25）
    #[default]
    Relevance,
    /// 时间倒序
    Recent,
}

/// 搜索请求。
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SearchQuery {
    /// 关键词（自然语言，内部会安全转换成 FTS5 查询）
    pub text: String,
    pub filter: SessionFilter,
    pub order: SearchOrder,
    /// 仅搜索用户 / 助手正文（排除工具输出与事件）
    pub messages_only: bool,
    pub limit: i64,
    pub offset: i64,
}

/// 单条命中。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub session_id: String,
    pub message_id: String,
    pub sequence: i64,
    pub role: String,
    pub kind: String,
    pub timestamp: Option<String>,
    /// 带高亮标记的上下文片段（默认 `<mark>`）
    pub snippet: String,
    /// bm25 相关度（越小越相关，取负值后越大越相关）
    pub score: f64,
    // 会话补充信息：搜索结果里直接展示，避免再查一次
    pub title: Option<String>,
    pub project_path: Option<String>,
    pub source: String,
    pub machine_id: Option<String>,
    pub session_updated_at: Option<String>,
}

/// 搜索响应。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResponse {
    pub hits: Vec<SearchHit>,
    /// 是否还有更多结果（用于「加载更多」）
    pub has_more: bool,
    pub took_ms: u64,
    /// 实际执行的 FTS5 查询（便于排查「为什么搜不到」）
    pub match_query: String,
}

/// 把用户输入转换成安全的 FTS5 MATCH 表达式。
///
/// 规则：
/// - 按空白切词，每个词用双引号包裹（内部引号翻倍转义），避免 FTS5 语法错误；
/// - 最后一个词追加 `*` 做前缀匹配（边打边搜体验）；
/// - 词之间是隐式 AND，符合「关键词搜索」直觉。
pub fn build_match_query(input: &str) -> String {
    let mut tokens: Vec<String> = Vec::new();
    for raw in input.split_whitespace() {
        // 去掉 FTS5 特殊字符，避免 `NEAR(`、`^`、`:` 之类导致语法错误
        let cleaned: String = raw
            .chars()
            .filter(|c| {
                !matches!(
                    c,
                    '"' | '\'' | '(' | ')' | '*' | '^' | ':' | '{' | '}' | '[' | ']'
                )
            })
            .collect();
        if cleaned.is_empty() {
            continue;
        }
        tokens.push(format!("\"{}\"", cleaned.replace('"', "\"\"")));
    }
    if tokens.is_empty() {
        return String::new();
    }
    // 最后一个词做前缀匹配
    if let Some(last) = tokens.last_mut() {
        last.push('*');
    }
    tokens.join(" ")
}

impl Database {
    /// 执行全文搜索。
    pub fn search(&self, query: &SearchQuery) -> Result<SearchResponse> {
        let start = std::time::Instant::now();
        let match_query = build_match_query(&query.text);
        if match_query.is_empty() {
            return Ok(SearchResponse {
                hits: Vec::new(),
                has_more: false,
                took_ms: 0,
                match_query,
            });
        }

        // 动态筛选：只拼接代码内常量列名，用户数据一律走参数绑定
        let mut clauses: Vec<String> = Vec::new();
        let mut bindings: Vec<Box<dyn ToSql>> = Vec::new();
        bindings.push(Box::new(match_query.clone())); // ?1 = MATCH

        if let Some(source) = query.filter.source.as_ref() {
            clauses.push("s.source = ?".to_string());
            bindings.push(Box::new(source.clone()));
        }
        if let Some(project) = query.filter.project_path.as_ref() {
            clauses.push("s.project_path = ?".to_string());
            bindings.push(Box::new(project.clone()));
        }
        if let Some(machine) = query.filter.machine_id.as_ref() {
            clauses.push("s.machine_id = ?".to_string());
            bindings.push(Box::new(machine.clone()));
        }
        if let Some(from) = query.filter.from.as_ref() {
            clauses.push("COALESCE(s.updated_at, s.created_at, '') >= ?".to_string());
            bindings.push(Box::new(from.clone()));
        }
        if let Some(to) = query.filter.to.as_ref() {
            clauses.push("COALESCE(s.updated_at, s.created_at, '') <= ?".to_string());
            bindings.push(Box::new(to.clone()));
        }
        if query.filter.only_archived {
            clauses.push("s.archived = 1".to_string());
        } else if !query.filter.include_archived {
            clauses.push("s.archived = 0".to_string());
        }
        if query.messages_only {
            clauses.push("m.kind = 'message'".to_string());
        }

        let extra = if clauses.is_empty() {
            String::new()
        } else {
            format!(" AND {}", clauses.join(" AND "))
        };
        // 多取一条用于判断 has_more
        let limit = query.limit.clamp(1, 500);
        // 排序：
        // - 相关度用 FTS5 的 `rank` 列（即 bm25），**不要**写成 `ORDER BY bm25(...)` 或它的别名：
        //   实测（100 万条消息 / 20 万命中）`ORDER BY rank` 约 280ms，而 `ORDER BY bm25()` 或别名约 520ms，
        //   因为后者会让 SQLite 无法复用同一次打分结果。
        // - 时间序不需要打分，直接按消息时间排序。
        let order = match query.order {
            SearchOrder::Relevance => "rank ASC",
            SearchOrder::Recent => "COALESCE(m.timestamp, '') DESC",
        };
        let sql = format!(
            "SELECT m.session_id, m.id, m.sequence, m.role, m.kind, m.timestamp,
                    snippet(message_fts, 0, '<mark>', '</mark>', '…', 18) AS snippet,
                    bm25(message_fts) AS score,
                    s.title, s.project_path, s.source, s.machine_id, s.updated_at
             FROM message_fts
             JOIN messages m ON m.rowid = message_fts.rowid
             JOIN sessions s ON s.id = m.session_id
             WHERE message_fts MATCH ?1{extra}
             ORDER BY {order}
             LIMIT ? OFFSET ?"
        );
        bindings.push(Box::new(limit + 1));
        bindings.push(Box::new(query.offset.max(0)));

        let mut hits = self.with_conn(|conn| {
            let mut stmt = conn.prepare_cached(&sql)?;
            let rows = stmt
                .query_map(params_from_iter(bindings.iter()), |r| {
                    Ok(SearchHit {
                        session_id: r.get(0)?,
                        message_id: r.get(1)?,
                        sequence: r.get(2)?,
                        role: r.get(3)?,
                        kind: r.get(4)?,
                        timestamp: r.get(5)?,
                        snippet: r.get::<_, Option<String>>(6)?.unwrap_or_default(),
                        // bm25 越小越相关；取负值让「越大越相关」更符合直觉
                        score: -r.get::<_, f64>(7).unwrap_or(0.0),
                        title: r.get(8)?,
                        project_path: r.get(9)?,
                        source: r.get(10)?,
                        machine_id: r.get(11)?,
                        session_updated_at: r.get(12)?,
                    })
                })?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            Ok(rows)
        })?;

        let has_more = hits.len() as i64 > limit;
        if has_more {
            hits.truncate(limit as usize);
        }
        Ok(SearchResponse {
            hits,
            has_more,
            took_ms: start.elapsed().as_millis() as u64,
            match_query,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fts_查询构造安全() {
        // 普通关键词：全部加引号，最后词前缀匹配
        assert_eq!(build_match_query("lazy deletion"), "\"lazy\" \"deletion\"*");
        // 特殊字符被清理，不会构造出非法 FTS5 语法
        assert_eq!(build_match_query("NEAR(a b)"), "\"NEARa\" \"b\"*");
        assert_eq!(build_match_query("^foo:bar"), "\"foobar\"*");
        // 空白输入返回空串（调用方据此跳过搜索）
        assert_eq!(build_match_query("   "), "");
        // 引号被转义而非报错
        let q = build_match_query("\"quoted\"");
        assert!(q.starts_with('"'));
    }
}
