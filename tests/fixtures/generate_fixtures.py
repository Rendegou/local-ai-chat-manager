#!/usr/bin/env python3
"""生成测试 fixtures（合成数据，绝不含真实 token / 路径 / 用户数据）。

用法：
    python tests/fixtures/generate_fixtures.py

生成内容（对应规格 §25）：
    tests/fixtures/kimi/normal          正常会话（含凭证目录，用于隐私红线测试）
    tests/fixtures/kimi/malformed-line  含损坏 JSON 行
    tests/fixtures/kimi/subagents       含子 Agent 的会话
    tests/fixtures/codex/normal         正常 rollout（含重复事件）
    tests/fixtures/codex/unknown-event  未知事件类型 + 损坏行
"""

import io
import json
import os

ROOT = os.path.dirname(os.path.abspath(__file__))


def write(rel_path, content):
    """写入 fixture 文件（统一 UTF-8 + LF，保证跨平台测试结果一致）。"""
    path = os.path.join(ROOT, rel_path)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with io.open(path, "w", encoding="utf-8", newline="\n") as handle:
        handle.write(content)
    print("wrote", rel_path)


def jsonl(rows):
    """把对象列表序列化为 JSONL 文本。"""
    return "\n".join(json.dumps(row, ensure_ascii=False) for row in rows) + "\n"


# --------------------------------------------------------------------------- #
# Kimi：正常会话
# --------------------------------------------------------------------------- #
KIMI_SID = "ses_11111111-1111-1111-1111-111111111111"
KIMI_BASE = "kimi/normal"

write(
    f"{KIMI_BASE}/session_index.jsonl",
    jsonl([
        {
            "sessionId": KIMI_SID,
            "sessionDir": f"/home/user/.kimi-code/sessions/wd_demo-project_0123456789ab/{KIMI_SID}",
            "workDir": "/home/user/projects/demo-project",
        }
    ]),
)

write(
    f"{KIMI_BASE}/sessions/wd_demo-project_0123456789ab/{KIMI_SID}/state.json",
    json.dumps(
        {
            "id": KIMI_SID,
            "version": 1,
            "cwd": "/home/user/projects/demo-project",
            "createdAt": 1757937000000,
            "updatedAt": 1757937600000,
            "archived": False,
            "title": "实现 Redis TTL lazy deletion",
            "titleKind": "auto",
            "lastTurnReason": "completed",
            "isCustomTitle": False,
            "agents": {"main": {"homedir": "/home/user", "type": "main"}},
            "lastPrompt": "(fixture 不保留用户原文)",
        },
        ensure_ascii=False,
        indent=1,
    )
    + "\n",
)

# 凭证目录：Adapter 与快照都必须跳过（规格 §16）
write(f"{KIMI_BASE}/credentials/token.json", '{"access_token": "REDACTED-FIXTURE-TOKEN"}\n')

write(
    f"{KIMI_BASE}/sessions/wd_demo-project_0123456789ab/{KIMI_SID}/agents/main/wire.jsonl",
    jsonl([
        {"type": "metadata", "protocol_version": 1, "created_at": "2026-09-15T10:00:00Z"},
        {"type": "profile.bind", "agentId": "main", "modelAlias": "kimi-k2", "profileName": "default"},
        {
            "type": "prompt.accepted",
            "agentId": "main",
            "promptId": "p1",
            "content": "帮我看看 Redis TTL lazy deletion 有没有问题",
            "time": "2026-09-15T10:00:01Z",
        },
        # 同一条用户输入的第二次记录：promptId 相同，必须去重
        {
            "type": "turn.prompt",
            "agentId": "main",
            "input": "帮我看看 Redis TTL lazy deletion 有没有问题",
            "origin": "user",
            "promptId": "p1",
            "time": "2026-09-15T10:00:01Z",
        },
        {
            "type": "context.append_loop_event",
            "agentId": "main",
            "time": "2026-09-15T10:00:02Z",
            "event": {"type": "step.begin", "uuid": "u1", "turnId": "t1", "step": 1},
        },
        {
            "type": "context.append_loop_event",
            "agentId": "main",
            "time": "2026-09-15T10:00:02Z",
            "event": {
                "type": "content.part",
                "uuid": "u2",
                "turnId": "t1",
                "step": 1,
                "stepUuid": "s1",
                "part": {"type": "think", "text": "先确认 TTL 的续期时机"},
            },
        },
        {
            "type": "context.append_loop_event",
            "agentId": "main",
            "time": "2026-09-15T10:00:03Z",
            "event": {
                "type": "content.part",
                "uuid": "u3",
                "turnId": "t1",
                "step": 1,
                "stepUuid": "s1",
                "part": {"type": "text", "text": "我看了 Redisson 的 watchdog 逻辑："},
            },
        },
        {
            "type": "context.append_loop_event",
            "agentId": "main",
            "time": "2026-09-15T10:00:03Z",
            "event": {
                "type": "content.part",
                "uuid": "u4",
                "turnId": "t1",
                "step": 1,
                "stepUuid": "s1",
                "part": {"type": "text", "text": "续期失败会让 key 被 lazy deletion 提前删除。"},
            },
        },
        {
            "type": "context.append_loop_event",
            "agentId": "main",
            "time": "2026-09-15T10:00:04Z",
            "event": {
                "type": "tool.call",
                "uuid": "u5",
                "turnId": "t1",
                "step": 1,
                "stepUuid": "s1",
                "toolCallId": "call_1",
                "name": "read_file",
                "args": {"path": "/home/user/projects/demo-project/src/cache.rs"},
            },
        },
        {
            "type": "context.append_loop_event",
            "agentId": "main",
            "time": "2026-09-15T10:00:05Z",
            "event": {
                "type": "tool.result",
                "parentUuid": "u5",
                "toolCallId": "call_1",
                "result": {"content": [{"type": "text", "text": "fn renew(&self) { /* ... */ }"}]},
            },
        },
        {
            "type": "context.append_loop_event",
            "agentId": "main",
            "time": "2026-09-15T10:00:06Z",
            "event": {"type": "step.end", "uuid": "u6", "turnId": "t1", "step": 1, "finishReason": "stop"},
        },
        {
            "type": "context.append_message",
            "agentId": "main",
            "time": "2026-09-15T10:00:07Z",
            "message": {
                "role": "user",
                "id": "m1",
                "origin": "user",
                "content": [{"type": "text", "text": "按 10 秒续期改一下"}],
            },
        },
        {"type": "usage.record", "agentId": "main", "model": "kimi-k2", "usage": {"input": 1200, "output": 300}},
        {"type": "token_counting.measured", "agentId": "main", "length": 1500, "tokens": 640},
        # 未知事件：必须计数并标记 partial，而不是静默丢弃
        {"type": "brand.new.event", "agentId": "main", "payload": {"x": 1}, "time": "2026-09-15T10:00:08Z"},
        {"type": "turn.ended", "agentId": "main", "turnId": "t1", "reason": "completed", "durationMs": 8000},
    ]),
)

# --------------------------------------------------------------------------- #
# Kimi：损坏行
# --------------------------------------------------------------------------- #
KIMI_BROKEN_SID = "ses_22222222-2222-2222-2222-222222222222"
KIMI_BROKEN_BASE = "kimi/malformed-line"

write(
    f"{KIMI_BROKEN_BASE}/sessions/wd_broken_abcdefabcdef/{KIMI_BROKEN_SID}/state.json",
    json.dumps(
        {
            "id": KIMI_BROKEN_SID,
            "version": 1,
            "cwd": "/home/user/projects/broken",
            "createdAt": 1757937000000,
            "updatedAt": 1757937600000,
            "title": "包含损坏行",
            "agents": {"main": {"type": "main"}},
        },
        ensure_ascii=False,
    )
    + "\n",
)

write(
    f"{KIMI_BROKEN_BASE}/sessions/wd_broken_abcdefabcdef/{KIMI_BROKEN_SID}/agents/main/wire.jsonl",
    json.dumps(
        {"type": "prompt.accepted", "agentId": "main", "promptId": "p1", "content": "第一句正常内容"},
        ensure_ascii=False,
    )
    + "\n"
    + '{"type": "prompt.accepted", "agentId": "main", "content": "这一行缺少右括号"\n'
    + json.dumps(
        {"type": "prompt.accepted", "agentId": "main", "promptId": "p2", "content": "第二句正常内容"},
        ensure_ascii=False,
    )
    + "\n",
)

# --------------------------------------------------------------------------- #
# Kimi：子 Agent
# --------------------------------------------------------------------------- #
KIMI_SUB_SID = "ses_33333333-3333-3333-3333-333333333333"
KIMI_SUB_BASE = "kimi/subagents"

write(
    f"{KIMI_SUB_BASE}/sessions/wd_multi-agent_0f0f0f0f0f0f/{KIMI_SUB_SID}/state.json",
    json.dumps(
        {
            "id": KIMI_SUB_SID,
            "version": 1,
            "cwd": "/home/user/projects/multi-agent",
            "createdAt": 1757937000000,
            "updatedAt": 1757937600000,
            "title": "带子 Agent 的会话",
            "agents": {"main": {"type": "main"}, "agent-abc": {"type": "sub"}},
        },
        ensure_ascii=False,
    )
    + "\n",
)

write(
    f"{KIMI_SUB_BASE}/sessions/wd_multi-agent_0f0f0f0f0f0f/{KIMI_SUB_SID}/agents/main/wire.jsonl",
    json.dumps(
        {"type": "prompt.accepted", "agentId": "main", "promptId": "p1", "content": "主 Agent 的问题"},
        ensure_ascii=False,
    )
    + "\n",
)

write(
    f"{KIMI_SUB_BASE}/sessions/wd_multi-agent_0f0f0f0f0f0f/{KIMI_SUB_SID}/agents/agent-abc/wire.jsonl",
    json.dumps(
        {"type": "prompt.accepted", "agentId": "agent-abc", "promptId": "s1", "content": "子 Agent 内容"},
        ensure_ascii=False,
    )
    + "\n",
)

# --------------------------------------------------------------------------- #
# Codex：正常 rollout
# --------------------------------------------------------------------------- #
CODEX_THREAD = "019d7b0d-8791-7181-951f-7b0b9c0a6ba7"
CODEX_BASE = "codex/normal"

write(
    f"{CODEX_BASE}/session_index.jsonl",
    jsonl([{"id": CODEX_THREAD, "thread_name": "RESP parser 实现", "updated_at": "2026-09-15T13:00:07Z"}]),
)

write(
    f"{CODEX_BASE}/sessions/2026/09/15/rollout-2026-09-15T13-00-00-{CODEX_THREAD}.jsonl",
    jsonl([
        {
            "timestamp": "2026-09-15T13:00:00.000000Z",
            "ordinal": 0,
            "type": "session_meta",
            "payload": {
                "session_id": CODEX_THREAD,
                "id": CODEX_THREAD,
                "timestamp": "2026-09-15T13:00:00Z",
                "cwd": "/home/user/projects/resp-parser",
                "originator": "codex_cli",
                "cli_version": "0.42.0",
                "model_provider": "openai",
                "history_mode": "full",
                "git": {"branch": "main", "commit_hash": "abc1234"},
                "base_instructions": "(fixture 省略，真实文件里可能很大)",
            },
        },
        {
            "timestamp": "2026-09-15T13:00:01.000000Z",
            "ordinal": 1,
            "type": "turn_context",
            "payload": {
                "turn_id": "turn-1",
                "cwd": "/home/user/projects/resp-parser",
                "model": "gpt-5-codex",
                "approval_policy": "on-request",
                "workspace_roots": ["/home/user/projects/resp-parser"],
            },
        },
        {
            "timestamp": "2026-09-15T13:00:02.000000Z",
            "ordinal": 2,
            "type": "event_msg",
            "payload": {"type": "task_started", "turn_id": "turn-1", "started_at": 1757936402},
        },
        {
            "timestamp": "2026-09-15T13:00:03.000000Z",
            "ordinal": 3,
            "type": "response_item",
            "payload": {
                "type": "message",
                "id": "msg-user-1",
                "role": "user",
                "content": [{"type": "input_text", "text": "把 RESP parser 的 tokenizer 写出来"}],
            },
        },
        # event_msg 中的同一条用户消息：必须去重
        {
            "timestamp": "2026-09-15T13:00:03.500000Z",
            "ordinal": 4,
            "type": "event_msg",
            "payload": {"type": "user_message", "message": "把 RESP parser 的 tokenizer 写出来"},
        },
        {
            "timestamp": "2026-09-15T13:00:04.000000Z",
            "ordinal": 5,
            "type": "response_item",
            "payload": {
                "type": "reasoning",
                "id": "rs-1",
                "summary": [{"type": "summary_text", "text": "先定义 token 类型，再处理 * $ + - :"}],
                "encrypted_content": "(fixture 省略)",
            },
        },
        {
            "timestamp": "2026-09-15T13:00:05.000000Z",
            "ordinal": 6,
            "type": "response_item",
            "payload": {
                "type": "function_call",
                "id": "fc-1",
                "call_id": "call-1",
                "name": "shell",
                "arguments": "{\"command\":[\"ls\",\"src\"]}",
            },
        },
        {
            "timestamp": "2026-09-15T13:00:06.000000Z",
            "ordinal": 7,
            "type": "response_item",
            "payload": {
                "type": "function_call_output",
                "id": "fco-1",
                "call_id": "call-1",
                "output": "main.rs\nparser.rs",
            },
        },
        {
            "timestamp": "2026-09-15T13:00:07.000000Z",
            "ordinal": 8,
            "type": "response_item",
            "payload": {
                "type": "message",
                "id": "msg-a-1",
                "role": "assistant",
                "content": [{"type": "output_text", "text": "tokenizer 已经写好，支持 RESP3 的 blob 类型。"}],
            },
        },
        {
            "timestamp": "2026-09-15T13:00:07.500000Z",
            "ordinal": 9,
            "type": "event_msg",
            "payload": {"type": "agent_message", "message": "tokenizer 已经写好，支持 RESP3 的 blob 类型。"},
        },
        {
            "timestamp": "2026-09-15T13:00:08.000000Z",
            "ordinal": 10,
            "type": "event_msg",
            "payload": {"type": "token_count", "info": {"total_tokens": 2048}},
        },
        {
            "timestamp": "2026-09-15T13:00:08.500000Z",
            "ordinal": 11,
            "type": "world_state",
            "payload": {"full": True, "state": {"cwd": "/home/user/projects/resp-parser"}},
        },
        {
            "timestamp": "2026-09-15T13:00:09.000000Z",
            "ordinal": 12,
            "type": "event_msg",
            "payload": {"type": "task_complete", "turn_id": "turn-1", "duration_ms": 7000},
        },
    ]),
)

# --------------------------------------------------------------------------- #
# Codex：未知事件 + 损坏行
# --------------------------------------------------------------------------- #
CODEX_OLD = "01a05c65-b254-7a20-b8ca-768f92965e04"
CODEX_OLD_BASE = "codex/unknown-event"

write(
    f"{CODEX_OLD_BASE}/sessions/2026/09/14/rollout-2026-09-14T09-00-00-{CODEX_OLD}.jsonl",
    json.dumps(
        {
            "timestamp": "2026-09-14T09:00:00.000000Z",
            "ordinal": 0,
            "type": "session_meta",
            "payload": {"session_id": CODEX_OLD, "cwd": "/home/user/projects/legacy", "cli_version": "0.9.0"},
        },
        ensure_ascii=False,
    )
    + "\n"
    + '{"timestamp": "2026-09-14T09:00:01.000000Z", "ordinal": 1, "type": "response_item"\n'
    + json.dumps(
        {
            "timestamp": "2026-09-14T09:00:02.000000Z",
            "ordinal": 2,
            "type": "response_item",
            "payload": {
                "type": "message",
                "id": "m1",
                "role": "user",
                "content": [{"type": "input_text", "text": "旧版本 schema 的会话"}],
            },
        },
        ensure_ascii=False,
    )
    + "\n"
    + json.dumps(
        {"timestamp": "2026-09-14T09:00:03.000000Z", "ordinal": 3, "type": "future_event_type", "payload": {"hello": "world"}},
        ensure_ascii=False,
    )
    + "\n"
    + json.dumps(
        {
            "timestamp": "2026-09-14T09:00:04.000000Z",
            "ordinal": 4,
            "type": "response_item",
            "payload": {
                "type": "message",
                "id": "m2",
                "role": "assistant",
                "content": [{"type": "output_text", "text": "仍然能读到这条回答。"}],
            },
        },
        ensure_ascii=False,
    )
    + "\n",
)

print("fixtures 生成完成")
