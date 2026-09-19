/**
 * 布局类原语：面板标题、语义分组卡片、表单字段、空状态、抽屉。
 *
 * 分组规则（docs/DESIGN.md §7）：Card 只用于**真正独立的对象、危险状态、临时浮层**，
 * 不用来把表单分组套成卡片——表单分组优先用「标题 + 间距 + divider」。
 */
import { useId, type ReactNode } from 'react'

import { useT } from '../../lib/i18n'
import { Overlay, OverlayHeader } from './Overlay'

/**
 * 面板标题栏：分层标题（主标题 + 元数据）+ 操作槽。
 *
 * 三个槽位宽度**不互相竞争**：
 * - `title` 最多占 60%，超出截断——保证长标题不会把 meta 挤没；
 * - `meta` 吃剩余空间并截断——保证长路径不会把标题挤没；
 * - `actions` 固定宽度。
 *
 * `headingLevel` 让每个页面有且只有一个 `h1`（此前硬编码 h2，
 * 导致四个页面全都没有一级标题，文档大纲从 h2 开始）。
 */
export function PanelHeader({
  title,
  meta,
  actions,
  /** 标题下方的补充信息（例如当前筛选摘要） */
  description,
  /** 语义标题层级：页面主标题传 1，面板/分区传 2（默认）或 3 */
  headingLevel = 2,
  sticky = false,
  className = '',
}: {
  title: ReactNode
  meta?: ReactNode
  actions?: ReactNode
  description?: ReactNode
  headingLevel?: 1 | 2 | 3
  sticky?: boolean
  className?: string
}) {
  const Heading = headingLevel === 1 ? 'h1' : headingLevel === 3 ? 'h3' : 'h2'
  return (
    <div className={`panel-header shrink-0 ${sticky ? 'sticky top-0 z-10' : ''} ${className}`}>
      <div className="flex min-w-0 items-center gap-3">
        {/* truncate 必须配 min-w-0：否则 nowrap 文本的固有宽度会撑宽整个头部 */}
        <Heading className="min-w-0 max-w-[60%] shrink truncate text-title text-ink">
          {title}
        </Heading>
        {meta ? (
          <div className="min-w-0 flex-1 truncate text-meta text-ink-muted">{meta}</div>
        ) : null}
        {actions ? (
          <div className="ml-auto flex shrink-0 items-center gap-1.5">{actions}</div>
        ) : null}
      </div>
      {description ? <div className="pt-1 text-meta text-ink-muted">{description}</div> : null}
    </div>
  )
}

/**
 * 语义分组卡片。
 *
 * **不是设置/同步页的默认容器**——绝大多数分组应该用 `Section`（标题 + 间距 + divider）。
 * 保留给真正独立的对象与危险状态。
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
  return (
    <section
      className={`rounded-panel ${
        tone === 'danger'
          ? 'border border-danger/35 bg-danger/6'
          : 'section-card'
      } ${className}`}
    >
      <header className="flex items-start justify-between gap-3 px-4 pb-1.5 pt-3">
        <div className="min-w-0">
          <h3 className={`text-section ${tone === 'danger' ? 'text-danger' : 'text-ink'}`}>
            {title}
          </h3>
          {description ? <p className="pt-0.5 text-meta text-ink-muted">{description}</p> : null}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-1.5">{actions}</div> : null}
      </header>
      <div className="px-4 pb-3.5 pt-2">{children}</div>
    </section>
  )
}

/**
 * 无卡片的设置分组：标题 + 说明 + 间距 + divider。
 *
 * 这是设置页与同步页的**默认容器**。它没有背景、没有圆角、没有边框，
 * 只靠排版与一条分隔线表明「这几项属于一组」。
 */
export function Section({
  title,
  description,
  actions,
  headingLevel = 2,
  children,
  className = '',
}: {
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
  headingLevel?: 2 | 3
  children: ReactNode
  className?: string
}) {
  const Heading = headingLevel === 3 ? 'h3' : 'h2'
  return (
    <section className={`border-b border-line pb-6 last:border-b-0 last:pb-0 ${className}`}>
      <header className="flex items-start justify-between gap-3 pb-2">
        <div className="min-w-0">
          <Heading className="text-section text-ink">{title}</Heading>
          {description ? (
            <p className="pt-0.5 text-meta text-ink-muted">{description}</p>
          ) : null}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-1.5">{actions}</div> : null}
      </header>
      <div className="flex flex-col gap-3">{children}</div>
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
    <div>
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
    <div className="flex items-start gap-3 py-1">
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
  icon,
  className = '',
}: {
  title: string
  description?: ReactNode
  primaryAction?: ReactNode
  secondaryAction?: ReactNode
  /** 标题上方的弱化图标（传递场景感，不承担语义） */
  icon?: ReactNode
  className?: string
}) {
  return (
    <div
      className={`flex h-full flex-col items-center justify-center gap-2.5 px-8 text-center ${className}`}
    >
      {icon ? <div className="pb-1 text-ink-faint">{icon}</div> : null}
      <div className="text-section text-ink">{title}</div>
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

/**
 * 抽屉：窄窗口下会话上下文 / 全局导航 / 来源管理的承载。
 *
 * 键盘与 AT 契约全部来自 `Overlay`（焦点圈定、Escape、焦点归还、背景 inert、portal）。
 * 从上方 46px 标题栏之下展开，标题栏保持可用——用户仍能拖动窗口、点窗口控制。
 */
export function Drawer({
  title,
  subtitle,
  onClose,
  widthClass = 'w-[280px]',
  children,
}: {
  title: string
  subtitle?: string
  onClose: () => void
  widthClass?: string
  children: ReactNode
}) {
  const t = useT()
  const titleId = `drawer-${useId()}`
  const belowHeader = 'absolute inset-x-0 bottom-0 top-[var(--app-header-h)]'
  return (
    <Overlay
      open
      onClose={onClose}
      labelledBy={titleId}
      backdropClassName={`${belowHeader} bg-canvas/60`}
      positionClassName={`pointer-events-none ${belowHeader} flex items-stretch justify-start`}
      panelClassName={`${widthClass} max-w-[86vw] rounded-none border-y-0 border-l-0`}
    >
      <OverlayHeader
        id={titleId}
        title={title}
        subtitle={subtitle}
        onClose={onClose}
        closeLabel={t('common.closeTitle', { title })}
      />
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain">{children}</div>
    </Overlay>
  )
}
