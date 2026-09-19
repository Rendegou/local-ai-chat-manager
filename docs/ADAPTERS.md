# Adapter 说明

Adapter 负责把各家 AI CLI 的本地文件翻译成统一模型（`NormalizedSession` / `NormalizedMessage`），
UI 与索引层完全看不到原始文件结构。

统一接口（`crates/aichat-core/src/adapters/mod.rs`）：

```rust
trait ConversationAdapter {
    fn id(&self) -> &str;      // 内置实现返回字面量；用户自定义来源的 id 是运行期值
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

## ZCode

### 真实目录结构（依据本机 `~/.zcode` 实测）

```text
~/.zcode/v2/sessions/<hex 目录>/<taskId>.json
```

单文件 JSON：`meta`（`taskId` / `title` / `workspacePath` / `createdAt` / `updatedAt`（毫秒）/ `status`）
+ `messages[]`（`role` / `content`）。消息本身无时间戳字段。

### 映射约定

- external_id = 文件名去掉 `.json`；标题/项目/时间取自 `meta`；
- `role`：`user` / `assistant` 映射为消息，未知 role 记为事件消息并 `note_unknown`；
- `~/.zcode/v2/credentials.json` 等凭证文件走 `paths::is_forbidden_path`，永不读取、永不复制。

---

## Cursor

### 真实存储（依据本机 `%APPDATA%/Cursor` 实测；逆向格式，无官方文档）

会话在 SQLite `%APPDATA%/Cursor/User/globalStorage/state.vscdb`（WAL 模式，只读打开）：

| 表 | 内容 |
| --- | --- |
| `composerHeaders` | 会话元数据：`composerId` / `workspaceId` / `createdAt` / `lastUpdatedAt`（毫秒）/ `isArchived` / `isSubagent`；`value` JSON 里有标题 `name` |
| `cursorDiskKV` | 消息体：key = `bubbleId:<composerId>:<bubbleId>`，value 为气泡 JSON |

### 归一化约定

- external_id = `composerId`；排除 `isArchived=1` 与 `empty-state-draft`；
- bubble 的 `type`：1 = 用户，2 = 助手；`text` 为正文；`thinking` → 推理摘要；
  `toolFormerData`（`name` / `params` / `result` / `status`）→ 工具调用 + 工具结果；
- 排序按 bubble 内的 `createdAt`（ISO8601，约 4% 缺失），缺失者按 key 字典序排在最前——
  实测 key 字典序与创建顺序全部错位，不能拿 key 当时序；
- 未知字段 / 未知 type：计数 + raw 片段 + `partial`，不静默丢弃。

### 增量指纹（SQLite 数据源的关键差异）

全部会话共用一个 db 文件，不能靠文件指纹。每个 composer 的
`content_revision = lastUpdatedAt`（NULL 时兜底 `createdAt` → `"0"`），
指纹 key 用伪路径 `state.vscdb#<composerId>`，扫描器直接比对版本号，
不重新哈希几百 MB 的 db。

### 隐私

只读打开、永不写回；`raw_files` 为空（会话是 db 行，不复制整个 db——那包含所有会话）。

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

## 用户自定义来源（GenericJsonAdapter）

**这是「满足所有人」的答案里最实在的一块。** 给每个 AI 编程工具写一个 Rust 适配器追不上生态：
新工具出现的速度远快于写 parser 的速度。而这类工具几乎都把历史写成 `~/.xxx/` 下的 JSONL 或 JSON，
所以真正需要的不是更多适配器，而是一个**不需要写代码**的通用读取器 + 一份可验证的字段映射。

`crates/aichat-core/src/adapters/generic.rs`，一个用户配置的来源对应一个实例。

### 字段映射（`FieldMapping`，存在 `settings.sources[id].mapping`）

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `layout` | `jsonl` | `jsonl` 一行一条消息；`json` 一个文件一个会话对象 |
| `messagesPath` | `messages` | 仅 `json` 布局：消息数组路径，`.` 分隔（如 `data.items`）；找不到时退回顶层数组 |
| `roleField` | `role` | 角色字段，可下钻（如 `author.role`） |
| `textField` | `content` | 正文字段；字符串 / `[{text}]` 块数组 / 嵌套对象都认 |
| `timeField` | `timestamp` | 留空表示不读时间 |
| `toolField` | 空 | 仅角色为 `tool` 时使用 |
| `titleField` | 空 | `json` 从文件根对象读，`jsonl` 从第一条记录读 |
| `projectField` | 空 | 读取位置同 `titleField` |
| `roleMap` | 空 | 把不认识的角色名对到标准角色，如 `{bot: assistant}` |
| `extensions` | `["jsonl"]` | 参与索引与**文件监听**的扩展名（不含点） |
| `maxDepth` | `8` | 目录递归深度上限（1–32） |

`SourceConfig` 因此多了两个字段：`displayName`（用户起的名字）与 `mapping`（有它即「自定义来源」）。
两者都有容器级 `#[serde(default)]`，旧的 `settings.json` 照常加载。可选字段用「留空即不配置」而不是
`Option`：表单与 serde 都更直白。

### 三条设计约定

1. **映射写错不能静默成功**。一条消息都读不出来时返回明确错误（指向该改哪个字段），
   而不是建一个空会话——静默成功会让人以为接上了，扫描完才发现什么都没有，那时已经不知道错在哪。
2. **认不出的角色不丢**。保留为 `unknown` + `event`（`note_unknown` 置 `partial`、保留 raw），
   沿用既有约定；配合 `roleMap` 让用户自己补，而不是我们猜。
3. **与内置来源共用增量机制**。`content_revision` 留空 → 走 `size+mtime+hash` 指纹，
   文件变了才重解析。没有为自定义来源发明第二套逻辑。

### 两个容易踩的点

- `watch_extensions()` **必须覆写**：默认实现从静态 `registry::catalog()` 查扩展名，而自定义来源不在
  catalog 里，会静默退回 `json/jsonl`——用户填了别的扩展名就永远收不到文件变更通知。
- `external_id` 用文件名；同名文件分布在不同子目录时拼一段相对路径哈希，否则两个 `session.json`
  会共用同一个会话主键、互相覆盖。

### 标识冲突

自定义来源**不能占用非 `pending` 的内置标识**（`AppSettings::validate()` 拒绝）：那会让两个适配器
同 id 抢同一批会话。但 `pending` 例外——「把还没适配的工具自己接上」正是自定义来源的用途之一。
一个原本判为 `pending` 的工具被映射接上后，`source_catalog()` 会把它的 `access` 改报为 `native`，
界面上不再显示「待适配」。

### 试解析

`Library::preview_generic_mapping(root, mapping)` 采样前 3 个会话，返回文件数、会话数、消息数、
示例正文与告警。**参数收 `root` + `mapping` 而不是读设置**：用户要在保存前反复调映射，
不必先落盘再改再删。单个文件失败只进告警，不让整次试解析失败。

---

## 数据源分类（`access`）

`registry::catalog()` 里 `access` 的三种取值决定一个来源在界面上能被怎么用：

| access | 含义 | 有内置适配器 | 出现在「添加来源」 | 可配置 |
| --- | --- | --- | --- | --- |
| `native` | 有内置适配器 | 是 | 未连接时 | 目录 |
| `import` | 只支持手动导入标准包 | 否 | 是 | 无 |
| `pending` | 认识这个工具、知道数据大概在哪，但**还没写适配器** | 否 | 是（标「待适配」+「用自定义来源接入」） | 无 |

`pending` 的用处是把「产品不支持」变成「还没做」：用户能看见我们认识这个工具，而不是在列表里
找不到、以为永远不会有。它也是收集真实需求的地方——哪个 `pending` 条目被问得最多，下一个适配器
就写哪个。`description` 里的路径一律标注**未在本机验证**；写成一个看起来权威的默认路径更糟，
一旦写错用户会照着去指一个空目录。

---

## 测试

- `tests/fixtures/` 下的合成数据覆盖：正常会话、损坏行、子 Agent、未知事件、凭证目录；
- 生成脚本：`python tests/fixtures/generate_fixtures.py`（不含任何真实 token / 路径 / 用户数据）；
- 集成测试：`cargo test -p aichat-core --test adapters_test`。
