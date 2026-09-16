/**
 * 同步状态管理：Sync 页所需的仓库状态、同步执行与冲突处理。
 */
import { create } from 'zustand'

import * as ipc from '../lib/ipc'
import type { ArchiveEntry, SyncReport, SyncStatus } from '../types/ipc'

interface SyncState {
  status: SyncStatus | null
  report: SyncReport | null
  archives: ArchiveEntry[]
  running: boolean
  progress: string | null
  loading: boolean
  error: ipc.IpcError | null

  refresh: () => Promise<void>
  run: (options?: { push?: boolean; setRemote?: string | null }) => Promise<SyncReport | null>
  abortRebase: () => Promise<void>
  loadArchives: () => Promise<void>
  archiveOld: () => Promise<void>
  restore: (relPath: string) => Promise<void>
  setProgress: (progress: string | null) => void
  setRunning: (running: boolean) => void
}

export const useSync = create<SyncState>((set, get) => ({
  status: null,
  report: null,
  archives: [],
  running: false,
  progress: null,
  loading: false,
  error: null,

  /** 读取仓库状态（分支 / 远端 / 变更 / 冲突）。 */
  refresh: async () => {
    set({ loading: true })
    try {
      set({ status: await ipc.syncStatus() })
    } catch (error) {
      set({ error: error as ipc.IpcError })
    } finally {
      set({ loading: false })
    }
  },

  /** 执行一次同步（后端通过事件推送每一步进度）。 */
  run: async (options) => {
    set({ running: true, progress: null })
    try {
      const report = await ipc.syncNow(options)
      set({ report })
      await get().refresh()
      await get().loadArchives()
      return report
    } catch (error) {
      set({ error: error as ipc.IpcError })
      return null
    } finally {
      set({ running: false, progress: null })
    }
  },

  /** 冲突处理：中止 rebase（不自动合并、不丢数据）。 */
  abortRebase: async () => {
    try {
      await ipc.abortRebase()
      await get().refresh()
    } catch (error) {
      set({ error: error as ipc.IpcError })
    }
  },

  /** 归档列表。 */
  loadArchives: async () => {
    try {
      set({ archives: await ipc.listArchives() })
    } catch (error) {
      set({ error: error as ipc.IpcError })
    }
  },

  /** 按天数阈值批量归档。 */
  archiveOld: async () => {
    try {
      await ipc.archiveOldSessions()
      await get().loadArchives()
    } catch (error) {
      set({ error: error as ipc.IpcError })
    }
  },

  /** 从归档恢复。 */
  restore: async (relPath) => {
    try {
      await ipc.restoreArchive(relPath)
      await get().loadArchives()
      await get().refresh()
    } catch (error) {
      set({ error: error as ipc.IpcError })
    }
  },

  setProgress: (progress) => set({ progress }),
  setRunning: (running) => set({ running }),
}))
