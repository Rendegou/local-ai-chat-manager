/**
 * 行类原语（平坦工作台）。
 *
 * 三个过去散落在页面里手写的「行」：
 * - PaneRow：来源栏/抽屉里的筛选行（图标位 + 标签 + 计数 + 尾随槽）；
 * - SectionLabel：分组小标题（小号弱色 + 大写字距；CJK 下 uppercase 自然失效）；
 * - ListRow：同步/设置页里的数据行（引导位 + 主/次文本 + 尾随槽）。
 *
 * 行高 34px、圆角 6px；选中态 = 轻中性背景 + 中等字重。
 * **没有左侧铜条**——铜条曾同时出现在全局导航、来源筛选和会话行上，
 * 三根同色同宽的竖线在同一屏里争夺注意力（docs/DESIGN_AUDIT.md §7）。
 */
import type { ReactNode } from 'react'

/**
 * 分组小标题：12px 弱化大写标签（CJK 无 small-caps，靠字号/字距/色阶分层）。
 * 说明文字（如计数）通过 `trailing` 右置。
 */
export function SectionLabel({
  children,
  trailing,
  className = '',
}: {
  children: ReactNode
  trailing?: ReactNode
  className?: string
}) {
  return (
    <div className={`flex items-center justify-between px-2.5 pb-1 pt-3 ${className}`}>
      <span className="text-meta font-semibold uppercase tracking-[0.06em] text-ink-faint">
        {children}
      </span>
      {trailing ? <span className="text-meta tabular-nums text-ink-faint">{trailing}</span> : null}
    </div>
  )
}

/**
 * 上下文筛选行：来源、项目等会话级筛选。
 *
 * 选中态 = 轻中性背景 + font-medium（比全局导航更弱一档），无 inset 阴影、无竖条。
 * `trailing` 替换默认的计数位（例如项目行的复制按钮）。
 */
export function PaneRow({
  active = false,
  onClick,
  icon,
  label,
  count,
  title,
  trailing,
  className = '',
}: {
  active?: boolean
  onClick: () => void
  icon?: ReactNode
  label: ReactNode
  count?: number | string
  title?: string
  trailing?: ReactNode
  /** 例如在项目行里与兄弟按钮并排时传 'flex-1'（flex-basis 0% 覆盖 w-full） */
  className?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-current={active ? 'true' : undefined}
      className={`flex h-[34px] w-full items-center justify-between gap-2 rounded-control px-2.5 text-left text-ui transition-colors ${
        active
          ? 'bg-selected-soft font-medium text-ink'
          : 'text-ink-muted hover:bg-hover hover:text-ink'
      } ${className}`}
    >
      <span className="flex min-w-0 flex-1 items-center gap-2">
        {icon}
        <span className="min-w-0 flex-1 truncate">{label}</span>
      </span>
      {trailing ?? (
        <span className="shrink-0 text-meta tabular-nums text-ink-faint">{count ?? 0}</span>
      )}
    </button>
  )
}

/**
 * 数据行：同步步骤、归档条目、未提交文件等「图标 + 主文本 + 次文本 + 右侧操作」。
 */
export function ListRow({
  leading,
  title,
  subtitle,
  trailing,
  className = '',
}: {
  leading?: ReactNode
  title: ReactNode
  subtitle?: ReactNode
  trailing?: ReactNode
  className?: string
}) {
  return (
    <div className={`flex items-center gap-2.5 px-1 py-1.5 ${className}`}>
      {leading ? <span className="shrink-0">{leading}</span> : null}
      <div className="min-w-0 flex-1">
        <div className="truncate text-body text-ink">{title}</div>
        {subtitle ? <div className="truncate text-meta text-ink-muted">{subtitle}</div> : null}
      </div>
      {trailing ? <div className="flex shrink-0 items-center gap-2">{trailing}</div> : null}
    </div>
  )
}
