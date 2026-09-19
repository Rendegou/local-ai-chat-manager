/**
 * 状态类原语：状态胶囊、提示条、加载与骨架屏（规格 §4.3 / §7）。
 *
 * 核心规则：**任何语义状态都不能只靠颜色表达**。
 * StatusPill 与 Notice 的语义语气强制带图标（✓/!/✕/i 的 SVG 版）；
 * 来源身份（codex/kimi）与中性态用色点，且始终伴随文字标签出现。
 */
import type { ReactNode } from 'react'

import { useT } from '../../lib/i18n'
import { Dot, Icon, type IconName } from './Icon'

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

/** 语气 → 底色（无描边，淡染承载语义；图标负责色觉冗余）。 */
const TONE_SURFACE: Record<Tone, string> = {
  neutral: 'bg-hover',
  accent: 'bg-accent/12',
  success: 'bg-success/12',
  warning: 'bg-warning/14',
  danger: 'bg-danger/12',
  info: 'bg-info/12',
  codex: 'bg-codex/10',
  kimi: 'bg-kimi/10',
}

/** 语义语气 → 图标（非颜色的冗余表达）。 */
const TONE_ICON: Partial<Record<Tone, IconName>> = {
  success: 'check',
  warning: 'warning',
  danger: 'close',
  info: 'info',
}

/** 身份/中性语气 → 色点。 */
const TONE_DOT: Partial<Record<Tone, 'neutral' | 'accent' | 'codex' | 'kimi'>> = {
  neutral: 'neutral',
  accent: 'accent',
  codex: 'codex',
  kimi: 'kimi',
}

/** 语气徽章：图标或色点，始终与文字一起出现。 */
function ToneMark({ tone, size = 11 }: { tone: Tone; size?: number }) {
  const icon = TONE_ICON[tone]
  if (icon) return <Icon name={icon} size={size} className={TONE_TEXT[tone]} />
  // sm 尺寸下色点也缩小一号，保持与文字的比例
  return <Dot tone={TONE_DOT[tone] ?? 'neutral'} className={size <= 9 ? 'h-1 w-1' : ''} />
}

/** 状态胶囊：数据源、同步状态、解析状态、归档状态等统一使用它。 */
export function StatusPill({
  tone = 'neutral',
  size = 'md',
  children,
  title,
}: {
  tone?: Tone
  /** sm：列表行内的微型徽标；md：默认 */
  size?: 'sm' | 'md'
  children: ReactNode
  title?: string
}) {
  const box =
    size === 'sm' ? 'gap-1 px-1.5 py-px text-micro leading-4' : 'gap-1.5 px-2 py-0.5 text-meta leading-5'
  return (
    <span
      title={title}
      className={`inline-flex shrink-0 items-center rounded-chip font-medium ${box} ${TONE_SURFACE[tone]}`}
    >
      <ToneMark tone={tone} size={size === 'sm' ? 9 : 11} />
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
      className={`flex items-start gap-2.5 rounded-panel px-3 py-2.5 ${TONE_SURFACE[tone]} ${className}`}
    >
      <span className={`pt-1 ${TONE_TEXT[tone]}`}>
        <ToneMark tone={tone} size={13} />
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

/**
 * 可移除筛选片（搜索筛选区）。
 *
 * 整片即「移除」按钮：点击任意位置都移除该筛选，
 * ✕ 图标只是示能，不是单独的点击目标。
 */
export function Chip({
  onRemove,
  children,
}: {
  onRemove: () => void
  children: ReactNode
}) {
  const t = useT()
  return (
    <button
      type="button"
      onClick={onRemove}
      aria-label={t('common.removeFilterAria', { label: typeof children === 'string' ? children : '' })}
      title={t('common.removeFilterTitle')}
      className="group inline-flex h-6 shrink-0 items-center gap-1 rounded-chip border border-line bg-canvas px-2 text-meta text-ink transition-colors hover:border-line-strong"
    >
      {children}
      <Icon
        name="close"
        size={10}
        className="text-ink-faint transition-colors group-hover:text-ink"
      />
    </button>
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
