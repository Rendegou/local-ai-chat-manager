# Local AI Chat Manager

> 一个轻量、高性能、Local-first 的 AI Coding 会话管理客户端。
>
> 首版仅支持 **OpenAI Codex** 与 **Kimi Code CLI**。

---

## 1. 项目目标

开发一个跨平台桌面客户端，用于自动发现、读取、索引、浏览、搜索并通过 Git 同步本机 AI Coding 工具产生的会话记录。

核心目标不是构建“长期记忆系统”，也不是重新实现 Codex/KimiCode，而是解决一个非常具体的问题：

- 用户在多台电脑上分别使用 Codex / KimiCode；
- 两端都积累了大量本地会话历史；
- 原始会话通常已经以 JSON / JSONL 等结构化形式保存在本机；
- 用户希望像管理代码一样，用 Git 管理这些历史记录；
- 换电脑后通过一次同步即可看到另一台电脑上的历史会话；
- 必要时可以查看、搜索、归档、压缩历史会话。

最终产品可以理解为：

> **GitHub Desktop + AI Coding Chat History Viewer**

---

## 2. 第一版明确范围

### 必须支持

1. Codex 本地会话发现与读取
2. Kimi Code CLI 本地会话发现与读取
3. JSON / JSONL 解析
4. 原始会话只读访问
5. 会话列表
6. 会话详情
7. 按项目、工具、时间筛选
8. 全文搜索
9. 本地索引
10. Git 仓库初始化或绑定
11. Git pull / commit / push
12. 多设备同步
13. Git 冲突检测与提示
14. 会话归档
15. 可选 gzip / zstd 压缩归档
16. Windows / macOS / Linux 基础支持

### 第一版不做

不要实现：

- LLM 长期记忆
- Embedding
- 向量数据库
- RAG
- AI 摘要
- 自动提炼知识
- MCP Server
- 云服务器
- 自建同步服务
- 用户系统
- 团队协作
- 在线聊天
- 修改 Codex / KimiCode 原始会话
- 自动恢复会话到另一 AI 工具

这些全部视为后续扩展，而不是 MVP 内容。

---

## 3. 技术栈

### 桌面框架

**Tauri 2**

前端：

- TypeScript
- React
- Vite
- Zustand
- TanStack Query（按需）
- Tailwind CSS 或轻量 CSS 方案

后端：

- Rust

### 为什么不用 Electron

本项目主要工作负载是：

- 文件系统扫描
- JSON / JSONL 流式解析
- 文件哈希
- 大量文本搜索
- 子进程调用
- Git 操作
- 压缩 / 解压缩
- SQLite 索引

这些任务 Rust 很适合。

Tauri 相比 Electron 的目标优势：

- 更低常驻内存
- 安装包更小
- 启动速度更快
- 原生文件系统能力强
- 调用 Git / rg / zstd 等工具简单
- 安全边界更清晰

不要为了追求“全 Rust UI”而采用过于小众的 GUI 框架。UI 开发效率仍然优先使用 Web 前端，系统能力放到 Rust。

---

## 4. 核心设计原则

### 4.1 原始文件永远只读

程序不得修改 Codex / KimiCode 自己维护的 session 文件。

禁止：

- 在原始 JSONL 里补字段
- 改 title
- 删除 event
- 重新排序
- 自动格式化
- 覆盖 state.json

所有同步数据必须通过“复制 / 快照”产生。

### 4.2 Adapter 隔离不同工具

不要让 UI 或索引层直接依赖 Codex/Kimi 的具体文件结构。

统一定义：

```rust
trait ConversationAdapter {
    fn id(&self) -> &'static str;
    fn detect(&self) -> DetectionResult;
    fn scan(&self) -> Result<Vec<SessionDescriptor>>;
    fn parse(&self, descriptor: &SessionDescriptor) -> Result<NormalizedSession>;
}
```

Codex 与 KimiCode 各实现自己的 Adapter。

### 4.3 Git 只管理应用自己的 Sync Repo

推荐结构：

```text
AIChatRepo/
├── manifest.json
├── codex/
│   └── <machine-id>/
│       └── ...
├── kimi/
│   └── <machine-id>/
│       └── ...
└── archives/
```

不要直接对：

```text
~/.codex/
~/.kimi-code/
```

执行 Git 操作。

原因：

- 这些目录可能包含凭证、日志、缓存、配置；
- 上游工具可能升级目录结构；
- 直接 push 有隐私风险；
- Git 操作可能影响工具自己的原子写入。

### 4.4 默认同步文本，不默认压缩

活动会话保存成 JSON / JSONL。

因为 Git 能对文本做 diff 和增量存储。

只有归档历史数据时才允许：

```text
.jsonl.gz
.jsonl.zst
.zip
```

推荐优先 zstd。

---

## 5. Kimi Code 数据源

Kimi Code 官方文档说明，默认数据根目录：

```text
~/.kimi-code/
```

Windows：

```text
C:\Users\<username>\.kimi-code
```

也可能由环境变量：

```text
KIMI_CODE_HOME
```

覆盖。

主要文件：

```text
~/.kimi-code/
├── session_index.jsonl
└── sessions/
    └── <workDirKey>/
        └── <sessionId>/
            ├── state.json
            └── agents/
                ├── main/
                │   └── wire.jsonl
                └── <subagentId>/
                    └── wire.jsonl
```

Adapter 优先读取：

```text
session_index.jsonl
```

获得：

- sessionId
- sessionDir
- workDir

随后读取对应：

```text
state.json
agents/main/wire.jsonl
```

### KimiCode 第一版规则

只把 main agent 展示为主聊天。

subagent：

```text
agents/agent-*/wire.jsonl
```

可以保留进同步仓库，但 UI 第一版允许只在“调试信息 / 子 Agent”区域展示。

禁止读取或同步：

```text
credentials/
```

默认也不需要同步：

```text
logs/
updates/
bin/
plugins/
```

---

## 6. Codex 数据源

Codex Adapter 必须采用“自动发现 + 用户可配置”策略。

不要把某一个 Codex 版本的路径和 schema 写死到 UI 层。

Adapter 至少支持：

1. 检查 `CODEX_HOME` 类自定义目录（若当前版本提供）；
2. 检查用户 Home 下常见 `.codex` 数据目录；
3. 递归寻找符合 Codex session 特征的 JSON / JSONL；
4. 保存探测结果；
5. Settings 中允许用户手工选择 Codex 数据目录。

### Codex Adapter 要求

Adapter 对外必须只输出统一结构：

```ts
interface NormalizedSession {
  id: string
  source: 'codex' | 'kimi'
  title?: string
  projectPath?: string
  createdAt?: string
  updatedAt?: string
  model?: string
  messages: NormalizedMessage[]
  rawFiles: RawFileRef[]
  metadata: Record<string, unknown>
}
```

如果 Codex schema 在不同版本变化：

- 尽量容错；
- 未知 event 保留 raw 数据；
- 不能解析时不要报整个扫描失败；
- 标记 session 为 `partial`；
- UI 显示“部分事件暂未识别”。

---

## 7. 统一消息模型

```ts
interface NormalizedMessage {
  id: string
  role:
    | 'user'
    | 'assistant'
    | 'system'
    | 'tool'
    | 'developer'
    | 'unknown'

  kind:
    | 'message'
    | 'tool_call'
    | 'tool_result'
    | 'reasoning_summary'
    | 'event'

  timestamp?: string
  text?: string
  toolName?: string
  raw?: unknown
}
```

注意：

不要为了统一而丢数据。

Normalization 的目标是“方便展示”，不是替代原始文件。

---

## 8. 本地数据库

使用：

**SQLite**

全文搜索：

**SQLite FTS5**

不要引入 Elasticsearch / Meilisearch / 向量数据库。

数据库只承担缓存与索引角色。

Git Repo 中的数据才是跨设备同步的数据。

SQLite 数据库可以删除重建。

### 建议表

```text
sources
sessions
messages
raw_files
sync_files
settings
```

`sessions`：

```text
id
source
external_session_id
title
project_path
created_at
updated_at
machine_id
content_hash
sync_status
```

`messages`：

```text
id
session_id
role
kind
text
timestamp
sequence
```

创建 FTS5：

```sql
CREATE VIRTUAL TABLE message_fts USING fts5(
    session_id,
    text
);
```

---

## 9. 文件发现

程序启动：

```text
App Start
   ↓
Detect Adapters
   ↓
Codex detect()
Kimi detect()
   ↓
Read indexes / directory metadata
   ↓
Compare mtime + size + hash
   ↓
Only parse changed sessions
   ↓
Update SQLite
```

禁止每次启动重新完整解析所有历史 JSONL。

### Fingerprint

每个源文件记录：

```text
path
size
mtime
hash
```

快速阶段只比较：

```text
size + mtime
```

变化后再计算：

```text
BLAKE3
```

---

## 10. JSONL 解析

必须流式读取。

禁止：

```rust
read_to_string(500MB_file)
```

然后一次性反序列化。

推荐：

```text
BufReader
→ lines()
→ serde_json::from_str
→ event parser
```

单行损坏：

- 记录 warning；
- 跳过该行；
- 继续解析剩余内容。

不能因为一个错误 JSON 行导致整个会话不可见。

---

## 11. Git Sync Repo

用户第一次开启同步时：

```text
选择一个目录
        ↓
已有 Git Repo？
   ↓           ↓
  是           否
   ↓           ↓
使用         git init
```

可选配置 remote。

支持 GitHub / GitLab / Gitea / 自建 Git Server，但客户端本身不要绑定具体平台 API。

只调用标准 Git。

### Repo 文件设计

```text
repo/
├── .aichat/
│   ├── version.json
│   └── machines.json
│
├── codex/
│   ├── pc-a/
│   │   └── <session-id>/
│   └── pc-b/
│       └── <session-id>/
│
├── kimi/
│   ├── pc-a/
│   └── pc-b/
│
└── archives/
```

每台机器产生稳定：

```text
machine_id
```

例如 UUID。

不要把 Windows 用户名作为 machine id。

---

## 12. 为什么按 machine 分目录

如果 PC-A 与 PC-B 同时产生 session：

```text
kimi/pc-a/xxx
kimi/pc-b/yyy
```

天然不会冲突。

即使两个工具恰好产生相同 session id，也不会覆盖。

这是第一版避免 Git 冲突的关键。

---

## 13. 同步流程

点击：

```text
Sync
```

执行：

```text
1. 扫描本机变化
2. Copy changed sessions → Sync Repo
3. git status
4. git add
5. git commit
6. git pull --rebase
7. 如无冲突 → git push
8. 扫描 pull 下来的其他机器 session
9. 更新 SQLite
```

### Commit message

自动提交：

```text
sync: <machine-id> <ISO timestamp>
```

例如：

```text
sync: desktop-a 2026-09-15T22:30:00+08:00
```

---

## 14. Git 冲突策略

架构上尽量让冲突“不发生”，而不是做复杂合并器。

原则：

```text
机器 A 只写 machines/A/
机器 B 只写 machines/B/
```

其他机器目录视为只读。

如果仍产生冲突：

第一版不要自动智能 merge JSONL。

UI 显示：

```text
Sync Conflict
```

提供：

- 查看冲突文件
- 打开 Repo
- 重试
- Abort Rebase

不要自动丢弃用户数据。

---

## 15. 会话快照策略

同步仓库中的数据不是简单复制整个 `~/.kimi-code` 或 `~/.codex`。

每个 session 建议：

```text
<session-id>/
├── meta.json
├── conversation.jsonl
└── raw/
    └── ...
```

其中：

`meta.json`

保存：

```json
{
  "schemaVersion": 1,
  "source": "kimi",
  "externalSessionId": "...",
  "projectPath": "...",
  "createdAt": "...",
  "updatedAt": "...",
  "machineId": "..."
}
```

`conversation.jsonl`

保存统一后的事件流。

如果用户开启：

```text
Keep Raw Session Files
```

则额外复制必要的原始 session 文件到 `raw/`。

默认建议开启，因为第一版产品核心就是可靠备份历史。

---

## 16. 隐私与安全

必须特别重视。

Coding Session 中可能包含：

- 源代码
- API Key
- Access Token
- 内网地址
- 文件路径
- Shell 输出
- 数据库连接字符串
- Git remote
- 环境变量

因此：

### 默认规则

禁止同步：

- Kimi credentials
- OAuth 文件
- Cookie
- 独立凭证目录

### UI 提醒

第一次配置 remote 时明确显示：

> AI 会话可能包含源代码、命令输出、文件路径和敏感信息。建议使用 Private Git Repository。

### 后续扩展

可以未来添加：

- Secret Scan
- Regex Redaction
- age encryption

但不是 MVP 阻塞项。

---

## 17. 压缩与归档

用户可以选中旧会话：

```text
Archive
```

归档条件例如：

```text
90 days without update
```

归档后：

```text
archives/
└── kimi/
    └── <session>.tar.zst
```

推荐：

**zstd**

原因：

- 解压快
- 压缩性能高
- Rust 生态成熟

但不要自动压缩正在频繁变化的 conversation。

---

## 18. 搜索

第一版使用：

```text
SQLite FTS5
```

支持：

```text
Redisson watchdog
TTL lazy deletion
Agent Goal
Redis benchmark
```

筛选：

```text
Source: Codex / Kimi
Project
Machine
Date range
```

### Everything

Windows 未来可以作为可选增强。

MVP 不依赖 Everything。

原因：

- Everything 偏文件名/path 搜索；
- 我们主要需要会话正文全文搜索；
- FTS5 已经足够快；
- 要保证跨平台。

---

## 19. UI 结构

整体风格：

- 极简
- 类似 Linear / GitHub Desktop
- 不要复杂 Dashboard
- 不要堆 KPI 卡片
- 不要“大模型产品”式渐变背景

主界面：

```text
┌────────────────────────────────────────────────────────┐
│ Local Chats                         Search      Sync ✓ │
├─────────────┬──────────────────────────────────────────┤
│ All         │ RedisGo                                 │
│ Codex       │                                         │
│ Kimi Code   │ Sep 15                                  │
│             │ ● G2-B TTL benchmark                    │
│ Projects    │   Kimi Code     desktop-a     21:31     │
│ RedisGo     │                                         │
│ OPC         │ ● Goal experiment                       │
│ Thesis      │   Codex         laptop         19:10     │
│             │                                         │
│             │ Sep 14                                  │
│             │ ● RESP parser implementation            │
└─────────────┴──────────────────────────────────────────┘
```

### 页面

#### Conversations

- 左侧 Source / Project
- 中间会话列表
- 右侧 Conversation Viewer

#### Search

全文搜索。

结果显示：

```text
Project / Session
matching message
context before / after
```

#### Sync

显示：

```text
Repository
Branch
Remote
Last Pull
Last Push
Local Changes
Incoming Changes
```

按钮：

```text
Sync Now
Open Repository
View Git Log
```

#### Settings

```text
Codex Path
KimiCode Path
Sync Repo
Git executable
Archive compression
Keep raw files
```

---

## 20. Rust 模块建议

```text
src-tauri/src/
├── main.rs
├── adapters/
│   ├── mod.rs
│   ├── codex.rs
│   └── kimi.rs
│
├── scanner/
│   ├── mod.rs
│   ├── fingerprint.rs
│   └── watcher.rs
│
├── parser/
│   ├── mod.rs
│   └── jsonl.rs
│
├── storage/
│   ├── mod.rs
│   ├── db.rs
│   └── migrations.rs
│
├── sync/
│   ├── mod.rs
│   ├── snapshot.rs
│   └── git.rs
│
├── archive/
│   └── mod.rs
│
├── model/
│   ├── session.rs
│   └── message.rs
│
└── commands/
    ├── sessions.rs
    ├── search.rs
    ├── sync.rs
    └── settings.rs
```

---

## 21. 前端结构建议

```text
src/
├── app/
├── components/
├── features/
│   ├── conversations/
│   ├── search/
│   ├── sync/
│   └── settings/
├── stores/
├── lib/
└── types/
```

不要把后端 schema 到处复制。

建议从 Rust / OpenAPI-like schema 或统一类型文件维护 IPC 类型。

---

## 22. 性能要求

目标机器：

普通开发者电脑。

最低验收：

### 启动

10,000 个 session 元数据存在时：

- 使用缓存索引启动不应该重新解析所有 JSONL；
- UI 应快速可交互。

### 搜索

100 万条 message 索引规模：

普通关键词搜索目标：

```text
< 300 ms
```

### 大 Session

单个 100MB JSONL：

- 必须流式解析；
- 不能一次性进入 JS 内存；
- UI 虚拟列表渲染。

### 文件扫描

增量扫描优先依靠：

```text
mtime + size → hash
```

不要无脑重复 hash 所有文件。

---

## 23. 文件监听

可以使用 Rust notify crate。

监听：

- Codex sessions directory
- Kimi sessions directory

事件：

```text
create
modify
rename
remove
```

需要 debounce：

```text
500ms ~ 1500ms
```

避免 AI CLI 连续 append JSONL 时触发几十次解析。

---

## 24. MVP 阶段拆解

### Phase 0 — Skeleton

完成：

- Tauri 2
- React + TS
- Rust commands
- SQLite
- 基础设置页

验收：

应用可以启动、保存设置、正常打包。

### Phase 1 — Kimi Adapter

完成：

- 自动检测 KIMI_CODE_HOME
- 读取 session_index.jsonl
- 读取 state.json
- 解析 main wire.jsonl
- 生成 NormalizedSession

验收：

本机 KimiCode 历史可以在 GUI 中看到。

### Phase 2 — Codex Adapter

完成：

- 自动发现
- 手工路径设置
- Session 扫描
- JSONL 解析
- Schema 容错

验收：

本机 Codex 历史可以在 GUI 中看到。

### Phase 3 — Index + Search

完成：

- SQLite
- FTS5
- Project filter
- Source filter
- Date filter

验收：

可搜索历史聊天内容。

### Phase 4 — Git Sync

完成：

- Sync repo
- machine id
- snapshot
- git add
- commit
- pull --rebase
- push

验收：

PC-A 产生会话 → push → PC-B pull → GUI 可查看。

### Phase 5 — File Watcher

完成实时增量更新。

### Phase 6 — Archive

完成 zstd 归档。

### Phase 7 — Polish

完成：

- 错误提示
- 空状态
- Git 冲突 UI
- 大会话虚拟列表
- 性能测试

---

## 25. 测试策略

### Unit Tests

重点：

```text
JSONL parser
Kimi Adapter
Codex Adapter
Fingerprint
Snapshot
Path normalization
Git status parser
```

### Fixtures

测试目录：

```text
tests/fixtures/
├── kimi/
│   ├── normal/
│   ├── malformed-line/
│   └── subagents/
└── codex/
    ├── normal/
    └── unknown-event/
```

Fixture 必须去除真实 token / path / 用户数据。

### Integration

建立临时 Git Repo：

```text
repo-a
repo-b
bare-remote
```

测试：

```text
A commit
A push
B pull
B session visible
```

### 性能测试

自动生成：

```text
10k sessions
1m messages
100MB JSONL
```

验证扫描、搜索、解析与内存。

---

## 26. 错误处理

禁止大量 `unwrap()`。

错误分类：

```text
AdapterError
ParseError
DatabaseError
GitError
IoError
ArchiveError
ConfigError
```

前端不要直接显示 Rust backtrace。

转换成人可理解的信息：

```text
无法读取 Kimi 会话目录
Git pull 失败
当前仓库存在冲突
发现 3 条无法解析的会话事件
```

同时保留 debug log。

---

## 27. 日志

使用 tracing。

不要记录：

- 完整 prompt
- token
- credentials
- 私有代码正文

日志记录：

```text
session id
path
size
elapsed
error type
```

---

## 28. Git 实现方式

MVP 优先调用系统：

```text
git executable
```

而不是第一版就引入 libgit2。

原因：

- SSH config
- credential helper
- GitHub auth
- 企业 Git

用户本机 Git 已经处理得很好。

Rust 用：

```rust
std::process::Command
```

或 Tokio process。

所有参数必须分参数传入，不要拼 shell string。

错误：

```text
stdout
stderr
exit code
```

全部捕获。

---

## 29. 数据版本

所有同步文件必须带：

```json
{
  "schemaVersion": 1
}
```

未来 schema 升级必须提供 migration。

不要假设 v1 永远不变。

---

## 30. 第一版完成标准

满足以下场景即可认为 MVP 完成：

### Scenario A

电脑 A 安装 KimiCode，已有历史会话。

打开客户端：

```text
自动发现 → 列表展示 → 点开阅读
```

### Scenario B

电脑 A 有 Codex 历史。

客户端：

```text
自动检测 / 手工设置目录 → 查看历史
```

### Scenario C

搜索：

```text
lazy deletion
```

快速找到历史消息。

### Scenario D

配置 Private Git Repo。

电脑 A：

```text
Sync
```

电脑 B：

```text
Sync
```

随后可以看到电脑 A 的历史。

### Scenario E

Codex/Kimi 正在写 JSONL 时客户端运行，不破坏原文件，不导致上游工具 session 损坏。

---

# 31. 给 Coding Agent 的执行提示词

下面内容可以直接作为 Goal / Agent Prompt 使用。

---

## Agent Prompt

你现在是这个项目的首席工程师。请从零实现本仓库中的 **Local AI Chat Manager**。

你的目标不是快速做出一个 Demo，而是做出一个真正可以长期使用、结构清晰、性能优秀、易扩展的跨平台桌面客户端。

请完整阅读本规格文档，然后自主拆解任务并持续执行，直到 MVP 的核心验收场景全部跑通。

### 产品范围

第一版仅支持：

- OpenAI Codex
- Kimi Code CLI

功能只包含：

- 自动发现本地会话
- JSON / JSONL 流式解析
- 会话标准化
- SQLite + FTS5 索引
- 会话浏览
- 全文搜索
- Git Repo 快照同步
- 多设备历史合并
- Git pull / commit / push
- 文件监听
- zstd 历史归档

明确禁止把项目扩展成：

- 长期记忆系统
- RAG
- Vector DB
- AI Summary
- 云同步服务
- Chat Bot

### 技术栈

必须优先使用：

```text
Tauri 2
Rust
React
TypeScript
Vite
SQLite FTS5
```

不要改成 Electron。

### 核心工程原则

1. Codex/Kimi 原始 session 文件只读。
2. 不允许 Git 直接管理 AI 工具自己的数据目录。
3. 使用独立 Sync Repo。
4. 各机器只写自己的 `<source>/<machine-id>/`。
5. 活跃 session 使用文本 JSON/JSONL，不做压缩。
6. 历史 Archive 才允许 zstd。
7. JSONL 必须流式解析。
8. 单行 JSON 损坏不得导致整个 session 失败。
9. 大会话不得整体送入 JS 内存。
10. Adapter 必须与 UI 解耦。
11. SQLite 是可重建索引，不是同步数据的 source of truth。
12. Git 操作不得通过字符串拼 shell command。
13. 不读取、不复制、不提交 credentials。
14. 所有 sync schema 必须有 schemaVersion。
15. 对未知 Codex/Kimi event 必须保留 raw 信息，不要静默丢弃。

### 开发方式

首先检查当前仓库。如果为空，从项目脚手架开始。

然后按以下阶段工作：

```text
Phase 0 Tauri Skeleton
Phase 1 Kimi Adapter
Phase 2 Codex Adapter
Phase 3 SQLite + FTS
Phase 4 Conversation UI
Phase 5 Git Sync
Phase 6 File Watcher
Phase 7 Archive
Phase 8 Tests + Performance + Polish
```

每完成一个 Phase：

1. 运行 formatter；
2. 运行 lint；
3. 运行 Rust tests；
4. 运行前端 tests；
5. 运行 integration tests；
6. 修复失败；
7. 再进入下一阶段。

不要只写代码而不运行测试。

### Adapter 特别要求

Kimi Code：

优先根据官方目录：

```text
$KIMI_CODE_HOME
默认 ~/.kimi-code
```

读取：

```text
session_index.jsonl
sessions/<workDirKey>/<sessionId>/state.json
sessions/<workDirKey>/<sessionId>/agents/main/wire.jsonl
```

绝对禁止读取 / 同步：

```text
credentials/
```

Codex：

不要把某个单一版本的数据路径硬编码到整个应用。

实现：

```text
CodexAdapter.detect()
CodexAdapter.scan()
CodexAdapter.parse()
```

允许：

```text
auto detected path
manual override path
```

对 schema 变化容错。

### Git Sync

实现：

```text
scan
snapshot
status
add
commit
pull --rebase
push
reindex
```

发生冲突：

不要自动覆盖任何一边。

返回结构化 GitConflict 给 UI。

### 性能

不要过早微优化，但必须从架构上避免明显错误：

- 不全量重复解析；
- 不把 100MB JSONL 一次 load；
- 不在 React 渲染 10 万 DOM 节点；
- 不每次扫描 hash 所有文件；
- 不阻塞 Tauri UI 主线程。

### UI

目标是桌面工具，而不是 AI 营销网站。

风格参考：

```text
Linear
GitHub Desktop
VS Code utility panels
```

要求：

- 简洁
- 信息密度合理
- 无多余渐变
- 无巨大 KPI 卡片
- 无复杂动画
- 深浅色模式
- 大列表虚拟滚动

### 最终交付

最终必须提供：

1. 可运行源码；
2. README；
3. Architecture 文档；
4. Adapter 文档；
5. 测试；
6. sample fixtures；
7. Windows build；
8. Git Sync 使用说明；
9. 已知限制；
10. 后续路线图。

在核心 MVP 完成以前，不要花大量时间开发不在规格范围里的功能。

如果实现过程中发现 Codex 或 KimiCode 的实际本地格式与本文档假设不同，应以本机真实文件与官方文档为准，调整 Adapter，而不是修改整个架构。

最终目标：

> 用户在 PC-A 使用 Codex/KimiCode 写代码，点击 Sync；然后在 PC-B 打开本客户端并 Sync，就能搜索和查看 PC-A 的历史 AI Coding 会话。

