/**
 * 展示层格式化工具：时间、体积、角色标签等。
 *
 * 所有时间都按「本地时区」展示，但排序 / 筛选仍然使用后端的 RFC3339 字符串。
 */

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

  if (diffMs < minute) return '刚刚'
  if (diffMs < hour) return `${Math.floor(diffMs / minute)} 分钟前`
  if (isSameDay(date, now)) return `今天 ${formatTime(date)}`
  const yesterday = new Date(now.getTime() - day)
  if (isSameDay(date, yesterday)) return `昨天 ${formatTime(date)}`
  if (diffMs < 7 * day) return `${Math.floor(diffMs / day)} 天前`
  return formatDate(date)
}

/** 日期字符串（YYYY-MM-DD）。 */
export function formatDate(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** 时间字符串（HH:mm）。 */
export function formatTime(date: Date): string {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

/** 完整时间（YYYY-MM-DD HH:mm:ss）。 */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return `${formatDate(date)} ${formatTime(date)}:${String(date.getSeconds()).padStart(2, '0')}`
}

/** 列表分组用的日期标题（今天 / 昨天 / YYYY-MM-DD）。 */
export function dateGroupLabel(iso: string | null | undefined): string {
  if (!iso) return '未知时间'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const now = new Date()
  if (isSameDay(date, now)) return '今天'
  if (isSameDay(date, new Date(now.getTime() - 86_400_000))) return '昨天'
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
  return source
}

/** 消息角色展示名。 */
export function roleLabel(role: string): string {
  switch (role) {
    case 'user':
      return '用户'
    case 'assistant':
      return '助手'
    case 'system':
      return '系统'
    case 'tool':
      return '工具'
    case 'developer':
      return '开发者'
    default:
      return '事件'
  }
}

/** 消息种类展示名。 */
export function kindLabel(kind: string): string {
  switch (kind) {
    case 'message':
      return '消息'
    case 'tool_call':
      return '工具调用'
    case 'tool_result':
      return '工具结果'
    case 'reasoning_summary':
      return '推理摘要'
    default:
      return '事件'
  }
}

/** 会话同步状态展示名。 */
export function syncStatusLabel(status: string): string {
  switch (status) {
    case 'local':
      return '仅本机'
    case 'synced':
      return '已同步'
    case 'modified':
      return '待同步'
    case 'archived':
      return '已归档'
    case 'remote':
      return '其他设备'
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
  if (filter.onlyArchived) parts.push('已归档')
  return parts.length === 0 ? '全部会话' : parts.join(' · ')
}
