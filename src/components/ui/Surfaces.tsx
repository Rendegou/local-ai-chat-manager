/**
 * 布局类原语：面板标题、语义分组卡片、表单字段、空状态（规格 §7）。
 *
 * 分组规则：卡片只用于「设置 / 同步」这类语义分组，不用来把普通内容都套成卡片。
 */
import { useId, type ReactNode } from 'react'

/**
 * 面板标题栏：分层标题（主标题 + 元数据）+ 操作槽。
 *
 * `sticky` 用于内容可滚动的面板（如会话正文），滚动时标题栏保持可见。
 */
export function PanelHeader({
  title,
  meta,
  actions,
  /** 标题下方的补充信息（例如当前筛选摘要） */
  description,
  sticky = false,
  className = '',
}: {
  title: ReactNode
  meta?: ReactNode
  actions?: ReactNode
  description?: ReactNode
  sticky?: boolean
  className?: string
}) {
  return (
    <div
      className={`shrink-0 border-b border-line bg-panel px-3.5 py-2.5 ${
        sticky ? 'sticky top-0 z-10' : ''
      } ${className}`}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 flex-1 items-baseline gap-2.5">
          {/* truncate 必须配 min-w-0 + flex-1：否则 nowrap 文本的固有宽度会撑宽整个头部
              （仅在文字放到 200% 时才暴露出来） */}
          <h2 className="min-w-0 flex-1 truncate font-display text-title text-ink">{title}</h2>
          {meta ? (
            <div className="min-w-0 flex-1 truncate text-meta text-ink-muted">{meta}</div>
          ) : null}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-1.5">{actions}</div> : null}
      </div>
      {description ? <div className="pt-1 text-meta text-ink-muted">{description}</div> : null}
    </div>
  )
}

/**
 * 语义分组卡片：仅用于设置页与同步页的功能分组。
 *
 * `tone` 用于危险分组（Danger Zone），带边框强调但不靠颜色单独表意（标题里写清后果）。
 */
export function SectionCard({
  title,
  description,
  actions,
  tone = 'default',
  children,
  className = '',
}: {
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
  tone?: 'default' | 'danger'
  children: ReactNode
  className?: string
}) {
  // 默认卡：投影 + 顶内高光声明 elevation，不再加描边；danger 卡用语义描边 + 淡染
  const skin =
    tone === 'danger'
      ? 'border border-danger/40 bg-danger/5'
      : 'bg-panel shadow-panel'
  return (
    <section className={`rounded-panel ${skin} ${className}`}>
      <header className="flex items-start justify-between gap-3 border-b border-line/70 px-4 py-3">
        <div className="min-w-0">
          <h3
            className={`font-display text-lead ${tone === 'danger' ? 'text-danger' : 'text-ink'}`}
          >
            {title}
          </h3>
          {description ? (
            <p className="pt-0.5 text-meta text-ink-muted">{description}</p>
          ) : null}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-1.5">{actions}</div> : null}
      </header>
      <div className="px-4 py-3.5">{children}</div>
    </section>
  )
}

/**
 * 表单字段：真正把 label / hint / error 绑定到控件上。
 *
 * - `label` 通过 `htmlFor` 关联控件（点击标签即可聚焦）；
 * - hint 与 error 走 `aria-describedby`，出错时用 `aria-invalid` 标记；
 * - 控件由调用方传入（`children` 收到自动生成的 id）。
 */
export function FormField({
  label,
  hint,
  error,
  /** 右侧附加信息（例如“未保存”） */
  badge,
  children,
}: {
  label: string
  hint?: ReactNode
  error?: string | null
  badge?: ReactNode
  children: (props: { id: string; 'aria-describedby'?: string; 'aria-invalid'?: boolean }) => ReactNode
}) {
  const id = useId()
  const hintId = hint ? `${id}-hint` : undefined
  const errorId = error ? `${id}-error` : undefined
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined

  return (
    <div className="py-2">
      <div className="flex items-baseline justify-between gap-2 pb-1">
        <label htmlFor={id} className="text-body font-medium text-ink">
          {label}
        </label>
        {badge}
      </div>
      {children({ id, 'aria-describedby': describedBy, 'aria-invalid': Boolean(error) })}
      {hint && !error ? (
        <p id={hintId} className="pt-1 text-meta text-ink-muted">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="pt-1 text-meta text-danger">
          <span aria-hidden="true">! </span>
          {error}
        </p>
      ) : null}
    </div>
  )
}

/**
 * 只读信息行：用于展示路径、设备、Git 状态等「标签 + 值」。
 *
 * 与 FormField 的区别：FormField 用于可编辑控件（带 label/error 绑定），
 * Field 只用于展示，值默认用等宽字体承载路径与标识。
 */
export function Field({
  label,
  children,
  mono = false,
  hint,
}: {
  label: string
  children: ReactNode
  mono?: boolean
  hint?: ReactNode
}) {
  return (
    <div className="flex items-start gap-3 py-2">
      <div className="w-28 shrink-0 pt-0.5 text-meta text-ink-muted">{label}</div>
      <div className={`min-w-0 flex-1 text-body text-ink ${mono ? 'break-all font-mono text-meta' : ''}`}>
        {children}
        {hint ? <div className="pt-0.5 text-meta text-ink-muted">{hint}</div> : null}
      </div>
    </div>
  )
}

/**
 * 空状态：说明「为什么空」并给出下一步动作（主动作 + 次动作）。
 */
export function EmptyState({
  title,
  description,
  primaryAction,
  secondaryAction,
  className = '',
}: {
  title: string
  description?: ReactNode
  primaryAction?: ReactNode
  secondaryAction?: ReactNode
  className?: string
}) {
  return (
    <div
      className={`flex h-full flex-col items-center justify-center gap-2.5 px-8 text-center ${className}`}
    >
      <div className="text-lead text-ink">{title}</div>
      {description ? (
        <div className="max-w-md text-body leading-6 text-ink-muted">{description}</div>
      ) : null}
      {primaryAction || secondaryAction ? (
        <div className="flex items-center gap-2 pt-1">
          {primaryAction}
          {secondaryAction}
        </div>
      ) : null}
    </div>
  )
}
