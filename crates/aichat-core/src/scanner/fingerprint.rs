//! 文件指纹（规格 §9、§22）：**先比 size + mtime，变化后才算 BLAKE3**。
//!
//! 目的：扫描 1w+ 会话时，绝大多数文件都没变，绝不能每次都重新读文件算哈希。

use std::io::Read;
use std::path::Path;

use crate::error::{Error, Result};
use crate::storage::db::FingerprintRow;

/// 读取文件大小与修改时间（纳秒时间戳）。
///
/// 返回 `None` 表示文件不存在或无法读取元信息。
pub fn quick_stat(path: &Path) -> Option<(u64, i64)> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() {
        return None;
    }
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_nanos() as i64)
        .unwrap_or(0);
    Some((meta.len(), mtime))
}

/// 计算文件 BLAKE3（64KB 分块流式读取，内存恒定）。
pub fn hash_file(path: &Path) -> Result<String> {
    let mut file = std::fs::File::open(path).map_err(|e| Error::io(path, e))?;
    let mut hasher = blake3::Hasher::new();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buf).map_err(|e| Error::io(path, e))?;
        if read == 0 {
            break;
        }
        hasher.update(&buf[..read]);
    }
    Ok(hasher.finalize().to_hex().to_string())
}

/// 内存数据哈希（写快照后计算 conversation.jsonl 的内容哈希）。
pub fn hash_bytes(bytes: &[u8]) -> String {
    blake3::hash(bytes).to_hex().to_string()
}

/// 增量判定结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    /// size + mtime 一致：直接跳过（不读文件内容）
    Unchanged,
    /// size / mtime 变了但内容哈希一致（例如被重写但内容相同）：只更新元信息，跳过解析
    SameContent,
    /// 需要重新解析
    Changed,
}

/// 判定某个文件相对上次索引是否需要重新解析。
///
/// `previous`：上次索引留下的指纹（不存在则为新文件）。
/// 返回 `(决策, 最新指纹哈希)`；`Unchanged` 时哈希为 `None`（未计算）。
pub fn decide(
    path: &Path,
    previous: Option<&FingerprintRow>,
) -> Result<(Decision, Option<String>)> {
    let Some((size, mtime)) = quick_stat(path) else {
        return Ok((Decision::Changed, None)); // 调用方会按「文件不存在」处理
    };
    if let Some(prev) = previous {
        if prev.size == size && prev.mtime == mtime {
            return Ok((Decision::Unchanged, None));
        }
    }
    let hash = hash_file(path)?;
    if let Some(prev) = previous {
        if prev.hash.as_deref() == Some(hash.as_str()) {
            return Ok((Decision::SameContent, Some(hash)));
        }
    }
    Ok((Decision::Changed, Some(hash)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn 未变化时不重复计算哈希() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.jsonl");
        let mut f = std::fs::File::create(&path).unwrap();
        writeln!(f, "{{\"type\":\"x\"}}").unwrap();
        drop(f);

        let (size, mtime) = quick_stat(&path).unwrap();
        let prev = FingerprintRow {
            path: path.display().to_string(),
            session_id: "kimi:1".into(),
            role: "primary".into(),
            size,
            mtime,
            hash: Some("deadbeef".into()),
        };
        let (decision, hash) = decide(&path, Some(&prev)).unwrap();
        assert_eq!(decision, Decision::Unchanged);
        assert!(hash.is_none(), "未变化时不应计算哈希");
    }

    #[test]
    fn 内容变化时检测为_changed() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("b.jsonl");
        std::fs::write(&path, "line1\n").unwrap();
        let (size, mtime) = quick_stat(&path).unwrap();
        let prev = FingerprintRow {
            path: path.display().to_string(),
            session_id: "kimi:1".into(),
            role: "primary".into(),
            size,
            mtime,
            hash: Some("old".into()),
        };
        std::fs::write(&path, "line1\nline2\n").unwrap();
        let (decision, hash) = decide(&path, Some(&prev)).unwrap();
        assert_eq!(decision, Decision::Changed);
        assert!(hash.is_some());
    }

    #[test]
    fn 重写但内容相同只更新元信息() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("c.jsonl");
        std::fs::write(&path, "same\n").unwrap();
        let hash_before = hash_file(&path).unwrap();
        let prev = FingerprintRow {
            path: path.display().to_string(),
            session_id: "codex:1".into(),
            role: "primary".into(),
            // 伪造不同的 size/mtime，强制走哈希比较分支
            size: 1,
            mtime: 1,
            hash: Some(hash_before),
        };
        std::fs::write(&path, "same\n").unwrap();
        let (decision, _) = decide(&path, Some(&prev)).unwrap();
        assert_eq!(decision, Decision::SameContent);
    }
}
