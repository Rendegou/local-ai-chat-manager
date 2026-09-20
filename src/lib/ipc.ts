/**
 * IPC 封装：所有与 Rust 后端的交互都经过这里。
 *
 * - 统一把 Rust 的结构化错误转换成 `IpcError`，UI 直接展示 `message`（人话）；
 * - 事件订阅集中在这里，避免后端事件名散落在组件中。
 */
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

import type {
  AppSettings,
  ArchiveEntry,
  ArchiveReport,
  CommandError,
  MessageRow,
  ProjectSummary,
  ScanProgress,
  ScanReport,
  SearchQuery,
  SearchResponse,
  SessionDetail,
  SessionFilter,
  SessionSummary,
  SourceRow,
  StorageStats,
  SyncReport,
  SyncStatus,
  FieldMapping,
  GenericPreview,
  GitCommit,
} from '../types/ipc'

/** 前端侧错误：保留分类 + 人话信息 + 原始细节。 */
export class IpcError extends Error {
  readonly kind: string
  readonly detail: string

  constructor(error: CommandError | string) {
    const isStructured = typeof error === 'object' && error !== null && 'message' in error
    super(isStructured ? error.message : String(error))
    this.name = 'IpcError'
    this.kind = isStructured ? error.kind : 'unknown'
    this.detail = isStructured ? error.detail : String(error)
  }
}

/** 调用后端命令并规范化错误。 */
async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args)
  } catch (raw) {
    throw new IpcError(raw as CommandError)
  }
}

// ---------------------------------------------------------------------------
// 事件
// ---------------------------------------------------------------------------

/** 后端事件名（与 Rust `commands::EVENT_*` 常量一致）。 */
export const EVENTS = {
  scanProgress: 'scan-progress',
  syncProgress: 'sync-progress',
  libraryChanged: 'library-changed',
} as const

/** 订阅扫描进度。 */
export function onScanProgress(handler: (progress: ScanProgress) => void): Promise<UnlistenFn> {
  return listen<ScanProgress>(EVENTS.scanProgress, (event) => handler(event.payload))
}

/** 订阅同步进度（一行文字）。 */
export function onSyncProgress(handler: (step: string) => void): Promise<UnlistenFn> {
  return listen<string>(EVENTS.syncProgress, (event) => handler(event.payload))
}

/** 订阅索引变化（扫描 / 文件监听 / 同步后触发，UI 据此刷新）。 */
export function onLibraryChanged(handler: () => void): Promise<UnlistenFn> {
  return listen(EVENTS.libraryChanged, () => handler())
}

// ---------------------------------------------------------------------------
// 数据源 / 会话
// ---------------------------------------------------------------------------

/** 探测数据源（Codex / Kimi 目录）。 */
export const detectSources = () => call<SourceRow[]>('detect_sources')

/** 读取已缓存的数据源信息。 */
export const listSources = () => call<SourceRow[]>('list_sources')

/** 会话列表。 */
export const listSessions = (filter: SessionFilter, limit = 200, offset = 0) =>
  call<SessionSummary[]>('list_sessions', { filter, limit, offset })

/** 会话总数。 */
export const countSessions = (filter: SessionFilter) => call<number>('count_sessions', { filter })

/** 会话详情。 */
export const getSession = (sessionId: string) =>
  call<SessionDetail | null>('get_session', { sessionId })

/** 消息分页。 */
export const getMessages = (sessionId: string, offset = 0, limit = 200) =>
  call<MessageRow[]>('get_messages', { sessionId, offset, limit })

/** 某条消息的前后文（搜索结果跳转）。 */
export const getMessagesAround = (sessionId: string, sequence: number, before = 30, after = 60) =>
  call<MessageRow[]>('get_messages_around', { sessionId, sequence, before, after })

/** 项目列表。 */
export const listProjects = () => call<ProjectSummary[]>('list_projects')

/** 机器列表。 */
export const listMachines = () => call<string[]>('list_machines')

/** 索引统计。 */
export const getStats = () => call<StorageStats>('get_stats')

/** 增量扫描（force=true 全量重建）。 */
export const scanLibrary = (force = false) => call<ScanReport>('scan_library', { force })

/** 重建索引。 */
export const rebuildIndex = () => call<ScanReport>('rebuild_index')

// ---------------------------------------------------------------------------
// 搜索 / 同步 / 归档 / 设置
// ---------------------------------------------------------------------------

/** 全文搜索。 */
export const search = (query: SearchQuery) => call<SearchResponse>('search', { query })

/** 同步状态。 */
export const syncStatus = () => call<SyncStatus>('sync_status')

/** 执行同步。 */
export const syncNow = (options?: {
  push?: boolean
  setRemote?: string | null
  commitMessage?: string | null
  skipScan?: boolean
}) => call<SyncReport>('sync_now', { options: options ?? {} })

/** Git 日志。 */
export const gitLog = (limit = 30) => call<GitCommit[]>('git_log', { limit })

/** 中止 rebase。 */
export const abortRebase = () => call<void>('abort_rebase')

/** 归档指定会话。 */
export const archiveSessions = (sessionIds: string[]) =>
  call<ArchiveReport>('archive_sessions', { sessionIds })

/** 按天数阈值批量归档。 */
export const archiveOldSessions = () => call<ArchiveReport>('archive_old_sessions')

/** 归档列表。 */
export const listArchives = () => call<ArchiveEntry[]>('list_archives')

/** 恢复归档。 */
export const restoreArchive = (relPath: string) => call<string>('restore_archive', { relPath })

/** 读取设置。 */
export const getSettings = () => call<AppSettings>('get_settings')

/** 保存设置。 */
export const saveSettings = (settings: AppSettings) =>
  call<AppSettings>('save_settings', { settings })

/** 应用数据目录。 */
export const dataDir = () => call<string>('data_dir')

/** 本机 machine id。 */
export const machineId = () => call<string>('machine_id')

export const sourceCatalog = () => call<import('../types/ipc').SourceDefinition[]>('source_catalog')
export const previewImport = (source: string, text: string) => call<import('../types/ipc').ImportPreview>('preview_import', { source, text })
export const confirmImport = (token: string) => call<import('../types/ipc').ImportReport>('confirm_import', { token })
export const cancelImport = (token: string) => call<void>('cancel_import', { token })
export const saveImportTemplate = (path: string, source: string, format: string) => call<void>('save_import_template', { path, source, format })

/** 自定义来源的试解析：先看目录里能读出什么，再决定要不要保存。 */
export const previewGenericSource = (sourceId: string, path: string, mapping: FieldMapping) =>
  call<GenericPreview>('preview_generic_source', { sourceId, path, mapping })
