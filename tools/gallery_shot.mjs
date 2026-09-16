#!/usr/bin/env node
/**
 * 组件画廊截图：按「区块 × 主题」逐张截取，供设计评审。
 *
 * 用法：node tools/gallery_shot.mjs --out .ui-shots/gallery [--themes dark,light] [--width 1200]
 * 前置：npm run dev（默认 http://localhost:1420）
 */
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import puppeteer from 'puppeteer-core'

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const EDGE_ARGS = ['--no-first-run', '--no-default-browser-check', '--disable-extensions', '--hide-scrollbars']
// 某些受限 Windows 沙箱会以 0xC0000022 阻止 Edge 子进程启动；仅在显式请求时关闭浏览器沙箱。
if (process.env.AICHAT_EDGE_NO_SANDBOX === '1') EDGE_ARGS.push('--no-sandbox')
const SECTIONS = ['type', 'icons', 'buttons', 'inputs', 'nav', 'rows', 'messages', 'feedback', 'cards']

function parseArgs(argv) {
  const args = {
    out: '.ui-shots/gallery',
    url: 'http://localhost:1420',
    themes: ['dark', 'light'],
    width: 1200,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i]
    if (!key.startsWith('--')) continue
    const value = argv[i + 1]
    i += 1
    if (key === '--out') args.out = value
    else if (key === '--url') args.url = value
    else if (key === '--themes') args.themes = value.split(',')
    else if (key === '--width') args.width = Number(value)
  }
  return args
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  mkdirSync(resolve(args.out), { recursive: true })

  const browser = await puppeteer.launch({
    executablePath: EDGE,
    headless: true,
    args: EDGE_ARGS,
  })

  const written = []
  try {
    for (const theme of args.themes) {
      const tab = await browser.newPage()
      await tab.setViewport({ width: args.width, height: 900, deviceScaleFactor: 2 })
      await tab.goto(`${args.url}/?gallery&theme=${theme}`, {
        waitUntil: 'networkidle2',
        timeout: 60000,
      })
      // 等字体真实加载完成，避免截图里出现回落字体
      await tab.evaluate(() => document.fonts.ready)
      for (const id of SECTIONS) {
        const el = await tab.$(`#${id}`)
        if (!el) {
          console.error(`找不到区块 #${id}`)
          continue
        }
        const name = `${id}-${theme}.png`
        await el.screenshot({ path: resolve(args.out, name) })
        written.push(name)
        // 表单控件额外拍一张「下拉展开」状态
        if (id === 'inputs') {
          await tab.evaluate(() => {
            const trigger = document.querySelector('#inputs button[aria-haspopup="listbox"]')
            if (trigger instanceof HTMLElement) trigger.click()
          })
          await new Promise((r) => setTimeout(r, 350))
          const openName = `inputs-open-${theme}.png`
          await el.screenshot({ path: resolve(args.out, openName) })
          written.push(openName)
          await tab.keyboard.press('Escape')
        }
      }
      await tab.close()
    }
  } finally {
    await browser.close()
  }
  console.log(`已生成 ${written.length} 张画廊截图 → ${resolve(args.out)}`)
}

main().catch((error) => {
  console.error('画廊截图失败：', error)
  process.exit(1)
})
