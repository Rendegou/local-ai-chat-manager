/**
 * IPC 类型定义：与 Rust 侧 `aichat-core` 的 serde 结构一一对应（camelCase）。
 *
 * 约定（规格 §21）：类型只在这一处维护，业务代码不重复声明后端结构。
 */

/** 错误分类，与 Rust `ErrorKind` 对应。 */
export type ErrorKind =
  | 'adapter'
  | 'parse'
  | 'database'
  | 'git'
  | 'io'
  | 'archive'
  | 'config'
  | 'notFound'
  | 'conflict'

/** IPC 错误结构（Rust 已转换成「人话」，前端不展示 backtrace）。 */
export interface CommandError {
  kind: ErrorKind
  message: string
  detail: string
}

/** 数据源探测结果。 */
export interface SourceRow {
  id: string
  displayName: string
  rootPath: string | null
  found: boolean
  sessionHint: number
  manual: boolean
  notes: string | null
  detectedAt: string | null
}

/** 会话摘要。 */
export interface SessionSummary {
  id: string
  source: string
  externalId: string
  title: string | null
  projectPath: string | null
  createdAt: string | null
  updatedAt: string | null
  machineId: string | null
  messageCount: number
  partial: boolean
  archived: boolean
  syncStatus: string
  primaryFile: string | null
  contentHash: string | null
}

/** 原始文件信息。 */
export interface RawFileRow {
  path: string
  role: string
  size: number
  mtime: number
  hash: string | null
}

/** 会话详情。 */
export interface SessionDetail extends SessionSummary {
  sourceRoot: string | null
  metadata: Record<string, unknown>
  rawFiles: RawFileRow[]
}

/** 消息行（分页加载）。 */
export interface MessageRow {
  id: string
  sessionId: string
  sequence: number
  role: string
  kind: string
  text: string | null
  toolName: string | null
  timestamp: string | null
  raw: unknown
}

/** 列表筛选条件。 */
export interface SessionFilter {
  source?: string | null
  projectPath?: string | null
  machineId?: string | null
  from?: string | null
  to?: string | null
  includeArchived?: boolean
  onlyArchived?: boolean
  text?: string | null
}

/** 搜索结果单条。 */
export interface SearchHit {
  sessionId: string
  messageId: string
  sequence: number
  role: string
  kind: string
  timestamp: string | null
  snippet: string
  score: number
  title: string | null
  projectPath: string | null
  source: string
  machineId: string | null
  sessionUpdatedAt: string | null
}

/** 搜索响应。 */
export interface SearchResponse {
  hits: SearchHit[]
  hasMore: boolean
  tookMs: number
  matchQuery: string
}

/** 搜索请求。 */
export interface SearchQuery {
  text: string
  filter?: SessionFilter
  order?: 'relevance' | 'recent'
  messagesOnly?: boolean
  limit?: number
  offset?: number
}

/** 项目聚合。 */
export interface ProjectSummary {
  projectPath: string
  name: string
  sessionCount: number
  lastUpdated: string | null
  sources: string[]
}

/** 索引统计。 */
export interface StorageStats {
  sessions: number
  messages: number
  archivedSessions: number
  projects: number
  bytesOnDisk: number
}

/** 设置（与 Rust `AppSettings` 对应）。 */
export interface AppSettings {
  sources: Record<string, { enabled: boolean; path: string | null }>
  codexPath: string | null
  kimiPath: string | null
  cursorPath: string | null
  zcodePath: string | null
  syncRepo: string | null
  gitExe: string
  remoteUrl: string | null
  archiveCompression: 'zstd' | 'gzip'
  archiveAfterDays: number
  keepRawFiles: boolean
  autoScanOnStart: boolean
  watchEnabled: boolean
  theme: 'system' | 'light' | 'dark'
  language: 'system' | 'zh' | 'en'
  scanBatchLimit: number
  showArchived: boolean
}

/** 扫描进度事件。 */
export interface ScanProgress {
  phase: string
  done: number
  total: number
  current: string | null
}

/** 扫描报告。 */
export interface ScanReport {
  scanned: number
  parsed: number
  skipped: number
  removed: number
  failed: number
  pending: number
  skippedDuplicates: number
  durationMs: number
  warnings: string[]
  sources: unknown[]
}

/** Git 冲突（规格 §14）。 */
export interface GitConflict {
  inRebase: boolean
  files: string[]
  message: string
  stdout: string
  stderr: string
}

/** Git 文件变更。 */
export interface GitFileChange {
  path: string
  index: string
  worktree: string
}

/** 同步状态。 */
export interface SyncStatus {
  repo: string | null
  exists: boolean
  isRepo: boolean
  branch: string
  remote: string | null
  settingsRemote: string | null
  lastPull: string | null
  lastPush: string | null
  localChanges: number
  incomingChanges: number
  ahead: number
  behind: number
  pendingSessions: number
  pendingBytes: number
  conflict: GitConflict | null
  gitVersion: string | null
  changes: GitFileChange[]
  recentCommits: string[]
  error: string | null
}

/** 同步步骤。 */
export interface SyncStep {
  name: string
  ok: boolean
  detail: string
  durationMs: number
}

/** 同步报告。 */
export interface SyncReport {
  steps: SyncStep[]
  branch: string
  remote: string | null
  committed: boolean
  pushed: boolean
  pulled: boolean
  snapshot: {
    written: number
    skipped: number
    failed: number
    bytes: number
    files: { relPath: string; bytes: number }[]
  }
  conflict: GitConflict | null
  durationMs: number
}

/** 归档条目。 */
export interface ArchiveEntry {
  relPath: string
  source: string
  machineId: string
  sessionId: string
  sizeBytes: number
  createdAt: string
  compression: string
  title: string | null
}

/** 归档报告。 */
export interface ArchiveReport {
  archived: number
  failed: number
  bytesIn: number
  bytesOut: number
  entries: string[]
  warnings: string[]
}

export interface SourceDefinition {
  id: string
  displayName: string
  adapterVersion: number
  access: 'native' | 'import' | 'pending'
  platforms: string[]
  description: string
  status: 'available' | 'missing' | 'partial' | 'error'
  enabled: boolean
  notes: string | null
}
export interface ImportMessage { role: string; text: string; kind: string; timestamp: string | null; toolName: string | null; attachments: string[] }
export interface ImportPreview {
  token: string
  failed: number
  warnings: string[]
  /** 后端识别出来的输入格式（例如「JSONL 转录（一行一条消息）」）。导入是猜测，界面要把它说出来 */
  detectedFormat: string
  sessions: { source: string; externalId: string; title: string | null; messageCount: number; messages: ImportMessage[]; partial: boolean }[]
}
export interface ImportReport { success: number; duplicates: number; failed: number; partial: number; warnings: string[] }
