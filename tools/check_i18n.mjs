#!/usr/bin/env node
/**
 * 后端文案 code 与前端字典的一致性检查。
 *
 * 为什么要这个脚本：Rust 那边有一批面向用户的文案（探测说明、catalog 描述），
 * 它们只说 code、翻译只在前端字典里。这种「两边靠约定对齐」的结构，
 * 最容易出的错是**加了 code 忘了翻译**——而那要等用户切到英文才会发现。
 * 所以把它变成一条可以跑的断言。
 *
 * 检查三件事：
 * 1. Rust 里出现的每个 `LocalizedText::new/with("code", …)` 的 code，中英文字典里都要有；
 * 2. 由 id 推导的 `source.<id>.description`，每个 catalog 来源都要有；
 * 3. 字典 `backend` 分组里不能有已经没有任何 Rust 代码使用的孤儿条目。
 *
 * 用法：node tools/check_i18n.mjs
 * 退出码非 0 表示有不一致（可直接用于 CI）。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')

/** 递归找出目录下的所有 .rs 文件。 */
function rustFiles(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...rustFiles(full))
    else if (entry.endsWith('.rs')) out.push(full)
  }
  return out
}

/** 从 Rust 源码里抽出文案 code。 */
function codesFromRust() {
  const codes = new Set()
  // LocalizedText::new("x.y", …) / LocalizedText::with("x.y", …) / SourceNote::plain("x.y", …)
  const literal = /LocalizedText::(?:new|with)\(\s*"([^"]+)"/g
  for (const file of rustFiles(join(ROOT, 'crates/aichat-core/src'))) {
    // serde 属性与静态目录里没有 code，只有这些构造点有
    const text = readFileSync(file, 'utf8')
    for (const match of text.matchAll(literal)) codes.add(match[1])
  }

  // catalog 的描述 code 由 id 推导（`source.<id>.description`），要从 catalog 里取 id
  const registry = readFileSync(join(ROOT, 'crates/aichat-core/src/adapters/registry.rs'), 'utf8')
  for (const match of registry.matchAll(/definition\(\s*"([a-z0-9-]+)"/g)) {
    codes.add(`source.${match[1]}.description`)
  }
  // 上面那条正则抓不到 `SourceDefinition { ..definition("workbuddy", …) }` 这种写法，
  // 兜底再扫一遍所有 `definition("id",` 形式（含带前缀的）
  for (const match of registry.matchAll(/definition\(\s*"([a-z0-9-]+)"/g)) {
    codes.add(`source.${match[1]}.description`)
  }
  return codes
}

/** 从字典里抽出 `backend` 分组的 key。 */
function codesFromDict(path) {
  const text = readFileSync(path, 'utf8')
  const start = text.indexOf('  backend: {')
  if (start < 0) throw new Error(`${path} 里找不到 backend 分组`)
  const body = text.slice(start)
  const end = body.indexOf('\n  },')
  const block = body.slice(0, end < 0 ? body.length : end)
  const codes = new Set()
  for (const match of block.matchAll(/^\s+'([^']+)':/gm)) codes.add(match[1])
  return codes
}

const rust = codesFromRust()
const zh = codesFromDict(join(ROOT, 'src/lib/i18n/zh.ts'))
const en = codesFromDict(join(ROOT, 'src/lib/i18n/en.ts'))

const failures = []
const missingZh = [...rust].filter((c) => !zh.has(c)).sort()
const missingEn = [...rust].filter((c) => !en.has(c)).sort()
const extraZh = [...zh].filter((c) => !rust.has(c)).sort()
const extraEn = [...en].filter((c) => !rust.has(c)).sort()

if (missingZh.length) failures.push(`zh.ts 缺少 ${missingZh.length} 条：\n    ${missingZh.join('\n    ')}`)
if (missingEn.length) failures.push(`en.ts 缺少 ${missingEn.length} 条：\n    ${missingEn.join('\n    ')}`)
if (extraZh.length) failures.push(`zh.ts 有 ${extraZh.length} 条已无人使用：\n    ${extraZh.join('\n    ')}`)
if (extraEn.length) failures.push(`en.ts 有 ${extraEn.length} 条已无人使用：\n    ${extraEn.join('\n    ')}`)

console.log(`后端文案 code：${rust.size} 条；字典 zh ${zh.size} / en ${en.size}`)
if (failures.length === 0) {
  console.log('一致性检查通过 ✓（每个 code 都有中英翻译，也没有孤儿条目）')
  process.exit(0)
}
console.log(`发现 ${failures.length} 类问题：`)
for (const failure of failures) console.log('  ✗ ' + failure)
console.log(`\n提示：新增 code 时同步补 src/lib/i18n/zh.ts 与 en.ts 的 backend 分组（脚本见 ${relative(ROOT, import.meta.filename)}）`)
process.exit(1)
