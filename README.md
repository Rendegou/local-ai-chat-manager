# Local AI Chat Manager

> 一个轻量、高性能、Local-first 的 AI Coding 会话管理客户端。
> 自动发现、索引、搜索本机 **OpenAI Codex** 与 **Kimi Code CLI** 的历史会话，并通过**独立的 Git 仓库**在多台电脑之间同步。

`Tauri 2` + `Rust` + `React` + `TypeScript` + `SQLite FTS5`

---

## 它解决什么问题

- 你在多台电脑上分别使用 Codex / Kimi Code；
- 两端都积累了大量本地会话历史（JSONL）；
- 你希望像管理代码一样用 Git 管理这些历史；
- 换电脑后一次同步，就能看到另一台电脑上的会话，并且可以全文搜索。

## 界面

![会话浏览](docs/images/demo-conversations.png)

> 截图使用的是合成演示数据（`npm run ui:demo` 一键生成：54 个虚构会话、6 个虚构项目，含长标题与空会话样本）。

左：数据源与项目筛选；中：按日期分组的会话列表（虚拟滚动）；右：会话内容（虚拟滚动 + 分页加载，工具消息可折叠）。

## 核心特性

| 能力 | 说明 |
| --- | --- |
| 自动发现 | Codex：`CODEX_HOME` → `~/.codex`（递归找 `rollout-*.jsonl`）；Kimi：`KIMI_CODE_HOME` → `~/.kimi-code`；均支持手工指定目录 |
| 流式解析 | JSONL 逐行流式解析，单行损坏跳过并告警，100MB+ 会话不进内存 |
| 增量索引 | `size + mtime` 快速比对，变化后才算 BLAKE3；未变化会话零 IO |
| 全文搜索 | SQLite FTS5，100 万条消息下普通关键词 < 300ms（实测 p50 约 92ms） |
| Git 同步 | 只管理独立 Sync Repo，按机器分目录天然避免冲突；冲突不自动合并 |
| 历史归档 | 旧会话压缩为 `.tar.zst`（可选 gzip），随时恢复 |
| 原始文件只读 | Codex / Kimi 的 session 文件永不被修改；凭证类目录永不读取 |

## 快速开始

### 1. 环境要求

- Rust（stable）与 Cargo
- Node.js 20+
- 系统 `git`（同步功能需要）
- Windows：WebView2（Win11 自带；Win10 一般已内置）+ MSVC 生成工具（或 MinGW-w64，见下）
- macOS / Linux：系统 WebView 依赖（WKWebView / WebKitGTK）

### 2. 开发运行

```bash
npm install
npm run tauri:dev      # 启动桌面应用（前端热更新 + Rust 后端）
```

### 3. 打包

```bash
npx tauri build                    # 产出可执行文件 + 安装包（NSIS/MSI/DMG/AppImage…）
npx tauri build --bundles nsis     # 只出 Windows NSIS 安装包
npx tauri build --no-bundle        # 只要可执行文件
```

本机实测产物：

```text
target/release/local-ai-chat-manager.exe                      9.4 MB
target/release/bundle/nsis/Local AI Chat Manager_0.1.0_x64-setup.exe   3.1 MB
target/release/bundle/msi/Local AI Chat Manager_0.1.0_x64_en-US.msi      4.4 MB
```

> 直接用 cargo 构建生产版需要开启 `production` 特性（否则会尝试连接 dev 服务器）：
> `cargo build --release -p local-ai-chat-manager --features production`

### 4. 想先试用？用演示数据

```bash
python tools/make_demo_data.py C:/tmp/aichat-demo   # 生成合成演示数据（假项目 / 假会话）
# 然后在「设置」里把 Codex 目录指向 <目录>/codex-home、KimiCode 目录指向 <目录>/kimi-home
```

### 5. 无界面自检（推荐先跑一遍）

```bash
cargo run -p aichat-core --bin aichat-cli -- detect        # 探测数据源
cargo run -p aichat-core --bin aichat-cli -- scan          # 增量扫描并建索引
cargo run -p aichat-core --bin aichat-cli -- list --limit 10
cargo run -p aichat-core --bin aichat-cli -- search "lazy deletion"
```

<details>
<summary>Windows：没有 MSVC 时如何编译（MinGW-w64 方案）</summary>

Tauri 官方推荐 MSVC 工具链。若机器上没有 Visual C++ 生成工具，可以用 MinGW-w64：

```bash
# 1) 安装 MinGW-w64（任选其一的来源）
#    本仓库提供了一个从清华 TUNA 镜像安装的脚本（无需管理员权限）
python tools/install_mingw.py C:/Users/<you>/tools/mingw64

# 2) 使用 GNU 工具链构建
rustup toolchain install stable-x86_64-pc-windows-gnu
set PATH=C:\Users\<you>\tools\mingw64\mingw64\bin;%PATH%
set CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER=C:\Users\<you>\tools\mingw64\mingw64\bin\x86_64-w64-mingw32-gcc.exe
cargo +stable-x86_64-pc-windows-gnu test -p aichat-core
```

注意：Tauri 的 Windows 打包（NSIS/MSI）在 MinGW 下不保证可用，正式发布请用 MSVC 工具链。
</details>

## 项目结构

```text
├── crates/aichat-core/      # 全部业务逻辑（不依赖 Tauri，可独立测试）
│   ├── src/adapters/        # Codex / Kimi / 同步仓库 三个 Adapter
│   ├── src/parser/          # JSONL 流式解析（容错）
│   ├── src/scanner/         # 增量扫描（指纹）+ 文件监听（debounce）
│   ├── src/storage/         # SQLite + FTS5 索引
│   ├── src/sync/            # Git 快照同步（命令封装、快照、编排）
│   ├── src/archive/         # zstd / gzip 归档
│   ├── src/bin/aichat_cli.rs# 命令行自检与性能测试
│   └── tests/               # 适配器 / 端到端 / 多机同步 集成测试
├── src-tauri/               # Tauri 2 外壳（IPC 命令、文件监听、插件）
├── src/                     # React 前端（会话 / 搜索 / 同步 / 设置）
├── tests/fixtures/          # 合成测试数据（含生成脚本）
└── docs/                    # 架构 / 适配器 / Git 同步 / 限制 / 路线图
```

## 文档

- [架构说明](docs/ARCHITECTURE.md) — 分层、数据流、性能设计与关键取舍
- [Adapter 说明](docs/ADAPTERS.md) — Codex / Kimi 真实文件格式与归一化规则
- [Git 同步说明](docs/GIT-SYNC.md) — 仓库结构、同步流程、多机与冲突处理
- [已知限制](docs/LIMITATIONS.md) — 明确不支持的场景与取舍
- [路线图](docs/ROADMAP.md) — 后续计划

## 安全与隐私

- **永不读取、永不复制、永不提交** `credentials/`、`token`、`auth.json`、私钥等敏感路径（代码中有硬性红线校验，并有测试覆盖）；
- AI 会话可能包含源代码、命令输出、内网地址与密钥，**请务必使用 Private 仓库**；
- 所有同步数据都由「复制 / 快照」产生，绝不修改 AI 工具自己的数据目录。

## 测试

```bash
cargo test -p aichat-core           # 单元 + 适配器 + 端到端 + 只读保证 + 多机 Git 同步
cargo run -p aichat-core --release --bin aichat-cli -- bench --sessions 10000 --messages 100
cargo run -p aichat-core --release --bin aichat-cli -- bench-session --size-mb 100
npm run typecheck && npm run build  # 前端类型检查与打包
```

## 验证结果（本机实测）

全部命令都在本机真实数据上跑过，输出如下（详见 [docs/LIMITATIONS.md](docs/LIMITATIONS.md) 的「性能边界」）：

```text
# 真实数据：325 个会话 / 77,263 条消息（Codex 186 + Kimi 141）
aichat-cli scan            → 解析 325，跳过 0，失败 0，耗时 26.4s，索引 402 MB
aichat-cli scan（二次）     → 解析 0，跳过 325，耗时 91 ms          ← 增量：未变化不重解析
aichat-cli search "lazy deletion"  → 命中 3 条，耗时 3 ms
aichat-cli search "AGENTS.md"      → 命中 3 条，耗时 11 ms

# 合成数据：100 万条消息
aichat-cli bench --sessions 10000 --messages 100
  → 写入 1,000,000 条 43s（≈2.3 万条/秒），索引 249 MB
  → 搜索（单关键词命中 20 万条的极端情况）p50 288 ms / p95 305 ms

# 大会话：100 MB 单个 JSONL（181,668 条消息）
aichat-cli bench-session --size-mb 100
  → 解析 7.5s（13.4 MB/s），峰值内存 31 MB   ← 流式解析，不整体进内存

# 桌面应用
npx tauri build --bundles nsis
  → 产出 target/release/local-ai-chat-manager.exe + NSIS 安装包（3.1 MB）
  → 运行 exe：自动探测数据源、建立索引（325 会话 / 77,263 消息）、监听两个会话目录、渲染完整界面

# 前端视觉与无障碍（截图 + 断言，见 docs/UI-QA.md）
npm run ui:qa                     → 横向溢出 / 嵌套滚动 / 焦点可达 / 大列表虚拟化
npm run ui:a11y                   → 深色与浅色主题的 WCAG AA 对比度审计

# 代码质量（规格 §31：每阶段都跑 formatter 与 lint）
cargo fmt --all -- --check        → 无格式差异
cargo clippy -p aichat-core --all-targets   → 0 warning
cargo clippy -p local-ai-chat-manager       → 0 warning
```

`cargo test -p aichat-core` 共 **41 个测试**：单元 28、Adapter 6、端到端 2、只读保证 2、
多机 Git 同步 2、搜索性能剖析 1。

## License

MIT
