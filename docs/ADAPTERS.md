# Adapter 说明

Adapter 负责把各家 AI CLI 的本地文件翻译成统一模型（`NormalizedSession` / `NormalizedMessage`），
UI 与索引层完全看不到原始文件结构。

统一接口（`crates/aichat-core/src/adapters/mod.rs`）：

```rust
trait ConversationAdapter {
    fn id(&self) -> &'static str;
    fn detect(&self, ctx) -> Vec<DetectionResult>;      // 探测数据源
    fn scan(&self, ctx) -> Result<Vec<SessionDescriptor>>;  // 只收集路径，不读内容
    fn parse_streaming(&self, ctx, descriptor, sink) -> Result<ParsedSessionInfo>; // 流式解析
    fn parse(&self, ctx, descriptor) -> Result<NormalizedSession>;  // 默认由流式版本聚合
    fn is_remote(&self) -> bool;                        // 是否来自同步仓库
}
```

## 目录探测规则（统一约定）

1. **用户显式配置的目录是唯一数据源**：配置了就只扫描该目录（可预测、不越界）；
2. 未配置时自动发现（环境变量优先，其次默认位置与常见位置）；
3. 自动发现时要求目录里确实有该工具的会话痕迹；
4. 探测结果写入 `sources` 表并展示在 UI（含「未找到」提示与人话说明）。

---

## Kimi Code CLI

### 真实目录结构（依据本机 `~/.kimi-code` 实测）

```text
~/.kimi-code/
├── session_index.jsonl                     # {"sessionId","sessionDir","workDir"}
└── sessions/
    └── <workDirKey>/                        # wd_<name>_<hash>，例如 wd_my-project_0123456789ab
        └── <sessionDir>/                    # ses_xxx 或 session_xxx
            ├── state.json                   # title / cwd / createdAt / updatedAt / agents
            └── agents/
                ├── main/wire.jsonl          # 主聊天事件流（解析对象）
                └── agent-*/wire.jsonl       # 子 Agent（登记但不进主聊天）
```

### 与规格的两点务实差异

1. **以目录遍历为主、`session_index.jsonl` 为辅**：索引里是绝对路径，跨机器复制后会失效；
   `sessions/<workDirKey>/<sessionDir>/` 始终可用。索引仅用于补充 `workDir`（完整项目路径）。
2. **session id 统一按 UUID 主体**：索引里的 id 是 `ses_...`，而目录名可能是 `session_...`，
   因此去掉 `ses_` / `session_` 前缀后比对（同一会话的两种命名都可识别）。

### wire.jsonl 事件映射

| 事件类型 | 归一化结果 |
| --- | --- |
| `prompt.accepted` | 用户消息（权威来源，`content`） |
| `turn.prompt` | 用户消息（仅当 `promptId` 未被 `prompt.accepted` 覆盖时；用 promptId 精确去重） |
| `turn.steer` / `prompt.steered` | 用户消息（中途插话） |
| `context.append_message` | 按 `message.role` 映射；`toolCalls` 展开为工具调用 |
| `context.append_loop_event` / `content.part` | `part.type=text` → 助手文本（同一 step 的分片合并为一条）；`think` → 推理摘要 |
| `context.append_loop_event` / `tool.call` | 工具调用（`name` + `args`） |
| `context.append_loop_event` / `tool.result` | 工具结果 |
| `step.begin` / `step.end` | 分片边界（不产出消息） |
| 已知遥测（`llm.request`、`usage.record`、`token_counting.*`、`file_history.*`、`config.update`、`staleGuard.recorded`、`tools.*`、`token_usage_record`、`inter_agent_communication_metadata`、`interaction.*`、`task.waitDelivered`、`turn.step.retrying` 等） | 只计数，不入索引（原始文件保留全部） |
| 有语义的事件（`plan_mode.*`、`swarm_mode.*`、`turn.cancel`、`turn.step.interrupted`、`prompt.aborted`、`task.terminated`、`goal.update`、`permission.record_approval_result`） | 事件消息（人类可读文本） |
| 其它未知类型 | 计数 + `[未识别事件] xxx` 事件消息 + 最多 2KB raw 片段，并把会话标记为 `partial` |

`state.json` 提供标题、项目路径（`cwd`）、创建/更新时间（毫秒时间戳）；子 Agent 的 wire 文件登记进 `raw_files`（用于备份），但**不进入主聊天**。

### 隐私

`credentials/`、`server.token` 等目录/文件永不读取、永不复制（`paths::is_forbidden_path`）。

---

## OpenAI Codex

### 真实目录结构（依据本机 `~/.codex` 实测）

```text
~/.codex/
├── session_index.jsonl                 # {"id","thread_name","updated_at"} → 标题
├── sessions/2026/09/15/rollout-2026-09-15T13-00-00-<uuid>.jsonl
└── archived_sessions/...
```

rollout 的行结构（顶层统一为 `{timestamp, ordinal, type, payload}`）：

| 顶层 type | 处理 |
| --- | --- |
| `session_meta` | 会话级元信息：`session_id`、`cwd`、`cli_version`、`git` 等（`base_instructions` 等超大字段不复制） |
| `turn_context` | 模型、工作目录、审批策略（取最新值） |
| `response_item` | 消息 / 推理 / 工具调用与结果（见下表） |
| `event_msg` | 事件层记录，与 `response_item` 有重叠，靠相邻去重合并 |
| `world_state` / `compacted` / `token_usage_record` / `inter_agent_communication_metadata` | 只计数 |

`response_item` / `event_msg` 的 payload.type 映射：

| payload.type | 归一化结果 |
| --- | --- |
| `message`（user / assistant / developer / system） | 消息（`content` 数组拼接，未知内容块保留原始 JSON） |
| `reasoning` | 推理摘要（`summary`） |
| `function_call` / `custom_tool_call` / `local_shell_call` / `web_search_call` / `computer_call` | 工具调用 |
| `function_call_output` / `custom_tool_call_output` | 工具结果 |
| `agent_message` | 事件（多 Agent 协作消息，标注 `[author → recipient]`） |
| `user_message` / `agent_message`（event_msg） | 消息（与 response_item 去重） |
| `agent_reasoning` | 推理摘要 |
| `item_completed` → `CommandExecution` | 工具调用（命令行）+ 工具结果（输出 + exit code） |
| `item_completed` → `FileChange` / `McpToolCall` / `WebSearch` / `CollabAgentToolCall` | 工具调用（+ 结果） |
| `item_completed` → `ContextCompaction` / `SubAgentActivity` | 事件 |
| `item_completed` → `UserMessage` / `AgentMessage` / `Reasoning` / 工具项 | 对应消息类型（去重） |
| `token_count` / `token_usage_record` / `task_started` / `task_complete` / `turn_aborted` / `thread_settings_applied` / `internal_chat_message_metadata_passthrough` | 只计数 |
| 其它未知类型 | 计数 + `partial` 标记（会话仍可正常浏览） |

### 会话 id 与多文件会话

- 会话 id 取文件名中**第一个 UUID**（实测两种命名都以它作为 `session_meta.session_id`）：
  - `rollout-<ISO 时间>-<uuid>.jsonl`
  - `rollout-<ISO 时间>-<uuid>_<uuid>.jsonl`（父子 / 续写会话）
- 同一 session 出现多个 rollout 文件时，**保留修改时间最新的那份作为内容来源**，
  其余文件登记为 `extra_file`（快照时照常备份）。这样避免两份文件互相覆盖导致「每次扫描都重解析」。

### 标题

优先级：`session_index.jsonl` 的 `thread_name` → 首条「非注入」用户消息（截断 72 字）→ 无标题。

判定「系统注入内容」的启发式：以 `<`、`#`、`{`、`[`、```` ``` ```` 开头，或匹配 `AGENTS.md instructions`、
`permissions instructions`、`environment_context`、`recommended_plugins`、`The following is the Codex agent history`、
`Message Type:`、`You are running inside the Codex` 等前缀。否则 Codex 会把 AGENTS.md 内容当成标题。

---

## 同步仓库 Adapter（第三种数据源）

把 `Sync Repo` 中其他机器写入的快照当作数据源读取：

```text
<repo>/<source>/<machine-id>/<session-id>/
├── meta.json           # schemaVersion / machineId / contentHash / 标题 / 项目 / 时间
└── conversation.jsonl  # 归一化消息流（一行一条）
```

- 扫描阶段不读文件内容（标题、时间在解析阶段从 `meta.json` 取）；
- 会话主键与本机一致（`source:machine:external`），因此**本机的同一会话不会重复索引**：
  扫描时以本地文件为权威来源，仓库副本只服务其他机器；
- 其他机器的会话标记 `sync_status = remote`，UI 中可区分「本机 / 其他设备」。

---

## 测试

- `tests/fixtures/` 下的合成数据覆盖：正常会话、损坏行、子 Agent、未知事件、凭证目录；
- 生成脚本：`python tests/fixtures/generate_fixtures.py`（不含任何真实 token / 路径 / 用户数据）；
- 集成测试：`cargo test -p aichat-core --test adapters_test`。
