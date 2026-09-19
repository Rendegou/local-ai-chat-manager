/**
 * 展示层格式化工具：时间、体积、角色标签等。
 *
 * 所有时间都按「本地时区」展示，但排序 / 筛选仍然使用后端的 RFC3339 字符串。
 * 日期时间一律走 `Intl.DateTimeFormat`（docs/DESIGN.md §2）：手工拼接 `getFullYear()`
 * 会固定成 `YYYY-MM-DD HH:mm:ss`，既不跟随系统区域设置，也不支持 12 小时制，
 * 结果是同一屏里两种时间格式并存。
 *
 * formatter 按「语言 + 选项」缓存 —— 每次调用新建 `Intl.DateTimeFormat` 是这个页面
 * 最容易被忽视的开销（虚拟列表一次滚动就是几百次）。
 *
 * 文案随界面语言（lib/i18n 的模块级当前语言，由 LanguageProvider 同步）。
 */
import { getLanguage, t, type Language } from './i18n'

/** formatter 缓存键 → 实例。 */
const dateFormatters = new Map<string, Intl.DateTimeFormat>()

function formatter(options: Intl.DateTimeFormatOptions, language: Language = getLanguage()) {
  const key = `${language}:${JSON.stringify(options)}`
  let instance = dateFormatters.get(key)
  if (!instance) {
    instance = new Intl.DateTimeFormat(language === 'zh' ? 'zh-CN' : 'en-US', options)
    dateFormatters.set(key, instance)
  }
  return instance
}

/** 相对时间（今天 / 昨天 / N 天前 / 具体日期）。 */
export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour

  if (diffMs < minute) return t('format.justNow')
  if (diffMs < hour) return t('format.minutesAgo', { n: Math.floor(diffMs / minute) })
  if (isSameDay(date, now)) return t('format.todayAt', { time: formatTime(date) })
  const yesterday = new Date(now.getTime() - day)
  if (isSameDay(date, yesterday)) return t('format.yesterdayAt', { time: formatTime(date) })
  if (diffMs < 7 * day) return t('format.daysAgo', { n: Math.floor(diffMs / day) })
  return formatDate(date)
}

/** 日期（跟随系统区域设置）。 */
export function formatDate(date: Date): string {
  return formatter({ year: 'numeric', month: '2-digit', day: '2-digit' }).format(date)
}

/** 时间（跟随系统区域设置，支持 12/24 小时制）。 */
export function formatTime(date: Date): string {
  return formatter({ hour: '2-digit', minute: '2-digit' }).format(date)
}

/** 完整日期时间。 */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return formatter({
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(date)
}

/** 列表分组用的日期标题（今天 / 昨天 / 具体日期）。 */
export function dateGroupLabel(iso: string | null | undefined): string {
  if (!iso) return t('format.unknownTime')
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const now = new Date()
  if (isSameDay(date, now)) return t('format.today')
  if (isSameDay(date, new Date(now.getTime() - 86_400_000))) return t('format.yesterday')
  return formatDate(date)
}

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
  )
}

/** 字节数 → 人类可读（1.2 MB）。 */
export function formatBytes(bytes: number | null | undefined): string {
  if (!bytes || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`
}

/** 毫秒 → 人类可读耗时。 */
export function formatDuration(ms: number | null | undefined): string {
  if (ms == null) return '—'
  if (ms < 1000) return `${ms} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`
  return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`
}

/** 路径最后一段（项目名）。 */
export function baseName(path: string | null | undefined): string {
  if (!path) return ''
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '')
  const parts = normalized.split('/')
  return parts[parts.length - 1] || path
}

/** 数据源展示名。 */
export function sourceLabel(source: string): string {
  if (source === 'kimi') return 'Kimi Code'
  if (source === 'codex') return 'Codex'
  if (source === 'cursor') return 'Cursor'
  if (source === 'zcode') return 'ZCode'
  return source
}

/** 数据源色点/徽章语气（没有专属配色的数据源用 accent / neutral 兜底）。 */
export function sourceTone(source: string): 'neutral' | 'accent' | 'codex' | 'kimi' {
  if (source === 'kimi') return 'kimi'
  if (source === 'codex') return 'codex'
  if (source === 'cursor') return 'accent'
  return 'neutral'
}

/** 数据源强调文字色（会话标题旁的来源标注）。 */
export function sourceTextClass(source: string): string {
  if (source === 'kimi') return 'text-kimi'
  if (source === 'codex') return 'text-codex'
  if (source === 'cursor') return 'text-accent'
  return 'text-ink'
}

/** 消息角色展示名。 */
export function roleLabel(role: string): string {
  switch (role) {
    case 'user':
      return t('format.role.user')
    case 'assistant':
      return t('format.role.assistant')
    case 'system':
      return t('format.role.system')
    case 'tool':
      return t('format.role.tool')
    case 'developer':
      return t('format.role.developer')
    default:
      return t('format.role.event')
  }
}

/** 消息种类展示名。 */
export function kindLabel(kind: string): string {
  switch (kind) {
    case 'message':
      return t('format.kind.message')
    case 'tool_call':
      return t('format.kind.toolCall')
    case 'tool_result':
      return t('format.kind.toolResult')
    case 'reasoning_summary':
      return t('format.kind.reasoning')
    default:
      return t('format.kind.event')
  }
}

/** 会话同步状态展示名。 */
export function syncStatusLabel(status: string): string {
  switch (status) {
    case 'local':
      return t('format.sync.local')
    case 'synced':
      return t('format.sync.synced')
    case 'modified':
      return t('format.sync.modified')
    case 'archived':
      return t('format.sync.archived')
    case 'remote':
      return t('format.sync.remote')
    default:
      return status
  }
}

/**
 * 把当前筛选条件描述成一句话（规格 §5.2：窄窗口下工具栏必须保留筛选摘要）。
 */
export function describeFilter(filter: {
  source?: string | null
  projectPath?: string | null
  onlyArchived?: boolean
  from?: string | null
  to?: string | null
}): string {
  const parts: string[] = []
  if (filter.projectPath) parts.push(baseName(filter.projectPath) || filter.projectPath)
  if (filter.source) parts.push(sourceLabel(filter.source))
  if (filter.from || filter.to) parts.push(`${filter.from ?? ''}~${filter.to ?? ''}`)
  if (filter.onlyArchived) parts.push(t('format.archived'))
  return parts.length === 0 ? t('format.allChats') : parts.join(' · ')
}
