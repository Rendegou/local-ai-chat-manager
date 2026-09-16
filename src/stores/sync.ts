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
  clearError: () => void
  setProgress: (progress: string | null) => void
  setRunning: (running: boolean) => void
}

export const useSync = create<SyncState>((set) => ({
  status: null,
  report: null,
  archives: [],
  running: false,
  progress: null,
  loading: false,
  error: null,

  /** 读取仓库状态（分支 / 远端 / 变更 / 冲突）。 */
  refresh: async () => {
    set({ loading: true, error: null })
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
    set({ running: true, progress: null, error: null })
    let report: SyncReport | null = null
    try {
      report = await ipc.syncNow(options)
      const [status, archives] = await Promise.all([ipc.syncStatus(), ipc.listArchives()])
      set({ report, status, archives })
      return report
    } catch (error) {
      set({ error: error as ipc.IpcError })
      // 同步本身成功、仅刷新视图失败时，仍把报告交给页面展示。
      return report
    } finally {
      set({ running: false, progress: null })
    }
  },

  /** 冲突处理：中止 rebase（不自动合并、不丢数据）。 */
  abortRebase: async () => {
    set({ error: null })
    try {
      await ipc.abortRebase()
      set({ status: await ipc.syncStatus() })
    } catch (error) {
      set({ error: error as ipc.IpcError })
    }
  },

  /** 归档列表。 */
  loadArchives: async () => {
    set({ error: null })
    try {
      set({ archives: await ipc.listArchives() })
    } catch (error) {
      set({ error: error as ipc.IpcError })
    }
  },

  /** 按天数阈值批量归档。 */
  archiveOld: async () => {
    set({ error: null })
    try {
      await ipc.archiveOldSessions()
      set({ archives: await ipc.listArchives() })
    } catch (error) {
      set({ error: error as ipc.IpcError })
    }
  },

  /** 从归档恢复。 */
  restore: async (relPath) => {
    set({ error: null })
    try {
      await ipc.restoreArchive(relPath)
      const [archives, status] = await Promise.all([ipc.listArchives(), ipc.syncStatus()])
      set({ archives, status })
    } catch (error) {
      set({ error: error as ipc.IpcError })
    }
  },

  clearError: () => set({ error: null }),
  setProgress: (progress) => set({ progress }),
  setRunning: (running) => set({ running }),
}))
