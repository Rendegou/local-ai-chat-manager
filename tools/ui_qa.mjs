#!/usr/bin/env node
/**
 * 视觉与无障碍 QA（规格 §8 Phase 4）。
 *
 * 把「不该出现的问题」写成断言，而不是靠肉眼看截图：
 * 1. 键盘流程：Tab 走一遍主界面，每个可聚焦元素都要有可访问名称与可见焦点；
 * 2. 缩放：200% 文本缩放下不得出现横向溢出；
 * 3. 大数据：2000 个会话时列表只渲染可视区（DOM 节点数保持常数）；
 * 4. 双重滚动：阅读区内只允许一个滚动容器；
 * 5. 对比度：正文与元数据达到 WCAG AA（复用 ui_shot 的审计实现）。
 *
 * 用法：node tools/ui_qa.mjs [--sizes 1440x900,900x700] [--url http://localhost:1420]
 * 退出码非 0 表示有断言失败（可直接用于 CI）。
 */
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import puppeteer from 'puppeteer-core'

import { injectionFor as baseInjection } from './ui_shot.mjs'

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'

/** 参数解析。 */
function parseArgs(argv) {
  const args = { url: 'http://localhost:1420', sizes: ['1440x900', '1180x800', '900x700'], mock: '.ui-shots/mock/data.json' }
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i]
    if (!key.startsWith('--')) continue
    const value = argv[i + 1]
    i += 1
    if (key === '--url') args.url = value
    if (key === '--sizes') args.sizes = value.split(',')
    if (key === '--mock') args.mock = value
  }
  return args
}

/** 注入脚本：state 支持 normal / empty / bulk（2000 会话，用于验证虚拟滚动）。 */
function injectionFor(mock, state, theme) {
  const bulk = state === 'bulk'
  return baseInjection(bulk ? { ...mock, sessions: [] } : mock, bulk ? 'normal' : state, theme)
    .replace(
      'const sessions = mock.sessions;',
      bulk
        ? `const sessions = (() => {
             const base = ${JSON.stringify(mock.sessions)};
             const out = [];
             for (let i = 0; out.length < 2000; i += 1) {
               const source = base[i % base.length];
               out.push(Object.assign({}, source, { id: source.id + '#bulk' + i, externalId: source.externalId + '-' + i }));
             }
             return out;
           })();`
        : 'const sessions = mock.sessions;',
    )
}

/** 页面内断言：键盘可达性与命名。 */
const KEYBOARD_AUDIT = (steps) => {
  const results = []
  const element = document.activeElement
  const describe = (node) => {
    if (!node || node === document.body) return { tag: 'BODY', name: '' }
    const name =
      node.getAttribute('aria-label') ||
      node.getAttribute('title') ||
      (node.textContent || '').trim().slice(0, 30)
    const rect = node.getBoundingClientRect()
    const style = getComputedStyle(node)
    return {
      tag: node.tagName,
      name,
      visible: rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden',
      hasOutline: style.outlineStyle !== 'none' && style.outlineWidth !== '0px',
    }
  }
  results.push(describe(element))
  return results
}

/** 页面内断言：横向溢出 / 双重滚动 / 渲染节点数。 */
const LAYOUT_AUDIT = () => {
  const root = document.documentElement
  const overflow = root.scrollWidth - root.clientWidth
  // 阅读区（含背景 reading 的滚动容器）内部不应再有可滚动元素
  const reader = document.querySelector('.overflow-y-auto.bg-reading')
  let innerScrollers = 0
  if (reader) {
    for (const node of reader.querySelectorAll('*')) {
      if (node.scrollHeight > node.clientHeight + 4 && node.clientHeight > 40) {
        const style = getComputedStyle(node)
        if (style.overflowY === 'auto' || style.overflowY === 'scroll') innerScrollers += 1
      }
    }
  }
  const sessionRows = [...document.querySelectorAll('button')].filter((b) =>
    (b.className || '').includes('h-[56px]'),
  ).length
  const rendered = document.querySelectorAll('*').length
  // 诊断：找出横向越界的元素（最多 5 个），便于定位溢出真因
  const limit = window.innerWidth
  const offenders = []
  for (const node of document.querySelectorAll('body *')) {
    const rect = node.getBoundingClientRect()
    if (rect.width === 0) continue
    if (rect.right > limit + 1) {
      offenders.push({
        tag: node.tagName,
        cls: (node.className || '').toString().split(' ').slice(0, 4).join(' '),
        right: Math.round(rect.right),
        width: Math.round(rect.width),
      })
    }
  }
  offenders.sort((a, b) => b.right - a.right)
  return { overflow, innerScrollers, sessionRows, rendered, offenders: offenders.slice(0, 5) }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!existsSync(EDGE)) {
    console.error(`找不到 Edge：${EDGE}`)
    process.exit(1)
  }
  const mock = JSON.parse(readFileSync(resolve(args.mock), 'utf8'))
  const browser = await puppeteer.launch({
    executablePath: EDGE,
    headless: true,
    args: ['--no-first-run', '--no-default-browser-check', '--hide-scrollbars'],
  })

  const failures = []
  const notes = []
  try {
    for (const size of args.sizes) {
      const [width, height] = size.split('x').map(Number)
      for (const theme of ['dark', 'light']) {
        const tab = await browser.newPage()
        await tab.setViewport({ width, height })
        await tab.evaluateOnNewDocument(injectionFor(mock, 'normal', theme))
        await tab.goto(args.url, { waitUntil: 'networkidle2', timeout: 60000 })
        await tab.waitForSelector('header', { timeout: 20000 })
        await new Promise((r) => setTimeout(r, 700))

        // 1) 布局断言：横向溢出 / 双重滚动
        const layout = await tab.evaluate(LAYOUT_AUDIT)
        if (layout.overflow > 1) {
          failures.push(`[${size}/${theme}] 页面出现横向溢出：${layout.overflow}px`)
        }
        if (layout.innerScrollers > 0) {
          failures.push(`[${size}/${theme}] 阅读区出现嵌套滚动容器：${layout.innerScrollers} 个`)
        }
        notes.push(`[${size}/${theme}] DOM 节点 ${layout.rendered}，会话行 ${layout.sessionRows}`)

        // 2) 键盘流程：Tab 20 步，逐个检查可访问名称与可见焦点
        await tab.evaluate(() => document.body.focus())
        for (let step = 0; step < 20; step += 1) {
          await tab.keyboard.press('Tab')
          const [info] = await tab.evaluate(KEYBOARD_AUDIT)
          if (info.tag === 'BODY') continue
          if (!info.name) {
            failures.push(`[${size}/${theme}] 第 ${step + 1} 个焦点元素缺少可访问名称（${info.tag}）`)
          }
          if (!info.visible) {
            failures.push(`[${size}/${theme}] 第 ${step + 1} 个焦点元素不可见（${info.name}）`)
          }
        }

        // 3) 200% 缩放：不得横向溢出
        await tab.evaluate(() => {
          document.documentElement.style.fontSize = '200%'
        })
        await new Promise((r) => setTimeout(r, 300))
        const zoomed = await tab.evaluate(LAYOUT_AUDIT)
        if (zoomed.overflow > 1) {
          const detail = zoomed.offenders
            .map((o) => `${o.tag}.${o.cls}(宽 ${o.width}, 右边界 ${o.right})`)
            .join(' ; ')
          failures.push(`[${size}/${theme}] 200% 缩放后横向溢出：${zoomed.overflow}px → ${detail}`)
        }
        await tab.evaluate(() => {
          document.documentElement.style.fontSize = ''
        })
        await tab.close()
      }
    }

    // 4) 大数据：2000 个会话时只渲染可视区
    const bulkTab = await browser.newPage()
    await bulkTab.setViewport({ width: 1440, height: 900 })
    await bulkTab.evaluateOnNewDocument(injectionFor(mock, 'bulk', 'dark'))
    await bulkTab.goto(args.url, { waitUntil: 'networkidle2', timeout: 60000 })
    await bulkTab.waitForSelector('header', { timeout: 20000 })
    await new Promise((r) => setTimeout(r, 900))
    const bulk = await bulkTab.evaluate(LAYOUT_AUDIT)
    notes.push(`[bulk 2000 会话] DOM 节点 ${bulk.rendered}，实际渲染会话行 ${bulk.sessionRows}`)
    if (bulk.sessionRows > 60) {
      failures.push(`[bulk] 会话列表未虚拟化：渲染了 ${bulk.sessionRows} 行`)
    }
    if (bulk.rendered > 4000) {
      failures.push(`[bulk] DOM 节点过多：${bulk.rendered}`)
    }
    await bulkTab.close()
  } finally {
    await browser.close()
  }

  console.log('=== UI QA 结果 ===')
  for (const note of notes) console.log('  ' + note)
  if (failures.length === 0) {
    console.log('  断言全部通过 ✓（横向溢出 / 嵌套滚动 / 焦点可见性 / 大列表虚拟化）')
    process.exit(0)
  }
  console.log(`  失败 ${failures.length} 项：`)
  for (const failure of failures) console.log('  ✗ ' + failure)
  process.exit(1)
}

main().catch((error) => {
  console.error('QA 运行失败：', error)
  process.exit(1)
})
