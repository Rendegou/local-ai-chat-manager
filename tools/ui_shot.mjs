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
import { resolve } from 'node:path'
import puppeteer from 'puppeteer-core'

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const NAV_LABEL = { conversations: '会话', search: '搜索', sync: '同步', settings: '设置' }

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
const PAGE_MOCK = String.raw`
(() => {
  const mock = __MOCK__;
  const stateName = __STATE__;
  const theme = __THEME__;
  const sessions = mock.sessions;
  const messages = mock.messages;

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
  const doSearch = (query) => {
    const terms = (query.text || '').split(/\s+/).filter(Boolean);
    const hits = [];
    if (terms.length) {
      for (const session of byFilter(query.filter)) {
        for (const message of messages[session.id] || []) {
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

  const sync = stateName === 'empty' ? mock.syncStatusUnset
    : stateName === 'conflict' ? mock.syncStatusConflict : mock.syncStatus;
  const emptyState = stateName === 'empty';
  const scanReport = {
    scanned: mock.stats.sessions, parsed: 0, skipped: mock.stats.sessions, removed: 0,
    failed: 0, pending: 0, skippedDuplicates: 0, durationMs: 86, warnings: [], sources: mock.sources,
  };

  const table = {
    detect_sources: () => mock.sources,
    list_sources: () => mock.sources,
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
    search: (a) => doSearch(a.query),
    sync_status: () => sync,
    sync_now: () => ({
      steps: [], branch: 'main', remote: sync.remote, committed: true, pushed: true, pulled: true,
      snapshot: { written: 2, skipped: 20, failed: 0, bytes: 184320, files: [] },
      conflict: null, durationMs: 3200,
    }),
    git_log: () => mock.gitLog,
    abort_rebase: () => null,
    archive_sessions: () => ({ archived: 1, failed: 0, bytesIn: 0, bytesOut: 184320, entries: [], warnings: [] }),
    archive_old_sessions: () => ({ archived: 0, failed: 0, bytesIn: 0, bytesOut: 0, entries: [], warnings: [] }),
    list_archives: () => (emptyState ? [] : mock.archives),
    restore_archive: () => 'D:/AIChatRepo/kimi/ses_0aa1',
    get_settings: () => Object.assign({}, mock.settings, { theme }),
    save_settings: (a) => Object.assign({}, a.settings, { theme }),
    data_dir: () => mock.dataDir,
    machine_id: () => mock.machineId,
  };

  window.__TAURI_INTERNALS__ = {
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

/** 生成注入脚本（替换占位符）。 */
function injectionFor(mock, stateName, theme) {
  return PAGE_MOCK
    .replace('__MOCK__', JSON.stringify(mock))
    .replace('__STATE__', JSON.stringify(stateName))
    .replace('__THEME__', JSON.stringify(theme))
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
  if (!existsSync(EDGE)) {
    console.error(`找不到 Edge：${EDGE}`)
    process.exit(1)
  }
  const mock = JSON.parse(readFileSync(mockPath, 'utf8'))
  mkdirSync(resolve(args.out), { recursive: true })

  const browser = await puppeteer.launch({
    executablePath: EDGE,
    headless: true,
    args: ['--no-first-run', '--no-default-browser-check', '--disable-extensions', '--hide-scrollbars'],
  })

  const written = []
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
              await tab.evaluate((label) => {
                const button = [...document.querySelectorAll('button')]
                  .find((b) => b.textContent?.trim() === label)
                button?.click()
              }, NAV_LABEL[page])
            }
            await new Promise((r) => setTimeout(r, 700))
            await tab.screenshot({ path: resolve(args.out, name) })
            await tab.close()
            written.push(name)
          }
        }
      }
    }
  } finally {
    await browser.close()
  }
  console.log(`已生成 ${written.length} 张截图 → ${resolve(args.out)}`)
}

main().catch((error) => {
  console.error('截图失败：', error)
  process.exit(1)
})
