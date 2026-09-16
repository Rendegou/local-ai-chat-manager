#!/usr/bin/env python3
"""生成演示数据：用于截图、试用与文档配图。

全部内容均为**合成数据**（假项目名、假代码、假命令输出），不含任何真实会话。

用法：
    python tools/make_demo_data.py <输出目录> [--sessions 22] [--days 9]

生成的目录结构就是 Codex / Kimi 的真实布局，可直接在应用里把两个数据源指过去：

    <输出目录>/codex-home/{session_index.jsonl, sessions/YYYY/MM/DD/rollout-*.jsonl}
    <输出目录>/kimi-home/{session_index.jsonl, sessions/<workDirKey>/<sessionId>/{state.json, agents/main/wire.jsonl}}
"""

import argparse
import hashlib
import io
import json
import os
import random
import uuid
from datetime import datetime, timedelta, timezone

# 演示用的项目（均为虚构）
PROJECTS = [
    ("redis-go", "/home/dev/projects/redis-go"),
    ("web-dashboard", "/home/dev/work/web-dashboard"),
    ("thesis-parser", "/home/dev/study/thesis-parser"),
    ("blog-engine", "/home/dev/projects/blog-engine"),
]

# 会话标题 + 与标题匹配的对话内容（英文标识符 + 少量中文说明，贴近真实开发者习惯）
TOPICS = [
    (
        "实现 RESP3 协议解析器",
        [
            ("user", "帮我把 RESP3 的解析器补完，先支持 simple string、error、integer、bulk string 和 array。"),
            ("assistant", "先确认几件事：\n1. inline command（不带 * 前缀）要不要支持？\n2. bulk string 的长度前缀用 i64 还是 usize？"),
            ("user", "inline 先不做。长度用 i64，方便表示 -1 的空值语义。"),
            ("tool", "cargo test parser::resp3 -- --nocapture"),
            ("tool_result", "running 12 tests\ntest parser::resp3::simple_string ... ok\ntest parser::resp3::bulk_string ... ok\ntest parser::resp3::null_bulk ... ok\n\ntest result: ok. 12 passed"),
            ("assistant", "解析器已通过 12 个用例。关键点：\n- `read_line` 用 `read_until(b'\\r\\n')` 复用缓冲区，避免逐 token 分配\n- `-1` 长度返回 `None`，与 Redis 的空值语义对齐\n- 剩余字节留在缓冲区里，支持粘包场景"),
        ],
    ),
    (
        "Redis watchdog 续期失败排查",
        [
            ("user", "线上偶发 key 提前过期，怀疑是 watchdog 续期失败，帮我看下日志和时间线。"),
            ("assistant", "从日志看每次失败前都有一次 `Connection reset by peer`。续期是异步线程发起的，连接池被占满时会超时，导致 TTL 没有被刷新。"),
            ("tool", "grep -n \"renew\" src/cache/watcher.rs | head -20"),
            ("tool_result", "42:    pub fn renew(&self, key: &str) -> Result<()> {\n57:        let ttl = self.config.renew_interval * 3;"),
            ("assistant", "建议做两点改动：\n1. `renew_interval` 与 `lock_lease_time` 解耦，按 TTL/3 计算续期时机\n2. 续期失败记录指标并重试一次，避免静默失败"),
            ("user", "按这个改，顺便加上指标。"),
        ],
    ),
    (
        "给会话列表加虚拟滚动",
        [
            ("user", "会话列表在 1 万条时滚动很卡，帮我换成虚拟列表。"),
            ("assistant", "改成只渲染可视区 + overscan：\n- 固定行高时直接用滚动位置算下标\n- 变高列表用估算高度 + ResizeObserver 回填真实高度"),
            ("tool", "npm run test -- virtual-list"),
            ("tool_result", "PASS src/hooks/useVirtual.test.ts\n  ✓ 只渲染可视区\n  ✓ 变高行测量后位置正确\n\nTests: 6 passed"),
        ],
    ),
    (
        "整理第三章实验数据",
        [
            ("user", "把 bench 结果整理成表格，按 QPS 和 p99 两列排。"),
            ("assistant", "整理好了，按 QPS 降序排列（数据见下），另外补了一列内存占用便于对比。"),
            ("tool", "sqlite3 bench.db \"select name, qps, p99_ms from results order by qps desc\""),
            ("tool_result", "redis\t128000\t0.8\nmemcached\t96000\t1.2\nlocal-cache\t74000\t0.4"),
        ],
    ),
    (
        "文章详情页 SEO 元信息",
        [
            ("user", "文章页要支持自定义 title/description，还有 og:image，帮我加上。"),
            ("assistant", "在 front matter 里加了 `seo` 字段，回退顺序是：seo.title → title → 站点名。og:image 支持相对路径，构建时转成绝对 URL。"),
        ],
    ),
    (
        "把配置项收敛到 settings.toml",
        [
            ("user", "现在配置散在 env 和配置文件两处，统一到 settings.toml 吧。"),
            ("assistant", "统一后优先级定为：命令行 > 环境变量 > settings.toml > 默认值，并且启动时打印一次生效配置（隐藏敏感值）。"),
        ],
    ),
    (
        "分页查询的 COUNT 优化",
        [
            ("user", "列表页的 count 查询很慢，2 秒以上。"),
            ("assistant", "改成覆盖索引扫描即可：`select count(*) from t where (created_at, id) > (?, ?)` 走 `(created_at, id)` 复合索引，避免回表。"),
            ("tool", "EXPLAIN QUERY PLAN select count(*) from articles where created_at > '2026-01-01'"),
            ("tool_result", "SEARCH articles USING COVERING INDEX idx_articles_created_id (created_at>?)"),
        ],
    ),
    (
        "补充集成测试",
        [
            ("user", "给同步流程加一个集成测试，覆盖两边都有新提交的情况。"),
            ("assistant", "测试里建了两个仓库加一个裸仓库，验证「A 提交并推送 → B 拉取后能看到」以及冲突时不自动合并。"),
        ],
    ),
]

RANDOM_COMMANDS = [
    ("cargo clippy --all-targets", "Finished `dev` profile in 2.1s\n0 warnings"),
    ("cargo fmt --check", "(no output)"),
    ("git status --porcelain", " M src/parser.rs\n?? src/tests/"),
    ("ls -la src", "total 48\ndrwxr-xr-x  parser\n-rw-r--r--  main.rs"),
]


def iso(dt):
    """RFC3339 时间字符串（与 Codex rollout 的格式一致）。"""
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f") + "Z"


def write(path, content):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with io.open(path, "w", encoding="utf-8", newline="\n") as handle:
        handle.write(content)


def jsonl(rows):
    return "\n".join(json.dumps(row, ensure_ascii=False) for row in rows) + "\n"


def codex_session(root, thread, title, project, when, topic):
    """写一个 Codex rollout 文件（结构与本机真实文件一致）。"""
    lines = []
    ordinal = 0

    def push(kind, payload, ts):
        nonlocal ordinal
        lines.append({"timestamp": iso(ts), "ordinal": ordinal, "type": kind, "payload": payload})
        ordinal += 1

    push(
        "session_meta",
        {
            "session_id": thread,
            "id": thread,
            "timestamp": iso(when),
            "cwd": project,
            "originator": "codex_cli",
            "cli_version": "0.42.0",
            "model_provider": "openai",
            "history_mode": "full",
            "git": {"branch": "main", "commit_hash": hashlib.sha1(thread.encode()).hexdigest()[:7]},
        },
        when,
    )
    push("turn_context", {"turn_id": "turn-1", "cwd": project, "model": "gpt-5-codex", "approval_policy": "on-request"}, when)
    cursor = when
    for role, text in topic:
        cursor += timedelta(seconds=random.randint(20, 90))
        if role == "user":
            push("response_item", {"type": "message", "id": f"msg-{ordinal}", "role": "user",
                                   "content": [{"type": "input_text", "text": text}]}, cursor)
        elif role == "assistant":
            push("response_item", {"type": "reasoning", "id": f"rs-{ordinal}",
                                   "summary": [{"type": "summary_text", "text": "先确认接口约束，再看实现细节"}]}, cursor)
            push("response_item", {"type": "message", "id": f"msg-{ordinal}", "role": "assistant",
                                   "content": [{"type": "output_text", "text": text}]}, cursor)
        elif role == "tool":
            push("response_item", {"type": "function_call", "id": f"fc-{ordinal}", "call_id": f"call-{ordinal}",
                                   "name": "shell", "arguments": json.dumps({"command": text.split()}, ensure_ascii=False)}, cursor)
        elif role == "tool_result":
            push("response_item", {"type": "function_call_output", "id": f"fco-{ordinal}",
                                   "call_id": f"call-{ordinal}", "output": text}, cursor)
    push("event_msg", {"type": "task_complete", "turn_id": "turn-1", "duration_ms": 42_000}, cursor)

    day = when.strftime("%Y/%m/%d")
    rel = f"sessions/{day}/rollout-{when.strftime('%Y-%m-%dT%H-%M-%S')}-{thread}.jsonl"
    write(os.path.join(root, rel), jsonl(lines))
    return cursor


def kimi_session(root, session_id, title, project, when, topic):
    """写一个 Kimi 会话目录（state.json + agents/main/wire.jsonl）。"""
    workdir_key = "wd_" + os.path.basename(project).replace(".", "-") + "_" + hashlib.sha1(project.encode()).hexdigest()[:12]
    session_dir = os.path.join(root, "sessions", workdir_key, session_id)
    created_ms = int(when.timestamp() * 1000)

    cursor = when
    lines = [{"type": "metadata", "protocol_version": 1, "created_at": iso(when)}]
    for role, text in topic:
        cursor += timedelta(seconds=random.randint(20, 90))
        if role == "user":
            lines.append({"type": "prompt.accepted", "agentId": "main", "promptId": f"p{len(lines)}",
                          "content": text, "time": iso(cursor)})
        elif role == "assistant":
            lines.append({"type": "context.append_loop_event", "agentId": "main", "time": iso(cursor),
                          "event": {"type": "content.part", "uuid": uuid.uuid4().hex[:8], "turnId": "t1",
                                    "step": len(lines), "stepUuid": f"s{len(lines)}",
                                    "part": {"type": "think", "text": "先梳理约束，再给方案"}}})
            lines.append({"type": "context.append_loop_event", "agentId": "main", "time": iso(cursor),
                          "event": {"type": "content.part", "uuid": uuid.uuid4().hex[:8], "turnId": "t1",
                                    "step": len(lines), "stepUuid": f"s{len(lines)}",
                                    "part": {"type": "text", "text": text}}})
        elif role == "tool":
            lines.append({"type": "context.append_loop_event", "agentId": "main", "time": iso(cursor),
                          "event": {"type": "tool.call", "uuid": uuid.uuid4().hex[:8], "turnId": "t1",
                                    "step": len(lines), "stepUuid": f"s{len(lines)}",
                                    "toolCallId": f"call{len(lines)}", "name": "shell",
                                    "args": {"command": text.split()}}})
        elif role == "tool_result":
            lines.append({"type": "context.append_loop_event", "agentId": "main", "time": iso(cursor),
                          "event": {"type": "tool.result", "parentUuid": uuid.uuid4().hex[:8],
                                    "toolCallId": f"call{len(lines)}", "result": {"content": [{"type": "text", "text": text}]}}})
    lines.append({"type": "turn.ended", "agentId": "main", "turnId": "t1", "reason": "completed",
                  "durationMs": 38_000, "time": iso(cursor)})

    write(os.path.join(session_dir, "state.json"), json.dumps({
        "id": session_id, "version": 1, "cwd": project,
        "createdAt": created_ms, "updatedAt": int(cursor.timestamp() * 1000),
        "archived": False, "title": title, "titleKind": "auto",
        "lastTurnReason": "completed", "isCustomTitle": False,
        "agents": {"main": {"homedir": "/home/dev", "type": "main"}},
    }, ensure_ascii=False, indent=1) + "\n")
    write(os.path.join(session_dir, "agents", "main", "wire.jsonl"), jsonl(lines))
    return cursor, session_id, workdir_key


def main():
    parser = argparse.ArgumentParser(description="生成演示数据（合成，用于截图与试用）")
    parser.add_argument("out", help="输出目录")
    parser.add_argument("--sessions", type=int, default=22, help="会话总数（默认 22）")
    parser.add_argument("--days", type=int, default=9, help="时间跨度天数（默认 9）")
    parser.add_argument("--seed", type=int, default=20260916, help="随机种子（保证可复现）")
    args = parser.parse_args()

    random.seed(args.seed)
    codex_root = os.path.join(args.out, "codex-home")
    kimi_root = os.path.join(args.out, "kimi-home")
    now = datetime.now(timezone.utc).replace(microsecond=0)

    codex_index, kimi_index = [], []
    newest = None  # 最新的一条会话（截图里默认选中的那条）

    for i in range(args.sessions):
        project_name, project = PROJECTS[i % len(PROJECTS)]
        title, topic = TOPICS[i % len(TOPICS)]
        # 时间：越靠后的会话越旧，保证列表里按时间倒序自然分组
        when = now - timedelta(days=(i * args.days) // max(args.sessions, 1), hours=random.randint(0, 6),
                               minutes=random.randint(0, 59))
        if i % 2 == 0:
            thread = str(uuid.uuid4())
            updated = codex_session(codex_root, thread, title, project, when, topic)
            codex_index.append({"id": thread, "thread_name": f"{title}", "updated_at": iso(updated)})
            entry = ("codex", project, title, updated)
        else:
            session_id = "ses_" + str(uuid.uuid4())
            updated, session_id, _ = kimi_session(kimi_root, session_id, title, project, when, topic)
            kimi_index.append({"sessionId": session_id,
                               "sessionDir": os.path.join(kimi_root, "sessions", project_name, session_id),
                               "workDir": project})
            entry = ("kimi", project, title, updated)
        if newest is None or updated > newest[3]:
            newest = entry

    # Codex 的标题索引（应用会读它来显示标题）
    if codex_index:
        write(os.path.join(codex_root, "session_index.jsonl"), jsonl(codex_index))
    # Kimi 的会话索引
    if kimi_index:
        write(os.path.join(kimi_root, "session_index.jsonl"), jsonl(kimi_index))

    print("演示数据已生成：")
    print(f"  Codex 数据源：{codex_root}")
    print(f"  Kimi  数据源：{kimi_root}")
    print(f"  会话数：{args.sessions}（Codex {len(codex_index)} / Kimi {len(kimi_index)}）")
    print(f"  最新会话：{newest[2]}（{newest[0]} @ {newest[1]}）")


if __name__ == "__main__":
    main()
