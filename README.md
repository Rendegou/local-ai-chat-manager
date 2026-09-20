# Local AI Chat Manager

本地 AI 编程会话管理工具 · A local-first manager for AI coding CLI chat history.

**中文** | [English](#english)

> 当前版本：**0.4.2 Beta**。Windows 已完成主要功能验证；macOS 和 Linux 尚未进行真机测试。
>
> Current version: **0.4.2 Beta**. Main workflows verified on Windows; macOS and Linux have not been tested on real hardware yet.

技术栈：Tauri 2、Rust、React、TypeScript、SQLite FTS5。
Tech stack: Tauri 2, Rust, React, TypeScript, SQLite FTS5.

![会话浏览](docs/images/demo-conversations.png)

截图使用合成演示数据，不包含真实会话。 / The screenshot uses synthetic demo data; no real conversations are shown.

---

## 中文

### 简介

本地 AI 编程会话管理工具，用于整理和搜索 **OpenAI Codex**、**Kimi Code CLI** 的历史会话，也可以通过独立的 Git 仓库在多台电脑之间同步。

### 功能

- 内置适配 Codex / Kimi Code / Cursor / ZCode / Claude Code / Gemini CLI / WorkBuddy；
  Cline、Continue.dev、Aider 已识别但尚未适配
- **自定义来源**：给任意工具的 JSONL / JSON 目录填一份字段映射就能接成常驻来源，
  带「试解析」在保存前验证映射——不需要等我们写适配器
- 导入支持自动识别：标准会话包、OpenAI/Anthropic 消息形、JSONL 转录、Claude Code 转录、Markdown
- 按项目、时间和数据源浏览历史记录
- 使用 SQLite FTS5 全文搜索
- 增量扫描，只处理新增或变化的文件
- 通过 Git 在多台电脑间同步会话副本
- 对旧会话进行 zstd / gzip 归档
- 不修改 AI 工具原始会话文件
- 界面双语（中文 / 英文），默认跟随系统，可在设置中切换

### 当前状态

项目仍处于 Beta 阶段，适合试用和反馈，不建议直接用于唯一的数据备份。

- Windows：已完成构建、安装包和主要流程测试
- macOS / Linux：已有平台适配代码和打包配置，尚未在真机验证
- 多机同步：自动化测试已覆盖，真实设备迁移仍需进一步测试
- 发布包：暂未提供，请从源码运行

已知限制见 [docs/LIMITATIONS.md](docs/LIMITATIONS.md)。

### 从源码运行

需要安装：

- Node.js 20+
- Rust stable
- Git（使用同步功能时需要）
- 对应平台的 Tauri 系统依赖

```bash
npm install
npm run tauri:dev
```

构建桌面应用：

```bash
npm run tauri:build
```

Tauri 在不同平台使用各自的系统 WebView，因此 macOS 和 Linux 安装包需要在对应系统上构建。

### Git 同步

应用使用一个单独的 Git 仓库保存会话副本，不会把当前项目代码仓库当作同步仓库。

1. 在设置中选择本地同步目录
2. 填写 GitHub、GitLab、Gitea 或自建 Git 服务的远端地址
3. 使用系统 Git 完成认证
4. 在同步页面执行同步

应用本身不保存 GitHub 密钥。HTTPS 认证由 Git Credential Manager 处理，SSH 认证使用系统已有的 SSH Key。

会话可能包含源码、命令输出或内部地址，建议将同步仓库设为 Private。

### 数据与隐私

- 原始 Codex / Kimi 会话文件只读
- 同步内容来自复制生成的快照
- 凭据、Token、私钥和认证文件不会进入同步目录
- 首次正式迁移前建议先备份原始会话目录

### 测试

```bash
cargo test -p aichat-core
npm run typecheck
npm run build
npm run ui:qa
npm run ui:a11y
```

测试覆盖解析、增量索引、搜索、归档、多机 Git 同步及主要前端布局。测试结果不等同于所有平台的生产验证。

### 项目结构

```text
crates/aichat-core/  Rust 核心逻辑、存储、搜索与同步
src-tauri/           Tauri 桌面端入口与 IPC
src/                 React 前端
tests/fixtures/      合成测试数据
docs/                架构、同步协议、限制与路线图
```

### 文档

- [架构说明 Architecture](docs/ARCHITECTURE.md)
- [数据适配 Data adapters](docs/ADAPTERS.md)
- [Git 同步 Git sync](docs/GIT-SYNC.md)
- [已知限制 Known limitations](docs/LIMITATIONS.md)
- [界面规范 Design system](docs/DESIGN.md)
- [设计审计 Design audit](docs/DESIGN_AUDIT.md)
- [UI 重构报告 UI refactor report](docs/UI_REFACTOR_REPORT.md)
- [数据源可扩展性报告 Source extensibility](docs/SOURCE_EXTENSIBILITY_REPORT.md)
- [UI 验收 UI QA](docs/UI-QA.md)
- [路线图 Roadmap](docs/ROADMAP.md)

---

## English

### Introduction

A local-first manager for AI coding CLI chat history. It organizes and searches past sessions from **OpenAI Codex** and **Kimi Code CLI**, and can sync them across multiple machines through a dedicated Git repository.

### Features

- Built-in adapters for Codex / Kimi Code / Cursor / ZCode / Claude Code / Gemini CLI / WorkBuddy;
  Cline, Continue.dev and Aider are recognised but not adapted yet
- **Custom sources**: point at any tool's JSONL / JSON directory, map its fields, and it becomes a
  first-class source — with a test-parse step to verify the mapping before saving
- Import auto-detects standard packages, OpenAI/Anthropic message shapes, JSONL transcripts,
  Claude Code transcripts and Markdown
- Browse history by project, time, and data source
- Full-text search powered by SQLite FTS5
- Incremental scanning — only new or changed files are processed
- Sync session copies across machines via Git
- zstd / gzip archiving for older sessions
- Never modifies the original AI tool session files
- Bilingual UI (Chinese / English); follows the system language by default and can be switched in Settings

### Current status

The project is still in Beta: suitable for trial and feedback, not recommended as your only data backup.

- Windows: build, installer, and main workflows tested
- macOS / Linux: platform adaptation code and packaging configuration exist, but not yet verified on real hardware
- Multi-machine sync: covered by automated tests; real-device migration still needs further testing
- Release builds: not provided yet; please run from source

See [docs/LIMITATIONS.md](docs/LIMITATIONS.md) for known limitations.

### Run from source

Requirements:

- Node.js 20+
- Rust stable
- Git (required for the sync feature)
- Platform-specific Tauri system dependencies

```bash
npm install
npm run tauri:dev
```

Build the desktop app:

```bash
npm run tauri:build
```

Tauri uses each platform's native system WebView, so macOS and Linux installers must be built on the corresponding systems.

### Git sync

The app stores session copies in a separate Git repository; the project code repository itself is never used as the sync repository.

1. Choose a local sync directory in Settings
2. Enter the remote URL of a GitHub, GitLab, Gitea, or self-hosted Git service
3. Authenticate through the system Git installation
4. Run the sync from the Sync page

The app never stores GitHub credentials itself. HTTPS authentication is handled by Git Credential Manager; SSH authentication uses the existing system SSH keys.

Sessions may contain source code, command output, or internal addresses — it is recommended to keep the sync repository Private.

### Data & privacy

- Original Codex / Kimi session files are read-only
- Synced content comes from snapshot copies
- Credentials, tokens, private keys, and authentication files never enter the sync directory
- Back up your original session directories before the first real migration

### Testing

```bash
cargo test -p aichat-core
npm run typecheck
npm run build
npm run ui:qa
npm run ui:a11y
```

Tests cover parsing, incremental indexing, search, archiving, multi-machine Git sync, and the main frontend layouts. Passing tests do not equal production verification on every platform.

### Project structure

```text
crates/aichat-core/  Rust core logic, storage, search, and sync
src-tauri/           Tauri desktop entry point and IPC
src/                 React frontend
tests/fixtures/      Synthetic test data
docs/                Architecture, sync protocol, limitations, and roadmap
```

### Docs

- [Architecture](docs/ARCHITECTURE.md)
- [Data adapters](docs/ADAPTERS.md)
- [Git sync](docs/GIT-SYNC.md)
- [Known limitations](docs/LIMITATIONS.md)
- [Design system](docs/DESIGN.md)
- [Design audit](docs/DESIGN_AUDIT.md)
- [UI refactor report](docs/UI_REFACTOR_REPORT.md)
- [Source extensibility report](docs/SOURCE_EXTENSIBILITY_REPORT.md)
- [UI QA](docs/UI-QA.md)
- [Roadmap](docs/ROADMAP.md)

---

## License

MIT
