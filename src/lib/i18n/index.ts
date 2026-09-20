/**
 * 轻量 i18n：界面中英双语。
 *
 * 设计取舍（与项目自绘图标/自研虚拟列表一致：够用、零依赖）：
 * - 两份平行字典（zh.ts / en.ts），嵌套 key（如 'nav.conversations'）；
 * - 组件用 `useT()`（订阅语言变化）；非组件环境（lib/format.ts 等）用 `t()`，
 *   读取模块级当前语言（由 LanguageProvider 同步）；
 * - `t(key, { n })` 支持 `{n}` 插值；缺失 key 回退中文并在控制台告警；
 * - 语言设置持久化在 settings.json（Rust `AppSettings.language`），
 *   'system' 时按 navigator.language 判断。
 */
import { createContext, createElement, useContext, type ReactNode } from 'react'

import { zh } from './zh'
import { en } from './en'

export type Language = 'zh' | 'en'
export type LanguageSetting = 'system' | Language

export type Dict = typeof zh

const DICTS: Record<Language, Dict> = { zh, en }

/** 'system' 时按浏览器/系统语言判断。 */
export function resolveLanguage(setting: LanguageSetting): Language {
  if (setting === 'zh' || setting === 'en') return setting
  return typeof navigator !== 'undefined' && navigator.language.toLowerCase().startsWith('zh')
    ? 'zh'
    : 'en'
}

/* ---- 模块级当前语言：供非 React 环境（lib/format.ts）读取 ---- */
let activeLanguage: Language = 'zh'
export function getLanguage(): Language {
  return activeLanguage
}

const LanguageContext = createContext<Language>('zh')

/** 语言 Provider：挂在应用根部；同时同步模块级语言与 <html lang>。 */
export function LanguageProvider({
  language,
  children,
}: {
  language: Language
  children: ReactNode
}) {
  // 幂等赋值：放在渲染期是为了让同一次渲染里的 format.ts 调用立刻拿到新语言
  activeLanguage = language
  if (typeof document !== 'undefined') {
    document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en'
  }
  return createElement(LanguageContext.Provider, { value: language }, children)
}

export function useLanguage(): Language {
  return useContext(LanguageContext)
}

function lookup(dict: Dict, key: string): string | null {
  let node: unknown = dict
  for (const part of key.split('.')) {
    node = (node as Record<string, unknown> | null)?.[part]
  }
  return typeof node === 'string' ? node : null
}

/**
 * 后端文案的查表：`backend` 分组下的**扁平** key。
 *
 * 不能走 `lookup` 的点号路径——后端的 code 形如 `source.cline.description`，
 * 按点拆分会去找 `dict.source.cline.description` 这个嵌套结构，
 * 而字典里它是 `backend['source.cline.description']` 一条扁平条目。
 * 扁平存法的好处是 code 与条目一一对应，`tools/check_i18n.mjs` 能直接比对。
 */
function lookupBackend(dict: Dict, code: string): string | null {
  const group = (dict as unknown as Record<string, unknown>).backend as
    | Record<string, unknown>
    | undefined
  const value = group?.[code]
  return typeof value === 'string' ? value : null
}

/** 查表 + 插值；缺失 key 回退中文并告警（不中断渲染）。 */
export function translate(
  lang: Language,
  key: string,
  params?: Record<string, string | number>,
): string {
  let text = lookup(DICTS[lang], key)
  if (text === null) {
    if (lang !== 'zh') console.warn(`[i18n] missing key: ${key} (${lang})`)
    text = lookup(DICTS.zh, key) ?? key
  }
  if (params) {
    for (const [name, value] of Object.entries(params)) {
      text = text.replaceAll(`{${name}}`, String(value))
    }
  }
  return text
}

/** 非组件环境（lib/format.ts 等）使用：读取模块级当前语言。 */
export function t(key: string, params?: Record<string, string | number>): string {
  return translate(activeLanguage, key, params)
}

/**
 * 由后端提供的可翻译文案：`{ code, params, fallback }`。
 *
 * 为什么后端不直接回中文：Rust 那边有一百多条「探测说明 / 错误信息 / 校验提示」，
 * 硬编码中文会让英文界面里混进中文（用户实测反馈的第一个问题就是这样）。
 * 现在后端给一个稳定的 `code` + 参数，翻译表仍然只有前端这一份；
 * `fallback` 是后端的中文原文，用于日志、以及前端还不认识的新 code——
 * 宁可显示中文，也不要显示一个 `error.foo.bar` 这样的裸键。
 */
export interface LocalizedText {
  code: string
  params?: Record<string, string>
  fallback: string
}

/** 组件内使用：订阅语言变化，语言切换时组件重渲染。 */
export function useT() {
  const lang = useContext(LanguageContext)
  const t = (key: string, params?: Record<string, string | number>) =>
    translate(lang, key, params)
  /**
   * 翻译后端文案：字典里有这个 code 就用译文，没有就用后端给的原文。
   * 用 `lookup` 而不是 `translate` 判断存在性——后者会把缺失 key 原样返回，
   * 无法区分「翻译结果恰好等于 key」和「没有这条翻译」。
   */
  t.text = (text: LocalizedText | null | undefined): string => {
    if (!text) return ''
    return resolveBackend(lang, text)
  }
  return t
}

/** 后端文案的统一解析：有译文用译文，没有就用后端给的中文原文。 */
function resolveBackend(lang: Language, text: LocalizedText): string {
  const template = lookupBackend(DICTS[lang], text.code)
  if (template === null) {
    if (lang !== 'zh') console.warn(`[i18n] missing backend code: ${text.code} (${lang})`)
    return text.fallback
  }
  let out = template
  for (const [name, value] of Object.entries(text.params ?? {})) {
    out = out.replaceAll(`{${name}}`, String(value))
  }
  return out
}

/** 非组件环境的版本（lib/format.ts 等）。 */
export function translateLocalized(text: LocalizedText | null | undefined): string {
  if (!text) return ''
  return resolveBackend(activeLanguage, text)
}
