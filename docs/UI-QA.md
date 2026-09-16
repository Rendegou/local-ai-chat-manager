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

## 自动断言（npm run ui:qa）

截图靠人看，回归靠断言。`tools/ui_qa.mjs` 覆盖四类容易悄悄坏掉的问题：

| 断言 | 判据 | 为什么需要 |
| --- | --- | --- |
| 横向溢出 | `documentElement.scrollWidth ≤ 视口宽 + 1` | 文字放大到 200% 时，`truncate` 的 nowrap 文本与 rem 栏宽最容易把整页撑宽 |
| 嵌套滚动 | 阅读区内不再有可滚动元素 | 双重滚动会让长消息难以阅读（规格 §8 验收项） |
| 焦点可达 | Tab 20 步内每个焦点元素都有可访问名称且可见 | 键盘用户不该掉进「看不见的焦点」 |
| 大列表虚拟化 | 2000 个会话时渲染行数 ≤ 60、DOM 节点 ≤ 4000 | 防止有人把虚拟列表改回全量渲染 |

会话行的选择器是 `button[data-row="session"]`（改 SessionRow 结构时保持这个钩子）。

## 组件画廊（组件级重设计的验收工具）

`tools/gallery_shot.mjs` 按「区块 × 主题」截取 `?gallery` 页面：

```bash
npm run dev            # 另开一个终端
node tools/gallery_shot.mjs --out .ui-shots/gallery
```

区块清单在脚本的 `SECTIONS` 里；表单控件区块会额外拍一张下拉展开态（`inputs-open-*.png`）。
规则：**组件先在画廊里过关（全状态、深浅双主题），才允许进页面。**

对比度审计（`npm run ui:a11y`）用 1×1 canvas 把 `oklch()` 等现代颜色转成 sRGB 后再算对比度 ——
直接解析字符串会把 `oklch(0.2 0.005 265)` 当成 rgb 读，得出完全错误的结论。

## 已知的排版脆弱点（修过，别再犯）

- `truncate` 必须与 `min-w-0 flex-1` 一起用：`white-space: nowrap` 的固有宽度会传播到父容器，
  文字放大后能把整个文档撑宽；
- 固定栏宽用 px（`w-[224px]`）而不是 rem（`w-56`）：仅文字放大时 rem 会翻倍，栏宽失衡；
- 阅读区需要 `overflow-hidden` + `min-w-0`：否则其固有内容宽度会参与整页布局计算。
