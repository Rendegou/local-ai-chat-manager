/**
 * 全局状态（zustand）：设置、索引状态、会话筛选与选中。
 *
 * 设计取舍：
 * - 只在 store 里放「跨页面共享」的状态；分页数据由各页面自己持有（消息列表等）；
 * - 所有后端调用都走 `lib/ipc`，错误统一进 `error` 字段，由 App 统一提示。
 */
import { create } from 'zustand'

import * as ipc from '../lib/ipc'
import type {
  AppSettings,
  ProjectSummary,
  ScanReport,
  SessionDetail,
  SessionFilter,
  SessionSummary,
  SourceRow,
  StorageStats,
} from '../types/ipc'

/** 页面（规格 §19：Conversations / Search / Sync / Settings）。 */
export type PageKey = 'conversations' | 'search' | 'sync' | 'settings'

interface LibraryState {
  // ---- 主题 ----
  theme: 'system' | 'light' | 'dark'

  // ---- 导航 ----
  page: PageKey
  /** 窄窗口下的筛选抽屉是否展开（纯 UI 状态） */
  filtersOpen: boolean
  /** 设置草稿（null 表示与已保存设置一致） */
  settingsDraft: AppSettings | null
  /** 设置页是否有未保存草稿（用于离开前保护） */
  settingsDirty: boolean
  /** 因未保存草稿而被拦下的目标页面 */
  pendingPage: PageKey | null

  // ---- 设置与数据源 ----
  settings: AppSettings | null
  sources: SourceRow[]
  machines: string[]
  projects: ProjectSummary[]
  stats: StorageStats | null

  // ---- 会话列表 ----
  sessions: SessionSummary[]
  total: number
  loadingSessions: boolean
  filter: SessionFilter
  selected: SessionDetail | null
  selectedId: string | null

  // ---- 扫描状态 ----
  scanning: boolean
  scanProgress: { done: number; total: number } | null
  lastScan: ScanReport | null

  // ---- 错误 ----
  error: ipc.IpcError | null

  // ---- actions ----
  setPage: (page: PageKey) => void
  setFiltersOpen: (open: boolean) => void
  /** 修改草稿（会自动更新「未保存」标记） */
  patchSettingsDraft: (patch: Partial<AppSettings>) => void
  /** 保存草稿；返回是否成功 */
  saveSettingsDraft: () => Promise<boolean>
  /** 放弃草稿，恢复到已保存设置 */
  resetSettingsDraft: () => void
  setSettingsDirty: (dirty: boolean) => void
  /** 导航请求：设置页有未保存草稿时先拦下（规格 §6.4） */
  requestPage: (page: PageKey) => void
  /** 确认放弃草稿并跳转 */
  confirmLeaveSettings: () => void
  /** 取消跳转 */
  cancelLeaveSettings: () => void
  setTheme: (theme: 'system' | 'light' | 'dark') => void
  setError: (error: ipc.IpcError | null) => void
  bootstrap: () => Promise<void>
  loadSettings: () => Promise<void>
  updateSettings: (settings: AppSettings) => Promise<boolean>
  loadSources: () => Promise<void>
  loadProjects: () => Promise<void>
  loadStats: () => Promise<void>
  setFilter: (patch: Partial<SessionFilter>) => void
  resetFilter: () => void
  loadSessions: (append?: boolean) => Promise<void>
  selectSession: (id: string | null) => Promise<void>
  scan: (force?: boolean) => Promise<void>
  setScanning: (scanning: boolean, progress?: { done: number; total: number } | null) => void
}

/** 默认筛选：不包含归档会话（规格：归档会话默认收起）。 */
const DEFAULT_FILTER: SessionFilter = {
  source: null,
  projectPath: null,
  machineId: null,
  from: null,
  to: null,
  includeArchived: false,
  onlyArchived: false,
  text: null,
}

/** 每页加载量：虚拟列表按需追加。 */
const PAGE_SIZE = 200

export const useLibrary = create<LibraryState>((set, get) => ({
  theme: 'system',
  page: 'conversations',
  filtersOpen: false,
  settingsDraft: null,
  settingsDirty: false,
  pendingPage: null,
  settings: null,
  sources: [],
  machines: [],
  projects: [],
  stats: null,
  sessions: [],
  total: 0,
  loadingSessions: false,
  filter: { ...DEFAULT_FILTER },
  selected: null,
  selectedId: null,
  scanning: false,
  scanProgress: null,
  lastScan: null,
  error: null,

  setPage: (page) => set({ page }),
  setFiltersOpen: (filtersOpen) => set({ filtersOpen }),
  patchSettingsDraft: (patch) => {
    const current = get().settingsDraft ?? get().settings
    if (!current) return
    const next = { ...current, ...patch }
    // 与已保存设置逐字段比较，决定是否标记「未保存」
    const saved = get().settings
    const dirty = saved ? JSON.stringify(next) !== JSON.stringify(saved) : true
    set({ settingsDraft: next, settingsDirty: dirty })
  },

  saveSettingsDraft: async () => {
    const draft = get().settingsDraft
    if (!draft) return true
    const ok = await get().updateSettings(draft)
    if (ok) set({ settingsDraft: null, settingsDirty: false })
    return ok
  },

  resetSettingsDraft: () => set({ settingsDraft: null, settingsDirty: false }),

  setSettingsDirty: (settingsDirty) => set({ settingsDirty }),

  requestPage: (page) => {
    const state = get()
    // 只在「离开设置页且草稿未保存」时拦截，其余情况直接跳转
    if (state.page === 'settings' && state.settingsDirty && page !== 'settings') {
      set({ pendingPage: page })
      return
    }
    set({ page })
  },

  confirmLeaveSettings: () => {
    const { pendingPage } = get()
    set({ settingsDirty: false, pendingPage: null, page: pendingPage ?? get().page })
  },

  cancelLeaveSettings: () => set({ pendingPage: null }),
  setTheme: (theme) => set({ theme }),
  setError: (error) => set({ error }),

  /** 启动时加载设置、数据源、项目与首批会话。 */
  bootstrap: async () => {
    try {
      const settings = await ipc.getSettings()
      set({ settings, theme: settings.theme })
      await Promise.all([get().loadSources(), get().loadProjects(), get().loadStats()])
      await get().loadSessions()
    } catch (error) {
      set({ error: error as ipc.IpcError })
    }
  },

  loadSettings: async () => {
    try {
      const settings = await ipc.getSettings()
      set({ settings, theme: settings.theme })
    } catch (error) {
      set({ error: error as ipc.IpcError })
    }
  },

  /** 保存设置（失败时返回 false，由设置页展示错误）。 */
  updateSettings: async (settings) => {
    try {
      const saved = await ipc.saveSettings(settings)
      set({ settings: saved, theme: saved.theme })
      // 数据源路径可能变化：重新探测 + 刷新列表
      await Promise.all([get().loadSources(), get().loadProjects()])
      await get().loadSessions()
      return true
    } catch (error) {
      set({ error: error as ipc.IpcError })
      return false
    }
  },

  loadSources: async () => {
    try {
      const sources = await ipc.listSources()
      set({ sources })
    } catch (error) {
      set({ error: error as ipc.IpcError })
    }
  },

  loadProjects: async () => {
    try {
      const [projects, machines] = await Promise.all([ipc.listProjects(), ipc.listMachines()])
      set({ projects, machines })
    } catch (error) {
      set({ error: error as ipc.IpcError })
    }
  },

  loadStats: async () => {
    try {
      set({ stats: await ipc.getStats() })
    } catch (error) {
      set({ error: error as ipc.IpcError })
    }
  },

  setFilter: (patch) => {
    set({ filter: { ...get().filter, ...patch } })
    void get().loadSessions()
  },

  resetFilter: () => {
    set({ filter: { ...DEFAULT_FILTER } })
    void get().loadSessions()
  },

  /** 加载会话列表（append=true 时追加下一页）。 */
  loadSessions: async (append = false) => {
    const { filter, sessions } = get()
    set({ loadingSessions: true })
    try {
      const offset = append ? sessions.length : 0
      const [rows, total] = await Promise.all([
        ipc.listSessions(filter, PAGE_SIZE, offset),
        ipc.countSessions(filter),
      ])
      set({ sessions: append ? [...sessions, ...rows] : rows, total })
    } catch (error) {
      set({ error: error as ipc.IpcError })
    } finally {
      set({ loadingSessions: false })
    }
  },

  /** 选中会话并加载详情（消息由查看器按需分页拉取）。 */
  selectSession: async (id) => {
    if (!id) {
      set({ selectedId: null, selected: null })
      return
    }
    set({ selectedId: id, selected: null })
    try {
      const detail = await ipc.getSession(id)
      // 防止快速切换时旧请求覆盖新选中
      if (get().selectedId === id) set({ selected: detail })
    } catch (error) {
      set({ error: error as ipc.IpcError })
    }
  },

  /** 触发扫描（后端会把进度通过事件推回来）。 */
  scan: async (force = false) => {
    set({ scanning: true, scanProgress: null })
    try {
      const report = await ipc.scanLibrary(force)
      set({ lastScan: report })
      await Promise.all([get().loadSessions(), get().loadProjects(), get().loadStats()])
      // 选中的会话可能已更新，重新拉取详情
      if (get().selectedId) await get().selectSession(get().selectedId)
    } catch (error) {
      set({ error: error as ipc.IpcError })
    } finally {
      set({ scanning: false, scanProgress: null })
    }
  },

  setScanning: (scanning, progress = null) => set({ scanning, scanProgress: progress }),
}))
