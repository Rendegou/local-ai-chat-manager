/**
 * 按钮原语（docs/DESIGN.md §7）。
 *
 * 约定：
 * - 四种语气：primary（主操作）、secondary（次要，默认）、ghost（工具动作）、danger（破坏性）；
 * - 覆盖 hover / active / focus-visible / disabled / loading 五种状态；
 * - 尺寸：sm 28px / md 32px / lg 36px（lg 只给页面级 Primary 用）；
 * - 所有语气都带 1px 边框（primary/ghost 用透明边框）——否则同一行里不同语气的按钮
 *   会因为边框有无而错位 1px；
 * - hover 只改表面色，不移动布局；loading 时保持宽度不跳动；
 * - 不依赖颜色单独表达语义：danger 同时带图标位（由调用方传入）。
 */
import type { ButtonHTMLAttributes, ReactNode } from 'react'

import { Spinner } from './Status'

/** 按钮语气。 */
export type ButtonTone = 'primary' | 'secondary' | 'ghost' | 'danger'

/** 按钮尺寸：sm 面板内、md 工具栏与表单、lg 页面级主操作。 */
export type ButtonSize = 'sm' | 'md' | 'lg'

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
  // 主按钮：实心低饱和铜，无投影（每屏至多一个；见 index.css .btn-primary）
  primary: 'btn-primary border border-transparent',
  // 次按钮：透明底 + 真实 1px 边框（见 index.css .btn-secondary）
  secondary: 'btn-secondary',
  ghost: 'border border-transparent bg-transparent text-ink-muted hover:bg-hover hover:text-ink active:bg-selected',
  danger: 'btn-danger',
}

/** 尺寸 → 类名（高度与文档一致：sm 28 / md 32 / lg 36）。 */
const SIZE: Record<ButtonSize, string> = {
  sm: 'h-7 gap-1.5 px-2.5 text-meta',
  md: 'h-8 gap-2 px-3 text-body',
  lg: 'h-9 gap-2 px-4 text-body',
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
      className={`inline-flex shrink-0 items-center justify-center rounded-control font-medium transition-[color,background-color,border-color,filter] disabled:cursor-not-allowed disabled:opacity-55 ${TONE[tone]} ${SIZE[size]} ${className}`}
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
  const box = size === 'sm' ? 'h-7 w-7' : size === 'lg' ? 'h-9 w-9' : 'h-8 w-8'
  return (
    <button
      type={type}
      title={label}
      aria-label={label}
      className={`inline-flex shrink-0 items-center justify-center rounded-control transition-[color,background-color,border-color,filter] disabled:cursor-not-allowed disabled:opacity-55 ${TONE[tone]} ${box} ${className}`}
      {...rest}
    >
      {children}
    </button>
  )
}
