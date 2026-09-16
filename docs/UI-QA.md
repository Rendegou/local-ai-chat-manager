# 前端视觉 QA（截图基线）

视觉重构不能只靠“看起来对”。这里记录一套**确定性**的截图流程：同样的数据、同样的视口、
同样的主题，任何一次改动都能和基线逐张对比。

## 为什么不用桌面窗口截图

桌面截图受 DPI 缩放、窗口位置、窗口遮挡影响，点击坐标不可复现，同一份代码可能拍出不同结果。
本项目前端是纯 Web 层（Tauri 只是外壳），因此改用系统自带的 Edge（headless）加载同一个前端，
把 Tauri IPC 换成 mock 数据 —— 数据依然来自**真实内核**（Rust 扫描出的 SQLite 索引），
只是不再需要窗口。

## 三步流程

```bash
# 1) 生成合成演示数据（假项目、假会话，可安全截图与分享）
npm run ui:demo

# 2) 用真实内核扫描这份演示数据，再把索引导出成 IPC 同形的 mock JSON
cargo run -p aichat-core --bin aichat-cli -- scan --data-dir .ui-shots/demo-index
npm run ui:mock

# 3) 起前端开发服务器，然后按「页面 × 主题 × 视口 × 状态」批量截图
npm run dev            # 另开一个终端
npm run ui:shots -- --out .ui-shots/phase4 --states normal,empty,conflict
```

产物在 `.ui-shots/<阶段>/`（已 gitignore，用命令可随时重建）：
`<页面>-<主题>-<宽度x高度>[-状态].png`，例如 `conversations-dark-1440x900-empty.png`。

## 覆盖矩阵（规格 §8 Phase 0）

| 维度 | 取值 |
| --- | --- |
| 页面 | conversations / search / sync / settings |
| 主题 | dark / light |
| 视口 | 1440×900、1180×800、900×700 |
| 状态 | normal（正常数据）/ empty（无数据、未配置同步）/ conflict（同步冲突） |

演示数据刻意包含这些样本：16 条消息的长会话、`partial`（含未识别事件）、0 条消息的空会话、
4 个项目、两个数据源各半。

## 桌面端补充验证

浏览器截图覆盖布局与排版；涉及真实窗口的行为（文件监听刷新、窗口缩放拖动、系统文件选择框）
仍需在桌面端手动验证，最终交付前用 `npx tauri build` 出的安装包跑一遍。
