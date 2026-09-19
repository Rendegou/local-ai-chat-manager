# UI 设计审计（二次重构基线）

> 审计对象：2026-09-19 工作区未提交 WIP（`git status` 中 `M` 与 `??` 的全部前端文件）。
> 审计范围：`src/app`、`src/components/ui`、`src/features`、`src/lib`、`src/stores`、`src/index.css`。
> 审计方式：代码阅读 + `.ui-shots/latest` 既有截图（1440 / 1180 / 900 三档视口，深色与浅色）+ `tools/ui_qa.mjs` 现有断言。
>
> 前置说明：现有基线**可运行**（`npm run build`、五档 headless 布局检查、Impeccable detector 0 findings 均通过）。
> 本审计不否定这一点——下面 10 项是**设计层**问题，不是构建或运行问题。

## 摘要

| 编号 | 优先级 | 问题 | 主要位置 |
| --- | --- | --- | --- |
| 1 | P1 | 来源能力与本机实际来源混淆 | `SourceSidebar.tsx` / `SettingsPage.tsx` / `SearchPage.tsx` / `lib.rs` |
| 2 | P1 | Settings 数据源形成整页配置墙 | `SettingsPage.tsx` |
| 3 | P1 | 导入来源显示值与真实值可能不同 | `ImportPanel.tsx` / `Inputs.tsx` |
| 4 | P1 | 全局导航和会话上下文共用一个 Sidebar | `App.tsx` / `SourceSidebar.tsx` |
| 5 | P1 | 搜索条件和结果状态可能不一致 | `SearchPage.tsx` |
| 6 | P1 | 同步页存在重复主操作 | `SyncPage.tsx` |
| 7 | P2 | 三个信息层级共用铜色左侧阴影 | `Rows.tsx` / `SessionList.tsx` / `index.css` |
| 8 | P2 | Settings/Sync 仍有过多 Card 和封闭边框 | `Surfaces.tsx` / `SettingsPage.tsx` / `SyncPage.tsx` |
| 9 | P2 | Overlay 与自绘 Select 无障碍契约不完整 | `Surfaces.tsx` / `Inputs.tsx` / `QuickSearch.tsx` |
| 10 | P2 | 共享层级和格式规范仍未完全统一 | 多处 |

---

## 1. P1 — 来源能力与本机实际来源混淆

**当前代码位置**

- `crates/aichat-core/src/adapters/registry.rs:19-29`：`catalog()` 固定返回 8 个来源
  （codex / kimi / cursor / zcode / claude / gemini / workbuddy / doubao-work），
  每个都带 `access`（`native` / `import`）与静态 `description`。
- `crates/aichat-core/src/lib.rs:305-315`：`source_catalog` 把 `SourceRow.found` 折算成
  `status`（`available` / `missing` / …），但**「能力存在」这件事本身已经在列表里**。
- `src/features/settings/SettingsPage.tsx:125`：`sourceCatalog.map(...)` 无过滤条件，
  8 个来源全部展开成带 Toggle、状态文案、目录输入框、说明的整块区域。
- `src/features/conversations/SourceSidebar.tsx:44-48` + `96-109`：
  `SOURCE_ORDER = sourceCatalog.map(s => s.id)`，再把 `sources` 里未出现在 catalog 的补在后面。
  Catalog 里的每一项都会渲染成一行来源，`count` 取 `SourceRow.sessionHint ?? 0`。
- `src/features/search/SearchPage.tsx:220-226`：来源下拉硬编码 4 个选项（Codex / Kimi Code / Cursor / ZCode）。
- `src/app/App.tsx:213` + `254-261`：`missingSources = sources.filter(s => !s.found)`，
  数量 > 0 就在标题栏显示警告图标，并把用户送到设置页。

**用户影响**

用户装的是「Codex + Kimi」，但界面同时告诉他：数据源有 8 个，其中 6 个「未发现」，
标题栏还有一个警告图标催他去设置页处理。这制造了两个错误认知：

1. 以为产品有 6 项功能坏掉了（实际是这 6 个工具本机没装）；
2. 以为「未发现」是一种需要修复的故障状态（实际是正常情况）。

更糟的是侧栏来源列表把「Codex（15 个会话）」和「Claude Code（0 个会话）」渲染成完全同构的行，
只差一个数字。用户无法一眼看出「哪些是我真实拥有的历史，哪些只是产品支持的能力」。

**推荐方案**

引入**派生的前端视图模型** `SourceView`（见 `docs/DESIGN.md` §数据源模型），把
「产品支持」与「本机实际拥有」分开，并让三个界面各自只消费自己的子集：

- `visibleInSidebar = found || configured || hasHistory`
  → 侧栏只显示本机真实存在的来源；Cursor / Claude 在未安装时不出现。
- `visibleInSearch = hasHistory`
  → 搜索来源筛选只列出真的有历史的来源（避免选了必定零结果）。
- `visibleInConnectedSettings = found || configured || hasHistory || status === 'partial' || status === 'error'`
  → 设置里已连接来源列表只显示需要管理的来源；普通 `missing` 候选不做展示。
- `needsAttention = status === 'partial' || status === 'error' || (configured && status === 'missing')`
  → 标题栏警告只对「真的出问题了」的来源计数；单纯未安装**不算错误**、不触发警告。
- 未安装但仍可用的候选来源，进入「添加来源」抽屉（`SourceManagerDrawer` 的 add 模式）。

**优先级 P1** —— 这是本次重构中影响面最大的一项：它同时污染会话页、搜索页、设置页和标题栏。

---

## 2. P1 — Settings 数据源形成整页配置墙

**当前代码位置**

- `src/features/settings/SettingsPage.tsx:124-143`：`SectionCard` 内 `sourceCatalog.map`，
  每个来源渲染 `<div className="border-b border-line pb-4 last:border-0">`，
  内部包含：`Toggle`（名称 + 拨杆）、`access` + `status` 拼接文案、
  `FormField` + `DirectoryInput`（原生来源）、`description`、`notes` 段落。
- 同一个 `<div className="mx-auto flex w-full max-w-[980px] flex-col gap-4">`（第 117 行）
  里还串了另外 5 个 `SectionCard`：导入、同步与隐私、扫描与归档、外观与行为、诊断、Danger Zone。

**用户影响**

8 个来源 × （Toggle 行 + 目录输入行 + 说明文本）≈ 视觉上 24–32 行，占据了设置页首屏的**全部**空间。
用户为了改一个「归档阈值」必须滚过整段数据源配置。同时因为每一项都展开同等详细程度，
「Codex（已发现，有 15 个会话）」和「Gemini CLI（未发现，无历史）」消耗的注意力是一样的——
而前者才是用户真正需要管理的对象。

这是「把所有配置项一次性摊平」的典型症状：信息完备，但没有编辑优先级。

**推荐方案**

按 `docs/DESIGN.md` 的设置页信息架构改：

1. 宽屏（≥1024px）分两栏：左侧 168px 分区导航（数据源 / 同步与隐私 / 扫描与归档 / 外观与行为 / 诊断与安全），
   右侧内容区最大宽度 720px。窄屏降级为页面顶部 Select + 单列表单。
2. 数据源区只渲染 `visibleInConnectedSettings` 的来源，**每个来源一行**：
   名称 · 状态点 + 文本 · 会话数 · 截断路径或「自动发现」 · enabled Toggle · 「配置」文字按钮。
   **不在主页面展开路径输入框**。
3. 路径编辑、添加来源、导入会话移入 `SourceManagerDrawer` 抽屉（模式：`add` / `configure` / `import`）。
4. 主页面 Header 只保留两个 Secondary 操作：「添加来源」「导入会话」，保存/还原沿用 store 里的草稿机制。

**优先级 P1** —— 设置页是用户遇到问题时的必经之路，当前形态让人不愿意打开它。

---

## 3. P1 — 导入来源显示值与真实值可能不同

**当前代码位置**

- `src/features/settings/ImportPanel.tsx:11`：`const [source, setSource] = useState('doubao-work')`。
- 同文件 `:45`：`options={[...catalog.map(s => ({ value: s.id, label: s.displayName })), { value: 'custom', ... }]}`。
  `catalog` 来自 `source_catalog`，真实环境里包含 `doubao-work`；但在**任何 catalog 不含
  `doubao-work` 的场景**（mock、精简 catalog、后端将来改名）下，初始值就落在 options 之外。
- `src/components/ui/Inputs.tsx:113-114`：
  ```ts
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value))
  const selected = options[selectedIndex]
  ```
  `findIndex` 返回 `-1` 时被 `Math.max(0, ...)` 抬成 `0`，于是触发器渲染 `options[0].label`。
- 同文件 `:198`：`<span className="min-w-0 flex-1 truncate">{selected?.label ?? ''}</span>` 显示的是这个被抬上来的项。

**用户影响**

组件显示「Codex」，但 `sourceId` 变量里是 `doubao-work`。用户点「下载 JSON 模板」，
拿到的是豆包格式模板，界面却写着 Codex；点「预览导入」，会话被存进 `doubao-work` 来源下，
而用户以为自己导入的是 Codex 会话。这是**静默的数据归属错误**——错误的来源标识会一路进索引，
影响后续的来源筛选与同步目录结构。

同时这个 `Math.max(0, ...)` 也影响所有其它 Select：任何「当前值不在 options 中」的场景
（例如筛选器选项随数据变化而失效）都会静默显示第一项，让用户以为筛选已生效。

**推荐方案**

1. `Select` 修正语义：`findIndex` 返回 `-1` 时 `selected` 必须是 `undefined`，
   并且**允许 `value` 为空字符串**表示「未选择」。
   ```ts
   const selectedIndex = options.findIndex((option) => option.value === value)
   const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined
   ```
   键盘高亮仍需要一个落点，单独用 `activeIndex = selectedIndex >= 0 ? selectedIndex : 0`。
2. 触发器在 `!selected` 时显示显式 placeholder（「请选择来源」），而不是空白或第一项。
3. `options.length === 0` 时禁用触发器并显示「无可用选项」。
4. `ImportPanel` 初始 `source` 为空字符串，不再硬编码 `doubao-work`；
   未选择合法来源时禁用「下载模板 / 预览 / 确认」三个动作。
5. Import 选项只包含 `access === 'import'` 的来源 + 自定义来源，不把原生来源混进导入列表。

**优先级 P1** —— 会产生错误持久化数据的静默 bug。

---

## 4. P1 — 全局导航和会话上下文共用一个 Sidebar

**当前代码位置**

- `src/app/App.tsx:341-351`：`sidebarVisible = useMinWidth('xl')`（1280px）。
  ≥1280px 时 `<aside className="app-sidebar w-[208px]">` 包住 `<SourceSidebar />` 常驻于**所有页面**；
  <1280px 时收进 `Drawer`，同样承载 `<SourceSidebar />`。
- `src/features/conversations/SourceSidebar.tsx:74-85`：页面导航（会话 / 搜索 / 同步）在侧栏顶部。
- 同文件 `:180-188`：设置入口在侧栏底部。
- 同文件 `:87-110`：数据源列表；`:112-161`：项目列表。

**用户影响**

两个不同性质的东西被塞进一条 208px 的竖条里：

1. **全局导航**（我在产品的哪个区域）——对所有页面都成立；
2. **会话上下文**（我在看哪个来源/项目的会话）——只在会话页成立。

后果是具体的：

- 在搜索页，「数据源」「项目」两段占据 208px 宽度和大部分高度，但它们**对搜索页的筛选毫无作用**
  （搜索页有自己的来源筛选，见问题 5）。用户会尝试点击侧栏来源，结果被弹回会话页。
- 在设置页，同样的数据源列表出现在左侧，而右侧设置内容里也有一份数据源列表——同一份信息在一屏内出现两次，
  且两者行为不同（左侧是筛选，右侧是配置）。
- 1280px 以下，导航和数据源一起消失进抽屉；用户想从设置页切到搜索页，必须打开一个标注为
  「打开导航与筛选」的按钮，再在抽屉里找到目标。**一级导航不该需要两步。**

**推荐方案**

把这一条竖条拆成两个互不知道对方存在的东西：

1. **全局导航 Rail**（`src/app/AppNavRail.tsx`）：72px 宽，`≥768px` 恒在，四个入口
   icon + 中文标签（不做纯 icon 导航），`aria-current="page"`，active 用完整中性背景。
   `<768px` 才收进标题栏的导航 Drawer。
2. **会话上下文 Pane**（`src/features/conversations/SourcePane.tsx`）：只负责数据源、项目、统计、扫描空状态，
   不再包含任何全局导航。`≥1280px` 且当前页为会话页时常驻（208px）；
   768–1279px 由会话列表 Header 的「来源与项目」按钮打开 Drawer；进入搜索 / 同步 / 设置时**完全不渲染**。

Zustand 侧：`filtersOpen` 重命名为 `sourcePaneOpen`，新增独立的 `navigationOpen`。
两个 Drawer 状态**不得复用**——当前共用一个布尔值正是「打开来源筛选却弹出全局导航」的根因。

**优先级 P1** —— 影响每个页面、每个窗口尺寸。

---

## 5. P1 — 搜索条件和结果状态可能不一致

**当前代码位置**

- `src/features/search/SearchPage.tsx:35-48`：`text` / `order` / `source` / `project` / `machine` /
  `from` / `to` / `messagesOnly` 全部是**独立的 draft 状态**，
  `response` 是唯一的结果状态。
- 同文件 `:102-128`：`run()` 一次性读取当前所有 draft 值发出请求，
  `finally { setLoading(false) }`。
- 同文件 `:138-147`：排序 `Select` 的 `onChange` 只 `setOrder(...)`，**不触发查询**。
- 同文件 `:190-197`：Chip 移除时 `chip.clear()` 然后 `setResponse(null)`——直接清空结果。
- 同文件 `:135`：`meta` 显示 `response.hits.length`，而 `response` 来自**上一次**查询条件。
- 同文件 `:119`：`ipc.search(...)` 无请求序号保护。

**用户影响**

三个具体的不一致：

1. **排序切换无反馈**：用户把排序从「相关度」改成「时间」，控件已显示「时间」，结果却还是相关度排序的。
   用户会认为排序功能坏了，或者认为「时间」和「相关度」结果一样。
2. **筛选改变后结果陈旧**：用户勾选「只搜对话正文」，Chip 出现、按钮状态更新，但列表没变。
   用户无法判断是「筛选没有匹配到差异」还是「筛选没生效」。
3. **移除 Chip 清空结果**：移除一个筛选条件，比之前更宽的结果集应该出现，实际却整片清空回到空状态。
4. **请求竞态**：连续改两次筛选，第一次请求后返回时可能覆盖第二次的结果，
   而界面上的控件显示的是第二次的条件——**结果和条件永久错位**，直到用户手动再搜一次。

**推荐方案**

把「编辑中的条件」和「已应用的条件」拆成两组状态：

```ts
draftText, draftCriteria      // 用户正在编辑的
appliedText, appliedCriteria  // 产生当前 response 的
response, loadingInitial, refreshing, requestSeqRef
```

- 首次搜索、关键词变化：仍由 Enter / 搜索按钮提交（显式动作）。
- 已有结果且 `draftText === appliedText` 时，排序或筛选变化在 250ms 后**自动查询**。
- 自动更新期间**保留旧结果**，Header 显示「正在更新结果…」并通过 `aria-live="polite"` 宣告。
- 只有在**新请求成功后**才更新 `appliedCriteria`、结果数与 Chips。
- 每个请求带 `seq = ++requestSeqRef.current`；响应返回时 `seq !== requestSeqRef.current` 直接丢弃。
- 关键词被修改但未提交时显示「关键词已修改，按 Enter 更新」，不把旧结果伪装成新关键词的结果。
- 清除 Chip 修改 **draft** 并走同一套自动刷新逻辑，不再 `setResponse(null)`。
- Source options 改为来自 `visibleInSearch` 的 `SourceView`（问题 1），删除硬编码 4 项。
- 高级筛选区从 `section-card` 改为无 Card 的内联 section。

**优先级 P1** —— 搜索是产品的核心能力，条件与结果不一致会直接摧毁用户对结果的信任。

---

## 6. P1 — 同步页存在重复主操作

**当前代码位置**

- `src/features/sync/SyncPage.tsx:181-188`：Header `actions` 里有一个 `tone="primary"` 的「立即同步」。
- 同文件 `:330-350`：`nextStep` Notice 的 `actions` 里，当 `nextStep.action === 'sync'` 时
  又渲染一个 `<Button size="sm" onClick={() => void run({ push: true })}>{t('sync.syncNow')}</Button>`
  （即第二颗「立即同步」）。
- 同文件 `:295-327`（同步健康）、`:353-383`（待同步内容）是另外两张 `SectionCard`，
  排在 nextStep Notice **之后**——也就是说「待同步会话数」「预计写入字节」「隐私提醒」这些
  **做决定所需的信息出现在按钮下方**。
- `nextStep` 还缺 clean / failed 两种状态的按钮策略：`:141-146` 的 clean 分支 `action: null`
  但 Header 的 Primary 仍然存在并可用。

**用户影响**

用户在同步页看到两个语义完全相同的主按钮，不知道点哪个（点了都一样，但看起来像是两个不同的操作）。
更严重的是**决策顺序颠倒**：他先看到「立即同步」按钮，往下滚才知道这次要写多少字节、
有多少会话会离开本机、远端到底配没配。对于一个「会把源代码和命令输出推到远端」的操作，
这是不可接受的信息顺序。

另外在 `conflict` 状态下，Header 的 Primary 因 `disabled={Boolean(conflict)}` 变成禁用态，
而冲突处理按钮在下方 Notice 里——用户第一眼看到的是一个灰色的「立即同步」，而不是「先处理冲突」。

**推荐方案**

把 Header 精简到只保留「刷新」和「打开仓库」，删除独立的 `nextStep` Notice，
把两者合并为**一个扁平的 `SyncSummary`**（不再使用 `SectionCard`），顺序固定为：

```
仓库路径 / 远端地址 / 分支 → 最近拉取·推送 → 待同步会话 / 预计字节 / 本地变更 / ahead·behind
→ 隐私提示（仅在需要时以 Notice 出现） → 推荐下一步文案 → 唯一主操作
```

主操作按状态唯一：

| 状态 | 主操作 |
| --- | --- |
| 未配置仓库 | 「去设置」 |
| 未配置远端 | 「保存远端并同步」 |
| 有待同步或 ahead | 「立即同步」 |
| clean | **不显示强 Primary**，只显示「已是最新状态」 |
| conflict | 隐藏正常同步按钮，只显示「中止 Rebase / 重试同步 / 打开仓库」 |
| 有失败步骤 | 一个「重试同步」 |

上一次同步结果与归档/诊断保留在折叠的高级区域。普通状态不用大型彩色 Notice；
只有错误、冲突、隐私风险使用 Notice。

**优先级 P1** —— 重复主操作 + 决策信息倒置出现在一个会外发数据的操作上。

---

## 7. P2 — 三个信息层级共用铜色左侧阴影

**当前代码位置**

- `src/components/ui/Rows.tsx:70`：
  `active ? 'bg-selected font-medium text-ink shadow-[inset_2px_0_0_0_var(--semantic-accent)]' : ...`
  —— 这一条同时作用于侧栏的**页面导航行**、**来源行**、**项目行**、**设置入口**。
- `src/index.css:371-374`：
  ```css
  .session-row-active {
    background: var(--surface-selected);
    box-shadow: inset 2px 0 0 var(--semantic-accent);
  }
  ```
- `src/features/conversations/SessionList.tsx:242`：会话行应用 `session-row-active`。

**用户影响**

宽度 1440px 的会话页上，同一屏内可能同时出现三条铜色竖线：

1. 侧栏「会话」（全局导航 active）；
2. 侧栏「Codex」（来源筛选 active）；
3. 会话列表里的选中会话。

它们粗细相同、颜色相同、位置都在左边缘，构成三条并列的、视觉等价的强调线。
用户扫一眼无法判断哪一条表示「我在这里」（导航）、哪一条表示「我在过滤什么」（筛选）、
哪一条表示「我选中了这条」（选择）。这违反项目自己的铁律——铜色视觉面积不应超过 3–5%，
而这里三处叠加已经超出了「点缀」的量。

此外 `inset box-shadow` 在 `Settings`/`Sync` 的静态控件上也大量使用（见问题 8），
导致「左侧竖线」这一形状在整套 UI 里不再专属于任何一种语义。

**推荐方案**

按层级分配三种不同的选中表达，**全部去掉 inset 阴影**：

| 层级 | 表达 |
| --- | --- |
| 全局导航 active | 完整中性 `bg-selected` 背景 + `text-ink` + `font-medium`，无竖条 |
| 来源 / 项目 active | 轻 `bg-selected`（更低不透明度）+ `font-medium`，无竖条 |
| 会话 active | 整行 `bg-selected` 背景 + 标题对比度提升，无竖条 |

铜色只留给：Primary 按钮、链接、搜索命中 `<mark>`、键盘 focus ring。
来源彩色圆点仅用于来源识别，不承担 active 状态。

具体改动：
- 删除 `Rows.tsx` 的 `shadow-[inset_2px_0_0_0_var(--semantic-accent)]`；
- 删除 `index.css` 中 `.session-row-active` 的 `box-shadow`；
- 新增 `--surface-selected-soft` 令牌供来源/项目行使用。

**优先级 P2** —— 不影响功能，但持续削弱所有选中反馈的可读性。

---

## 8. P2 — Settings/Sync 仍有过多 Card 和封闭边框

**当前代码位置**

- `src/components/ui/Surfaces.tsx:76-80`：
  ```ts
  const skin = tone === 'danger'
    ? 'bg-danger/6 shadow-[inset_0_0_0_1px_color-mix(in_oklch,var(--semantic-danger)_35%,transparent)]'
    : 'section-card'
  ```
- `src/index.css:352-356`：`.section-card { border: 1px solid var(--line); border-radius: 8px; background: var(--surface-panel); }`
- `src/index.css:413-418`：`.btn-secondary { box-shadow: inset 0 0 0 1px var(--line-strong); }`
- `src/index.css:428-433`：`.btn-danger` 同样是 inset ring。
- `src/index.css:467-482`：`.field` 用 `box-shadow: inset 0 0 0 1px var(--field-ring)` 代替 border。
- `SettingsPage.tsx` 有 6 个 `SectionCard`，`SyncPage.tsx` 有 5 个。

**用户影响**

设置页现在是 6 张圆角卡片在浅色面板上堆叠。每张卡片有 1px 边框 + 8px 圆角 + 独立内边距，
视觉上产生「6 个互不相关的小应用」的感觉，而它们其实是同一个设置表单的 6 个分组。
「Card」这个形状本来表示「独立物件」，用在表单分组上就变成了纯装饰——正好是
`docs/DESIGN.md` 铁律里「能不用 Card 就不用 Card」要禁止的用法。

`inset box-shadow` 代替 border 的问题更隐蔽：它让「聚焦环」和「控件边框」在视觉上无法区分，
一个输入框 focus 时可能有**两层**环（`.field:focus` 的 inset ring + 全局 `:focus-visible` 的 outline），
在搜索框的 `autoFocus` 场景下会同时出现，看起来像一圈厚重的铜色描边。

**推荐方案**

- `.field` 改为真实 `border: 1px solid var(--line)` + `border-radius: var(--radius-control)`，
  `background: var(--surface-field)`；focus 只改 `border-color`。
- `.btn-secondary` 改用真实 `border: 1px solid var(--line-strong)`。
- `.btn-danger` 改为真实 border + 淡背景。
- Danger Section 删除 inset shadow，改用真实 border + 淡染。
- `.section-card` **不再作为设置/同步页所有分组的默认容器**：表单分组优先使用
  「section 标题 + 间距 + divider」；Card 只保留给真正独立的对象、危险状态、临时浮层。
- 每个控件**只有一个焦点边界**：键盘 focus 用外 `outline`，鼠标 focus 只改 border。
  搜索页的程序化 `autoFocus` 不显示双层铜色圈（用 `:focus-visible` 而非 `:focus` 驱动外圈）。

**优先级 P2** —— 是问题 7 的同源问题，一起改成本最低。

---

## 9. P2 — Overlay 与自绘 Select 无障碍契约不完整

**当前代码位置**

- `src/components/ui/Surfaces.tsx:222-255`（`Drawer`）：
  - 遮罩是一个 `<button aria-label="关闭{title}">`，覆盖 `absolute inset-0 z-20`；
  - 面板 `<aside>` 没有 `role="dialog"` / `aria-modal` / `aria-labelledby`；
  - 没有焦点圈定——`Tab` 会把焦点送到抽屉**背后的页面元素**上；
  - 没有保存/恢复触发器焦点；
  - 背景区域没有 `inert`；
  - 没有 portal，渲染在 App 的 flex 容器内（`relative` 定位依赖祖先）。
- `src/features/search/QuickSearch.tsx:101-129`：
  - 有 `role="dialog" aria-modal="true"`，但同样没有焦点圈定与焦点恢复；
  - 输入框有 `role="combobox" aria-expanded`，但**没有 `aria-controls`**，
    也没有 `aria-activedescendant`；
  - 结果容器有 `role="listbox"`，选项有 `role="option" aria-selected`，
    但输入框与 listbox 之间没有 id 关联——屏幕阅读器无法把两者连起来。
- `src/components/ui/Inputs.tsx:184-206`（`Select`）：
  - 触发器是 `<button aria-haspopup="listbox" aria-expanded>`，**没有 `role="combobox"`**；
  - `aria-activedescendant` 已设置（`:195`），但**没有 `aria-controls`** 指向 listbox；
  - 关闭时 `aria-activedescendant` 被清空（正确），但 listbox 的 `id` 复用了 `useId`，
    而 `aria-controls` 缺失意味着这条链路断了一半。
- `src/features/settings/SettingsPage.tsx:126-133`：数据源区域没有 `aria-labelledby` 关联，
  多个 `Toggle` 的 `aria-label` 是来源名——在 8 个来源同时展开时会重复。

**用户影响**

键盘与屏幕阅读器用户无法可靠地使用抽屉和快速搜索：打开来源抽屉后按 Tab，
焦点会跑到抽屉背后的标题栏按钮上——视觉上焦点消失了（被遮罩挡住），
继续按 Tab 可能触发「扫描本地会话」这类破坏性动作。这是可访问性缺陷，也是误操作风险。

Quick Search 是 Ctrl+K 主入口，但它对屏幕阅读器只是一句「dialog」，用户听不到
「有 3 条结果，当前选中第 1 条」这类关键状态。

**推荐方案**

新建 `src/components/ui/Overlay.tsx` 作为 Drawer 与 Quick Search 的公共基础，统一提供：

- portal 挂载（脱离祖先 flex 布局与 `overflow` 裁切）；
- `role="dialog"` + `aria-modal="true"` + `aria-labelledby`（指向标题元素）；
- 打开时保存 `document.activeElement`；
- `Tab` / `Shift+Tab` 焦点圈定在 overlay 内；
- `Escape` 关闭；
- 关闭后恢复触发器焦点；
- 背景区域设为 `inert`；
- overlay 内 `overscroll-behavior: contain`；
- `prefers-reduced-motion` 下禁用入场运动。

`QuickSearch`：输入框补齐 combobox 语义（`aria-controls` + `aria-activedescendant`），
结果列表 listbox/option 与输入框 id 关联，并在结果数变化时通过 `aria-live` 宣告。

`Select`：触发器改为 `role="combobox"` + `aria-controls`；`value` 不存在时 `selected` 为 `undefined`
（见问题 3）；空 options 时禁用并显示「无可用选项」。

**优先级 P2** —— 不影响鼠标用户，但对键盘/AT 用户是阻塞级缺陷，且修复成本集中在一个新文件。

---

## 10. P2 — 共享层级和格式规范仍未完全统一

**当前代码位置与表现**

1. **`PanelHeader` 没有正确的 `h1/h2` 层级**
   `src/components/ui/Surfaces.tsx:43`：标题**硬编码为 `<h2>`**。
   四个页面（会话 / 搜索 / 同步 / 设置）都用它作页面主标题，
   于是每个页面都**没有 `h1`**，文档大纲从 `h2` 开始。
   同时 `:40` 的 `title` 与 `:45` 的 `meta` **都是 `flex-1`**，
   两者同时设置时各占一半宽度，长路径会把标题挤窄。

2. **App 无 skip link**
   `src/app/App.tsx:227-383`：从 `<header>` 到 `<main>` 有数十个可聚焦控件
   （扫描、数据源警告、快速搜索、同步、更多菜单、窗口控制 ×3、导航行…）。
   键盘用户每次进页面都要 Tab 穿过整条导航才能到内容区。

3. **日期未统一使用 `Intl.DateTimeFormat`**
   `src/lib/format.ts:30-48`：`formatDate` / `formatTime` / `formatDateTime` 全部手工拼接
   `getFullYear()` / `padStart`。结果是不跟随系统区域设置（始终 `YYYY-MM-DD HH:mm:ss`），
   也不支持 12 小时制。`SettingsPage.tsx:79` 另外用了
   `new Date().toLocaleTimeString()`——同一页面上两种时间格式并存。

4. **全局错误和页面错误可能重复**
   `App.tsx:365-382` 渲染 `useLibrary.error`（全局）。
   `SettingsPage.tsx:118-122` 也渲染 `useLibrary.error`（同一个 store 字段），
   `SyncPage.tsx:196-208` 渲染 `useSync.error`。
   在设置页触发一个 IPC 错误时，**同一个错误在页内和页底各显示一次**。

5. **大型导入预览没有虚拟化**
   `ImportPanel.tsx:73-82`：`preview.sessions.map(...)` 内嵌 `s.messages.map(...)`，
   两层无界 `.map()`。后端限制每个会话预览 10 条消息、每条 1500 字（`importPreviewSummary` 文案），
   但**会话数没有上限**——导入 200 个会话时会一次性创建 200 × 10 = 2000 个 DOM 节点块。

**用户影响**

- 无 `h1` + 无 skip link：屏幕阅读器用户和键盘用户都无法快速定位「这个页面是什么」与「跳到内容」。
- 日期格式不跟随系统：英文用户看到 `2026-09-19 14:30:00`，与系统里其它应用的
  `9/19/2026, 2:30 PM` 不一致；且 `SettingsPage` 里紧邻的两个时间戳格式就不同。
- 错误重复：一个失败在视觉上被放大成两个，用户会怀疑是否发生了两次不同的错误。
- 导入预览无虚拟化：大量导入时页面卡顿（与项目「10 万条消息也不渲染无界 DOM」的自研虚拟列表目标矛盾）。

**推荐方案**

1. `PanelHeader` 增加 `headingLevel?: 1 | 2 | 3`（默认 2）。页面主标题传 `1`，
   会话列表与阅读器传 `2`，内部分区传 `2`/`3`。
   同时把 title / meta / actions 改成**明确槽位**：title 不参与 `flex-1` 竞争，
   meta 可 `flex-1` 但必须 truncate，长路径不能把标题挤到不可见。
   焦点锚点增加 `scroll-margin-top`。
2. `App.tsx` 在最前加键盘可聚焦的 skip link（指向 `#main-content`），
   给 `<main>` 加 `id="main-content"`。
3. `lib/format.ts` 统一走 `Intl.DateTimeFormat`（缓存 formatter 实例，避免每次调用重新构造），
   `SettingsPage` 的 `toLocaleTimeString` 一并收敛。
4. 全局异步错误**只在 App Shell 的 ErrorNotice 显示**；Settings / Search / Sync 只保留
   字段级错误与「该流程专属」的错误（如导入失败、日期区间非法）。
5. 导入预览只先显示**会话摘要**；消息区域使用现有 `useVirtual` Hook 或受限分页，
   禁止 `sessions/messages` 双层无界 `.map()`。
6. 数字、大小、耗时统一 `tabular-nums`。
7. 保留用户消息与工具消息的语义容器；不要为了「去 Card」删除真正有意义的消息边界。
8. 动画最后处理，仅保留 Overlay 的 120–160ms opacity/transform。

**优先级 P2** —— 单项影响有限，但合计构成「产品细节不统一」的整体感受，
且其中 skip link、h1 层级、错误去重都是低成本高收益。

---

## 附：修复顺序建议

按依赖关系排序（后续项依赖前序项的产出）：

1. `src/lib/sources.ts`（问题 1 的数据模型）——所有页面都消费它。
2. `src/components/ui/Overlay.tsx`（问题 9 的基础）——Drawer / QuickSearch / SourceManagerDrawer 共用。
3. `index.css` 令牌 + `Rows.tsx` / `Button.tsx` / `Inputs.tsx` / `Surfaces.tsx`（问题 3、7、8、10.1）。
4. App Shell 拆分（问题 4）——依赖 1、2。
5. 四个页面重构（问题 2、5、6）——依赖 1、2、3、4。
6. `tools/ui_shot.mjs` / `tools/ui_qa.mjs` 扩展——依赖全部页面改动完成。
