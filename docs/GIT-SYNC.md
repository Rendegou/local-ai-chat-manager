# Git 同步说明

## 1. 为什么用独立仓库

**不要**直接对 `~/.codex/` 或 `~/.kimi-code/` 执行 Git 操作：

- 这些目录里有凭证、日志、缓存与配置；
- 上游工具升级会改变目录结构；
- 直接 push 有隐私风险；
- Git 操作可能干扰工具自身的原子写入。

因此同步只发生在你指定的 **Sync Repo**：仓库里的内容全部来自「复制 / 快照」，原始文件永远只读。

## 2. 仓库结构

```text
<repo>/
├── manifest.json                    # schemaVersion / 已知机器列表
├── .gitignore                       # 忽略 *.tmp
├── .aichat/
│   ├── version.json                 # schemaVersion / app / 创建时间
│   └── machines.json                # 每台机器的登记信息（首次/最近同步时间）
├── codex/<machine-id>/<session-id>/
│   ├── meta.json                    # schemaVersion / 标题 / 项目 / 时间 / contentHash / machineId
│   ├── conversation.jsonl           # 归一化消息流（一行一条，Git 可 diff）
│   └── raw/                         # 可选：原始文件副本（Keep Raw Session Files）
├── kimi/<machine-id>/<session-id>/{meta.json, conversation.jsonl, raw/}
└── archives/<source>/<machine-id>/<session-id>.tar.zst
```

**每台机器只写自己的 `<source>/<machine-id>/`，其他机器目录视为只读** —— 这是第一版「让冲突不发生」的核心设计：
即使两台机器产生同名 session id，也落在不同目录下，不会互相覆盖。

## 3. 初始化

1. 打开「设置」→ 选择一个目录（例如 `D:\AIChatRepo`，不要选 `~/.codex` 之类）；
2. 可选：填写远端地址（GitHub / GitLab / Gitea / 自建 Git 均可，客户端不绑定任何平台 API）；
3. 点击「立即同步」：目录不是 Git 仓库时会自动 `git init`；
4. 有远端时会先 `git pull --rebase`，无上游分支时用 `push --set-upstream origin <branch>`。

> ⚠ AI 会话可能包含源代码、命令输出、内网地址、密钥等，**请务必使用 Private Repository**。

## 4. 一次同步做了什么

```text
1. 扫描本机变化（增量：size+mtime → BLAKE3）
2. 把新增 / 变更的会话写成快照（内容哈希一致则跳过）
3. git status
4. git add -A
5. git commit -m "sync: <machine> <ISO8601>"      # 例如 sync: desktop-a 2026-09-15T22:30:00+08:00
6. git pull --rebase
7. 无冲突 → git push（首次自动设置上游）
8. 重新扫描（把其他机器拉取下来的会话建进索引）
9. 更新 SQLite 索引与同步状态
```

每一步都会记录耗时与结果，展示在「同步」页；发生冲突时会立即停止后续步骤。

## 5. 多设备流程

```text
PC-A：打开应用 → 扫描 → 设置同步仓库 + 远端 → 「立即同步」（push）
PC-B：git clone <远端> <本地目录> → 应用里选择该目录 → 「立即同步」
      → 索引中出现 A 的会话（标记为「其他设备」，可按设备筛选）
```

PC-B 本机的会话同样会被扫描并 push；因为目录按机器隔离，两边不会互相覆盖。

## 6. 冲突处理（规格 §14）

架构上让冲突尽可能不发生，但仍可能出现（例如同一文件被手工改动、仓库被外部工具重写）。
此时：

- **不自动合并**、**不自动覆盖任何一边**、**不丢弃本地数据**；
- 「同步」页顶部显示冲突卡片：`Sync Conflict` + 冲突文件列表；
- 提供三个操作：
  - **中止 Rebase**：执行 `git rebase --abort`，回到同步前状态（本地提交仍在）；
  - **重试同步**：处理完冲突后重新同步；
  - **打开仓库**：用系统文件管理器打开仓库目录，手工解决。

冲突信息以结构化形式（`GitConflict { inRebase, files, message, stdout, stderr }`）从 Rust 传到 UI。

## 7. Git 调用方式

- 只调用**系统 `git` 可执行文件**（第一版不引入 libgit2）：SSH、credential helper、GitHub / 企业 Git 认证全部交给用户本机 git；
- 参数**逐项传入**（`std::process::Command`），绝不拼接 shell 字符串；
- 完整捕获 `stdout` / `stderr` / 退出码；
- 设置 `GIT_TERMINAL_PROMPT=0`，避免 GUI 卡在凭据输入；Windows 下隐藏控制台窗口。

## 8. 归档与同步的关系

- 活动会话始终是**文本**（`conversation.jsonl`），便于 Git 做 diff 与增量存储；
- 「归档」把长期未更新的会话压成 `archives/<source>/<machine>/<session>.tar.zst`，
  并**移除仓库中的活动快照目录**（避免同一份数据存两份）；本地原始文件不受影响；
- 归档会话仍可被索引引用（搜索 / 列表可显示），随时可在同步页「恢复」回活动快照。

## 9. 常见问题

| 现象 | 原因与处理 |
| --- | --- |
| `找不到 git 可执行文件` | 未安装 git 或不在 PATH；可在设置里填绝对路径 |
| 推送失败（认证） | 客户端不处理凭据，请在终端里先 `git push` 一次完成认证配置 |
| `pull --rebase` 失败但无冲突 | 查看同步页的 stderr 摘要；常见为远端不存在 / 分支未跟踪 |
| 索引里出现两台机器的同名会话 | 正常：会话主键包含 machine id，两台机器的同名会话互不覆盖 |
