/**
 * 输入类原语：文本输入、下拉、开关（规格 §7）。
 *
 * 与旧实现的差别：
 * - 不再用 `outline-none` 抹掉焦点环 —— 统一走 `:focus-visible`（见 index.css）；
 * - 字号统一到 13.5px，占位符与边框对比度满足可读性；
 * - 开关用 description 说明副作用，避免“只有一根拨杆”的不确定性。
 */
import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react'

/** 文本输入；`onEnter` 是搜索框这类「回车即执行」场景的便捷属性。 */
export function TextInput({
  className = '',
  onEnter,
  onKeyDown,
  ...rest
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'className'> & {
  className?: string
  onEnter?: () => void
}) {
  return (
    <input
      onKeyDown={(event) => {
        onKeyDown?.(event)
        if (event.key === 'Enter' && onEnter) onEnter()
      }}
      className={`w-full rounded-control border border-line bg-canvas px-2.5 py-1.5 text-body text-ink shadow-sunken transition-colors placeholder:text-ink-faint hover:border-line-strong focus-visible:border-accent disabled:opacity-50 ${className}`}
      {...rest}
    />
  )
}

/** 下拉选择：支持 `options` 数组或直接传 `<option>` 子节点。 */
export function Select({
  className = '',
  children,
  options,
  ...rest
}: Omit<SelectHTMLAttributes<HTMLSelectElement>, 'className' | 'children'> & {
  className?: string
  children?: ReactNode
  options?: Array<{ value: string; label: string }>
}) {
  return (
    <select
      className={`rounded-control border border-line bg-canvas px-2 py-1.5 text-body text-ink shadow-sunken transition-colors hover:border-line-strong focus-visible:border-accent disabled:opacity-50 ${className}`}
      {...rest}
    >
      {options
        ? options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))
        : children}
    </select>
  )
}

/**
 * 开关：用于布尔设置项。
 *
 * 始终渲染成 checkbox + 标签 + 说明，键盘可用（Space 切换），
 * 不依赖颜色表达开/关（勾选框本身有状态）。
 */
export function Toggle({
  checked,
  onChange,
  label,
  description,
  disabled,
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  label: string
  description?: ReactNode
  disabled?: boolean
}) {
  return (
    <label
      className={`flex cursor-pointer items-start gap-2.5 py-1.5 ${
        disabled ? 'cursor-not-allowed opacity-50' : ''
      }`}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5 h-4 w-4 shrink-0 accent-accent"
      />
      <span className="min-w-0">
        <span className="block text-body text-ink">{label}</span>
        {description ? (
          <span className="block text-meta text-ink-muted">{description}</span>
        ) : null}
      </span>
    </label>
  )
}
