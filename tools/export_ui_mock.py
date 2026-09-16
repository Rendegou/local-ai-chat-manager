#!/usr/bin/env python3
"""把演示索引导出成前端截图用的 mock 数据。

思路：截图不应依赖真实桌面窗口——用真实内核（aichat-cli 扫描出来的 SQLite 索引）
导出与 IPC 完全同形的 JSON，前端在浏览器里加载同一份数据，就能得到可复现的截图。

用法：
    python tools/export_ui_mock.py <index-dir> <输出 json>

其中 index-dir 是 `aichat-cli scan --data-dir <dir>` 生成索引的目录。
"""

import io
import json
import os
import sqlite3
import sys


def fetch(conn, sql, params=()):
    conn.row_factory = sqlite3.Row
    return [dict(row) for row in conn.execute(sql, params)]


def main():
    index_dir, out_path = sys.argv[1], sys.argv[2]
    db = os.path.join(index_dir, "index.db")
    conn = sqlite3.connect(db)

    settings = json.load(io.open(os.path.join(index_dir, "settings.json"), encoding="utf-8"))

    # ---- 会话（字段名与 Rust serde 的 camelCase 一致）----
    sessions = []
    for row in fetch(
        conn,
        """select id, source, external_session_id, title, project_path, created_at, updated_at,
                  machine_id, message_count, partial, archived, sync_status, primary_file, content_hash
           from sessions order by coalesce(updated_at, created_at, '') desc""",
    ):
        sessions.append({
            "id": row["id"],
            "source": row["source"],
            "externalId": row["external_session_id"],
            "title": row["title"],
            "projectPath": row["project_path"],
            "createdAt": row["created_at"],
            "updatedAt": row["updated_at"],
            "machineId": row["machine_id"],
            "messageCount": row["message_count"],
            "partial": bool(row["partial"]),
            "archived": bool(row["archived"]),
            "syncStatus": row["sync_status"],
            "primaryFile": row["primary_file"],
            "contentHash": row["content_hash"],
        })

    # ---- 消息（按会话分组，供分页接口切片）----
    messages = {}
    for row in fetch(
        conn,
        """select id, session_id, sequence, role, kind, text, tool_name, timestamp
           from messages order by session_id, sequence""",
    ):
        messages.setdefault(row["session_id"], []).append({
            "id": row["id"],
            "sessionId": row["session_id"],
            "sequence": row["sequence"],
            "role": row["role"],
            "kind": row["kind"],
            "text": row["text"],
            "toolName": row["tool_name"],
            "timestamp": row["timestamp"],
            "raw": None,
        })

    # ---- 项目聚合 ----
    projects = []
    for row in fetch(
        conn,
        """select project_path, count(*) as session_count, max(coalesce(updated_at, created_at)) as last_updated,
                  group_concat(distinct source) as sources
           from sessions where project_path is not null and project_path <> ''
           group by project_path order by last_updated desc""",
    ):
        path = row["project_path"]
        projects.append({
            "projectPath": path,
            "name": path.replace("\\", "/").rstrip("/").split("/")[-1],
            "sessionCount": row["session_count"],
            "lastUpdated": row["last_updated"],
            "sources": (row["sources"] or "").split(",") if row["sources"] else [],
        })

    sources = [{
        "id": r["id"],
        "displayName": r["display_name"],
        "rootPath": r["root_path"],
        "found": bool(r["found"]),
        "sessionHint": r["session_hint"],
        "manual": bool(r["manual"]),
        "notes": r["notes"],
        "detectedAt": r["detected_at"],
    } for r in fetch(conn, "select * from sources order by id")]

    machines = [r["machine_id"] for r in fetch(
        conn, "select distinct machine_id from sessions where machine_id is not null order by machine_id")]

    page_count = conn.execute("pragma page_count").fetchone()[0]
    page_size = conn.execute("pragma page_size").fetchone()[0]
    stats = {
        "sessions": conn.execute("select count(*) from sessions").fetchone()[0],
        "messages": conn.execute("select count(*) from messages").fetchone()[0],
        "archivedSessions": 0,
        "projects": len(projects),
        "bytesOnDisk": page_count * page_size,
    }

    data = {
        "sources": sources,
        "sessions": sessions,
        "messages": messages,
        "projects": projects,
        "machines": machines,
        "stats": stats,
        "settings": settings,
        "dataDir": os.path.abspath(index_dir),
        "machineId": machines[0] if machines else "00000000-0000-0000-0000-000000000000",
        # 正常态：已绑定仓库、有远端、有变更与历史提交
        "syncStatus": {
            "repo": "D:/AIChatRepo",
            "exists": True,
            "isRepo": True,
            "branch": "main",
            "remote": "git@github.com:dev/aichat-history.git",
            "lastPull": "2026-09-16T01:12:00Z",
            "lastPush": "2026-09-16T01:12:04Z",
            "localChanges": 3,
            "incomingChanges": 0,
            "ahead": 1,
            "behind": 0,
            "pendingSessions": 2,
            "conflict": None,
            "gitVersion": "git version 2.48.1.windows.1",
            "changes": [
                {"path": "kimi/9f21.../ses_4c1e/conversation.jsonl", "index": "M", "worktree": " "},
                {"path": "kimi/9f21.../ses_4c1e/meta.json", "index": "M", "worktree": " "},
                {"path": "codex/9f21.../01a0.../conversation.jsonl", "index": "A", "worktree": " "},
            ],
            "recentCommits": [
                "9d1c4f7 sync: dev-desktop 2026-09-16T01:12:04+08:00",
                "1f77a02 sync: dev-desktop 2026-09-15T22:41:18+08:00",
                "04c2b8e sync: laptop 2026-09-15T19:30:02+08:00",
            ],
            "error": None,
        },
        # 空/错误态：还没配置仓库
        "syncStatusUnset": {
            "repo": None, "exists": False, "isRepo": False, "branch": "", "remote": None,
            "lastPull": None, "lastPush": None, "localChanges": 0, "incomingChanges": 0,
            "ahead": 0, "behind": 0, "pendingSessions": 0, "conflict": None,
            "gitVersion": None, "changes": [], "recentCommits": [],
            "error": "尚未配置同步仓库目录",
        },
        # 冲突态（用于演示 §14 的冲突卡片）
        "syncStatusConflict": {
            "repo": "D:/AIChatRepo", "exists": True, "isRepo": True, "branch": "main",
            "remote": "git@github.com:dev/aichat-history.git",
            "lastPull": "2026-09-16T00:58:00Z", "lastPush": "2026-09-15T22:41:20Z",
            "localChanges": 1, "incomingChanges": 1, "ahead": 1, "behind": 1, "pendingSessions": 1,
            "conflict": {
                "inRebase": True,
                "files": ["kimi/9f21.../ses_4c1e/conversation.jsonl"],
                "message": "git pull --rebase 遇到冲突（1 个文件），已暂停 rebase",
                "stdout": "", "stderr": "CONFLICT (content): Merge conflict in kimi/.../conversation.jsonl",
            },
            "gitVersion": "git version 2.48.1.windows.1",
            "changes": [{"path": "kimi/9f21.../ses_4c1e/conversation.jsonl", "index": "U", "worktree": "U"}],
            "recentCommits": ["9d1c4f7 sync: dev-desktop 2026-09-16T01:12:04+08:00"],
            "error": None,
        },
        "archives": [
            {"relPath": "archives/kimi/9f21.../ses_0aa1.tar.zst", "source": "kimi", "machineId": "9f21e0c4-3a55-4c0e-9b1a-2f2f6d0a11c3",
             "sessionId": "ses_0aa1", "sizeBytes": 184320, "createdAt": "2026-09-14T10:02:00Z", "compression": "zstd",
             "title": "旧版配置迁移调研"},
            {"relPath": "archives/codex/9f21.../01a05c65.tar.zst", "source": "codex", "machineId": "9f21e0c4-3a55-4c0e-9b1a-2f2f6d0a11c3",
             "sessionId": "01a05c65-b254-7a20-b8ca-768f92965e04", "sizeBytes": 96256, "createdAt": "2026-09-11T18:30:00Z",
             "compression": "zstd", "title": "Q2 数据导出脚本"},
        ],
        "gitLog": "9d1c4f7 2026-09-16 sync: dev-desktop 2026-09-16T01:12:04+08:00\n"
                  "1f77a02 2026-09-15 sync: dev-desktop 2026-09-15T22:41:18+08:00\n"
                  "04c2b8e 2026-09-15 sync: laptop 2026-09-15T19:30:02+08:00",
    }

    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    io.open(out_path, "w", encoding="utf-8").write(json.dumps(data, ensure_ascii=False))
    print("mock 数据已导出：%s（会话 %d，消息 %d，项目 %d）"
          % (out_path, len(sessions), stats["messages"], len(projects)))


if __name__ == "__main__":
    main()
