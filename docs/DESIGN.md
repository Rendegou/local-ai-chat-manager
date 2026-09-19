# DESIGN.md — Local Chats 界面规范

> 本文件是**可执行规范**，不是设计宣言。每一条都对应 `src/index.css` 里的令牌或共享组件里的实现，
> 可以用 `npm run ui:qa` 与 Impeccable detector 验证。
> 上游问题清单见 `docs/DESIGN_AUDIT.md`；历史探索记录见 `docs/FRONTEND_VISUAL_REDESIGN.md`。
>
> 本文件优先级高于：临时视觉偏好、既有不良 UI 模式、通用组件库默认值、「让它更好看」的解读。

## 0. 一条铁律

**能用排版解决就不加颜色，能用留白解决就不加边框，能用边框解决就不加阴影，能不用 Card 就不用 Card。**

推论（可直接判定）：

- 静态表面（Button / Input / Card / 导航 / 列表行）**一律禁止 `box-shadow`**。
- 阴影只允许出现在真正浮起的层：Dropdown、Popover、Drawer、Dialog、Quick Search。
- 铜色（accent）只出现在 Primary 按钮、链接、搜索命中、键盘 focus ring，视觉面积 ≤ 5%。
- 同一屏**最多一个 Primary Action**。

---

## 1. Spacing

唯一允许的间距阶梯（像素）：

| 令牌 | 值 | 用途 |
| --- | --- | --- |
| `1` | 4px | 图标与文字、行内元素之间 |
| `2` | 8px | 控件内边距、紧凑堆叠 |
| `3` | 12px | 表单字段之间、卡片内边距 |
| `4` | 16px | 分组内边距、页面水平边距 |
| `6` | 24px | 分组之间 |
| `8` | 32px | 页面主分区之间 |
| `12` | 48px | 空状态上下留白 |

规则：

- 不在上表里的值不得用于新的间距。
- 垂直节奏靠间距，不靠边框：分组之间用 `24px` 间距或一条 `1px divider`，**不要两者都用**。
- 页面内容区水平内边距固定 `16px`（`p-4`）；宽屏内容区在此基础上用 `mx-auto max-w-[720px]` 居中。

---

## 2. Typography

六档，不多不少。

| 角色 | 令牌 | 字号 | 字重 | 行高 | 用途 |
| --- | --- | --- | --- | --- | --- |
| Page title | `text-title` | 16px | 600 | 1.4 | 每页唯一的 `h1` |
| Section title | `text-section` | 14px | 600 | 1.5 | 设置分组、面板标题 |
| Body | `text-body` | 14px | 400 | 1.65 | 正文、控件文本、消息内容 |
| Secondary | `text-ui` | 13px | 400 | 1.5 | 侧栏行、按钮、列表次级信息 |
| Caption | `text-meta` | 12px | 400 | 1.5 | 元数据：路径、时间、设备、状态 |
| Technical | `text-tech` | 11.5px | 400 | 1.45 | 仅等宽技术标识：序号、hash、快捷键 |

规则：

- 字号下限：正文与控件 ≥ 13px，元数据 12px，只有技术标识允许 11.5px 等宽。
- 层级靠「字号 × 字重 × 字距」三者拉开，不能只靠字号。
- 拉丁字形用打包的 Inter，CJK 回落系统栈；等宽优先 JetBrains Mono / Cascadia Code。
- **数字一律 `tabular-nums`**：计数、体积、耗时、时间戳、序号。它们对齐才能被快速扫描。
- 时间日期统一走 `Intl.DateTimeFormat`（见 `src/lib/format.ts`），不手工拼接字符串。
- 长路径与状态文本必须 `truncate`，但**不得把标题挤到不可见**（标题不参与 `flex-1` 竞争）。

---

## 3. Colors

### 表面四层 + 交互态

| 令牌 | 深色 | 浅色 | 用途 |
| --- | --- | --- | --- |
| `--surface-canvas` | `#111214` | `#f5f4f2` | 应用背景 |
| `--surface-panel` | `#151619` | `#edecea` | 侧栏、列表栏、设置分组底 |
| `--surface-reading` | `#111214` | `#f5f4f2` | 正文阅读区 |
| `--surface-raised` | `#1d1f22` | `#ffffff` | 用户消息、工具块 |
| `--surface-overlay` | `#212327` | `#ffffff` | 浮层（唯一允许投影的表面） |
| `--surface-field` | `#1b1c1f` | `#ffffff` | 输入框 / 下拉触发器 |
| `--surface-hover` | `rgba(255,255,255,.035)` | `rgb(28 25 20 / .045)` | hover |
| `--surface-selected` | `rgba(255,255,255,.065)` | `rgb(28 25 20 / .07)` | 选中（完整背景） |
| `--surface-selected-soft` | `rgba(255,255,255,.045)` | `rgb(28 25 20 / .05)` | 选中（来源/项目等次级层级） |

### 文字与线

| 令牌 | 用途 | 对比度要求 |
| --- | --- | --- |
| `--ink` | 主要文字 | ≥ 12:1 |
| `--ink-muted` | 元数据 | ≥ 4.5:1（AA） |
| `--ink-faint` | 三级信息、禁用态 | ≥ 4.5:1（在选中背景上也必须达标） |
| `--line` | 结构分隔线 | — |
| `--line-strong` | 控件边框、hover 边界 | — |
| `--line-subtle` | 列表行 hairline | — |

### 语义色

`--semantic-accent`（铜）/ `--semantic-success` / `--semantic-warning` / `--semantic-danger` / `--semantic-info`。
另有两个**来源识别色**（`--source-codex` / `--source-kimi`）：只用于「来自哪个工具」，
**不承担成功/失败含义**，且始终与文字标签同时出现。

### 占比

一屏内大约 **70% 安静**（canvas / panel / 无彩文字）、**20% 中等**（selected / hover / 边框）、
**10% 强调**（铜色、语义色、来源色）。超过这个比例就说明用色代替了层级。

---

## 4. Radius

三档，主区域一律 `0`：

| 令牌 | 值 | 用途 |
| --- | --- | --- |
| `--radius-chip` | 4px | 徽标、Chip、色点容器、小标签 |
| `--radius-control` | 6px | 按钮、输入框、下拉、列表行选中 |
| `--radius-panel` | 8px | 工具块、用户消息、浮层、Card |

主内容区之间**只用 1px 结构分隔线**，不用圆角或投影分隔。

---

## 5. Shadow

只有浮层能有阴影，全项目只使用一个令牌：

```css
/* 深色 */
--depth-overlay: 0 2px 6px rgb(0 0 0 / .32), 0 18px 44px rgb(0 0 0 / .42);
/* 浅色 */
--depth-overlay: 0 2px 6px rgb(48 40 28 / .1), 0 20px 48px rgb(48 40 28 / .15);
```

允许使用 `--shadow-overlay` 的组件，仅此五类：

1. Dropdown（`Select` 的 listbox）
2. Popover（`Menu`）
3. Drawer（`SourcePane` / `SourceManagerDrawer` 的窄窗口形态）
4. Dialog（`Overlay`）
5. Quick Search（Ctrl+K 面板）

`--shadow-panel` / `--shadow-raised` / `--shadow-sunken` / `--shadow-msg` 保留令牌名但值为 `none`。
**静态 Button、Input、Card、导航、列表禁止任何 `box-shadow`，包括 `inset`。**

---

## 6. 每页最多一个 Primary Action

| 页面 | Primary | Secondary |
| --- | --- | --- |
| 会话 | 扫描本地会话（仅索引为空时） | 全部筛选与列表操作 |
| 搜索 | 搜索 | 高级筛选、清除、加载更多 |
| 同步 | 由状态唯一决定（立即同步 / 保存远端并同步 / 去设置 / 重试同步） | 刷新、打开仓库 |
| 设置 | 保存（仅在有未保存修改时） | 还原、添加来源、导入会话 |

判定方法：在同一屏内数 `tone="primary"` 的 `<Button>`，超过 1 个就是缺陷。
`clean` 状态的同步页应显示 0 个 Primary。

---

## 7. 组件规范

### Button

| 尺寸 | 高度 | padding-x | 字号 | icon |
| --- | --- | --- | --- | --- |
| `sm`（面板内、列表行） | 28px | 10px | 12px | 12px |
| `md`（默认，工具栏与表单） | 32px | 12px | 14px | 14px |
| `lg`（页面级 Primary） | 36px | 16px | 14px | 14px |

- 状态：`hover` 只改表面色 → `active` 加深 → `focus-visible` 外 outline → `disabled` 降低对比但**文字仍可读**（opacity ≥ 0.55）→ `loading` 保持宽度不跳动。
- 不依赖颜色单独表达语义：`danger` 必须同时带图标或写清后果。
- 禁止 `transition: all`；只过渡 `background-color` / `color` / `border-color` / `filter`，120ms。

### Input / Select / DateInput

- 高度 **36px**（`h-9`），padding-x 12px，字号 14px。
- 真实 `border: 1px solid var(--line)`；hover `--line-strong`；invalid `--semantic-danger`。
- **只有一个焦点边界**：键盘 focus 用外 `outline`（2px accent + 2px offset）；
  鼠标 focus 只改 border-color。程序化 `autoFocus` 不显示外层铜色圈。
- Select 触发器：`role="combobox"` + `aria-haspopup="listbox"` + `aria-expanded` + `aria-controls`。
  `value` 不在 options 中时 `selected` 必须是 `undefined` 并显示 placeholder，
  **禁止静默显示第一个 option**。options 为空时禁用并显示「无可用选项」。

### Table / 列表行

- 行高 32–34px；行间 `1px --line-subtle`；整列平铺，无圆角、无投影。
- 层级信息：主文本 14px/400–500 → 次文本 12px/400 muted → 技术标识 11.5px mono。
- 选中态见 §8，禁止任何 inset 阴影。

### Card

**只用于**：

1. 真正独立的对象（用户消息、工具调用/结果块）；
2. 危险状态（Danger Zone）；
3. 临时浮层。

**不用于**：表单分组、页面分区、信息展示（`SettingsPage` / `SyncPage` 的普通分组）。
表单分组优先使用「标题 + 间距 + divider」。Card 内边距 16px，圆角 `--radius-panel`。

### Dialog / Drawer / Dropdown（`Overlay`）

- portal 挂载；`role="dialog"` + `aria-modal="true"` + `aria-labelledby`。
- 打开时保存触发器焦点；`Tab`/`Shift+Tab` 焦点圈定；`Escape` 关闭；关闭后恢复触发器焦点。
- 背景区域 `inert`；overlay 内 `overscroll-behavior: contain`。
- 入场动画：120–160ms `opacity` + `transform`，`prefers-reduced-motion` 下禁用。

### Tabs / SegmentedNav

- 高度 32px，圆角 `--radius-control`，active = `bg-selected` + `text-ink`。
- `aria-current="page"`（页面级）或 `aria-selected`（分段控件）。
- 无左侧竖条、无阴影、无渐变。

### Badge / StatusPill

- 高度 20px（sm 16px），padding-x 8px，圆角 `--radius-chip`，字号 12px（sm 11.5px）。
- **必须带图标或色点**，不允许只靠背景色表意。
- 来源色点只做识别，不承担 active / 选中语义。

---

## 8. 选中态分层

三个层级必须用三种不同表达，**全部禁止 inset 阴影与左侧铜条**：

| 层级 | 表达 | 令牌 |
| --- | --- | --- |
| 全局导航 active | 完整中性背景 + `text-ink` + `font-medium` | `bg-selected` |
| 来源 / 项目 active | 轻中性背景 + `font-medium` | `--surface-selected-soft` |
| 会话 active | 整行中性背景 + 标题对比度提升 | `bg-selected` |

铜色保留给：Primary 按钮、链接、搜索命中 `<mark>`、键盘 focus ring。

---

## 9. 数据源模型（前端派生视图）

`SourceView` 是「产品支持的能力」与「本机实际拥有」的统一表达，由 `src/lib/sources.ts`
的纯函数 `buildSourceViews(catalog, rows, settings)` 派生。**不新增 IPC schema，不修改 Rust adapter 注册表。**

规则（固定，不可在页面里就地改写）：

```
found      = SourceRow.found === true
configured = settings.sources[id].path 是非空字符串
hasHistory = SourceRow.sessionHint > 0

visibleInSidebar           = found || configured || hasHistory
visibleInSearch            = hasHistory
visibleInConnectedSettings = found || configured || hasHistory
                             || status === 'partial' || status === 'error'
needsAttention             = status === 'partial' || status === 'error'
                             || (configured && status === 'missing')
```

- 单纯「产品支持但本机未发现」**不算错误**，不触发顶部警告，也不进入已连接来源列表——
  它只出现在「添加来源」抽屉的候选中。
- Catalog 中不存在但 `SourceRow` 有历史的来源仍必须生成 `SourceView`，
  否则导入/同步历史会从界面上消失。
- 排序沿用 Catalog 顺序，未知来源排在末尾。

消费方：

| 界面 | 使用的子集 |
| --- | --- |
| 会话页 SourcePane | `visibleInSidebar` |
| 搜索页来源筛选 | `visibleInSearch` |
| 设置已连接来源 | `visibleInConnectedSettings` |
| 添加来源抽屉 | 未连接的 Catalog 来源 |
| 标题栏警告 | `needsAttention` |

---

## 10. 页面信息架构

### App Shell

```
[ skip link → #main-content ]
┌──────────────────────────────── 46px 标题栏 ────────────────────────────────┐
│ 品牌 · 扫描进度 · needsAttention 警告 · 快速搜索 · 同步状态 · 更多操作 · 窗口控制 │
├──────┬───────────────────────────────────────────────────────────────────────┤
│ Rail │  页面主体（<main id="main-content">）                                  │
│ 72px │                                                                       │
└──────┴───────────────────────────────────────────────────────────────────────┘
```

- Rail 四项：会话 / 搜索 / 同步 / 设置，icon + 中文标签，`≥768px` 恒在。
- `<768px`：Rail 收进标题栏导航 Drawer；会话上下文另有一个独立 Drawer，**两者状态不复用**。

### 会话页

- `≥1280px`：SourcePane（208px）+ 会话列表（336px）+ 阅读器。
- `768–1279px`：会话列表 + 阅读器；SourcePane 由列表 Header 的「来源与项目」按钮打开抽屉。
- `<768px`：两级视图（列表 → 详情）。

### 搜索页

- 首屏四个决策点：关键词、搜索、排序、已启用筛选 chips。
- 高级筛选（来源 / 项目 / 设备 / 日期 / 仅正文）默认收起，**无 Card**，内联 section。
- 条件状态分 draft / applied 两组；排序与筛选在有结果时自动刷新（250ms 防抖）。
- 关键词改动未提交时明确提示「关键词已修改，按 Enter 更新」。

### 同步页

- Header 只保留「刷新」与「打开仓库」。
- 一个扁平 `SyncSummary` 按决策顺序排列：仓库 → 远端 → 分支 → 最近拉取/推送 →
  待同步会话/字节/本地变更/ahead·behind → 隐私提示 → 推荐下一步 → **唯一主操作**。
- 普通状态不用大型彩色 Notice；只有错误、冲突、隐私风险使用 Notice。
- 上一次同步结果、归档、Git 日志、数据源收进折叠的高级区域。

### 设置页

- `≥1024px`：左侧 168px 分区导航（数据源 / 同步与隐私 / 扫描与归档 / 外观与行为 / 诊断与安全），
  右侧内容最大宽度 720px。
- `<1024px`：分区导航收成页面顶部 Select，单列表单，不产生横向滚动。
- 数据源区每个来源**一行**：名称 · 状态点 + 文本 · 会话数 · 截断路径或「自动发现」 · Toggle · 「配置」。
  路径编辑、添加来源、导入会话移入 `SourceManagerDrawer`。
- 离开保护与草稿机制沿用 `src/stores/library.ts`，不新建状态。

---

## 11. 动效

- 最后处理，改完布局与状态之后再评估是否需要。
- 只允许短时 `opacity` / `transform`，120–160ms。
- 不做 scale / translate / glow 类「设计感动画」。
- `prefers-reduced-motion: reduce` 下全部压成瞬时（全局规则负责）。

---

## 12. 可访问性契约

- 每个页面**恰好一个 `h1`**（`PanelHeader headingLevel={1}`）；会话列表与阅读器用 `h2`，内部分区用 `h2`/`h3`。
- App 最前有可聚焦 skip link，指向 `<main id="main-content">`。
- 所有图标按钮必须有 `aria-label`；所有可聚焦元素的焦点环在深浅两色下都可见。
- 每个异步区域用 `aria-live="polite"` 宣告状态变化（搜索更新、同步进度、导入结果）。
- 键盘可达性由 `npm run ui:qa` 断言，不靠人工检查。
