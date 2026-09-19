/**
 * 输入类原语（组件级重设计 · 批次 1）。
 *
 * 控件皮肤统一走 `.field`（见 index.css）：内陷表面 + inset ring，
 * hover / focus / invalid 只改 ring 颜色；键盘 focus-visible 另有全局外圈环。
 *
 * - Select 不再是原生 <select>：触发器 + 浮层列表 + 选中对勾 + 完整键盘导航；
 * - Toggle 是真正的拨杆开关（role="switch"），不再是裸 checkbox；
 * - TextInput 支持图标内嵌（搜索框）；DirectoryInput 是「路径输入 + 选择」组合。
 */
import {
  useEffect,
  useId,
  useRef,
  useState,
  type InputHTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react'

import { useT } from '../../lib/i18n'
import { Icon } from './Icon'

/** 文本输入；`onEnter` 是搜索框这类「回车即执行」场景的便捷属性。 */
export function TextInput({
  className = '',
  onEnter,
  onKeyDown,
  icon,
  ...rest
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'className'> & {
  className?: string
  /** 内嵌在输入框左侧的图标（搜索等场景） */
  icon?: ReactNode
  onEnter?: () => void
}) {
  const input = (
    <input
      onKeyDown={(event) => {
        onKeyDown?.(event)
        if (event.key === 'Enter' && onEnter) onEnter()
      }}
      className={`field h-9 w-full px-3 text-body text-ink transition-colors placeholder:text-ink-faint ${icon ? 'pl-8' : ''} ${className}`}
      {...rest}
    />
  )
  if (!icon) return input
  return (
    <div className={`relative ${className.includes('flex-1') ? 'flex-1' : ''}`}>
      <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-faint">
        {icon}
      </span>
      {input}
    </div>
  )
}

/** 日期输入：原生 type=date，皮肤与其余控件一致（弹出面板跟随 color-scheme）。 */
export function DateInput({
  className = '',
  ...rest
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & { className?: string }) {
  return (
    <input
      type="date"
      className={`field h-9 min-w-0 w-full px-3 text-body text-ink ${className}`}
      {...rest}
    />
  )
}

/* ---------------- Select（自绘下拉） ---------------- */

export interface SelectOption {
  value: string
  label: string
  /** 选项右侧的补充说明 */
  hint?: string
}

/**
 * 下拉选择。
 *
 * 焦点始终留在触发器上，用 aria-activedescendant 指向高亮项（combobox 模式）：
 * ↑/↓ 移动、Enter/Space 选中、Esc 关闭并回到触发器。
 *
 * 两条契约（以前都没有）：
 * - `value` 不在 options 中时 `selected` 必须是 `undefined` 并显示 placeholder。
 *   旧实现用 `Math.max(0, findIndex(...))` 把 -1 抬成 0，于是「内部值是 doubao-work、
 *   界面显示 Codex」——用户看到的来源和真正写入的来源不是同一个（DESIGN_AUDIT §3）。
 * - options 为空时禁用触发器并说明「无可用选项」，而不是渲染一个点不开的空框。
 */
export function Select({
  value,
  onChange,
  options,
  className = '',
  disabled,
  id,
  placeholder,
  'aria-label': ariaLabel,
  'aria-describedby': ariaDescribedBy,
  'aria-invalid': ariaInvalid,
}: {
  value: string
  onChange: (value: string) => void
  options: SelectOption[]
  className?: string
  disabled?: boolean
  id?: string
  /** 当前值不在 options 中时显示的提示文本 */
  placeholder?: string
  'aria-label'?: string
  'aria-describedby'?: string
  'aria-invalid'?: boolean
}) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const containerRef = useRef<HTMLDivElement>(null)
  const listId = useId()

  const selectedIndex = options.findIndex((option) => option.value === value)
  const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined
  const empty = options.length === 0
  const locked = disabled || empty

  // 打开时高亮当前选中项（没有选中项就落在第一项），并滚进可视区
  useEffect(() => {
    if (!open) return
    setActive(selectedIndex >= 0 ? selectedIndex : 0)
    requestAnimationFrame(() => {
      containerRef.current
        ?.querySelector('[role="option"][aria-selected="true"]')
        ?.scrollIntoView({ block: 'nearest' })
    })
  }, [open, selectedIndex])

  // 点击外部 / Esc 关闭
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [open])

  const choose = (index: number) => {
    const option = options[index]
    if (option) onChange(option.value)
    setOpen(false)
  }

  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (locked) return
    if (!open) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
        event.preventDefault()
        setOpen(true)
      }
      return
    }
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        setActive((index) => (index + 1) % options.length)
        break
      case 'ArrowUp':
        event.preventDefault()
        setActive((index) => (index - 1 + options.length) % options.length)
        break
      case 'Home':
        event.preventDefault()
        setActive(0)
        break
      case 'End':
        event.preventDefault()
        setActive(options.length - 1)
        break
      case 'Enter':
      case ' ':
        event.preventDefault()
        choose(active)
        break
      case 'Escape':
        event.preventDefault()
        setOpen(false)
        break
      case 'Tab':
        setOpen(false)
        break
    }
  }

  const label = empty ? t('common.noOptions') : (selected?.label ?? placeholder ?? t('common.notSelected'))

  return (
    <div ref={containerRef} className={`relative ${className}`}>
      <button
        type="button"
        id={id}
        role="combobox"
        disabled={locked}
        aria-label={ariaLabel}
        aria-describedby={ariaDescribedBy}
        aria-invalid={ariaInvalid || undefined}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open ? `${listId}-${active}` : undefined}
        data-empty={selected ? undefined : 'true'}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={onKeyDown}
        className="field flex h-9 w-full items-center justify-between gap-2 px-3 text-left text-body text-ink"
      >
        <span
          className={`min-w-0 flex-1 truncate ${selected ? '' : 'text-ink-faint'}`}
          data-select-value={value}
        >
          {label}
        </span>
        <Icon
          name="chevron"
          size={12}
          className={`shrink-0 text-ink-muted transition-transform duration-120 ${open ? 'rotate-180' : ''}`}
        />
      </button>
      {open ? (
        <div
          id={listId}
          role="listbox"
          aria-label={ariaLabel}
          className="absolute left-0 top-[calc(100%+4px)] z-30 max-h-64 min-w-full w-max max-w-72 overflow-y-auto rounded-panel border border-line bg-overlay py-1 shadow-overlay animate-pop"
        >
          {options.map((option, index) => {
            const isSelected = index === selectedIndex
            const isActive = index === active
            return (
              <button
                key={option.value}
                id={`${listId}-${index}`}
                type="button"
                role="option"
                aria-selected={isSelected}
                onMouseEnter={() => setActive(index)}
                onClick={() => choose(index)}
                className={`flex min-h-9 w-full items-center gap-2 px-3 py-2 text-left text-body transition-colors ${
                  isActive ? 'bg-hover' : ''
                } ${isSelected ? 'font-medium text-accent' : 'text-ink'}`}
              >
                <span className="min-w-0 flex-1 truncate">{option.label}</span>
                {option.hint ? (
                  <span className="shrink-0 text-meta text-ink-muted">{option.hint}</span>
                ) : null}
                {isSelected ? (
                  <Icon name="check" size={12} className="shrink-0 text-accent" />
                ) : null}
              </button>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}

/* ---------------- Toggle（拨杆开关） ---------------- */

/**
 * 开关：role="switch" 的按钮 + 标签 + 说明。
 *
 * 开/关同时由「拨杆位置 + 轨道颜色」表达（不只靠颜色）；
 * 滑移动效 140ms，`prefers-reduced-motion` 下由全局规则压成瞬时。
 *
 * `bare` 用于紧凑列表行（例如设置页的来源行）：只渲染拨杆，
 * `label` 仍然作为无障碍名称，不再重复显示一次来源名。
 */
export function Toggle({
  checked,
  onChange,
  label,
  description,
  disabled,
  bare = false,
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  label: string
  description?: ReactNode
  disabled?: boolean
  bare?: boolean
}) {
  const control = (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={(event) => {
        // 阻止 label 的默认转发（点击开关本身不应再触发一次 label 点击）
        if (!bare) event.preventDefault()
        onChange(!checked)
      }}
      className={`${bare ? '' : 'mt-0.5'} inline-flex h-[18px] w-[32px] shrink-0 items-center rounded-full px-[2px] transition-colors duration-150 ${
        checked ? 'toggle-track-on justify-end' : 'justify-start bg-line-strong/70'
      }`}
    >
      <span
        aria-hidden="true"
        className="block h-[14px] w-[14px] rounded-full bg-white ring-1 ring-black/15 transition-transform duration-150"
      />
    </button>
  )

  if (bare) {
    return <span className={disabled ? 'cursor-not-allowed opacity-55' : ''}>{control}</span>
  }

  return (
    <label
      className={`flex items-start gap-2.5 py-1.5 ${disabled ? 'cursor-not-allowed opacity-55' : 'cursor-pointer'}`}
    >
      {control}
      <span className="min-w-0">
        <span className="block text-body text-ink">{label}</span>
        {description ? (
          <span className="block text-meta text-ink-muted">{description}</span>
        ) : null}
      </span>
    </label>
  )
}

/* ---------------- DirectoryInput（路径输入 + 选择） ---------------- */

/**
 * 目录选择器：等宽路径输入 + 「选择」按钮（设置页与同步页共用）。
 * `onBrowse` 由调用方接 Tauri 目录选择对话框。
 */
export function DirectoryInput({
  value,
  onChange,
  onBrowse,
  placeholder,
  id,
  'aria-describedby': ariaDescribedBy,
  'aria-invalid': ariaInvalid,
}: {
  value: string
  onChange: (value: string) => void
  onBrowse: () => void
  placeholder?: string
  id?: string
  'aria-describedby'?: string
  'aria-invalid'?: boolean
}) {
  const t = useT()
  return (
    <div className="flex items-center gap-1.5">
      <TextInput
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        aria-describedby={ariaDescribedBy}
        aria-invalid={ariaInvalid}
        className="flex-1 font-mono text-meta"
      />
      <button
        type="button"
        onClick={onBrowse}
        className="field flex h-9 shrink-0 items-center gap-1.5 px-3 text-body text-ink"
      >
        <Icon name="folder" size={13} className="text-ink-muted" />
        {t('common.choose')}
      </button>
    </div>
  )
}
