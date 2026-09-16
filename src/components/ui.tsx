/**
 * 共享 UI 组件：保持极简，只提供本项目需要的少量原语。
 */
import type { ReactNode } from 'react'

/** 按钮：primary / default / ghost / danger 四种语气。 */
export function Button({
  children,
  onClick,
  variant = 'default',
  disabled,
  title,
  className = '',
}: {
  children: ReactNode
  onClick?: () => void
  variant?: 'primary' | 'default' | 'ghost' | 'danger'
  disabled?: boolean
  title?: string
  className?: string
}) {
  const base =
    'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[12px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50'
  const styles: Record<string, string> = {
    primary: 'bg-accent-600 text-white hover:bg-accent-500',
    default:
      'border border-line bg-surface-raised text-ink hover:bg-surface-sunken dark:hover:bg-surface-sunken',
    ghost: 'text-ink-muted hover:bg-surface-sunken hover:text-ink',
    danger: 'border border-red-500/40 text-red-600 hover:bg-red-500/10 dark:text-red-400',
  }
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={`${base} ${styles[variant]} ${className}`}
    >
      {children}
    </button>
  )
}

/** 小徽标（数据源 / 状态 / 消息类型）。 */
export function Badge({
  children,
  tone = 'neutral',
  title,
}: {
  children: ReactNode
  tone?: 'neutral' | 'accent' | 'warn' | 'muted'
  title?: string
}) {
  const tones: Record<string, string> = {
    neutral: 'border-line text-ink-muted',
    accent: 'border-accent-500/40 text-accent-600 dark:text-accent-400',
    warn: 'border-amber-500/40 text-amber-600 dark:text-amber-400',
    muted: 'border-transparent bg-surface-sunken text-ink-faint',
  }
  return (
    <span
      title={title}
      className={`inline-flex shrink-0 items-center rounded border px-1.5 py-0.5 text-[10.5px] leading-4 ${tones[tone]}`}
    >
      {children}
    </span>
  )
}

/** 空状态：说明 + 可选操作。 */
export function EmptyState({
  title,
  description,
  action,
}: {
  title: string
  description?: string
  action?: ReactNode
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
      <div className="text-[13px] font-medium text-ink-muted">{title}</div>
      {description ? (
        <div className="max-w-md text-[12px] leading-5 text-ink-faint">{description}</div>
      ) : null}
      {action}
    </div>
  )
}

/** 轻量加载指示。 */
export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 text-[12px] text-ink-faint">
      <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-line border-t-accent-500" />
      {label}
    </div>
  )
}

/** 面板标题栏（左侧标题，右侧操作）。 */
export function PanelHeader({
  title,
  subtitle,
  actions,
}: {
  title: ReactNode
  subtitle?: ReactNode
  actions?: ReactNode
}) {
  return (
    <div className="flex h-11 shrink-0 items-center justify-between gap-3 border-b border-line px-3">
      <div className="flex min-w-0 items-baseline gap-2">
        <div className="truncate text-[12.5px] font-semibold text-ink">{title}</div>
        {subtitle ? <div className="truncate text-[11.5px] text-ink-faint">{subtitle}</div> : null}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">{actions}</div>
    </div>
  )
}

/** 键值行（设置页 / 同步页的状态展示）。 */
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-3 py-1.5">
      <div className="w-32 shrink-0 pt-0.5 text-[11.5px] text-ink-faint">{label}</div>
      <div className="min-w-0 flex-1 text-[12px] text-ink">{children}</div>
    </div>
  )
}

/** 单行文本输入。 */
export function TextInput({
  value,
  onChange,
  placeholder,
  onEnter,
  autoFocus,
}: {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  onEnter?: () => void
  autoFocus?: boolean
}) {
  return (
    <input
      value={value}
      autoFocus={autoFocus}
      placeholder={placeholder}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && onEnter) onEnter()
      }}
      className="w-full rounded-md border border-line bg-surface px-2.5 py-1.5 text-[12px] text-ink outline-none placeholder:text-ink-faint focus:border-accent-500"
    />
  )
}

/** 下拉选择。 */
export function Select({
  value,
  onChange,
  options,
}: {
  value: string
  onChange: (value: string) => void
  options: Array<{ value: string; label: string }>
}) {
  return (
    <select
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className="rounded-md border border-line bg-surface px-2 py-1.5 text-[12px] text-ink outline-none focus:border-accent-500"
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  )
}

/** 开关（布尔设置项）。 */
export function Toggle({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  label: string
  hint?: string
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2.5 py-1.5">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5 h-3.5 w-3.5 accent-accent-600"
      />
      <span className="min-w-0">
        <span className="block text-[12px] text-ink">{label}</span>
        {hint ? <span className="block text-[11px] text-ink-faint">{hint}</span> : null}
      </span>
    </label>
  )
}
