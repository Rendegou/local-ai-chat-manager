#!/usr/bin/env node
/**
 * UI 截图工具（视觉重构的验收基线）。
 *
 * 为什么不用桌面窗口截图：
 * 桌面截图受 DPI 缩放、窗口位置、遮挡影响，点击坐标不可复现；而本项目前端是纯 Web 层，
 * 用系统自带的 Edge（headless）加载同一个前端、把 Tauri IPC 换成 mock 数据，
 * 就能得到**确定性**的截图：同样的数据、同样的视口、同样的主题，每次结果一致。
 *
 * 用法：
 *   node tools/ui_shot.mjs --out .ui-shots/phase0 [--themes dark,light]
 *        [--sizes 1440x900,1180x800,900x700] [--pages conversations,search,sync,settings]
 *        [--states normal,empty,conflict] [--mock .ui-shots/mock/data.json]
 *
 * 前置：
 *   npm run dev                                     # Vite，默认 http://localhost:1420
 *   python tools/export_ui_mock.py .ui-shots/demo-index .ui-shots/mock/data.json
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import puppeteer from 'puppeteer-core'

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'

/**
 * 候选浏览器。
 *
 * 曾经只用 Edge，但在这台机器的受限沙箱下 Edge 子进程会以 `Code: 0` 静默退出
 * （stderr 为空，无法从报错看出原因）；Chrome 用同样的参数可以正常启动。
 * 所以改成按顺序探测：环境变量指定 → Edge → Chrome → puppeteer 自带的 Chrome。
 */
function browserCandidates() {
  const list = []
  if (process.env.AICHAT_BROWSER) list.push(process.env.AICHAT_BROWSER)
  list.push(EDGE, CHROME)
  for (const version of ['win64-142.0.7444.162', 'win64-131.0.6778.204']) {
    list.push(resolve(homedir(), '.cache/puppeteer/chrome', version, 'chrome-win64/chrome.exe'))
  }
  return list.filter((path, index) => path && existsSync(path) && list.indexOf(path) === index)
}
const NAV_LABEL = { conversations: '会话', search: '搜索', sync: '同步', settings: '设置' }
const EDGE_ARGS = ['--no-first-run', '--no-default-browser-check', '--disable-extensions', '--hide-scrollbars']
// 某些受限 Windows 沙箱会以 0xC0000022 阻止浏览器子进程启动；仅在显式请求时关闭浏览器沙箱。
if (process.env.AICHAT_EDGE_NO_SANDBOX === '1') EDGE_ARGS.push('--no-sandbox')

/**
 * 依次尝试候选浏览器，返回第一个能真正启动的实例。
 *
 * 只检查文件存在是不够的——受限环境下 Edge 存在但每次启动都静默失败，
 * 所以这里实际拉起一次并把失败信息打印出来，方便判断是不是环境问题。
 */
export async function launchBrowser() {
  const candidates = browserCandidates()
  if (candidates.length === 0) {
    throw new Error('找不到可用的浏览器（Edge / Chrome / puppeteer 缓存都没有）')
  }
  const failures = []
  for (const executablePath of candidates) {
    try {
      const browser = await puppeteer.launch({ executablePath, headless: true, args: EDGE_ARGS })
      console.log(`浏览器：${executablePath}`)
      return browser
    } catch (error) {
      failures.push(`  ${executablePath} → ${String(error).split('\n')[0]}`)
    }
  }
  throw new Error(`所有候选浏览器都无法启动：\n${failures.join('\n')}`)
}

/**
 * 数据源场景（截图与 QA 共用）。
 *
 * 真实的 `source_catalog` 固定返回 8 个来源，而本机通常只装了其中一两个。
 * 这正是「能力 vs 本机实际」必须分开展示的原因，所以 mock 必须把六种情况都覆盖到：
 *
 * | 来源        | found | sessionHint | 配置    | status  | 期望出现在                    |
 * | ----------- | ----- | ----------- | ------- | ------- | ----------------------------- |
 * | codex       | 是    | 15          | 手工    | available | 侧栏 / 搜索 / 已连接         |
 * | kimi        | 是    | 13          | 手工    | available | 侧栏 / 搜索 / 已连接         |
 * | cursor      | 否    | 0           | 无      | missing | **只在「添加来源」**         |
 * | claude      | 否    | 0           | 手工路径 | missing | 侧栏 / 已连接（不在搜索）    |
 * | gemini      | 否    | 4           | 无      | missing | 侧栏 / 搜索 / 已连接         |
 * | workbuddy   | 否    | 0           | 无      | error   | 已连接 + 顶部告警             |
 * | doubao-work | 否    | 0           | 无      | missing | 只在「添加来源」（import）   |
 * | legacy-export | 否  | 2           | 无      | ——      | 侧栏 / 搜索 / 已连接（不在 Catalog） |
 */
export const SOURCE_FIXTURES = {
  rows: [
    { id: 'codex', displayName: 'Codex', rootPath: 'D:/demo/codex-home', found: true, sessionHint: 15, manual: true, notes: '使用设置中手工指定的目录', detectedAt: '2026-09-19T02:00:00Z' },
    { id: 'kimi', displayName: 'Kimi Code', rootPath: 'D:/demo/kimi-home', found: true, sessionHint: 13, manual: true, notes: '使用设置中手工指定的目录', detectedAt: '2026-09-19T02:00:00Z' },
    { id: 'claude', displayName: 'Claude Code', rootPath: 'D:/demo/claude-projects', found: false, sessionHint: 0, manual: true, notes: '使用设置中手工指定的目录', detectedAt: '2026-09-19T02:00:00Z' },
    { id: 'gemini', displayName: 'Gemini CLI', rootPath: null, found: false, sessionHint: 4, manual: false, notes: null, detectedAt: '2026-09-19T02:00:00Z' },
    { id: 'workbuddy', displayName: 'WorkBuddy', rootPath: 'C:/Users/Demo/AppData/Roaming/WorkBuddy', found: false, sessionHint: 0, manual: false, notes: '状态数据库被占用，无法读取', detectedAt: '2026-09-19T02:00:00Z' },
    { id: 'legacy-export', displayName: 'legacy-export', rootPath: null, found: false, sessionHint: 2, manual: false, notes: null, detectedAt: '2026-09-19T02:00:00Z' },
    { id: 'myagent', displayName: 'My Agent', rootPath: 'D:/demo/myagent/sessions', found: true, sessionHint: 1, manual: true, notes: '用户自定义来源', detectedAt: '2026-09-19T02:00:00Z' },
  ],
  catalog: [
    { id: 'codex', displayName: 'Codex', adapterVersion: 1, access: 'native', platforms: ['windows'], description: 'Codex 数据目录，留空自动发现', status: 'available', enabled: true, notes: null },
    { id: 'kimi', displayName: 'Kimi Code', adapterVersion: 1, access: 'native', platforms: ['windows'], description: 'Kimi Code 数据目录，留空自动发现', status: 'available', enabled: true, notes: null },
    { id: 'cursor', displayName: 'Cursor', adapterVersion: 1, access: 'native', platforms: ['windows'], description: 'globalStorage 目录（state.vscdb）', status: 'missing', enabled: true, notes: null },
    { id: 'zcode', displayName: 'ZCode', adapterVersion: 1, access: 'native', platforms: ['windows'], description: 'ZCode v2/sessions 目录', status: 'missing', enabled: true, notes: null },
    { id: 'claude', displayName: 'Claude Code', adapterVersion: 1, access: 'native', platforms: ['windows'], description: '~/.claude/projects 项目历史目录', status: 'missing', enabled: true, notes: null },
    { id: 'gemini', displayName: 'Gemini CLI', adapterVersion: 1, access: 'native', platforms: ['windows'], description: '~/.gemini/tmp 项目历史目录', status: 'missing', enabled: true, notes: null },
    { id: 'workbuddy', displayName: 'WorkBuddy', adapterVersion: 1, access: 'native', platforms: ['windows'], description: 'WorkBuddy 应用数据目录；按检测结果显示正文支持程度', status: 'error', enabled: true, notes: '状态数据库被占用，无法读取' },
    { id: 'doubao-work', displayName: '豆包工作', adapterVersion: 1, access: 'import', platforms: ['windows'], description: '仅支持标准格式手动导入；自动采集待适配', status: 'missing', enabled: true, notes: null },
    // 已识别但未适配：只在「添加来源」里出现，标注「待适配」
    { id: 'cline', displayName: 'Cline', adapterVersion: 1, access: 'pending', platforms: ['windows'], description: '尚未适配。常见位置：VS Code globalStorage 的 saoudrizwan.claude-dev/tasks（未在本机验证）', status: 'missing', enabled: true, notes: null },
    { id: 'continue', displayName: 'Continue.dev', adapterVersion: 1, access: 'pending', platforms: ['windows'], description: '尚未适配。常见位置：~/.continue/sessions（未在本机验证）', status: 'missing', enabled: true, notes: null },
    { id: 'aider', displayName: 'Aider', adapterVersion: 1, access: 'pending', platforms: ['windows'], description: '尚未适配。常见位置：项目目录下的 .aider.chat.history.md（未在本机验证）', status: 'missing', enabled: true, notes: null },
  ],
  /** 与 catalog 对应的设置里来源配置：claude 有手工路径（「未安装但已配置」）。 */
  settingsSources: {
    codex: { enabled: true, path: 'D:/demo/codex-home' },
    kimi: { enabled: true, path: 'D:/demo/kimi-home' },
    claude: { enabled: true, path: 'D:/demo/claude-projects' },
    // 用户自定义来源：不在 catalog 里，靠一份字段映射读取
    myagent: {
      enabled: true,
      path: 'D:/demo/myagent/sessions',
      displayName: 'My Agent',
      mapping: {
        layout: 'jsonl',
        messagesPath: 'messages',
        roleField: 'role',
        textField: 'content',
        timeField: 'timestamp',
        toolField: '',
        titleField: '',
        projectField: '',
        roleMap: {},
        extensions: ['jsonl'],
        maxDepth: 8,
      },
    },
  },
  /**
   * 「本机未安装但有历史」与「Catalog 里没有的来源」各造一条真实会话，
   * 否则侧栏与搜索里的这两个来源只是空数字，截图看不出它们真的能用。
   */
  extraSessions: [
    {
      id: 'gemini/demo-1', source: 'gemini', externalId: 'demo-1', title: 'Gemini: 归档脚本的幂等性',
      projectPath: '/home/dev/work/archive-tools', createdAt: '2026-09-17T09:12:00Z', updatedAt: '2026-09-17T09:30:00Z',
      machineId: 'demo-machine', messageCount: 4, partial: false, archived: false, syncStatus: 'synced',
      primaryFile: '/demo/gemini/demo-1.json', contentHash: 'gemini1',
    },
    {
      id: 'gemini/demo-2', source: 'gemini', externalId: 'demo-2', title: 'Gemini: 索引压缩策略对比',
      projectPath: '/home/dev/work/archive-tools', createdAt: '2026-09-16T11:02:00Z', updatedAt: '2026-09-16T11:20:00Z',
      machineId: 'demo-machine', messageCount: 3, partial: true, archived: false, syncStatus: 'synced',
      primaryFile: '/demo/gemini/demo-2.json', contentHash: 'gemini2',
    },
    {
      id: 'myagent/demo-1', source: 'myagent', externalId: 'demo-1', title: 'My Agent：自建工具的会话',
      projectPath: '/home/dev/work/my-agent', createdAt: '2026-09-18T09:00:00Z', updatedAt: '2026-09-18T09:20:00Z',
      machineId: 'demo-machine', messageCount: 2, partial: false, archived: false, syncStatus: 'local',
      primaryFile: '/demo/myagent/demo-1.jsonl', contentHash: 'myagent1',
    },
    {
      id: 'legacy-export/demo-1', source: 'legacy-export', externalId: 'legacy-1', title: '旧版导出的会话（来源已下线）',
      projectPath: '/home/dev/legacy/imported', createdAt: '2026-08-30T08:00:00Z', updatedAt: '2026-08-30T08:15:00Z',
      machineId: 'demo-machine', messageCount: 2, partial: false, archived: false, syncStatus: 'local',
      primaryFile: '/demo/legacy-export/legacy-1.json', contentHash: 'legacy1',
    },
  ],
  extraMessages: {
    'gemini/demo-1': [
      { id: 'gemini/demo-1#1', sessionId: 'gemini/demo-1', sequence: 1, role: 'user', kind: 'message', text: '归档脚本重复执行会覆盖已有文件，怎么做到幂等？', toolName: null, timestamp: '2026-09-17T09:12:00Z', raw: null },
      { id: 'gemini/demo-1#2', sessionId: 'gemini/demo-1', sequence: 2, role: 'assistant', kind: 'message', text: '用内容哈希命名，写入前先查 hash 是否已存在；存在就跳过。', toolName: null, timestamp: '2026-09-17T09:13:00Z', raw: null },
    ],
    'gemini/demo-2': [
      { id: 'gemini/demo-2#1', sessionId: 'gemini/demo-2', sequence: 1, role: 'user', kind: 'message', text: '索引压缩 watchdog 相关的策略怎么选？', toolName: null, timestamp: '2026-09-16T11:02:00Z', raw: null },
      { id: 'gemini/demo-2#2', sessionId: 'gemini/demo-2', sequence: 2, role: 'assistant', kind: 'message', text: 'zstd 在日志类数据上比 gzip 更划算，解压更快。', toolName: null, timestamp: '2026-09-16T11:03:00Z', raw: null },
    ],
    'myagent/demo-1': [
      { id: 'myagent/demo-1#1', sessionId: 'myagent/demo-1', sequence: 1, role: 'user', kind: 'message', text: '这个来源是用字段映射接进来的，没有专门的适配器。', toolName: null, timestamp: '2026-09-18T09:00:00Z', raw: null },
      { id: 'myagent/demo-1#2', sessionId: 'myagent/demo-1', sequence: 2, role: 'assistant', kind: 'message', text: '映射填对了就能读出来；填错了试解析会当场报错。', toolName: null, timestamp: '2026-09-18T09:00:10Z', raw: null },
    ],
    'legacy-export/demo-1': [
      { id: 'legacy-export/demo-1#1', sessionId: 'legacy-export/demo-1', sequence: 1, role: 'user', kind: 'message', text: '这是从旧版本导出的会话，来源已经不在产品目录里了。', toolName: null, timestamp: '2026-08-30T08:00:00Z', raw: null },
      { id: 'legacy-export/demo-1#2', sessionId: 'legacy-export/demo-1', sequence: 2, role: 'assistant', kind: 'message', text: '历史仍然保留，也可以在侧栏与搜索里筛到这个来源。', toolName: null, timestamp: '2026-08-30T08:01:00Z', raw: null },
    ],
  },
}

/** 解析命令行参数。 */
function parseArgs(argv) {
  const args = {
    out: '.ui-shots/latest',
    mock: '.ui-shots/mock/data.json',
    url: 'http://localhost:1420',
    themes: ['dark', 'light'],
    sizes: ['1440x900', '1180x800', '900x700'],
    pages: ['conversations', 'search', 'sync', 'settings'],
    states: ['normal'],
    a11y: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i]
    if (!key.startsWith('--')) continue
    const value = argv[i + 1]
    i += 1
    switch (key.slice(2)) {
      case 'out': args.out = value; break
      case 'mock': args.mock = value; break
      case 'url': args.url = value; break
      case 'themes': args.themes = value.split(','); break
      case 'sizes': args.sizes = value.split(','); break
      case 'pages': args.pages = value.split(','); break
      case 'states': args.states = value.split(','); break
      case 'a11y': args.a11y = value === 'true'; break
      default: break
    }
  }
  return args
}

/**
 * 在页面上下文里安装 IPC mock 的脚本。
 *
 * 两个关键点：
 * 1. 必须在页面脚本之前注入（evaluateOnNewDocument）；
 * 2. 处理逻辑必须写在页面里 —— 从 Node 传函数会被 JSON 序列化丢掉（注意 `String.raw`）。
 */
export const PAGE_MOCK = String.raw`
(() => {
  const mock = __MOCK__;
  const stateName = __STATE__;
  const theme = __THEME__;
  const fixtures = __SOURCES__;
  const sessions = mock.sessions;
  // 追加「本机未安装但有历史」与「Catalog 之外的来源」的会话（引用同一个数组，后续读到的就是完整集合）
  mock.sessions.push.apply(mock.sessions, fixtures.extraSessions);
  const messages = mock.messages;
  for (const key of Object.keys(fixtures.extraMessages)) messages[key] = fixtures.extraMessages[key];
  const sourceRows = fixtures.rows;
  const sourceCatalog = fixtures.catalog;
  const windowState = { maximized: false, calls: [] };
  window.__UI_QA_WINDOW_STATE__ = windowState;
  /** QA 用：记录每次 search 的请求序号，用来验证「旧响应不覆盖新响应」 */
  window.__UI_QA_SEARCH__ = { calls: [] };

  /** 会话筛选（与后端 SessionFilter 语义一致）。 */
  const byFilter = (filter) => {
    const f = filter || {};
    return sessions.filter((s) => {
      if (f.source && s.source !== f.source) return false;
      if (f.projectPath && s.projectPath !== f.projectPath) return false;
      if (f.machineId && s.machineId !== f.machineId) return false;
      if (f.text && !(s.title || '').includes(f.text)) return false;
      if (f.onlyArchived && !s.archived) return false;
      if (!f.includeArchived && !f.onlyArchived && s.archived) return false;
      return true;
    });
  };

  /** 正则元字符转义（手工实现，避免在 String.raw 模板里出现美元符号加花括号）。 */
  const escapeRe = (text) => {
    let out = '';
    for (const ch of text) {
      out += ('.*+?^$()[]{}|\\/'.indexOf(ch) >= 0 ? '\\' : '') + ch;
    }
    return out;
  };

  /** 关键词搜索：子串匹配 + 高亮，返回与 Rust 端同形的结构。 */
  /** 只搜对话正文时排除工具输出与事件（与后端 messagesOnly 语义一致）。 */
  const isBodyMessage = (message) => message.kind === 'message';

  const doSearch = (query) => {
    const terms = (query.text || '').split(/\s+/).filter(Boolean);
    const hits = [];
    if (terms.length) {
      for (const session of byFilter(query.filter)) {
        for (const message of messages[session.id] || []) {
          if (query.messagesOnly && !isBodyMessage(message)) continue;
          const text = message.text || '';
          if (!terms.every((t) => text.toLowerCase().includes(t.toLowerCase()))) continue;
          const at = Math.max(0, text.toLowerCase().indexOf(terms[0].toLowerCase()) - 40);
          const raw = text.slice(at, at + 90);
          const marked = terms.reduce((acc, t) =>
            acc.replace(new RegExp(escapeRe(t), 'gi'), (m) => '<mark>' + m + '</mark>'), raw);
          hits.push({
            sessionId: session.id, messageId: message.id, sequence: message.sequence,
            role: message.role, kind: message.kind, timestamp: message.timestamp,
            snippet: (at > 0 ? '…' : '') + marked + '…', score: -1 - hits.length * 0.01,
            title: session.title, projectPath: session.projectPath, source: session.source,
            machineId: session.machineId, sessionUpdatedAt: session.updatedAt,
          });
          if (hits.length >= 30) break;
        }
        if (hits.length >= 30) break;
      }
    }
    return { hits, hasMore: false, tookMs: 4, matchQuery: terms.map((t) => '"' + t + '"').join(' ') };
  };

  /**
   * 导入的「自动识别」在 mock 里也要按真实规则判断，而不是返回一个固定字符串——
   * 否则 QA 断言的是假象。判别顺序与 Rust 侧一致：先试整段 JSON（对象 / 数组），
   * 失败才逐行当 JSONL。所以「两行 JSON」不会被误判成一个 messages 对象。
   */
  const detectImportFormat = (text) => {
    const t = (text || '').trim();
    const tryParse = (value) => { try { return JSON.parse(value); } catch { return undefined; } };
    const parsed = tryParse(t);
    if (Array.isArray(parsed)) return '顶层消息数组';
    if (parsed && typeof parsed === 'object') {
      return parsed.schemaVersion !== undefined ? '标准会话包（schemaVersion 1）' : 'messages 数组对象';
    }
    const lines = t.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (lines.length > 0 && lines.every((line) => tryParse(line) !== undefined)) {
      return t.includes('"message"') && t.includes('"content"') ? 'Claude Code 转录' : 'JSONL 转录（一行一条消息）';
    }
    return 'Markdown 模板';
  };
  let importToken = 0;

  const sync = stateName === 'empty' ? mock.syncStatusUnset
    : stateName === 'conflict' ? mock.syncStatusConflict : mock.syncStatus;
  const emptyState = stateName === 'empty';
  const scanReport = {
    scanned: mock.stats.sessions, parsed: 0, skipped: mock.stats.sessions, removed: 0,
    failed: 0, pending: 0, skippedDuplicates: 0, durationMs: 86, warnings: [], sources: sourceRows,
  };

  const table = {
    detect_sources: () => sourceRows,
    list_sources: () => sourceRows,
    // 数据源目录（来源注册表）：8 个产品支持的来源，本机只发现其中一部分
    source_catalog: () => sourceCatalog.map((s) => ({
      ...s,
      descriptionCode: 'source.' + s.id + '.description',
    })),
    // 事件订阅：返回一个 no-op 反注册函数（真实后端返回 UnlistenFn）
    'plugin:event|listen': () => () => {},
    list_sessions: (a) => (emptyState ? [] : byFilter(a.filter))
      .slice(a.offset || 0, (a.offset || 0) + (a.limit || 200)),
    count_sessions: (a) => (emptyState ? 0 : byFilter(a.filter).length),
    get_session: (a) => {
      const s = emptyState ? null : sessions.find((x) => x.id === a.sessionId);
      if (!s) return null;
      const dir = (s.primaryFile || '/demo/session').replace(/\/[^/]+$/, '');
      return Object.assign({}, s, {
        sourceRoot: dir,
        metadata: { format: s.source === 'kimi' ? 'kimi/wire' : 'codex/rollout', wireLines: 128, telemetryEvents: 42 },
        rawFiles: [
          { path: dir + '/wire.jsonl', role: 'wire', size: 18432, mtime: 0, hash: s.contentHash },
          { path: dir + '/state.json', role: 'state', size: 512, mtime: 0, hash: null },
        ],
      });
    },
    get_messages: (a) => (messages[a.sessionId] || []).slice(a.offset || 0, (a.offset || 0) + (a.limit || 200)),
    get_messages_around: (a) => (messages[a.sessionId] || []).filter(
      (m) => m.sequence >= a.sequence - (a.before || 30) && m.sequence <= a.sequence + (a.after || 60)),
    list_projects: () => (emptyState ? [] : mock.projects),
    list_machines: () => mock.machines,
    get_stats: () => (emptyState
      ? { sessions: 0, messages: 0, archivedSessions: 0, projects: 0, bytesOnDisk: 0 } : mock.stats),
    scan_library: () => scanReport,
    rebuild_index: () => scanReport,
    // 记录调用序号与条件，供 QA 断言「筛选变化后确实发出了新查询」
    search: async (a) => {
      const log = window.__UI_QA_SEARCH__;
      const index = log.calls.length;
      const entry = {
        text: a.query.text,
        source: (a.query.filter || {}).source || '',
        order: a.query.order || 'relevance',
        messagesOnly: Boolean(a.query.messagesOnly),
        offset: a.query.offset || 0,
      };
      log.calls.push(entry);
      // QA 用：按调用序号注入人工延迟，用来构造「旧响应晚于新响应返回」的竞态
      const delay = (log.delays || {})[index] || 0;
      if (delay) await new Promise((r) => setTimeout(r, delay));
      const result = doSearch(a.query);
      entry.hits = result.hits.length;
      return result;
    },
    sync_status: () => sync,
    sync_now: () => ({
      steps: [], branch: 'main', remote: sync.remote, committed: true, pushed: true, pulled: true,
      snapshot: { written: 2, skipped: 20, failed: 0, bytes: 184320, files: [] },
      conflict: null, durationMs: 3200,
    }),
    git_log: () => [
      { hash: 'c0ffee1a', shortHash: 'c0ffee1', author: 'dev', date: '2026-09-19T10:12:00Z', refs: '', subject: '本地改动：整理第九章实验数据', unpushed: true },
      { hash: 'c0ffee2b', shortHash: 'c0ffee2', author: 'dev', date: '2026-09-18T21:40:00Z', refs: '', subject: '本地改动：补充集成测试', unpushed: true },
      { hash: 'beef1234', shortHash: 'beef123', author: 'dev', date: '2026-09-18T09:05:00Z', refs: 'HEAD -> main, origin/main', subject: 'sync: 写入 2 个会话快照', unpushed: false },
      { hash: 'beef5678', shortHash: 'beef567', author: 'dev', date: '2026-09-17T18:22:00Z', refs: 'origin/main', subject: 'sync: 首次推送仓库', unpushed: false },
    ],
    abort_rebase: () => null,
    archive_sessions: () => ({ archived: 1, failed: 0, bytesIn: 0, bytesOut: 184320, entries: [], warnings: [] }),
    archive_old_sessions: () => ({ archived: 0, failed: 0, bytesIn: 0, bytesOut: 0, entries: [], warnings: [] }),
    list_archives: () => (emptyState ? [] : mock.archives),
    restore_archive: () => 'D:/AIChatRepo/kimi/ses_0aa1',
    get_settings: () => Object.assign({}, mock.settings, {
      theme,
      language: 'zh',
      // 来源配置必须带上：claude 的「未安装但手工配置」只有从这里才能看出来
      sources: fixtures.settingsSources,
    }),
    save_settings: (a) => Object.assign({}, a.settings),
    preview_import: (a) => {
      importToken += 1;
      const token = 'mock-import-' + importToken;
      return {
        token,
        detectedFormat: detectImportFormat(a.text),
        failed: 0,
        warnings: [],
        sessions: [{
          source: a.source,
          externalId: 'mock-1',
          title: '示例会话（mock 预览）',
          messageCount: 2,
          partial: false,
          messages: [
            { role: 'user', text: '这是 mock 预览的第一条消息，用来验证预览面板的布局。', kind: 'message', timestamp: null, toolName: null, attachments: [] },
            { role: 'assistant', text: '第二条。真实实现会解析出你贴进来的内容。', kind: 'message', timestamp: null, toolName: null, attachments: [] },
          ],
        }],
      };
    },
    confirm_import: () => ({ success: 1, duplicates: 0, failed: 0, partial: 0, warnings: [] }),
    cancel_import: () => null,
    save_import_template: () => null,
    preview_generic_source: () => ({
      filesFound: 7,
      sessionsSampled: 3,
      messages: 18,
      samples: [
        {
          file: 'D:/demo/myagent/2026-09-18.jsonl',
          title: '示例会话（mock 试解析）',
          messages: [
            { role: 'user', kind: 'message', text: '这段文字来自 mock 的试解析结果。', timestamp: '2026-09-18T10:00:00Z' },
            { role: 'assistant', kind: 'message', text: '真实实现会按你填的字段映射去读目录。', timestamp: '2026-09-18T10:00:05Z' },
          ],
        },
      ],
      warnings: [],
    }),
    data_dir: () => mock.dataDir,
    machine_id: () => mock.machineId,
    'plugin:window|is_maximized': () => windowState.maximized,
    'plugin:window|start_dragging': () => {
      windowState.maximized = false;
      windowState.calls.push('start_dragging');
    },
    'plugin:window|toggle_maximize': () => {
      windowState.maximized = !windowState.maximized;
      windowState.calls.push('toggle_maximize');
    },
    'plugin:window|minimize': () => { windowState.calls.push('minimize'); },
    'plugin:window|close': () => { windowState.calls.push('close'); },
  };

  window.__TAURI_INTERNALS__ = {
    // getCurrentWindow() 需要的元数据（自绘标题栏的窗口控制会读到）
    metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main', windowLabel: 'main' } },
    invoke: async (cmd, args) => {
      const handler = table[cmd];
      if (!handler) {
        console.warn('[ui-shot] 未 mock 的命令：' + cmd);
        return null;
      }
      return handler(args || {});
    },
    transformCallback: () => 1,
    unregisterCallback: () => {},
    convertFileSrc: (p) => p,
  };
})();
`


/**
 * 切换页面：优先直接点 Rail 上的导航项；Rail 不存在（<768px）时先开标题栏的导航抽屉。
 */
async function gotoPage(tab, label) {
  const clicked = await tab.evaluate((name) => {
    const button = [...document.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === name,
    )
    if (button) {
      button.click()
      return true
    }
    return false
  }, label)
  if (clicked) return
  await tab.evaluate(() => {
    document.querySelector('button[aria-label="打开导航"]')?.click()
  })
  await new Promise((r) => setTimeout(r, 300))
  await tab.evaluate((name) => {
    const button = [...document.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === name,
    )
    button?.click()
  }, label)
}

/** 点一个文本完全匹配的按钮（设置页的分区操作、抽屉入口等）。 */
async function clickByText(tab, label) {
  return tab.evaluate((name) => {
    const button = [...document.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === name,
    )
    if (!button) return false
    button.click()
    return true
  }, label)
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 浮层类截图。
 *
 * 每个浮层有自己的合适视口与触发路径：
 * - 导航抽屉只在 <768px 出现（≥768px Rail 常驻），所以用 640x720；
 * - 来源抽屉需要 768–1279px 区间（此时「来源与项目」按钮才存在），用 1180x800；
 * - 设置页的三个抽屉与 Quick Search 用它们最常见的窗口尺寸。
 */
const OVERLAY_SHOTS = [
  {
    page: 'nav-drawer',
    size: '640x720',
    setup: async (tab) => {
      await tab.evaluate(() => {
        document.querySelector('button[aria-label="打开导航"]')?.click()
      })
      await wait(400)
    },
  },
  {
    page: 'source-drawer',
    size: '1180x800',
    setup: async (tab) => {
      await clickByText(tab, '来源与项目')
      await wait(400)
    },
  },
  {
    page: 'add-source',
    size: '1180x800',
    setup: async (tab) => {
      await gotoPage(tab, '设置')
      await wait(400)
      await clickByText(tab, '添加来源')
      await wait(400)
    },
  },
  {
    page: 'configure-source',
    size: '1180x800',
    setup: async (tab) => {
      await gotoPage(tab, '设置')
      await wait(400)
      await clickByText(tab, '配置')
      await wait(400)
    },
  },
  {
    page: 'import-drawer',
    size: '1180x800',
    setup: async (tab) => {
      await gotoPage(tab, '设置')
      await wait(400)
      await clickByText(tab, '导入会话')
      await wait(400)
    },
  },
  {
    page: 'custom-source',
    size: '1180x800',
    setup: async (tab) => {
      await gotoPage(tab, '设置')
      await wait(400)
      await clickByText(tab, '添加来源')
      await wait(400)
      // 从「待适配」的工具进入，验证「我们还没做 → 那我自己接」这条路径
      await tab.evaluate(() => {
        ;[...document.querySelectorAll('[role="dialog"] button')]
          .find((b) => b.textContent?.trim() === '用自定义来源接入')
          ?.click()
      })
      await wait(400)
      // 展开高级字段，让截图覆盖全部映射项
      await tab.evaluate(() => {
        ;[...document.querySelectorAll('[role="dialog"] button')]
          .find((b) => (b.textContent ?? '').includes('高级字段'))
          ?.click()
      })
      await wait(300)
    },
  },
  {
    page: 'custom-preview',
    size: '1180x800',
    setup: async (tab) => {
      await gotoPage(tab, '设置')
      await wait(400)
      await clickByText(tab, '添加来源')
      await wait(400)
      await tab.evaluate(() => {
        ;[...document.querySelectorAll('[role="dialog"] button')]
          .find((b) => b.textContent?.trim() === '用自定义来源接入')
          ?.click()
      })
      await wait(400)
      await tab.evaluate(() => {
        const dialog = document.querySelector('[role="dialog"]')
        const path = [...(dialog?.querySelectorAll('input') ?? [])][2]
        if (!(path instanceof HTMLInputElement)) return
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
        setter.call(path, 'D:/demo/myagent/sessions')
        path.dispatchEvent(new Event('input', { bubbles: true }))
      })
      await wait(300)
      await tab.evaluate(() => {
        ;[...document.querySelectorAll('[role="dialog"] button')]
          .find((b) => b.textContent?.trim() === '试解析')
          ?.click()
      })
      await wait(800)
    },
  },
  {
    page: 'quicksearch',
    size: '1440x900',
    setup: async (tab) => {
      await tab.evaluate(() => {
        const button = [...document.querySelectorAll('button')].find((b) =>
          (b.getAttribute('aria-label') ?? '').startsWith('快速搜索'),
        )
        button?.click()
      })
      // 等浮层挂载完成再输入：直接 type 会在面板还没渲染时抛「找不到选择器」，
      // 一个瞬时竞态就会让整轮截图中断。
      await tab.waitForSelector('[role="dialog"] input[role="combobox"]', { timeout: 5000 })
      await tab.type('[role="dialog"] input[role="combobox"]', 'watchdog', { delay: 20 })
      await wait(900)
    },
  },
]

/**
 * 对比度审计：遍历可见文本，取计算样式与「有效背景」，按 WCAG 算对比度。
 *
 * 返回低于阈值的条目（正文 4.5:1，大字号 3:1）。用来把「浅色/深色都要达到 AA」
 * 变成可执行的检查，而不是靠肉眼。
 */
const CONTRAST_AUDIT = () => {
  // 用 1×1 canvas 把任意 CSS 颜色（oklch / color-mix / var 展开后的值）转成 sRGB 字节，
  // 直接按字符串解析会踩到 `oklch(0.2 0.005 265)` 这类格式（数值含义与 rgb 完全不同）。
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 1
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  const cache = new Map()
  const parse = (color) => {
    if (!color) return null
    if (cache.has(color)) return cache.get(color)
    ctx.clearRect(0, 0, 1, 1)
    ctx.fillStyle = '#000'
    ctx.fillStyle = color
    ctx.fillRect(0, 0, 1, 1)
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data
    const value = { r, g, b, a: a / 255 }
    cache.set(color, value)
    return value
  }
  const luminance = ({ r, g, b }) => {
    const channel = (v) => {
      const s = v / 255
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
    }
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
  }
  const over = (fg, bg) => ({
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  })
  const effectiveBackground = (element) => {
    // 收集从根到叶的背景层，然后自下而上合成 —— 顺序反了会算出完全错误的颜色
    const layers = []
    let node = element
    while (node) {
      const bg = parse(getComputedStyle(node).backgroundColor)
      if (bg && bg.a > 0) layers.push(bg)
      node = node.parentElement
    }
    layers.reverse()
    let composed = layers.length > 0 ? layers[0] : { r: 255, g: 255, b: 255, a: 1 }
    // 注意：不能因为某一层已经不透明就提前结束 —— 下面还有更靠前的层需要叠加
    for (let i = 1; i < layers.length; i += 1) {
      composed = over(layers[i], composed)
    }
    return composed
  }
  const results = []
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  const seen = new Set()
  while (walker.nextNode()) {
    const text = walker.currentNode.textContent?.trim()
    if (!text) continue
    const element = walker.currentNode.parentElement
    if (!element || seen.has(element)) continue
    seen.add(element)
    const rect = element.getBoundingClientRect()
    if (rect.width < 2 || rect.height < 2) continue
    const style = getComputedStyle(element)
    if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) < 0.3) continue
    const fg = parse(style.color)
    if (!fg) continue
    const bg = effectiveBackground(element)
    const composed = fg.a < 1 ? over(fg, bg) : fg
    const l1 = luminance(composed)
    const l2 = luminance(bg)
    const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
    const size = Number.parseFloat(style.fontSize)
    const weight = Number(style.fontWeight) || 400
    const large = size >= 24 || (size >= 18.66 && weight >= 700)
    const threshold = large ? 3 : 4.5
    if (ratio + 0.01 < threshold) {
      const chainRaw = []
      {
        let n = element
        while (n) {
          const raw = getComputedStyle(n).backgroundColor
          if (raw !== 'rgba(0, 0, 0, 0)') chainRaw.push(`${n.tagName}:${raw}`)
          n = n.parentElement
        }
      }
      results.push({
        chain: chainRaw.join(' | '),
        text: text.slice(0, 40),
        ratio: Math.round(ratio * 100) / 100,
        threshold,
        color: style.color,
        bg: `rgb(${Math.round(bg.r)},${Math.round(bg.g)},${Math.round(bg.b)}) a=${bg.a.toFixed(2)}`,
        size: Math.round(size * 10) / 10,
        className: (element.className || '').toString().slice(0, 60),
      })
    }
  }
  return results
}

/** 生成注入脚本（替换占位符）。ui_qa.mjs 也复用它，保证行为一致。 */
export function injectionFor(mock, stateName, theme) {
  return PAGE_MOCK
    .replace('__MOCK__', JSON.stringify(mock))
    .replace('__STATE__', JSON.stringify(stateName))
    .replace('__THEME__', JSON.stringify(theme))
    .replace('__SOURCES__', JSON.stringify(SOURCE_FIXTURES))
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const mockPath = resolve(args.mock)
  if (!existsSync(mockPath)) {
    console.error(
      `mock 数据不存在：${mockPath}\n` +
      '先运行：python tools/export_ui_mock.py .ui-shots/demo-index .ui-shots/mock/data.json',
    )
    process.exit(1)
  }
  const mock = JSON.parse(readFileSync(mockPath, 'utf8'))
  mkdirSync(resolve(args.out), { recursive: true })

  const browser = await launchBrowser()

  const written = []
  const findings = []
  const failed = []
  try {
    for (const state of args.states) {
      for (const size of args.sizes) {
        const [width, height] = size.split('x').map(Number)
        for (const theme of args.themes) {
          for (const page of args.pages) {
            const name = `${page}-${theme}-${size}${state === 'normal' ? '' : `-${state}`}.png`
            const tab = await browser.newPage()
            await tab.setViewport({ width, height, deviceScaleFactor: 2 })
            await tab.evaluateOnNewDocument(injectionFor(mock, state, theme))
            await tab.goto(args.url, { waitUntil: 'networkidle2', timeout: 60000 })
            await tab.waitForSelector('header', { timeout: 20000 })
            // 等首屏数据落地（会话列表或空状态都算就绪）
            await tab.waitForFunction(() => document.body.innerText.includes('会话'), { timeout: 20000 })
            if (page !== 'conversations') {
              await gotoPage(tab, NAV_LABEL[page])
            }
            if (state === 'drawer') {
              // 窄窗口：点开标题栏的导航抽屉，验证全局导航的降级方案
              await tab.evaluate(() => {
                document.querySelector('button[aria-label="打开导航"]')?.click()
              })
              await new Promise((r) => setTimeout(r, 400))
            }
            if (state === 'more') {
              // 打开工具栏「更多操作」菜单（overlay 表面 + 阴影）
              await tab.evaluate(() => {
                const button = document.querySelector('button[aria-haspopup="menu"]')
                button?.click()
              })
              await new Promise((r) => setTimeout(r, 400))
            }
            if (state === 'detail') {
              // 两级视图：点第一条会话，验证「列表 → 详情 → 返回」
              await tab.evaluate(() => {
                const row = document.querySelector('button[data-row="session"]')
                if (row instanceof HTMLElement) row.click()
              })
              await new Promise((r) => setTimeout(r, 600))
            }
            if (state === 'query') {
              // 搜索出结果：输入关键词并回车
              await tab.evaluate(() => {
                const input = document.querySelector('input[aria-label="搜索关键词"]')
                if (input) {
                  const setter = Object.getOwnPropertyDescriptor(
                    window.HTMLInputElement.prototype, 'value').set
                  setter.call(input, 'watchdog')
                  input.dispatchEvent(new Event('input', { bubbles: true }))
                }
              })
              await tab.keyboard.press('Enter')
              await new Promise((r) => setTimeout(r, 700))
            }
            if (state === 'advanced') {
              // 展开高级筛选
              await tab.evaluate(() => {
                const button = [...document.querySelectorAll('button')]
                  .find((b) => (b.textContent ?? '').includes('高级筛选'))
                button?.click()
              })
              await new Promise((r) => setTimeout(r, 400))
            }
            if (state === 'dirty') {
              // 设置未保存 → 切换到其他页面应被拦下
              await tab.evaluate(() => {
                const toggle = document.querySelector('button[role="switch"]')
                if (!toggle) throw new Error('设置页未找到 role="switch" 的开关')
                toggle.click()
              })
              await new Promise((r) => setTimeout(r, 300))
              await gotoPage(tab, '会话')
              await new Promise((r) => setTimeout(r, 500))
            }
            if (state === 'focus') {
              // 键盘焦点状态：连按 Tab，验证焦点环清晰可见（Phase 1 验收项）
              for (let i = 0; i < 6; i += 1) {
                await tab.keyboard.press('Tab')
                await new Promise((r) => setTimeout(r, 80))
              }
            }
            await new Promise((r) => setTimeout(r, 700))
            await tab.screenshot({ path: resolve(args.out, name) })
            // 对比度审计：每个页面在最大视口各跑一次（含深浅两色）
            if (args.a11y && size === args.sizes[0]) {
              const issues = await tab.evaluate(CONTRAST_AUDIT)
              for (const issue of issues) {
                findings.push({ name, ...issue })
              }
            }
            await tab.close()
            written.push(name)
          }
        }
      }
    }

    // 浮层类截图：每个浮层有自己合适的视口与触发方式，不跟着主循环的尺寸矩阵跑
    for (const shot of OVERLAY_SHOTS) {
      for (const theme of args.themes) {
        const [width, height] = shot.size.split('x').map(Number)
        const name = `${shot.page}-${theme}.png`
        const tab = await browser.newPage()
        await tab.setViewport({ width, height, deviceScaleFactor: 2 })
        await tab.evaluateOnNewDocument(injectionFor(mock, 'normal', theme))
        await tab.goto(args.url, { waitUntil: 'networkidle2', timeout: 60000 })
        await tab.waitForSelector('header', { timeout: 20000 })
        await tab.waitForFunction(() => document.body.innerText.includes('会话'), { timeout: 20000 })
        try {
          await shot.setup(tab)
        } catch (error) {
          // 单个浮层没打开不该让整轮证据缺失：报告出来继续跑其余的
          console.error(`  !! ${shot.page} 截图失败：${String(error).slice(0, 160)}`)
          failed.push(`${shot.page}-${theme}`)
          await tab.close()
          continue
        }
        await new Promise((r) => setTimeout(r, 700))
        await tab.screenshot({ path: resolve(args.out, name) })
        if (args.a11y) {
          const issues = await tab.evaluate(CONTRAST_AUDIT)
          for (const issue of issues) findings.push({ name, ...issue })
        }
        await tab.close()
        written.push(name)
      }
    }
  } finally {
    await browser.close()
  }
  console.log(`已生成 ${written.length} 张截图 → ${resolve(args.out)}`)
  if (failed.length > 0) console.log(`未生成 ${failed.length} 张：${failed.join(', ')}`)
  if (args.a11y) {
    if (findings.length === 0) {
      console.log('对比度审计：未发现低于 WCAG AA 阈值的文本 ✓')
    } else {
      console.log(`对比度审计：发现 ${findings.length} 处低于阈值`)
      for (const issue of findings.slice(0, 25)) {
        console.log(`  [${issue.name}] ${issue.ratio}:1 < ${issue.threshold}:1  ${issue.size}px  "${issue.text}"`)
        console.log(`      color=${issue.color} bg=${issue.bg}`)
      }
    }
  }
}

// 直接执行时才跑 CLI；被 import 时（ui_qa.mjs）只导出工具函数
// 用文件名后缀判断，避免路径分隔符在 Windows/Git Bash 下的差异
const isDirectRun = /ui_shot[.]mjs$/.test(process.argv[1] || '')
if (isDirectRun) {
  main().catch((error) => {
    console.error('截图失败：', error)
    process.exit(1)
  })
}
