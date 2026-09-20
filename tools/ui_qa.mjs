#!/usr/bin/env node
/**
 * 视觉与无障碍 QA。
 *
 * 把「不该出现的问题」写成断言，而不是靠肉眼看截图。分五组：
 *
 * A. 基础布局：横向溢出 / 嵌套滚动 / 200% 缩放 / 大列表虚拟化
 * B. 数据源可见性：能力 vs 本机实际的六种组合（DESIGN_AUDIT §1）
 * C. 层级与选中态：每页一个 h1、skip link、active 元素无 box-shadow（§7）
 * D. 搜索一致性：条件改变触发新查询、旧响应不覆盖新响应（§5）
 * E. 浮层契约：Escape 关闭、Tab 不逃逸、焦点归还、Select 显示值与内部值一致（§9、§3）
 *
 * 用法：node tools/ui_qa.mjs [--sizes 1440x900,...] [--url http://localhost:1420] [--mock path]
 * 退出码非 0 表示有断言失败（可直接用于 CI）。
 */
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { injectionFor as baseInjection, launchBrowser } from './ui_shot.mjs'

/** 参数解析。 */
function parseArgs(argv) {
  const args = {
    url: 'http://localhost:1420',
    sizes: ['1440x900', '1280x800', '1180x800', '900x700', '768x700'],
    mock: '.ui-shots/mock/data.json',
  }
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

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

/** 点一个文本完全匹配的按钮（Rail 导航项、设置分区操作、抽屉入口）。 */
async function clickByText(tab, label) {
  return tab.evaluate((name) => {
    const button = [...document.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === name,
    )
    if (!button) return false
    // 真实鼠标点击会先把焦点给按钮；HTMLElement.click() 不会。
    // 不先 focus 的话，「关闭浮层后焦点归还触发器」这类断言测的是脚本行为而不是产品行为。
    button.focus()
    button.click()
    return true
  }, label)
}

/** 切页：≥768px 直接点 Rail；更窄时先开标题栏的导航抽屉。 */
async function goto(tab, label) {
  if (await clickByText(tab, label)) {
    await wait(500)
    return
  }
  await tab.evaluate(() => {
    document.querySelector('button[aria-label="打开导航"]')?.click()
  })
  await wait(350)
  await clickByText(tab, label)
  await wait(500)
}

/** 把值写进受控 input，并触发 React 的 onChange。 */
async function setInputValue(tab, selector, value) {
  return tab.evaluate(
    (sel, text) => {
      const input = document.querySelector(sel)
      if (!input) return false
      const descriptor = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')
      descriptor.set.call(input, text)
      input.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    },
    selector,
    value,
  )
}

/** 打开一个页面并等到首屏数据落地。 */
async function openPage(browser, args, { size, theme = 'dark', state = 'normal' }, mock) {
  const [width, height] = size.split('x').map(Number)
  const tab = await browser.newPage()
  await tab.setViewport({ width, height })
  await tab.evaluateOnNewDocument(injectionFor(mock, state, theme))
  await tab.goto(args.url, { waitUntil: 'networkidle2', timeout: 60000 })
  await tab.waitForSelector('header', { timeout: 20000 })
  await tab.waitForFunction(() => document.body.innerText.includes('会话'), { timeout: 20000 })
  await wait(500)
  return tab
}

/** 页面内断言：横向溢出 / 双重滚动 / 渲染节点数。 */
const LAYOUT_AUDIT = () => {
  const root = document.documentElement
  const overflow = root.scrollWidth - root.clientWidth
  // 阅读区使用稳定的语义标记，避免视觉类名调整后断言静默失效。
  const reader = document.querySelector('[data-scroll-region="conversation-reader"]')
  const readerExpected = Boolean(document.querySelector('.reading-panel'))
  let innerScrollers = 0
  if (reader) {
    for (const node of reader.querySelectorAll('*')) {
      if (node.scrollHeight > node.clientHeight + 4 && node.clientHeight > 40) {
        const style = getComputedStyle(node)
        if (style.overflowY === 'auto' || style.overflowY === 'scroll') innerScrollers += 1
      }
    }
  }
  const sessionRows = document.querySelectorAll('button[data-row="session"]').length
  const rendered = document.querySelectorAll('*').length
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
  return {
    overflow,
    readerExpected,
    readerFound: Boolean(reader),
    innerScrollers,
    sessionRows,
    rendered,
    offenders: offenders.slice(0, 5),
  }
}

/** 页面内断言：键盘可达性与命名。 */
const KEYBOARD_AUDIT = () => {
  const node = document.activeElement
  if (!node || node === document.body) return { tag: 'BODY', name: '' }
  const name =
    node.getAttribute('aria-label') ||
    node.getAttribute('title') ||
    (node.textContent || '').trim().slice(0, 30)
  const rect = node.getBoundingClientRect()
  const style = getComputedStyle(node)
  /*
   * 焦点环可能画在最近的 .field 包裹层上（组合型控件的外层承载唯一可见边界），
   * 所以沿祖先链向上找 3 层，而不是只看聚焦元素自己。
   */
  let hasOutline = false
  let cursor = node
  for (let depth = 0; cursor && depth < 3; depth += 1, cursor = cursor.parentElement) {
    const s = getComputedStyle(cursor)
    if (s.outlineStyle !== 'none' && Number.parseFloat(s.outlineWidth) > 0) {
      hasOutline = true
      break
    }
  }
  return {
    tag: node.tagName,
    name,
    visible: rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden',
    hasOutline,
    boxShadow: style.boxShadow,
  }
}

/**
 * 页面内断言：可访问性结构。
 *
 * `hasOutline` 以前被算出来但从未参与判定（脚本算了不断言 = 没有断言）。
 * 现在它进入返回值，由调用方按「键盘焦点必须有可见焦点环」来判失败。
 */
const STRUCTURE_AUDIT = () => {
  const h1 = [...document.querySelectorAll('h1')].filter((node) => {
    const rect = node.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0
  })
  const active = document.querySelector('[aria-current="page"], [aria-current="true"]')
  const activeStyle = active ? getComputedStyle(active) : null
  const sessionActive = document.querySelector('.session-row-active')
  const sessionStyle = sessionActive ? getComputedStyle(sessionActive) : null
  const skip = document.querySelector('.skip-link')
  const main = document.getElementById('main-content')
  return {
    h1Count: h1.length,
    h1Text: h1.map((node) => (node.textContent || '').trim()).join(' | '),
    activeTag: active?.tagName ?? null,
    activeText: (active?.textContent || '').trim().slice(0, 20),
    activeShadow: activeStyle ? activeStyle.boxShadow : null,
    activeInsetShadow: activeStyle ? activeStyle.boxShadow.includes('inset') : false,
    sessionActiveShadow: sessionStyle ? sessionStyle.boxShadow : null,
    skipHref: skip?.getAttribute('href') ?? null,
    hasMain: Boolean(main),
  }
}

/** 页面内断言：当前屏内可见的 Primary 按钮。 */
const PRIMARY_BUTTONS = () =>
  [...document.querySelectorAll('button.btn-primary')]
    .filter((node) => {
      const rect = node.getBoundingClientRect()
      const style = getComputedStyle(node)
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden'
    })
    .map((node) => (node.textContent || '').trim())

/** 页面内断言：data source 可见性。 */
const SOURCE_AUDIT = () => {
  // 常驻栏优先；窄窗口下它收进抽屉，此时审计抽屉内容
  const pane = document.querySelector('.app-source-pane') ?? document.querySelector('[role="dialog"]')
  const paneText = pane ? pane.textContent || '' : ''
  return {
    paneText,
    hasRail: Boolean(document.querySelector('.app-rail')),
    warningLabel:
      document.querySelector('button[aria-label*="数据源"]')?.getAttribute('aria-label') ?? null,
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!existsSync(resolve(args.mock))) {
    console.error(`mock 数据不存在：${resolve(args.mock)}`)
    process.exit(1)
  }
  const mock = JSON.parse(readFileSync(resolve(args.mock), 'utf8'))
  const browser = await launchBrowser()

  const failures = []
  const notes = []
  const fail = (message) => failures.push(message)
  const note = (message) => notes.push(message)

  try {
    /* ------------------------------------------------------------------ *
     * A. 基础布局：所有视口 + 深浅两色
     * ------------------------------------------------------------------ */
    for (const size of args.sizes) {
      for (const theme of ['dark', 'light']) {
        const tab = await openPage(browser, args, { size, theme }, mock)

        const layout = await tab.evaluate(LAYOUT_AUDIT)
        if (layout.overflow > 1) fail(`[${size}/${theme}] 页面出现横向溢出：${layout.overflow}px`)
        if (layout.readerExpected && !layout.readerFound) {
          fail(`[${size}/${theme}] 未找到会话阅读区，嵌套滚动断言未执行`)
        }
        if (layout.innerScrollers > 0) {
          fail(`[${size}/${theme}] 阅读区出现嵌套滚动容器：${layout.innerScrollers} 个`)
        }
        note(`[${size}/${theme}] DOM 节点 ${layout.rendered}，会话行 ${layout.sessionRows}`)

        // 键盘流程：Tab 20 步，逐个检查可访问名称、可见性与焦点环
        await tab.evaluate(() => document.body.focus())
        for (let step = 0; step < 20; step += 1) {
          await tab.keyboard.press('Tab')
          const info = await tab.evaluate(KEYBOARD_AUDIT)
          if (info.tag === 'BODY') continue
          if (!info.name) fail(`[${size}/${theme}] 第 ${step + 1} 个焦点元素缺少可访问名称（${info.tag}）`)
          if (!info.visible) fail(`[${size}/${theme}] 第 ${step + 1} 个焦点元素不可见（${info.name}）`)
          // hasOutline 真正参与判定：键盘 Tab 到的元素必须有可见焦点环
          if (!info.hasOutline) {
            fail(`[${size}/${theme}] 第 ${step + 1} 个焦点元素没有可见焦点环（${info.name}）`)
          }
        }

        // 200% 缩放：不得横向溢出
        await tab.evaluate(() => {
          document.documentElement.style.fontSize = '200%'
        })
        await wait(300)
        const zoomed = await tab.evaluate(LAYOUT_AUDIT)
        if (zoomed.overflow > 1) {
          const detail = zoomed.offenders
            .map((o) => `${o.tag}.${o.cls}(宽 ${o.width}, 右边界 ${o.right})`)
            .join(' ; ')
          fail(`[${size}/${theme}] 200% 缩放后横向溢出：${zoomed.overflow}px → ${detail}`)
        }
        await tab.evaluate(() => {
          document.documentElement.style.fontSize = ''
        })

        /* ---- B/C. 数据源可见性与层级（会话页） ---- */
        if (theme === 'dark') {
          // <1280px 时来源栏收在抽屉里：先把它打开再审计，
          // 顺带验证抽屉里的来源集合与常驻栏一致。
          const paneAlways = await tab.evaluate(() => Boolean(document.querySelector('.app-source-pane')))
          if (!paneAlways) {
            await clickByText(tab, '来源与项目')
            await wait(450)
          }
          const sources = await tab.evaluate(SOURCE_AUDIT)
          if (!paneAlways) {
            await tab.keyboard.press('Escape')
            await wait(350)
          }
          // Sidebar 不显示 Cursor：本机没装、没配置、没历史
          if (sources.paneText.includes('Cursor')) {
            fail(`[${size}] 会话页来源栏出现了本机未发现且无历史的 Cursor`)
          }
          // Sidebar 显示 Gemini：本机未安装，但有历史会话
          if (!sources.paneText.includes('Gemini CLI')) {
            fail(`[${size}] 会话页来源栏没有显示有历史的 Gemini CLI`)
          }
          // 顶部告警只统计 needsAttention，不是「所有未发现的来源」。
          // 本场景 6 个来源处于 missing，但只有 2 个需要处理：
          // WorkBuddy（error）与 Claude Code（手工配置了目录却探测不到）。
          if (sources.warningLabel && !sources.warningLabel.includes('2 个')) {
            fail(
              `[${size}] 标题栏告警应只统计需要处理的来源（2 个），实际：${sources.warningLabel}`,
            )
          }

          const structure = await tab.evaluate(STRUCTURE_AUDIT)
          if (structure.h1Count !== 1) {
            fail(`[${size}] 会话页 h1 数量为 ${structure.h1Count}（应为 1）：${structure.h1Text}`)
          }
          if (structure.activeInsetShadow) {
            fail(`[${size}] 全局导航 active 元素仍有 inset box-shadow`)
          }
          if (structure.sessionActiveShadow && structure.sessionActiveShadow !== 'none') {
            fail(`[${size}] 会话选中行仍有 box-shadow：${structure.sessionActiveShadow}`)
          }
          if (!structure.hasMain) fail(`[${size}] 缺少 #main-content`)
          if (structure.skipHref !== '#main-content') fail(`[${size}] skip link 未指向 #main-content`)
        }

        await tab.close()
      }
    }

    /* ------------------------------------------------------------------ *
     * A2. 大数据：2000 个会话时只渲染可视区
     * ------------------------------------------------------------------ */
    {
      const tab = await openPage(browser, args, { size: '1440x900', state: 'bulk' }, mock)
      const bulk = await tab.evaluate(LAYOUT_AUDIT)
      note(`[bulk 2000 会话] DOM 节点 ${bulk.rendered}，实际渲染会话行 ${bulk.sessionRows}`)
      if (bulk.sessionRows > 60) fail(`[bulk] 会话列表未虚拟化：渲染了 ${bulk.sessionRows} 行`)
      if (bulk.rendered > 4500) fail(`[bulk] DOM 节点过多：${bulk.rendered}`)
      await tab.close()
    }

    /* ------------------------------------------------------------------ *
     * B2. 搜索页与设置页的数据源子集
     * ------------------------------------------------------------------ */
    {
      const tab = await openPage(browser, args, { size: '1440x900' }, mock)

      // 搜索页：来源筛选只列有历史的来源
      await goto(tab, '搜索')
      await tab.evaluate(() => {
        ;[...document.querySelectorAll('button')]
          .find((b) => (b.textContent ?? '').includes('高级筛选'))
          ?.click()
      })
      await wait(300)
      await tab.evaluate(() => {
        // 高级筛选里的第一个下拉是「来源」；页头的排序下拉不是我们要测的那个
        const label = [...document.querySelectorAll('label')].find((node) =>
          (node.textContent || '').trim().startsWith('来源'),
        )
        label?.querySelector('[role="combobox"]')?.click()
      })
      await wait(300)
      const searchOptions = await tab.evaluate(() =>
        [...document.querySelectorAll('[role="option"]')].map((o) => (o.textContent || '').trim()),
      )
      if (searchOptions.length === 0) fail('[搜索] 来源筛选下拉没有打开，无法断言选项集合')
      if (searchOptions.some((text) => text.includes('Cursor'))) {
        fail(`[搜索] 来源筛选出现了无历史的 Cursor：${searchOptions.join(' / ')}`)
      }
      if (searchOptions.some((text) => text.includes('Claude'))) {
        fail('[搜索] 来源筛选出现了无历史的 Claude Code')
      }
      if (!searchOptions.some((text) => text.includes('Gemini'))) {
        fail(`[搜索] 来源筛选缺少有历史的 Gemini CLI：${searchOptions.join(' / ')}`)
      }
      if (!searchOptions.some((text) => text.includes('legacy-export'))) {
        fail('[搜索] 来源筛选缺少 Catalog 之外但有历史的来源')
      }
      await tab.keyboard.press('Escape')
      await wait(200)

      // 搜索页 h1
      const searchStructure = await tab.evaluate(STRUCTURE_AUDIT)
      if (searchStructure.h1Count !== 1) {
        fail(`[搜索] h1 数量为 ${searchStructure.h1Count}（应为 1）：${searchStructure.h1Text}`)
      }

      // 切到设置页
      await goto(tab, '设置')

      const settingsStructure = await tab.evaluate(STRUCTURE_AUDIT)
      if (settingsStructure.h1Count !== 1) {
        fail(`[设置] h1 数量为 ${settingsStructure.h1Count}（应为 1）：${settingsStructure.h1Text}`)
      }

      const settingsText = await tab.evaluate(() => document.querySelector('main')?.textContent ?? '')
      if (settingsText.includes('Cursor')) fail('[设置] 已连接来源列表出现了普通 missing 候选 Cursor')
      if (settingsText.includes('ZCode')) fail('[设置] 已连接来源列表出现了普通 missing 候选 ZCode')
      for (const expected of ['Codex', 'Kimi Code', 'Claude Code', 'Gemini CLI', 'legacy-export']) {
        if (!settingsText.includes(expected)) fail(`[设置] 已连接来源列表缺少 ${expected}`)
      }
      // 用户自己接进来的来源要能一眼认出是自己的
      if (!settingsText.includes('My Agent')) fail('[设置] 已连接来源列表缺少用户自定义来源')
      if (!settingsText.includes('自定义')) fail('[设置] 自定义来源没有「自定义」标记')
      // h1 只能有一个：设置页其它标题必须是 h2/h3
      const h2Count = await tab.evaluate(() => document.querySelectorAll('h2').length)
      note(`[设置] h1 = 1，h2 = ${h2Count}`)

      /* ---- E. 添加来源抽屉 ---- */
      await clickByText(tab, '添加来源')
      await wait(500)
      const addDrawer = await tab.evaluate(() => {
        const dialog = document.querySelector('[role="dialog"]')
        return {
          exists: Boolean(dialog),
          ariaModal: dialog?.getAttribute('aria-modal') ?? null,
          labelled: Boolean(dialog?.getAttribute('aria-labelledby')),
          text: dialog?.textContent ?? '',
          rootInert: document.getElementById('root')?.hasAttribute('inert') ?? null,
        }
      })
      if (!addDrawer.exists) fail('[添加来源] 抽屉未打开')
      if (addDrawer.ariaModal !== 'true') fail('[添加来源] 抽屉缺少 aria-modal="true"')
      if (!addDrawer.labelled) fail('[添加来源] 抽屉缺少 aria-labelledby')
      if (addDrawer.rootInert !== true) fail('[添加来源] 抽屉打开时背景未设为 inert')
      if (!addDrawer.text.includes('Cursor')) fail('[添加来源] 抽屉里没有 Cursor 候选')
      if (!addDrawer.text.includes('豆包工作')) fail('[添加来源] 抽屉里没有导入型来源「豆包工作」')
      if (addDrawer.text.includes('Codex')) fail('[添加来源] 抽屉里出现了已自动发现的 Codex')

      // 已识别但未适配的工具：必须能在这里看见，而不是「找不到 = 不支持」
      for (const name of ['Cline', 'Continue.dev', 'Aider']) {
        if (!addDrawer.text.includes(name)) fail(`[添加来源] 待适配清单里缺少 ${name}`)
      }
      const pendingRows = await tab.evaluate(() => {
        const dialog = document.querySelector('[role="dialog"]')
        const rows = [...(dialog?.querySelectorAll('button') ?? [])]
        return rows
          .filter((b) => ['Cline', 'Continue.dev', 'Aider'].some((n) => (b.textContent ?? '').trim().startsWith(n)))
          .map((b) => ({
            name: (b.textContent ?? '').trim(),
            // 待适配行是「不可点」的：点了不该把它当成一个可连接来源
            hasPendingPill: (b.textContent ?? '').includes('待适配') || (b.parentElement?.textContent ?? '').includes('待适配'),
          }))
      })
      if (pendingRows.length !== 3) {
        fail(`[添加来源] 待适配行数为 ${pendingRows.length}（应为 3）`)
      }
      for (const row of pendingRows) {
        if (!row.hasPendingPill) fail(`[添加来源] ${row.name} 没有标注「待适配」`)
      }

      /* ---- B4. 自定义来源：把「还没适配」接成可用来源的入口 ---- */
      await tab.evaluate(() => {
        ;[...document.querySelectorAll('[role="dialog"] button')]
          .find((b) => b.textContent?.trim() === '用自定义来源接入')
          ?.click()
      })
      await wait(500)
      const customForm = await tab.evaluate(() => {
        const dialog = document.querySelector('[role="dialog"]')
        const inputs = [...(dialog?.querySelectorAll('input') ?? [])]
        return {
          title: (dialog?.querySelector('h2')?.textContent ?? '').trim(),
          name: inputs[0]?.value ?? '',
          id: inputs[1]?.value ?? '',
          text: dialog?.textContent ?? '',
        }
      })
      if (!customForm.text.includes('角色字段') || !customForm.text.includes('正文字段')) {
        fail('[自定义来源] 表单缺少字段映射项')
      }
      // 从「待适配」进来时应预填显示名并派生标识，不用用户自己想 id
      if (customForm.name !== 'Cline') fail(`[自定义来源] 显示名未预填，实际「${customForm.name}」`)
      if (customForm.id !== 'cline') fail(`[自定义来源] 来源标识未派生，实际「${customForm.id}」`)
      if (!customForm.text.includes('试解析')) fail('[自定义来源] 表单缺少「试解析」按钮')

      // 未填目录时「试解析」「保存来源」都不可用（会读出不存在的目录）
      const beforePath = await tab.evaluate(() => {
        const dialog = document.querySelector('[role="dialog"]')
        const buttons = [...(dialog?.querySelectorAll('button') ?? [])]
        const find = (label) => buttons.find((b) => (b.textContent ?? '').trim() === label)
        return {
          preview: find('试解析')?.disabled ?? null,
          save: find('保存来源')?.disabled ?? null,
        }
      })
      if (beforePath.preview !== true) fail('[自定义来源] 未填目录时「试解析」应禁用')
      if (beforePath.save !== true) fail('[自定义来源] 未填目录时「保存来源」应禁用')

      // 填目录 → 试解析应返回采样结果
      await tab.evaluate(() => {
        const dialog = document.querySelector('[role="dialog"]')
        const inputs = [...(dialog?.querySelectorAll('input') ?? [])]
        const path = inputs[2]
        if (!(path instanceof HTMLInputElement)) return
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
        setter.call(path, 'D:/demo/myagent/sessions')
        path.dispatchEvent(new Event('input', { bubbles: true }))
      })
      await wait(250)
      await tab.evaluate(() => {
        ;[...document.querySelectorAll('[role="dialog"] button')]
          .find((b) => b.textContent?.trim() === '试解析')
          ?.click()
      })
      await wait(700)
      const preview = await tab.evaluate(() => {
        const dialog = document.querySelector('[role="dialog"]')
        return { text: dialog?.textContent ?? '' }
      })
      if (!/采样\s*3\s*个会话/.test(preview.text) && !preview.text.includes('采样 3 个会话')) {
        fail(`[自定义来源] 试解析没有显示采样会话数：${preview.text.slice(-160)}`)
      }
      if (!preview.text.includes('18 条消息')) {
        fail('[自定义来源] 试解析没有显示消息条数')
      }
      if (!preview.text.includes('mock 的试解析结果')) {
        fail('[自定义来源] 试解析没有展示示例消息内容')
      }

      // 换一个已被内置来源占用的标识：保存应被拒绝（错误提示里要点名冲突方）
      await tab.evaluate(() => {
        const dialog = document.querySelector('[role="dialog"]')
        const inputs = [...(dialog?.querySelectorAll('input') ?? [])]
        const id = inputs[1]
        if (!(id instanceof HTMLInputElement)) return
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
        setter.call(id, 'codex')
        id.dispatchEvent(new Event('input', { bubbles: true }))
      })
      await wait(250)
      const collision = await tab.evaluate(() => {
        const dialog = document.querySelector('[role="dialog"]')
        const buttons = [...(dialog?.querySelectorAll('button') ?? [])]
        return {
          save: buttons.find((b) => (b.textContent ?? '').trim() === '保存来源')?.disabled ?? null,
          text: dialog?.textContent ?? '',
        }
      })
      if (collision.save !== true) fail('[自定义来源] 占用内置标识（codex）时「保存来源」应禁用')
      if (!collision.text.includes('已被')) fail('[自定义来源] 没有说明标识与谁冲突')

      await tab.keyboard.press('Escape')
      await wait(400)

      // Escape 关闭 + 焦点归还
      await clickByText(tab, '添加来源')
      await wait(500)
      await tab.keyboard.press('Escape')
      await wait(400)
      const afterEscape = await tab.evaluate(() => ({
        dialogGone: !document.querySelector('[role="dialog"]'),
        focusText: (document.activeElement?.textContent || '').trim(),
        rootInert: document.getElementById('root')?.hasAttribute('inert') ?? null,
      }))
      if (!afterEscape.dialogGone) fail('[添加来源] 按 Escape 没有关闭抽屉')
      if (afterEscape.focusText !== '添加来源') {
        fail(`[添加来源] 关闭后焦点没有回到触发器，当前是「${afterEscape.focusText}」`)
      }
      if (afterEscape.rootInert !== false) fail('[添加来源] 关闭后背景仍处于 inert')

      /* ---- E2. 导入抽屉：初始不显示伪造的 Codex 选择 ---- */
      await clickByText(tab, '导入会话')
      await wait(500)
      const importState = await tab.evaluate(() => {
        const dialog = document.querySelector('[role="dialog"]')
        const combo = dialog?.querySelector('[role="combobox"]')
        const buttons = [...(dialog?.querySelectorAll('button') ?? [])]
        const preview = buttons.find((b) => (b.textContent || '').trim() === '预览导入')
        return {
          label: (combo?.textContent || '').trim(),
          dataValue: combo?.querySelector('[data-select-value]')?.getAttribute('data-select-value') ?? null,
          previewDisabled: preview instanceof HTMLButtonElement ? preview.disabled : null,
        }
      })
      if (importState.label !== '请选择来源') {
        fail(`[导入] 初始显示值应为「请选择来源」，实际是「${importState.label}」`)
      }
      if (importState.dataValue !== '') {
        fail(`[导入] 初始内部值应为空字符串，实际是「${importState.dataValue}」`)
      }
      if (importState.previewDisabled !== true) {
        fail('[导入] 未选择来源时「预览导入」仍然可点')
      }

      // 打开下拉：验证显示值与内部值一致 + 只有导入型来源
      await tab.evaluate(() => {
        document.querySelector('[role="dialog"] [role="combobox"]')?.click()
      })
      await wait(300)
      const importOptions = await tab.evaluate(() => ({
        options: [...document.querySelectorAll('[role="dialog"] [role="option"]')].map((o) =>
          (o.textContent || '').trim(),
        ),
        controls:
          document.querySelector('[role="dialog"] [role="combobox"]')?.getAttribute('aria-controls') ??
          null,
      }))
      if (importOptions.options.some((text) => text.startsWith('Codex'))) {
        fail(`[导入] 选项里混入了原生读取来源：${importOptions.options.join(' / ')}`)
      }
      if (!importOptions.options.some((text) => text.includes('豆包工作'))) {
        fail(`[导入] 选项里没有导入型来源「豆包工作」：${importOptions.options.join(' / ')}`)
      }
      if (!importOptions.controls) fail('[导入] 下拉触发器缺少 aria-controls')
      // 选择豆包工作后，显示值与内部值必须一致
      await tab.evaluate(() => {
        ;[...document.querySelectorAll('[role="dialog"] [role="option"]')]
          .find((o) => (o.textContent || '').includes('豆包工作'))
          ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      await wait(300)
      const selected = await tab.evaluate(() => {
        const combo = document.querySelector('[role="dialog"] [role="combobox"]')
        return {
          label: (combo?.textContent || '').trim(),
          dataValue: combo?.querySelector('[data-select-value]')?.getAttribute('data-select-value') ?? null,
        }
      })
      if (selected.dataValue === 'doubao-work' && !selected.label.includes('豆包工作')) {
        fail(`[Select] 内部值是 doubao-work，界面显示「${selected.label}」——显示值与真实值不一致`)
      }
      await tab.keyboard.press('Escape')
      await wait(400)

      /* ---- B3. 导入自动识别：预览必须说明「识别成了什么格式」 ---- */
      await clickByText(tab, '导入会话')
      await wait(500)
      // 未选来源时「预览导入」是禁用的（上一轮修掉的静默回退），所以先选一个导入型来源
      await tab.evaluate(() => {
        document.querySelector('[role="dialog"] [role="combobox"]')?.click()
      })
      await wait(300)
      await tab.evaluate(() => {
        ;[...document.querySelectorAll('[role="dialog"] [role="option"]')]
          .find((o) => (o.textContent || '').includes('豆包工作'))
          ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      await wait(300)
      const jsonl = [
        '{"role":"user","content":"第一行"}',
        '{"role":"assistant","content":"第二行"}',
      ].join('\n')
      await tab.evaluate((text) => {
        const area = document.querySelector('[role="dialog"] textarea')
        if (!(area instanceof HTMLTextAreaElement)) return
        const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
        setter.call(area, text)
        area.dispatchEvent(new Event('input', { bubbles: true }))
      }, jsonl)
      await wait(200)
      await clickByText(tab, '预览导入')
      await wait(700)
      const importPreview = await tab.evaluate(() => {
        const dialog = document.querySelector('[role="dialog"]')
        return { text: dialog?.textContent ?? '', hasFormat: /识别为：/.test(dialog?.textContent ?? '') }
      })
      if (!importPreview.hasFormat) {
        fail('[导入] 预览没有显示识别出来的格式（用户在确认前无从判断我们猜的依据）')
      }
      if (!importPreview.text.includes('JSONL')) {
        fail(`[导入] JSONL 输入未被识别为 JSONL 转录：${importPreview.text.slice(0, 120)}`)
      }
      await tab.keyboard.press('Escape')
      await wait(400)

      await tab.close()
    }

    /* ------------------------------------------------------------------ *
     * C2. Sync / Search / Settings 的选中态与主操作
     * ------------------------------------------------------------------ */
    for (const page of ['search', 'sync', 'settings']) {
      const tab = await openPage(browser, args, { size: '1440x900' }, mock)
      const label = { search: '搜索', sync: '同步', settings: '设置' }[page]
      await tab.evaluate((name) => {
        ;[...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === name)?.click()
      }, label)
      await wait(600)

      const structure = await tab.evaluate(STRUCTURE_AUDIT)
      if (structure.h1Count !== 1) {
        fail(`[${page}] h1 数量为 ${structure.h1Count}（应为 1）：${structure.h1Text}`)
      }
      if (structure.activeShadow && structure.activeShadow !== 'none') {
        fail(`[${page}] 导航 active 元素仍有 box-shadow：${structure.activeShadow}`)
      }

      if (page === 'sync') {
        // 正常态只有一个可执行同步 CTA
        const primaries = await tab.evaluate(PRIMARY_BUTTONS)
        if (primaries.length > 1) {
          fail(`[同步] 正常态出现 ${primaries.length} 个 Primary：${primaries.join(' / ')}`)
        }
        const syncButtons = await tab.evaluate(() =>
          [...document.querySelectorAll('button')]
            .filter((b) => {
              const rect = b.getBoundingClientRect()
              const text = (b.textContent || '').trim()
              return rect.width > 0 && (text === '立即同步' || text === '重试同步')
            })
            .map((b) => (b.textContent || '').trim()),
        )
        if (syncButtons.length > 1) {
          fail(`[同步] 出现 ${syncButtons.length} 个同步按钮：${syncButtons.join(' / ')}`)
        }
        note(`[同步] Primary ${primaries.length} 个，同步按钮 ${syncButtons.length} 个`)
      }

      if (page === 'settings') {
        // 设置页保存是唯一主操作，且只在有未保存修改时可用
        const primaries = await tab.evaluate(PRIMARY_BUTTONS)
        if (primaries.length > 1) {
          fail(`[设置] 出现 ${primaries.length} 个 Primary：${primaries.join(' / ')}`)
        }
        // 主题即时预览 + 还原（回归保护）
        await clickByText(tab, '外观与行为')
        await wait(400)
        const themeTrigger = await tab.evaluate(() => {
          const label = [...document.querySelectorAll('label')].find(
            (node) => node.textContent?.trim() === '主题',
          )
          return label?.htmlFor ?? ''
        })
        if (!themeTrigger) {
          fail('[设置] 外观与行为分区里找不到「主题」字段')
        } else {
          const rect = await tab.evaluate((id) => {
            const node = document.getElementById(id)
            const r = node?.getBoundingClientRect()
            return { height: r?.height ?? 0 }
          }, themeTrigger)
          if (rect.height < 36) fail(`[设置] 主题下拉触发器过矮：${rect.height}px`)
          await tab.evaluate((id) => {
            const node = document.getElementById(id)
            node?.scrollIntoView({ block: 'center' })
            node?.click()
          }, themeTrigger)
          await wait(300)
          const popup = await tab.evaluate(() => {
            const listbox = document.querySelector('[role="listbox"]')
            if (!(listbox instanceof HTMLElement)) return { clipped: true, optionHeight: 0 }
            const listRect = listbox.getBoundingClientRect()
            const optionRect = listbox.querySelector('[role="option"]')?.getBoundingClientRect()
            let parent = listbox.parentElement
            let clipped = false
            while (parent) {
              const style = getComputedStyle(parent)
              if (['hidden', 'clip', 'auto', 'scroll'].includes(style.overflowY)) {
                const parentRect = parent.getBoundingClientRect()
                if (listRect.bottom > parentRect.bottom + 1 || listRect.top < parentRect.top - 1) {
                  clipped = true
                  break
                }
              }
              parent = parent.parentElement
            }
            return { clipped, optionHeight: optionRect?.height ?? 0 }
          })
          if (popup.clipped) fail('[设置] 主题下拉浮层被祖先容器裁切')
          if (popup.optionHeight < 36) fail(`[设置] 下拉选项过矮：${popup.optionHeight}px`)
          await tab.evaluate(() => {
            ;[...document.querySelectorAll('[role="option"]')]
              .find((o) => o.textContent?.trim() === '浅色')
              ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
          })
          await wait(300)
          const appearance = await tab.evaluate(() => ({
            dark: document.documentElement.classList.contains('dark'),
            dirty: (document.querySelector('main')?.textContent ?? '').includes('有未保存的修改'),
          }))
          if (appearance.dark) fail('[设置] 选择「浅色」后未立即生效')
          // 关键回归：外观即时生效**并且**立即落盘，不该被算成「未保存的修改」——
          // 否则离开设置页会被拦下，点「放弃修改」主题还会翻回去。
          if (appearance.dirty) {
            fail('[设置] 改主题后出现「有未保存的修改」：外观应当即时落盘，不进入草稿')
          }

          // 「还原」要覆盖在真正的草稿字段上：外观不参与草稿，用 Toggle 制造未保存状态
          const toggled = await tab.evaluate(() => {
            const sw = document.querySelector('main button[role="switch"]')
            if (!sw) return null
            const before = sw.getAttribute('aria-checked')
            sw.click()
            return before
          })
          await wait(300)
          const afterToggle = await tab.evaluate(() =>
            (document.querySelector('main')?.textContent ?? '').includes('有未保存的修改'),
          )
          if (toggled === null) fail('[设置] 找不到可切换的开关，草稿回归未执行')
          else if (!afterToggle) fail('[设置] 切换开关后没有标记「有未保存的修改」')
          await clickByText(tab, '还原')
          await wait(300)
          const afterRevert = await tab.evaluate(() => ({
            dirty: (document.querySelector('main')?.textContent ?? '').includes('有未保存的修改'),
            switchState: document.querySelector('main button[role="switch"]')?.getAttribute('aria-checked'),
            dark: document.documentElement.classList.contains('dark'),
          }))
          if (afterRevert.dirty) fail('[设置] 点击「还原」后仍显示「有未保存的修改」')
          if (afterRevert.switchState !== toggled) {
            fail(`[设置] 「还原」没有把开关恢复到已保存值（${toggled} → ${afterRevert.switchState}）`)
          }
          if (afterRevert.dark) {
            fail('[设置] 「还原」不该回滚已落盘的主题（外观不是草稿字段）')
          }
        }
      }

      await tab.close()
    }

    /* ------------------------------------------------------------------ *
     * D. 搜索一致性：条件改变触发新查询；旧响应不覆盖新响应
     * ------------------------------------------------------------------ */
    {
      const tab = await openPage(browser, args, { size: '1440x900' }, mock)

      // 首屏搜索：输入关键词 + 回车
      await goto(tab, '搜索')
      // 关键词要能同时命中正文与工具输出，messagesOnly 才真的会改变结果条数，
      // 否则两条并发的响应条数相同，「旧响应不覆盖新响应」的断言会变得没有意义。
      const typed = await setInputValue(tab, 'input[aria-label="搜索关键词"]', 'renew')
      if (!typed) fail('[搜索] 找不到搜索关键词输入框')
      await tab.keyboard.press('Enter')
      await wait(700)
      const afterFirst = await tab.evaluate(() => window.__UI_QA_SEARCH__.calls.length)
      if (afterFirst !== 1) fail(`[搜索] 首次搜索发出的请求数为 ${afterFirst}（应为 1）`)

      // 展开高级筛选并改排序 → 应自动触发新查询
      await tab.evaluate(() => {
        ;[...document.querySelectorAll('button')].find((b) => (b.textContent ?? '').includes('高级筛选'))?.click()
      })
      await wait(300)
      await tab.evaluate(() => {
        document.querySelector('main')?.querySelector('[role="combobox"]')?.click()
      })
      await wait(300)
      await tab.evaluate(() => {
        ;[...document.querySelectorAll('[role="option"]')]
          .find((o) => (o.textContent || '').includes('时间'))
          ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      await wait(800)
      const afterOrder = await tab.evaluate(() => ({
        calls: window.__UI_QA_SEARCH__.calls.length,
        last: window.__UI_QA_SEARCH__.calls[window.__UI_QA_SEARCH__.calls.length - 1],
      }))
      if (afterOrder.calls <= afterFirst) {
        fail('[搜索] 改变排序后没有自动发出新查询（控件显示了新条件，结果却还是旧的）')
      }
      if (afterOrder.last?.order !== 'recent') {
        fail(`[搜索] 最后一次查询的排序是 ${afterOrder.last?.order}，应为 recent`)
      }

      /*
       * 竞态：先发一个「慢且宽」的请求，再发一个「快且窄」的请求。
       * 时间线（250ms 自动重查防抖）：
       *   t=0    改排序      → 排程重查
       *   t≈250  请求 N 发出（recent、不限正文）并被注入 1400ms 延迟
       *   t=400  勾选仅正文  → 排程重查
       *   t≈650  请求 N+1 发出（recent、仅正文）立即返回 → 写入结果
       *   t≈1650 请求 N 才返回 → 必须被序号守卫丢弃
       * 若丢弃失效，页头条数会变回 N 的（更多）结果。
       */
      await tab.evaluate(() => {
        const log = window.__UI_QA_SEARCH__
        log.delays = {}
        log.delays[log.calls.length] = 1400
      })
      await tab.evaluate(() => {
        document.querySelector('main')?.querySelector('[role="combobox"]')?.click()
      })
      await wait(250)
      await tab.evaluate(() => {
        ;[...document.querySelectorAll('[role="option"]')]
          .find((o) => (o.textContent || '').includes('相关度'))
          ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      await wait(400)
      await tab.evaluate(() => {
        document.querySelector('[role="switch"]')?.click()
      })
      await wait(2500)

      const race = await tab.evaluate(() => {
        const log = window.__UI_QA_SEARCH__
        const header = document.querySelector('main')?.textContent ?? ''
        const match = header.match(/(\d+)\s*条结果/)
        return {
          displayed: match ? Number(match[1]) : null,
          lastHits: log.calls[log.calls.length - 1]?.hits ?? null,
          calls: log.calls.map((c) => ({ order: c.order, messagesOnly: c.messagesOnly, hits: c.hits })),
        }
      })
      note(`[搜索] 请求序列 ${JSON.stringify(race.calls)}`)
      if (race.displayed === null) {
        fail('[搜索] 无法从页头读取结果条数')
      } else if (race.lastHits !== null && race.displayed !== race.lastHits) {
        fail(
          `[搜索] 旧响应覆盖了新结果：页头显示 ${race.displayed} 条，最后一次请求返回 ${race.lastHits} 条`,
        )
      }
      // 断言这次竞态确实构造出了两个条数不同的响应，否则上一条断言是空转
      const distinct = new Set(race.calls.map((c) => c.hits).filter((n) => n != null))
      if (distinct.size < 2) {
        fail(
          `[搜索] 竞态用例没有构造出条数不同的响应（hits: ${[...distinct].join(', ')}），断言无效`,
        )
      }

      await tab.close()
    }

    /* ------------------------------------------------------------------ *
     * E3. Quick Search：Tab 不逃逸 + 结果可读
     * ------------------------------------------------------------------ */
    {
      const tab = await openPage(browser, args, { size: '1440x900' }, mock)
      await tab.evaluate(() => {
        const trigger = [...document.querySelectorAll('button')].find((b) =>
          (b.getAttribute('aria-label') ?? '').startsWith('快速搜索'),
        )
        trigger?.focus()
        trigger?.click()
      })
      await wait(400)
      const before = await tab.evaluate(() => ({
        dialog: Boolean(document.querySelector('[role="dialog"]')),
        focusRole: document.activeElement?.getAttribute('role') ?? null,
        inputInDialog: Boolean(document.querySelector('[role="dialog"] [role="combobox"]')),
        controls: document.querySelector('[role="combobox"]')?.getAttribute('aria-controls') ?? null,
      }))
      if (!before.dialog) fail('[快速搜索] 面板未打开')
      if (before.focusRole !== 'combobox') fail('[快速搜索] 打开后焦点不在输入框上')
      if (before.controls) {
        // 没有结果时 aria-controls 应为空（指向不存在的元素比不指向更糟）
        note('[快速搜索] 初始无结果，aria-controls 为空 —— 符合预期')
      }

      // 输入后 Tab 不得逃到背景
      await tab.type('input[role="combobox"]', 'watchdog', { delay: 20 })
      await wait(900)
      const withResults = await tab.evaluate(() => {
        const combo = document.querySelector('[role="combobox"]')
        const list = document.querySelector('[role="listbox"]')
        const active = combo?.getAttribute('aria-activedescendant')
        return {
          controls: combo?.getAttribute('aria-controls') ?? null,
          listId: list?.id ?? null,
          activeDescendant: active,
          activeExists: active ? Boolean(document.getElementById(active)) : false,
          options: document.querySelectorAll('[role="option"]').length,
        }
      })
      if (!withResults.controls || withResults.controls !== withResults.listId) {
        fail('[快速搜索] aria-controls 没有指向 listbox')
      }
      if (!withResults.activeExists) fail('[快速搜索] aria-activedescendant 指向了不存在的元素')
      note(`[快速搜索] ${withResults.options} 条结果，combobox 契约完整`)

      for (let i = 0; i < 12; i += 1) {
        await tab.keyboard.press('Tab')
        const inside = await tab.evaluate(() =>
          Boolean(document.querySelector('[role="dialog"]')?.contains(document.activeElement)),
        )
        if (!inside) {
          fail(`[快速搜索] 第 ${i + 1} 次 Tab 把焦点送出了浮层（背景可被误操作）`)
          break
        }
      }

      await tab.keyboard.press('Escape')
      await wait(300)
      const closed = await tab.evaluate(() => ({
        dialogGone: !document.querySelector('[role="dialog"]'),
        focusLabel: document.activeElement?.getAttribute('aria-label') ?? '',
      }))
      if (!closed.dialogGone) fail('[快速搜索] Escape 没有关闭面板')
      if (!closed.focusLabel.startsWith('快速搜索')) {
        fail(`[快速搜索] 关闭后焦点没有回到触发按钮，当前是「${closed.focusLabel}」`)
      }
      await tab.close()
    }

    /* ------------------------------------------------------------------ *
     * G. 同步失败：原始输出与可执行建议（国内连 GitHub 失败时靠这个定位）
     * ------------------------------------------------------------------ */
    {
      const tab = await openPage(browser, args, { size: '1440x900' }, mock)
      await goto(tab, '同步')
      await wait(400)

      // 触发一次同步（mock 里推送到远端是失败的）
      await clickByText(tab, '立即同步')
      await wait(900)
      await clickByText(tab, '展开')
      await wait(600)

      const afterFail = await tab.evaluate(() => {
        const main = document.querySelector('main')?.textContent ?? ''
        return {
          text: main,
          // 失败步骤的原始输出默认收起，先看有没有「查看输出」入口
          hasShowLog: main.includes('查看输出'),
          pres: [...document.querySelectorAll('main pre')].map((p) => p.textContent ?? ''),
        }
      })
      if (!afterFail.hasShowLog) {
        fail('[同步失败] 失败步骤没有「查看输出」入口——只给一行摘要没法定位是 DNS/代理/证书/凭据')
      }
      // 建议要直接可见，不用展开
      if (!afterFail.text.includes('可以这样排查')) {
        fail('[同步失败] 没有给出可执行的排查建议')
      }
      if (!afterFail.text.includes('http.proxy')) {
        fail('[同步失败] 连不上远端的建议里没有具体的代理配置示例')
      }

      // 展开原始输出：必须能看到是哪条命令、退出码、以及完整 stderr
      await clickByText(tab, '查看输出')
      await wait(400)
      const expanded = await tab.evaluate(() =>
        [...document.querySelectorAll('main pre')].map((p) => p.textContent ?? ''),
      )
      const log = expanded.find((t) => t.includes('退出码')) ?? ''
      if (!log) {
        fail('[同步失败] 展开后看不到原始输出')
      } else {
        if (!log.includes('$ git ')) fail(`[同步失败] 原始输出没有说明是哪条命令：${log.slice(0, 80)}`)
        if (!/退出码 \d+/.test(log)) fail('[同步失败] 原始输出没有退出码')
        if (!log.includes('--- stderr ---')) fail('[同步失败] 原始输出没有分段标出 stderr')
        if (!log.includes('Failed to connect to github.com port 443')) {
          fail('[同步失败] 原始输出没有带上完整的原因行')
        }
        note('[同步失败] 原始输出含命令行 / 退出码 / stderr 全文')
      }

      /* ---- 远端连接诊断 ---- */
      await clickByText(tab, '测试远端连接')
      await wait(900)
      const diagnosis = await tab.evaluate(() => {
        const main = document.querySelector('main')?.textContent ?? ''
        const pres = [...document.querySelectorAll('main pre')].map((p) => p.textContent ?? '')
        return { text: main, report: pres.find((t) => t.includes('代理环境变量')) ?? '' }
      })
      if (!diagnosis.report) {
        fail('[远端诊断] 没有显示诊断报告')
      } else {
        for (const expected of ['仓库：', '远端：', 'git：', '网络配置：', '代理环境变量：']) {
          if (!diagnosis.report.includes(expected)) {
            fail(`[远端诊断] 报告缺少「${expected}」一项`)
          }
        }
      }
      if (!diagnosis.text.includes('复制诊断信息')) {
        fail('[远端诊断] 没有「复制诊断信息」按钮（用户要能整段贴出来求助）')
      }
      note('[远端诊断] 含仓库/远端/git/网络配置/代理环境变量与一次真实探测')

      await tab.close()
    }

    /* ------------------------------------------------------------------ *
     * F. 后端文案跟随语言 + Git 日志详情
     * ------------------------------------------------------------------ */
    {
      const tab = await openPage(browser, args, { size: '1440x900' }, mock)
      await goto(tab, '同步')
      // 高级区域里有数据源清单（探测说明来自后端）
      await clickByText(tab, '展开')
      await wait(500)

      const zhView = await tab.evaluate(() => {
        const main = document.querySelector('main')?.textContent ?? ''
        return { text: main }
      })
      if (!zhView.text.includes('尚未适配')) {
        fail('[i18n] 中文界面里没看到后端的来源说明，断言无法继续')
      }

      // 切到英文：后端发来的说明也必须跟着变
      await tab.evaluate(() => {
        const trigger = [...document.querySelectorAll('button')].find((b) =>
          (b.getAttribute('aria-label') ?? '').startsWith('更多操作'),
        )
        trigger?.focus()
        trigger?.click()
      })
      await wait(400)
      await tab.evaluate(() => {
        ;[...document.querySelectorAll('[role="menuitemradio"]')]
          .find((r) => r.textContent?.trim() === 'English')
          ?.click()
      })
      await wait(600)

      const enView = await tab.evaluate(() => ({
        lang: document.documentElement.lang,
        text: document.querySelector('main')?.textContent ?? '',
      }))
      if (enView.lang !== 'en') fail(`[i18n] 切英文后 html lang 仍是 ${enView.lang}`)
      // 后端文案的英文：说明与「未找到」都不能还是中文
      if (!enView.text.includes('Not adapted yet')) {
        fail('[i18n] 后端来源说明没有跟着切到英文（仍然是中文原文）')
      }
      if (enView.text.includes('尚未适配')) {
        fail('[i18n] 英文界面里仍出现后端的中文说明：尚未适配')
      }
      if (enView.text.includes('未找到')) {
        fail('[i18n] 英文界面里仍出现后端的中文说明：未找到')
      }

      /* ---- Git 日志：结构化 + 详情 + 未推送标记 ---- */
      await clickByText(tab, 'Read recent commits')
      await wait(600)
      const gitLog = await tab.evaluate(() => {
        const main = document.querySelector('main')?.textContent ?? ''
        return {
          text: main,
          // 旧实现是一整段 <pre>；新实现每条提交一个块
          hasPre: Boolean(document.querySelector('main pre')),
          authors: (main.match(/\bdev\b/g) ?? []).length,
        }
      })
      if (gitLog.hasPre) fail('[Git 日志] 仍是整段 <pre> 文本，没有换成结构化的提交列表')
      if (gitLog.authors < 2) {
        fail(`[Git 日志] 没有显示作者（旧实现丢了这个信息）：dev 出现 ${gitLog.authors} 次`)
      }
      if (!/20\d\d/.test(gitLog.text)) fail('[Git 日志] 没有显示提交时间')
      if (!gitLog.text.includes('origin/main')) {
        fail('[Git 日志] 没有显示分支/tag 装饰（refs）')
      }
      if (!gitLog.text.includes('Not pushed')) {
        fail('[Git 日志] 没有标记哪些提交还没推送')
      }
      note(`[Git 日志] 结构化提交列表，含作者/时间/refs/未推送标记，已无 <pre> 整段文本`)

      // 切回中文，避免影响后续断言
      await tab.evaluate(() => {
        const trigger = [...document.querySelectorAll('button')].find((b) =>
          (b.getAttribute('aria-label') ?? '').startsWith('More actions'),
        )
        trigger?.focus()
        trigger?.click()
      })
      await wait(400)
      await tab.evaluate(() => {
        ;[...document.querySelectorAll('[role="menuitemradio"]')]
          .find((r) => r.textContent?.trim() === '中文')
          ?.click()
      })
      await wait(400)
      await tab.close()
    }

    /* ------------------------------------------------------------------ *
     * C3. skip link 可聚焦并跳到 main
     * ------------------------------------------------------------------ */
    {
      const tab = await openPage(browser, args, { size: '1440x900' }, mock)
      await tab.evaluate(() => document.body.focus())
      await tab.keyboard.press('Tab')
      // skip link 的入场是 120ms 的 transform 过渡，立刻量位置会拿到动画中间态
      await wait(300)
      const first = await tab.evaluate(() => ({
        cls: document.activeElement?.className ?? '',
        hasOutline: getComputedStyle(document.activeElement).outlineStyle !== 'none',
        onScreen: (() => {
          const r = document.activeElement?.getBoundingClientRect()
          return Boolean(r && r.width > 0 && r.top >= -1 && r.top < 200)
        })(),
      }))
      if (!String(first.cls).includes('skip-link')) {
        fail(`[skip link] 第一个 Tab 落点不是 skip link，而是 class="${first.cls}"`)
      }
      if (!first.onScreen) fail('[skip link] 获得焦点后没有出现在视口内')
      if (!first.hasOutline) fail('[skip link] 获得焦点后没有可见焦点环')
      await tab.keyboard.press('Enter')
      await wait(300)
      const jumped = await tab.evaluate(() => ({
        hash: location.hash,
        mainExists: Boolean(document.getElementById('main-content')),
      }))
      if (jumped.hash !== '#main-content') fail(`[skip link] 回车后 hash 是 ${jumped.hash}`)
      if (!jumped.mainExists) fail('[skip link] #main-content 不存在')
      await tab.close()
    }
  } finally {
    await browser.close()
  }

  console.log('=== UI QA 结果 ===')
  for (const line of notes) console.log('  ' + line)
  if (failures.length === 0) {
    console.log('  断言全部通过 ✓（布局 / 数据源可见性 / 层级 / 搜索一致性 / 浮层契约 / 无障碍）')
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
