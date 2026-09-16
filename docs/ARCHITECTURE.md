# 架构说明

## 1. 分层

```text
┌──────────────────────────────────────────────────────────────┐
│ 前端（React + TS）                                            │
│  会话浏览 / 搜索 / 同步 / 设置   —— 只依赖 IPC 类型，不感知文件格式 │
└───────────────────────────┬──────────────────────────────────┘
                            │ Tauri IPC（命令 + 事件）
┌───────────────────────────┴──────────────────────────────────┐
│ src-tauri（外壳）                                             │
│  spawn_blocking 执行重活、事件推送（扫描/同步进度）、插件（目录选择/打开）│
└───────────────────────────┬──────────────────────────────────┘
                            │ Rust 函数调用（同一个进程）
┌───────────────────────────┴──────────────────────────────────┐
│ crates/aichat-core（业务核心）                                 │
│                                                              │
│  adapters/    Codex / Kimi / 同步仓库 → 统一模型               │
│  parser/      JSONL 流式解析（容错、低内存）                    │
│  scanner/     增量扫描（指纹）+ 文件监听（debounce）             │
│  storage/     SQLite + FTS5（可重建索引）                      │
│  sync/        Git 快照同步（命令封装 + 快照 + 编排）             │
│  archive/     zstd / gzip 归档                                │
└──────────────────────────────────────────────────────────────┘
```

**为什么把核心单独做成 crate**：业务逻辑与 UI 框架解耦，`cargo test -p aichat-core` 可以在没有桌面环境的情况下跑全部单元与集成测试（CI / 服务器也能跑），Tauri 外壳只做转发。

## 2. 数据流

```text
① 发现
   App 启动 → 适配器 detect() → 得到数据源根目录（可手工配置覆盖）
        ↓
② 扫描（毫秒级）
   scan() 只做目录遍历与轻量元信息，产出 SessionDescriptor（不读文件内容）
        ↓
③ 增量判定（关键性能点）
   比 size + mtime ──一致──→ 跳过（不读文件内容）
        │变化
        ↓
   BLAKE3 哈希 ──与上次相同──→ 只刷新指纹，跳过解析
        │不同
        ↓
④ 流式解析写库
   parse_streaming(descriptor, DatabaseSink)
   JSONL 逐行解析 → 每 512 条消息一个事务写 SQLite（内存恒定）
   解析成功后写入文件指纹 + 会话元数据（FTS 由触发器同步）
        ↓
⑤ 查询
   列表：sessions 索引（source / project / machine / updated_at）
   浏览：messages 按 (session_id, sequence) 分页读取
   搜索：FTS5 两阶段查询（候选 → bm25 打分）
```

## 3. 性能设计

| 场景 | 做法 | 实测 |
| --- | --- | --- |
| 启动 | 只加载索引，不全量重解析；UI 先可用 | 325 个真实会话：二次扫描 **91 ms**（解析 0 个） |
| 增量扫描 | `size+mtime` → BLAKE3 两级判定 | 325 个真实会话首次全量解析 26 s（release），之后 0 解析 |
| 大会话 | JSONL 流式解析 + 分批事务写入 | 100 MB 单文件、181,668 条消息：**7.5 s（13.4 MB/s），峰值内存 31 MB** |
| 搜索（真实数据） | FTS5 + `ORDER BY rank` | 325 会话 / 77,263 条消息：**2–11 ms** |
| 搜索（极端规模） | 同上 | 100 万条消息、单关键词命中 20 万条（占 20%）：**p50 288 ms / p95 305 ms** |
| 列表渲染 | 虚拟滚动（固定/变高两种模式） | 只渲染可视区 + overscan |
| 消息浏览 | 按页加载（默认 200 条/页）+ 变高虚拟滚动 | 10 万条消息页面上 DOM 节点保持常数 |
| 文件监听 | notify + 900 ms 去抖 | 连续追加 JSONL 只触发一次重新索引（有测试覆盖） |

> 复测命令：`aichat-cli bench --sessions 10000 --messages 100`、`aichat-cli bench-session --size-mb 100`。

### 搜索排序：为什么用 `ORDER BY rank` 而不是 `ORDER BY bm25(...)`

FTS5 的相关度排序要为**全部命中项**计算 bm25（I/O 受限）。实测（100 万条消息、单关键词命中 20 万条）：

```text
ORDER BY bm25(message_fts)         →  约 520 ms
ORDER BY score（bm25 的别名）        →  约 520 ms
ORDER BY rank                      →  约 280 ms   ← 采用
无排序 + LIMIT 51                   →  约 18 ms
```

差异来自 SQLite 能否复用同一次打分结果，因此代码里显式使用 FTS5 的 `rank` 列。

**曾经尝试过但放弃的方案**：先取候选 rowid（约 5 ms）再对候选集打分（2 万条约 92 ms）。
它快得多，但外部内容表的 `snippet()` / `bm25()` 需要「按 rowid 访问」的行上下文，
在 CTE 里物化 rowid 后会退化成读正文，**搜索结果失去高亮、相关度失真**。
搜索是核心功能，正确性优先，因此保留单阶段排序；详见 [LIMITATIONS.md](LIMITATIONS.md)。

## 4. 索引（SQLite）

- 定位：**可删除、可重建的缓存**；跨设备数据的 source of truth 是同步仓库里的文本快照。
- `messages` 与 `message_fts` 通过 **external content + 触发器**保持同步，索引里不重复存正文（省约一半体积）。
- **必须开启 `PRAGMA recursive_triggers = ON`**：SQLite 在执行 `INSERT OR REPLACE` 时默认不触发 DELETE 触发器，
  会让 FTS 残留旧索引项，实测会导致 rowid 错乱甚至 `database disk image is malformed`。
- 写入采用 WAL；大批量写入后主动 `wal_checkpoint(TRUNCATE)`，避免 WAL 膨胀影响查询。
- 表：`sources` / `sessions` / `messages` / `raw_files` / `sync_files` / `settings`（+ `message_fts`）。

## 5. 关键取舍

| 取舍 | 选择 | 原因 |
| --- | --- | --- |
| Git 实现 | 调用系统 `git` 可执行文件 | SSH、credential helper、企业 Git 等由用户本机 git 处理；参数逐项传入，不拼 shell |
| 冲突处理 | 按机器分目录 + 不自动合并 | 让冲突「不发生」，发生了也只报告、不丢数据 |
| 会话主键 | `<source>:<machine-id>:<external-id>` | 不同机器可能有相同 session id；同时让本机会话与仓库快照指向同一行 |
| 归一去重 | 相邻窗口 + promptId / 事件双写去重 | Codex 会双写同一条消息，Kimi 的 `turn.prompt` 与 `prompt.accepted` 也会重复 |
| 未知事件 | 计数 + 事件气泡 + 最多 2KB 的 raw 片段 | 既不静默丢弃，也不让索引体积翻倍（原始文件才是完整数据源） |
| 标题 | Codex 用 `session_index.thread_name`，Kimi 用 `state.json.title` | 缺少时退回首条「非注入」用户消息，再没有就显示「无标题」 |

## 6. 线程与并发

- Tauri 命令中，扫描 / 同步 / 归档走 `spawn_blocking`，不阻塞 UI 线程；
- 扫描用进程内互斥量串行化（文件监听与手动扫描不会同时改同一份索引）；
- 数据库是「单连接 + Mutex」：桌面端写入量可控，WAL 保证读体验，省掉连接池复杂度；
- 文件监听在独立线程运行，回调里只触发一次增量扫描（内部再做去抖）。

## 7. 目录布局（运行时）

```text
<应用数据目录>            # Windows: %LOCALAPPDATA%\dev.local.aichatmanager
├── index.db             # SQLite 索引（可删）
├── settings.json        # 用户设置
└── machine.json         # 本机 machine id（UUID，绝不用用户名）

<同步仓库>                # 用户自选目录，与 AI 工具数据目录完全隔离
├── manifest.json
├── .aichat/{version.json, machines.json}
├── codex/<machine-id>/<session-id>/{meta.json, conversation.jsonl, raw/}
├── kimi/<machine-id>/<session-id>/{meta.json, conversation.jsonl, raw/}
└── archives/<source>/<machine-id>/<session-id>.tar.zst
```
