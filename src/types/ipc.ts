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

/**
 * 后端提供的可翻译文案（与 Rust `LocalizedText` 对应）。
 *
 * 后端只给稳定 code + 参数，翻译表仍然只有前端这一份；
 * `fallback` 是后端的中文原文，用于日志与前端还不认识的新 code。
 */
export interface LocalizedText {
  code: string
  params?: Record<string, string>
  fallback: string
}

/** 探测说明（与 Rust `SourceNote` 对应）。 */
export interface SourceNote extends LocalizedText {
  severity: 'info' | 'warn' | 'error'
}

/** 一条 Git 提交（同步页的日志）。 */
export interface GitCommit {
  hash: string
  shortHash: string
  author: string
  /** ISO 8601 */
  date: string
  subject: string
  /** 分支 / tag 装饰 */
  refs: string
  /** 是否还没推送到远端 */
  unpushed: boolean
}

/** 数据源探测结果。 */
export interface SourceRow {
  id: string
  displayName: string
  rootPath: string | null
  found: boolean
  sessionHint: number
  manual: boolean
  /** 中文纯文本（旧数据 / 日志用）；界面展示优先用 notesText */
  notes: string | null
  /** 结构化探测说明：按 code 翻译 */
  notesText?: SourceNote[]
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

/**
 * 用户自定义来源的字段映射（与 Rust `FieldMapping` 对应）。
 *
 * 除 layout / messagesPath / roleField / textField 之外，留空即「不配置」。
 */
export interface FieldMapping {
  /** 文件布局：一行一条消息，还是一个文件一个会话对象 */
  layout: 'jsonl' | 'json'
  /** json 布局下消息数组的路径，用 . 分隔，例如 data.items */
  messagesPath: string
  roleField: string
  textField: string
  timeField: string
  toolField: string
  titleField: string
  projectField: string
  /** 非标准角色名映射，例如 { bot: 'assistant' } */
  roleMap: Record<string, string>
  extensions: string[]
  maxDepth: number
}

/** 单个来源的配置（与 Rust `SourceConfig` 对应）。 */
export interface SourceConfig {
  enabled: boolean
  path: string | null
  /** 用户自定义来源的显示名 */
  displayName?: string | null
  /** 存在即为「用户自定义来源」 */
  mapping?: FieldMapping | null
}

/** 试解析里的单条消息。 */
export interface GenericPreviewMessage {
  role: string
  kind: string
  text: string
  timestamp: string | null
}
/** 试解析里的单个会话摘要。 */
export interface GenericPreviewSample {
  file: string
  title: string | null
  messages: GenericPreviewMessage[]
}
/** 「试解析」结果：填完字段映射先看看这个目录能读出什么。 */
export interface GenericPreview {
  filesFound: number
  sessionsSampled: number
  messages: number
  samples: GenericPreviewSample[]
  warnings: string[]
}

/** 设置（与 Rust `AppSettings` 对应）。 */
export interface AppSettings {
  sources: Record<string, SourceConfig>
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
  /** 按冲突内容给出的处理建议（可翻译） */
  hint?: LocalizedText | null
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

/**
 * 远端连通性诊断结果（「测试远端连接」）。
 *
 * 国内连 GitHub 失败时，光有 stderr 往往不够——用户不知道自己有没有配代理、
 * 凭据助手是什么。一次把「环境 + 一次真实探测」摊开，`report` 就是可以整段复制出去的内容。
 */
export interface RemoteDiagnosis {
  gitVersion: string
  repo: string
  branch: string
  remote: string | null
  /** git config 里的 http/https/credential 项（代理与凭据助手） */
  netConfig: string
  /** 进程里生效的代理环境变量 */
  envProxy: string
  probe: { code: number; stdout: string; stderr: string; args: string[] } | null
  hint: LocalizedText | null
  /** 可直接复制给人看的整段诊断文本 */
  report: string
}

/** 同步步骤。 */
export interface SyncStep {
  name: string
  ok: boolean
  detail: string
  /** 失败时的原始输出（命令行 + 退出码 + stdout/stderr）；成功时为空 */
  log?: string
  /** 按 stderr 特征给出的可执行建议 */
  hint?: LocalizedText | null
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
  /** 中文原文（回退用）；展示走 `descriptionCode` 查字典 */
  description: string
  /** 描述文案的翻译 key，形如 `source.codex.description` */
  descriptionCode: string
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
