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

/** 组件内使用：订阅语言变化，语言切换时组件重渲染。 */
export function useT() {
  const lang = useContext(LanguageContext)
  return (key: string, params?: Record<string, string | number>) => translate(lang, key, params)
}
