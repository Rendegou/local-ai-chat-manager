/**
 * 按钮原语（规格 §7）。
 *
 * 约定：
 * - 四种语气：primary（主操作）、secondary（次要，默认）、ghost（工具动作）、danger（破坏性）；
 * - 覆盖 hover / active / focus-visible / disabled / loading 五种状态；
 * - hover 只改表面色，不移动布局；loading 时保持宽度不跳动；
 * - 不依赖颜色单独表达语义：danger 同时带图标位（由调用方传入）。
 */
import type { ButtonHTMLAttributes, ReactNode } from 'react'

import { Spinner } from './Status'

/** 按钮语气。 */
export type ButtonTone = 'primary' | 'secondary' | 'ghost' | 'danger'

/** 按钮尺寸：sm 用于面板内，md 用于工具栏与表单。 */
export type ButtonSize = 'sm' | 'md'

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'> {
  tone?: ButtonTone
  size?: ButtonSize
  /** 加载中：显示进度并阻止重复提交 */
  loading?: boolean
  /** 可选前置图标（emoji/字符即可，保持零图标依赖） */
  icon?: ReactNode
  className?: string
  children?: ReactNode
}

/** 语气 → 类名。 */
const TONE: Record<ButtonTone, string> = {
  // 主按钮：accent 渐变 + 顶内高光 + 柔和投影（唯一允许「浮起」的按钮）
  primary:
    'btn-primary text-accent-ink border border-transparent hover:brightness-105 active:brightness-95',
  // 次按钮：升一级的表面 + 细边 + 轻投影（声明一次 elevation）
  secondary:
    'bg-overlay text-ink border border-line shadow-panel hover:border-line-strong active:bg-hover',
  ghost: 'bg-transparent text-ink-muted border border-transparent hover:bg-hover hover:text-ink',
  danger: 'bg-transparent text-danger border border-danger/45 hover:bg-danger/12 active:bg-danger/18',
}

/** 尺寸 → 类名。 */
const SIZE: Record<ButtonSize, string> = {
  sm: 'h-7 gap-1.5 px-2.5 text-meta',
  md: 'h-8 gap-2 px-3 text-body',
}

/** 通用按钮。 */
export function Button({
  tone = 'secondary',
  size = 'md',
  loading = false,
  icon,
  className = '',
  children,
  disabled,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={`inline-flex shrink-0 items-center justify-center rounded-control font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${TONE[tone]} ${SIZE[size]} ${className}`}
      {...rest}
    >
      {loading ? <Spinner size="sm" /> : icon}
      {children}
    </button>
  )
}

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'> {
  /** 无障碍名称（必填）：图标按钮没有可见文字，必须显式声明 */
  label: string
  tone?: ButtonTone
  size?: ButtonSize
  className?: string
  children: ReactNode
}

/**
 * 图标按钮。
 *
 * 因为没有可见文字，`label` 是必填项，会同时作为 `aria-label` 与 tooltip。
 */
export function IconButton({
  label,
  tone = 'ghost',
  size = 'md',
  className = '',
  children,
  type = 'button',
  ...rest
}: IconButtonProps) {
  const box = size === 'sm' ? 'h-7 w-7' : 'h-8 w-8'
  return (
    <button
      type={type}
      title={label}
      aria-label={label}
      className={`inline-flex shrink-0 items-center justify-center rounded-control transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${TONE[tone]} ${box} ${className}`}
      {...rest}
    >
      {children}
    </button>
  )
}
