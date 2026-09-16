# Local AI Chat Manager

本地 AI 编程会话管理工具，用于整理和搜索 **OpenAI Codex**、**Kimi Code CLI** 的历史会话，也可以通过独立的 Git 仓库在多台电脑之间同步。

> 当前版本：**0.2.0 Beta（接近 Demo）**。Windows 已完成主要功能验证；macOS 和 Linux 尚未进行真机测试。

技术栈：Tauri 2、Rust、React、TypeScript、SQLite FTS5。

![会话浏览](docs/images/demo-conversations.png)

截图使用合成演示数据，不包含真实会话。

## 功能

- 自动发现 Codex 和 Kimi Code CLI 的本地会话
- 按项目、时间和数据源浏览历史记录
- 使用 SQLite FTS5 全文搜索
- 增量扫描，只处理新增或变化的文件
- 通过 Git 在多台电脑间同步会话副本
- 对旧会话进行 zstd / gzip 归档
- 不修改 AI 工具原始会话文件

## 当前状态

项目仍处于 Beta 阶段，适合试用和反馈，不建议直接用于唯一的数据备份。

- Windows：已完成构建、安装包和主要流程测试
- macOS / Linux：已有平台适配代码和打包配置，尚未在真机验证
- 多机同步：自动化测试已覆盖，真实设备迁移仍需进一步测试
- 发布包：暂未提供，请从源码运行

已知限制见 [docs/LIMITATIONS.md](docs/LIMITATIONS.md)。

## 从源码运行

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

## Git 同步

应用使用一个单独的 Git 仓库保存会话副本，不会把当前项目代码仓库当作同步仓库。

1. 在设置中选择本地同步目录
2. 填写 GitHub、GitLab、Gitea 或自建 Git 服务的远端地址
3. 使用系统 Git 完成认证
4. 在同步页面执行同步

应用本身不保存 GitHub 密钥。HTTPS 认证由 Git Credential Manager 处理，SSH 认证使用系统已有的 SSH Key。

会话可能包含源码、命令输出或内部地址，建议将同步仓库设为 Private。

## 数据与隐私

- 原始 Codex / Kimi 会话文件只读
- 同步内容来自复制生成的快照
- 凭据、Token、私钥和认证文件不会进入同步目录
- 首次正式迁移前建议先备份原始会话目录

## 测试

```bash
cargo test -p aichat-core
npm run typecheck
npm run build
npm run ui:qa
npm run ui:a11y
```

测试覆盖解析、增量索引、搜索、归档、多机 Git 同步及主要前端布局。测试结果不等同于所有平台的生产验证。

## 项目结构

```text
crates/aichat-core/  Rust 核心逻辑、存储、搜索与同步
src-tauri/           Tauri 桌面端入口与 IPC
src/                 React 前端
tests/fixtures/      合成测试数据
docs/                架构、同步协议、限制与路线图
```

## 文档

- [架构说明](docs/ARCHITECTURE.md)
- [数据适配](docs/ADAPTERS.md)
- [Git 同步](docs/GIT-SYNC.md)
- [已知限制](docs/LIMITATIONS.md)
- [路线图](docs/ROADMAP.md)

## License

MIT
