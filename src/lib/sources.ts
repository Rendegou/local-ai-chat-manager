/**
 * 数据源派生视图（docs/DESIGN_AUDIT.md §1 / docs/DESIGN.md §9）。
 *
 * 背景：后端 `source_catalog` 返回的是「产品支持哪些工具」，`list_sources` 返回的是
 * 「本机探测到了什么」。两者混用会让界面对用户说两种互相矛盾的话——
 * 侧栏把 Claude / Gemini 渲染成和 Codex 同构的一行，标题栏为「没装 Claude」报警，
 * 设置页把 8 个来源全部展开成配置墙。
 *
 * 这里把两个输入合并成一个 `SourceView`，页面只消费自己需要的子集：
 *
 * | 界面            | 子集                       |
 * | --------------- | -------------------------- |
 * | 会话页 SourcePane | visibleInSidebar         |
 * | 搜索页来源筛选    | visibleInSearch          |
 * | 设置已连接来源    | visibleInConnectedSettings |
 * | 添加来源抽屉      | 未连接的 Catalog 来源      |
 * | 标题栏警告        | needsAttention           |
 *
 * 纯函数、无副作用、不新增 IPC：库状态（sources / sourceCatalog / settings）照旧由
 * `stores/library.ts` 保存，页面通过 `useSourceViews()` 取得统一视图。
 */
import { useMemo } from 'react'

import { useLibrary } from '../stores/library'
import type { AppSettings, SourceConfig, SourceDefinition, SourceRow } from '../types/ipc'

/** 来源状态：与后端 `SourceCatalogEntry.status` 同构。 */
export type SourceStatus = 'available' | 'missing' | 'partial' | 'error'

/** 来源接入方式：原生读取 / 仅手动导入 / 待适配。 */
export type SourceAccess = SourceDefinition['access']

/** 合并后的来源视图：界面上一切「来源」判断都基于它。 */
export interface SourceView {
  id: string
  displayName: string
  /** 接入方式（来自 Catalog；未知来源按 'native' 处理） */
  access: SourceAccess
  status: SourceStatus
  /** 设置里的启用开关（未知来源默认为启用） */
  enabled: boolean
  /** 本机探测到目录（`SourceRow.found`） */
  found: boolean
  /** 在设置里手工指定过非空目录 */
  configured: boolean
  /** 索引里有该来源的会话（`SourceRow.sessionHint > 0`） */
  hasHistory: boolean
  /** 探测到的或手工指定的目录；都没有时为 null */
  rootPath: string | null
  /** 索引中的会话数 */
  sessionCount: number
  /** 后端给的人话说明（仅在来源真的存在时有意义） */
  notes: string | null
  /** 来源识别用的静态说明（Catalog），用于「添加来源」候选列表 */
  description: string
  /** 是否在会话页来源栏显示 */
  visibleInSidebar: boolean
  /** 是否在搜索页来源筛选中显示 */
  visibleInSearch: boolean
  /** 是否在设置「已连接来源」中显示 */
  visibleInConnectedSettings: boolean
  /** 是否需要用户处理（部分解析 / 读取失败 / 手工配置但目录已消失） */
  needsAttention: boolean
  /**
   * 是否是用户自定义来源（设置里有字段映射）。
   *
   * 界面用它而不是 `access` 来决定「配置」打开哪套表单：一个原本判为 pending 的工具
   * 被用户用字段映射接上之后，access 仍可能写着 pending，但它的配置方式已经是映射。
   */
  isCustom: boolean
}

/** 空设置兜底：没有 settings 时视为「未手工配置任何来源」。 */
const NO_SETTINGS_SOURCES: Record<string, SourceConfig> = {}

/**
 * 合并 Catalog 与探测结果，得到统一视图。
 *
 * 顺序：优先沿用 Catalog 顺序（产品定义的工具顺序稳定），
 * Catalog 里没有但索引里有历史的来源排在末尾（导入来源、旧版本遗留来源）。
 */
export function buildSourceViews(
  catalog: SourceDefinition[],
  rows: SourceRow[],
  settings: AppSettings | null,
): SourceView[] {
  const rowById = new Map(rows.map((row) => [row.id, row]))
  const settingsSources = settings?.sources ?? NO_SETTINGS_SOURCES
  const seen = new Set<string>()
  const views: SourceView[] = []

  const build = (id: string, definition: SourceDefinition | null): SourceView => {
    const row = rowById.get(id)
    const config = settingsSources[id]
    const mapping = config?.mapping ?? null
    const configuredPath = config?.path?.trim() ? config.path.trim() : null

    const found = row?.found === true
    const configured = configuredPath !== null
    const hasHistory = (row?.sessionHint ?? 0) > 0
    const status: SourceStatus = definition?.status ?? (found ? 'available' : 'missing')
    const needsAttention =
      status === 'partial' || status === 'error' || (configured && status === 'missing')

    return {
      id,
      // 用户自己起的名字优先；内置来源由 catalog 决定，故自定义来源不会撞车
      displayName: config?.displayName?.trim() || definition?.displayName || row?.displayName || id,
      access: definition?.access ?? 'native',
      status,
      enabled: config?.enabled ?? definition?.enabled ?? true,
      found,
      configured,
      hasHistory,
      rootPath: row?.rootPath ?? configuredPath,
      sessionCount: row?.sessionHint ?? 0,
      notes: found ? (row?.notes ?? null) : null,
      description: definition?.description ?? '',
      // 产品支持但本机没有 → 不进任何常驻界面，只出现在「添加来源」候选里
      visibleInSidebar: found || configured || hasHistory,
      // 没有历史就搜不到东西，列出来只会让用户选中一个必然零结果的筛选
      visibleInSearch: hasHistory,
      visibleInConnectedSettings:
        found || configured || hasHistory || status === 'partial' || status === 'error',
      needsAttention,
      isCustom: mapping != null,
    }
  }

  for (const definition of catalog) {
    seen.add(definition.id)
    views.push(build(definition.id, definition))
  }
  // Catalog 里没有、但索引里有记录的来源（导入来源、旧版本遗留）必须保留，
  // 否则这些来源的历史会从侧栏与设置里静默消失。
  for (const row of rows) {
    if (seen.has(row.id)) continue
    seen.add(row.id)
    views.push(build(row.id, null))
  }
  return views
}

/** 需要用户处理的来源（标题栏警告只对它计数）。 */
export function sourcesNeedingAttention(views: SourceView[]): SourceView[] {
  return views.filter((view) => view.needsAttention)
}

/** 仍未连接的 Catalog 候选（「添加来源」抽屉的列表）。 */
export function addableSourceViews(views: SourceView[]): SourceView[] {
  return views.filter((view) => !view.visibleInConnectedSettings)
}

/** 订阅库状态并派生视图。所有页面都通过它读取来源，不要直接读 `sources`。 */
export function useSourceViews(): SourceView[] {
  const { sources, sourceCatalog, settings } = useLibrary()
  return useMemo(
    () => buildSourceViews(sourceCatalog, sources, settings),
    [sourceCatalog, sources, settings],
  )
}
