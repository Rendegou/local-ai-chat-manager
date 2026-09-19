# UI 二次重构报告

> 日期：2026-09-19
> 基线：**当前未提交 WIP 的增量修改**（未 `git reset` / `git restore` / `git checkout --` / `git clean`，未丢弃任何既有改动）
> 交付物：本报告 + [DESIGN_AUDIT.md](./DESIGN_AUDIT.md)（问题审计）+ [DESIGN.md](./DESIGN.md)（界面规范）+ 代码

---

## 1. 一句话结论

按 `docs/DESIGN_AUDIT.md` 的 10 项问题做完了二次重构：**数据源从「产品支持什么」改回「本机实际有什么」**、
**全局导航与会话上下文拆成两条独立的栏**、**删掉三处并列的铜色左侧阴影与所有静态 inset 阴影**、
**修掉导入来源显示值与真实值不一致的静默 bug**、**让搜索结果永远对应当前筛选条件**、
**同步页收敛到唯一主操作**、**浮层补齐键盘与 AT 契约**。

验证结果见 §6；**未完成项与已知问题见 §8**（其中 Rust 集成测试有 7 项失败，是本次改动之前就存在的环境相关缺陷）。

---

## 2. 删除的视觉噪音

| 删除项 | 位置 | 说明 |
| --- | --- | --- |
| active 左侧铜条（3 处） | `Rows.tsx` `shadow-[inset_2px_0...]`、`index.css` `.session-row-active` | 全局导航、来源筛选、会话选中曾共用同一条 2px inset 铜条；一屏内最多同时出现三条同色同宽竖线，三者语义无法区分 |
| 静态控件 inset 阴影 | `index.css` `.field` / `.btn-secondary` / `.btn-danger` / Danger Section | 改用真实 1px `border`。inset ring 让「静态边框」与「焦点环」在视觉上无法区分，也是搜索框双层铜色圈的来源 |
| 重复 Primary | `SyncPage.tsx` | Header 与「下一步」提示各有一颗「立即同步」；现在 Header 只有刷新与打开仓库 |
| Settings/Sync 多余 Card | `SettingsPage.tsx`（6 → 0 个默认 Card）、`SyncPage.tsx`（5 → 0 个默认 Card） | 表单分组改用新增的 `Section`（标题 + 间距 + divider）；Card 只保留给独立对象、危险区与临时浮层 |
| 未安装 Agent 的主界面曝光 | `SourcePane.tsx` / `SearchPage.tsx` / `SettingsPage.tsx` / `App.tsx` | Cursor / ZCode / Gemini / 豆包工作 等「本机没装」的来源不再出现在来源栏、搜索筛选、已连接来源列表；标题栏警告也不再为它们计数 |
| 「设置」重复入口 | `App.tsx` 更多菜单 | Rail 已经是一级入口 |
| `package.json` 里的死键 | `zh.ts` / `en.ts` | 删掉 22 个重构后再无引用的文案键（`sync.healthTitle`、`settings.sourcesDesc`、`app.openDrawer` 等） |
| 全屏最上层的浮层遮罩 | `Surfaces.tsx` Drawer | 改用 portal + `Overlay`；抽屉不再依赖祖先的 `relative` 定位 |

---

## 3. 调整的层级

### 3.1 全局导航 ↔ 会话上下文

拆成两个互不知道对方存在的组件：

- **`app/AppNavRail.tsx`**（72px）：会话 / 搜索 / 同步 / 设置。`≥768px` 恒在；`<768px` 收进标题栏的导航抽屉。
  active = 完整中性背景 + `font-semibold` + `aria-current="page"`。
- **`features/conversations/SourcePane.tsx`**（208px）：只负责数据源、项目、统计、扫描空状态。
  `≥1280px` 且当前页为会话页时常驻；`768–1279px` 由会话列表头的「来源与项目」按钮打开抽屉；
  进入搜索 / 同步 / 设置时**完全不渲染**。

Zustand 侧把 `filtersOpen` 拆成 `sourcePaneOpen` 与 `navigationOpen` 两个独立状态——
此前共用一个布尔值，会出现「点来源筛选却弹出全局导航」。

### 3.2 来源状态：能力 vs 本机实际

新增 `src/lib/sources.ts` 的纯函数 `buildSourceViews(catalog, rows, settings) → SourceView[]`，
固定规则（`docs/DESIGN.md` §9）：

```
visibleInSidebar           = found || configured || hasHistory
visibleInSearch            = hasHistory
visibleInConnectedSettings = found || configured || hasHistory || status ∈ {partial, error}
needsAttention             = status ∈ {partial, error} || (configured && missing)
```

Catalog 里没有、但索引里有历史的来源（导入来源、旧版本遗留）仍会生成 SourceView——否则这些历史会从界面上消失。
未新增 IPC schema，未修改 Rust adapter 注册表。

### 3.3 搜索的 draft / applied 分离

`SearchPage.tsx` 把状态拆成 `draftText` / `draftCriteria` / `appliedText` / `appliedCriteria` / `response` /
`loadingInitial` / `refreshing` / `requestSeqRef`：

- 关键词：Enter / 搜索按钮显式提交；
- 排序与筛选：已有结果且关键词未变时 250ms 防抖后自动重查，期间**保留旧结果**并显示「正在更新结果…」（`aria-live="polite"`）；
- `appliedCriteria` 只在新请求成功后才更新；
- 每次请求带序号，旧响应返回时直接丢弃；
- 关键词改了没提交 → 明确提示「关键词已修改，按 Enter 更新」；
- 移除 Chip 只改 draft，走同一套自动刷新。

### 3.4 同步的推荐动作

`SyncPage.tsx` 的 Header 只留刷新与打开仓库；`SectionCard` + 独立 Notice 合并成一个扁平 `SyncSummary`，
顺序固定为：仓库 → 远端 → 分支 → 最近拉取/推送 → 待同步会话/字节/本地变更/ahead·behind →
隐私提示（仅当真有数据会离开本机）→ 推荐下一步 → **唯一主操作**。

| 状态 | 主操作 |
| --- | --- |
| 未配置仓库 | 去设置 |
| 未配置远端 | 保存远端并同步 |
| 有失败步骤 | 重试同步 |
| 有待同步 / ahead | 立即同步 |
| clean | 无 Primary，只显示「已是最新状态」 |
| conflict | 隐藏正常同步按钮，只显示中止 Rebase / 重试同步 / 打开仓库 |

---

## 4. 建立的设计系统（`docs/DESIGN.md`）

`docs/DESIGN.md` 从「只有原则的长篇宣言」重写成可执行规范，并全部落到令牌或组件实现里：

- **Spacing**：4 / 8 / 12 / 16 / 24 / 32 / 48
- **Typography**：Page title 16/600 · Section title 14/600 · Body 14/400 · Secondary 13/400 · Caption 12/400 · Technical 11.5px mono
- **Colors**：表面五层 + hover/selected/selected-soft；语义色按含义命名；来源色只做识别；一屏约 70/20/10 的安静/中等/强调配比
- **Radius**：4 / 6 / 8（`--radius-chip` / `--radius-control` / `--radius-panel`，`--radius-overlay` 与 panel 同档）
- **Shadow**：只有 Dropdown / Popover / Drawer / Dialog / Quick Search 可以用 `--shadow-overlay`；其余令牌保留名字但值为 `none`
- **Component rules**：Button（28/32/36 三档、五种状态、所有语气都带 1px 边框以免同行按钮错位）、
  Input/Select（36px、真实边框、单焦点边界、Select 的 `value` 不在 options 时必须是 placeholder）、
  Table/列表行、Card（只用于独立对象/危险状态/临时浮层）、Dialog/Drawer/Dropdown、Tabs、Badge
- **选中态分层**：全局导航 = `bg-selected` + font-semibold；来源/项目 = `bg-selected-soft` + font-medium；
  会话行 = 整行 `bg-selected` + 标题对比度提升。三者都**没有** inset 阴影或左侧竖条
- **每页最多一个 Primary Action**，并且这条规则是**机器可验证的**（见 §6）
- **可访问性契约**：每页恰好一个 `h1`、skip link、焦点环、`aria-live` 状态宣告

---

## 5. 重构的页面

| 页面 / 模块 | 主要变化 |
| --- | --- |
| **App Shell** | 46px 标题栏 + 72px Rail + `#main-content` + 可聚焦 skip link；`<img>` 补显式宽高；标题栏警告改用 `needsAttention`；更多菜单去掉重复的「设置」 |
| **会话** | `SourceSidebar` → `SourcePane`（不再含全局导航，只遍历 `visibleInSidebar`）；会话列表头新增「来源与项目」抽屉入口；选中行去掉铜条；列表标题改 `h2`；页面固定一个 `sr-only` `h1`（窄窗口两级视图下列表会被正文替换） |
| **搜索** | §3.3 的 draft/applied 分离；来源筛选改用 `visibleInSearch`（删掉 Codex/Kimi/Cursor/ZCode 硬编码）；高级筛选从 Card 改为内联 section；结果区在刷新时降透明度而不是清空 |
| **同步** | §3.4；上一次同步结果、归档、Git 日志、数据源收进折叠的高级区域；普通状态不再用大型彩色 Notice |
| **设置** | 分区导航（宽屏左侧 168px / 窄屏顶部 Select）+ 单分区内容（最大 720px）；数据源改为「已连接来源」每源一行；新增 `SourceManagerDrawer`（add / configure / import 三种模式）；`ImportPanel` 移入抽屉并重写 |

### 新增 / 重写的文件

```
新增  src/app/AppNavRail.tsx                  全局导航 Rail
新增  src/lib/sources.ts                     SourceView 派生模型
新增  src/components/ui/Overlay.tsx           浮层基础（portal / 焦点圈定 / inert / Escape / 焦点归还）
新增  src/features/conversations/SourcePane.tsx
新增  src/features/settings/SourceManagerDrawer.tsx
重写  src/features/settings/SettingsPage.tsx
重写  src/features/settings/ImportPanel.tsx
重写  src/features/search/SearchPage.tsx
重写  src/features/search/QuickSearch.tsx
重写  src/features/sync/SyncPage.tsx
重写  src/app/App.tsx
重写  src/components/ui/Surfaces.tsx / Button.tsx / Inputs.tsx / Rows.tsx
删除  src/features/conversations/SourceSidebar.tsx
```

Rust Adapter、会话数据模型、同步协议、虚拟列表、分页消息、Quick Search、设置草稿与离开保护、
同步冲突保护均未改动，仅改变它们被呈现的方式。

---

## 6. 验证命令与结果

环境：Windows，Playwright 用 puppeteer-core。Edge 在这台机器的受限沙箱下会以 `Code: 0` 静默退出
（stderr 为空），因此 `tools/ui_shot.mjs` 现在按 `AICHAT_BROWSER` → Edge → Chrome → puppeteer 缓存
的顺序探测，用到哪个会打印出来。本节所有结果都是实际执行输出。

| 命令 | 结果 |
| --- | --- |
| `npm run build` | ✅ 通过（`tsc --noEmit` + vite build） |
| `npm run ui:qa` | ✅ **断言全部通过**（5 个视口 × 深浅两色 + 2000 会话虚拟滚动 + 全部交互断言） |
| `npm run ui:shots` | ✅ 52 张 → `.ui-shots/after-refactor`（另有 1 张组件画廊，共 53 个 PNG） |
| `npm run ui:a11y` | ✅ **对比度审计未发现低于 WCAG AA 阈值的文本**（含抽屉与快速搜索） |
| Impeccable detector | ✅ `0 findings` |
| `cargo test -p aichat-core` | ❌ **47 通过 / 7 失败**——失败项为改动前既有、与前端无关，详见 §8 |

### `npm run ui:qa` 的实际断言范围

**A. 布局**：1440×900 / 1280×800 / 1180×800 / 900×700 / 768×700 × 深浅两色，
每档断言无横向溢出、阅读区无嵌套滚动、200% 字体缩放下无横向溢出、Tab 20 步每个焦点元素有可访问名称/可见/有可见焦点环；
另有 2000 会话下只渲染 15 行会话（虚拟化）。

**B. 数据源可见性**（这是本次重构的核心，全部落成断言）：

- 会话页来源栏**不显示 Cursor**（本机未装、未配置、无历史）
- 会话页来源栏**显示 Gemini CLI**（本机未安装，但有历史会话）
- 搜索页来源筛选里没有 Cursor / Claude Code，**有** Gemini CLI 与 Catalog 之外的 `legacy-export`
- 设置「已连接来源」不出现普通 missing 候选 Cursor / ZCode；出现 Codex / Kimi / Claude / Gemini / legacy-export
- 标题栏告警数为 **2**（WorkBuddy 读取失败 + Claude 手工配置却探测不到），而不是「6 个来源未找到」
- 「添加来源」抽屉里**有** Cursor 与豆包工作，**没有**已自动发现的 Codex

**C. 层级与选中态**：会话 / 搜索 / 同步 / 设置四页各自恰好一个 `h1`；
导航 active 元素与 `.session-row-active` 的 computed `box-shadow === none`；`#main-content` 存在且 skip link 指向它；
skip link 是第一个 Tab 落点、聚焦后出现在视口内、有可见焦点环、回车后 hash 变成 `#main-content`。

**D. 搜索一致性**：改变排序后自动发出新查询（最后一次请求的 `order === 'recent'`）；
构造「慢的宽条件请求 + 快的窄条件请求」竞态，断言页头显示的结果条数等于**最后一次**请求返回的条数
（实测序列 `hits: 12 → 12 → 12 → 4`，页头显示 4），并额外断言这次竞态确实产生了不同条数的响应，避免断言空转。

**E. 浮层契约**：抽屉有 `aria-modal="true"` + `aria-labelledby`，打开时 `#root` 为 `inert`，
Escape 关闭、关闭后 `inert` 解除且焦点回到触发器；Quick Search 打开后焦点在 combobox 上，
`aria-controls` 指向 listbox、`aria-activedescendant` 指向存在的元素，连按 12 次 Tab 焦点都不逃出浮层，
Escape 后焦点回到触发按钮；导入抽屉初始显示「请选择来源」且内部值为空字符串、未选来源时「预览导入」禁用、
选项里没有原生读取来源、选中豆包工作后显示值与内部值一致。

> 注：`KEYBOARD_AUDIT` 的 `hasOutline` 此前只被计算、从未参与判定。现在它进入失败判断
> （键盘 Tab 到的元素必须有可见焦点环），并沿祖先链向上找 3 层——组合型控件的焦点环画在 `.field` 包裹层上。

### 视口与主题覆盖

| 视口 | 深色 | 浅色 |
| --- | --- | --- |
| 1440×900 | ✅ | ✅ |
| 1280×800 | ✅ | ✅ |
| 1180×800 | ✅ | ✅ |
| 900×700 | ✅ | ✅ |
| 768×700 | ✅ | ✅ |

另加 640×720 的导航抽屉、1440×900 的快速搜索，以及 1180×800 下的来源抽屉 / 添加来源 / 来源配置 / 导入抽屉。

---

## 7. Mock QA 与真实 Tauri 验证的区别

**这两类验证不能互相替代**，本节把它们分开写。

### 7.1 Mock QA（`tools/ui_shot.mjs` / `tools/ui_qa.mjs`）

在 headless Chrome 里加载同一个前端，把 Tauri IPC 换成 `tools/ui_shot.mjs` 的 `SOURCE_FIXTURES`。
它覆盖的是**六种数据源组合**（本机发现 / 手工配置 / 仅有历史 / 未安装 / 读取失败 / Catalog 之外），
这类组合真机上很难同时凑齐，而它们正是本次重构的核心分支。所以：

- 覆盖到的：全部布局断言、全部交互断言、全部数据源可见性分支、深浅两色对比度；
- 覆盖不到的：真实 `list_sources` / `source_catalog` 的返回形状、WebView2 与 Chromium 的渲染差异、
  真实 DPI 缩放、真实索引规模。

`SOURCE_FIXTURES` 是手工构造的，与后端真实返回**形状一致但不是同一份数据**。

### 7.2 真实 Tauri 验证（已完成）

```
cargo build --release -p local-ai-chat-manager --features production   # MinGW GNU 工具链，3m52s
python tools/desktop_shot.py --out .ui-shots/desktop-after-refactor --sizes 1440x900,1180x800
```

真实窗口（DPI 缩放 1.5）加载真实索引（**776 个会话 / 147486 条消息 / 663 MB**），
用真实 `list_sources` / `source_catalog` 得到：

- **会话页来源栏**：Codex 223 · Kimi Code 148 · Cursor 254 · ZCode 24 · Claude Code 122 · WorkBuddy 2
- **未出现**：Gemini CLI、豆包工作 —— 本机确实没有它们的目录，也没有历史
- **设置「已连接来源」**：上述 6 个来源各一行（名称 · 状态 · 会话数 · 路径 · 开关 · 配置），没有配置墙
- **「添加来源」抽屉**：里面正好是 **Gemini CLI（原生读取）** 与 **豆包工作（文件导入）** 两个候选

这直接验证了计划里要求的两条：本机未安装且无历史的 Agent 不在侧栏 / 搜索 / 已连接来源中，
但它们仍可在「添加来源」里找到。

证据文件：`.ui-shots/desktop-after-refactor/`
（`conversations-1440x900.png`、`conversations-1180x800.png`、`step-settings.png`、`step-add-source.png`）

> 说明：`tools/desktop_shot.py` 会打印「无法把窗口置于最前」——那是它的 `raise_window` 探测失败提示，
> 但点击仍然生效（截图里设置页与抽屉都正确打开了）。这是该工具在受限桌面会话下的已知噪音，不是本次改动引入的。

### 7.3 Before / After 截图

| 目录 | 内容 |
| --- | --- |
| `.ui-shots/before-refactor/` | 改动前从 `.ui-shots/latest` 复制的 26 张基线截图（重构前先复制，未覆盖） |
| `.ui-shots/after-refactor/` | 改动后 52 张（4 个页面 × 5 视口 × 2 主题 + 6 类浮层 × 2 主题）+ 1 张组件画廊 |
| `.ui-shots/desktop-after-refactor/` | 真实 Tauri 窗口截图（会话页 ×2 尺寸 + 设置页 + 添加来源抽屉 + 导入抽屉） |
| `.ui-shots/a11y/` | 对比度审计用的截图 |

---

## 8. 仍值得继续优化 / 未完成项

### 8.1 Rust 集成测试 7 项失败（**改动前既有，与本次重构无关**）

```
cargo test -p aichat-core --no-fail-fast
  28 passed · 0 failed   (unit)
   6 passed · 0 failed
   4 passed · 0 failed
   5 passed · 1 failed   cursor_zcode_test::cursor_内容版本号驱动增量扫描
   0 passed · 3 failed   pipeline_test（扫描索引搜索与快照全流程 / 关闭原始副本后… / 同步仓库会话作为第三数据源被索引）
   1 passed · 1 failed   readonly_test::扫描与归档都不修改原始文件
   1 passed · 0 failed
   1 passed · 2 failed   sync_test（冲突时不自动合并且可中止_rebase / 两台机器通过裸仓库同步会话）
```

**根因（已定位）**：这些测试用的 `settings_with(...)` 辅助函数只把
`codex_path` / `kimi_path` / `cursor_path` / `zcode_path` 钉到临时空目录，**没有钉住本次 WIP 新增的
`claude` / `gemini` / `workbuddy`**。这些新 adapter 会自动发现用户主目录下的真实数据，
于是 `library.scan()` 把本机真实的 125 个会话一起扫了进来：

```
assertion `left == right` failed: 两个数据源各解析 1 个会话
  left: 126   right: 2
```

也就是说：**在任何装了 Claude Code / Gemini CLI 的机器上，这批集成测试都会失败**——它们测的是环境而不是代码。

**本次没有修改**：Rust 侧不在本次前端重构范围内，而且这批 adapter 正是当前未提交 WIP 正在改的部分，
现在动它会让「前端重构是否引入回归」无法判断。

**建议的修法**（一行级别，留给作者决定）：在 `settings_with` 里同样把 `claude` / `gemini` / `workbuddy`
指向 `empty(...)` 临时目录；或者更彻底一点，给 `AppSettings` 加一个「只扫描显式指定路径」的测试开关。

### 8.2 仍是 Mock / 未做的验证

- **搜索竞态**只在 mock 上验证过（用 `__UI_QA_SEARCH__.delays` 注入延迟）。
  真实后端没有可注入延迟的钩子，这个场景目前**没有真机证据**。
- **导入流程**只验证到「初始状态、选项集合、未选来源时禁用、显示值与内部值一致」。
  真实的「预览 → 确认 → 写入索引」链路需要在真机上准备一份导入文件才能走通，本次未做。
- **同步页的 conflict / failed / clean 三种状态**在 mock 上有截图（`--states`），
  真实仓库处于 clean 状态，conflict 与 failed 未在真机复现。
- **窄窗口（<768px）**只做了浏览器验证。真实窗口有最小宽度限制，`768x700` 已经接近下限，
  `<768px` 的导航抽屉只存在于浏览器证据里。

### 8.3 已知的设计取舍

- **Claude Code 在设置里显示「未发现 0 个会话」**：它被手工配置过目录（`configured === true`），
  按固定规则会进入「已连接来源」，即使目录不存在、也没有历史。规则本身是明确的，
  但这一行对用户的信息量偏低——后续可以考虑把「已配置但探测不到」单独归成一组提示。
- **Cursor 在真机上显示「未发现 254 个会话」**：Catalog 的探测结果说没找到目录，但索引里确实有 254 个会话。
  界面同时如实呈现这两个事实，没有隐藏矛盾，但也没解释为什么——值得在来源行上加一句说明。
- **`.section-card` 仍然存在于代码里**（Gallery 与危险区在用），只是不再是设置/同步页的默认容器。
  保留它是有意的：Card 对「危险状态」是正确用法。
- **来源色只有 codex / kimi 两个专属色**，其余来源用中性色点。这是既有设计，本次未扩展。
- **`SettingsPage` 的分区一次只渲染一个**，所以「保存 / 还原」在切换分区时不会丢失草稿（草稿在 store 里），
  但用户看不到「另一个分区还有未保存修改」以外的提示——只有一个全局的「有未保存的修改」状态胶囊。

### 8.4 下一步值得做的

1. 按 §8.1 修掉测试隔离，让 `cargo test` 在任何机器上都能给出可信信号。
2. 给真实后端的搜索加一个可注入延迟的测试开关，让竞态断言也能在真机上跑。
3. 把 `tools/desktop_shot.py` 的点击脚本化成一次完整的真机回归（设置 / 搜索 / 同步 / 添加来源），
   而不是像这次一样按坐标手点。
4. Gallery 里的 `PanelHeader` / `SectionCard` / `Section` 示例补上新的 `headingLevel` 与三种选中态对照。
