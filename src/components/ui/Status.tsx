/**
 * 状态类原语：状态胶囊、提示条、加载与骨架屏（规格 §4.3 / §7）。
 *
 * 核心规则：**任何语义状态都不能只靠颜色表达**。
 * 因此 StatusPill 与 Notice 都强制带一个字形（✓ / ! / ✕ / •）或图标，
 * 色盲用户与灰度截图下同样可辨。
 */
import type { ReactNode } from 'react'

/** 语义语气。 */
export type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info' | 'codex' | 'kimi'

/** 语气 → 文字色类名。 */
const TONE_TEXT: Record<Tone, string> = {
  neutral: 'text-ink-muted',
  accent: 'text-accent',
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-danger',
  info: 'text-info',
  codex: 'text-codex',
  kimi: 'text-kimi',
}

/** 语气 → 边框/底色类名。 */
const TONE_SURFACE: Record<Tone, string> = {
  neutral: 'border-line bg-canvas/40',
  accent: 'border-accent/40 bg-accent/10',
  success: 'border-success/45 bg-success/10',
  warning: 'border-warning/45 bg-warning/12',
  danger: 'border-danger/45 bg-danger/12',
  info: 'border-info/40 bg-info/10',
  codex: 'border-codex/35 bg-codex/10',
  kimi: 'border-kimi/35 bg-kimi/10',
}

/** 语气 → 字形（非颜色的冗余表达）。 */
const TONE_GLYPH: Record<Tone, string> = {
  neutral: '•',
  accent: '•',
  success: '✓',
  warning: '!',
  danger: '✕',
  info: 'i',
  codex: '◇',
  kimi: '◆',
}

/** 状态胶囊：数据源、同步状态、解析状态、归档状态等统一使用它。 */
export function StatusPill({
  tone = 'neutral',
  children,
  title,
  /** 覆盖默认字形（例如数据源用专属标识） */
  glyph,
}: {
  tone?: Tone
  children: ReactNode
  title?: string
  glyph?: string
}) {
  return (
    <span
      title={title}
      className={`inline-flex shrink-0 items-center gap-1 rounded-control border px-1.5 py-0.5 text-meta leading-5 ${TONE_SURFACE[tone]}`}
    >
      <span aria-hidden="true" className={`text-micro font-semibold ${TONE_TEXT[tone]}`}>
        {glyph ?? TONE_GLYPH[tone]}
      </span>
      <span className="text-ink">{children}</span>
    </span>
  )
}

/**
 * 提示条：info / success / warning / danger。
 *
 * 成功提示可短暂出现；失败提示应持续到用户处理（由调用方决定何时清除）。
 */
export function Notice({
  tone = 'info',
  title,
  children,
  actions,
  className = '',
}: {
  tone?: Exclude<Tone, 'codex' | 'kimi'>
  title?: ReactNode
  children?: ReactNode
  actions?: ReactNode
  className?: string
}) {
  const role = tone === 'danger' || tone === 'warning' ? 'alert' : 'status'
  return (
    <div
      role={role}
      className={`flex items-start gap-2.5 rounded-panel border px-3 py-2.5 ${TONE_SURFACE[tone]} ${className}`}
    >
      <span aria-hidden="true" className={`pt-0.5 text-meta font-semibold ${TONE_TEXT[tone]}`}>
        {TONE_GLYPH[tone]}
      </span>
      <div className="min-w-0 flex-1">
        {title ? <div className="text-body font-medium text-ink">{title}</div> : null}
        {children ? <div className="text-meta text-ink-muted">{children}</div> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-1.5">{actions}</div> : null}
    </div>
  )
}

/** 轻量加载指示（配合 aria-live 使用）。 */
export function Spinner({ size = 'md', label }: { size?: 'sm' | 'md'; label?: string }) {
  const box = size === 'sm' ? 'h-3 w-3 border-[1.5px]' : 'h-3.5 w-3.5 border-2'
  return (
    <span className="inline-flex items-center gap-2 text-meta text-ink-muted">
      <span
        aria-hidden="true"
        className={`inline-block animate-spin rounded-full border-line border-t-accent ${box}`}
      />
      {label}
    </span>
  )
}

/** 骨架屏：数据未就绪时的稳定占位，避免整块空白跳动。 */
export function Skeleton({
  className = '',
  lines = 1,
}: {
  className?: string
  lines?: number
}) {
  return (
    <span className="block">
      {Array.from({ length: lines }).map((_, index) => (
        <span
          key={index}
          aria-hidden="true"
          className={`mb-1.5 block h-3 animate-pulse rounded bg-hover ${className}`}
        />
      ))}
    </span>
  )
}
