/**
 * 行类原语（组件级重设计 · 批次 3）。
 *
 * 三个过去散落在页面里手写的「行」：
 * - SidebarRow：来源栏/抽屉里的导航行（图标位 + 标签 + 计数 + 尾随槽）；
 * - SectionLabel：分组小标题（CJK 没有 small-caps，不做全大写伪装，靠字重与色阶分层）；
 * - ListRow：同步/设置页里的数据行（引导位 + 主/次文本 + 尾随槽）。
 *
 * 行与行之间靠背景与间距区分，不再用连续横向 hairline。
 */
import type { ReactNode } from 'react'

/**
 * 分组小标题：色阶弱化的 12px 中字重。
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
    <div className={`flex items-center justify-between px-2 pb-1 pt-2.5 ${className}`}>
      <span className="text-meta font-medium text-ink-faint">{children}</span>
      {trailing ? <span className="text-meta tabular-nums text-ink-faint">{trailing}</span> : null}
    </div>
  )
}

/**
 * 侧栏导航行：来源、项目、归档入口等。
 *
 * 选中态 = 填充表面 + 左侧 inset 强调条（box-shadow 不影响布局，文字不位移）；
 * `trailing` 替换默认的计数位（例如项目行的复制按钮）。
 */
export function SidebarRow({
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
      className={`flex w-full items-center justify-between gap-2 rounded-control px-2 py-1.5 text-left text-body transition-colors ${
        active
          ? 'bg-selected font-medium text-ink shadow-[inset_2px_0_0_0_var(--semantic-accent)]'
          : 'text-ink-muted hover:bg-hover hover:text-ink'
      } ${className}`}
    >
      <span className="flex min-w-0 flex-1 items-center gap-1.5">
        {icon}
        <span className="min-w-0 flex-1 truncate">{label}</span>
      </span>
      {trailing ?? (
        <span className="shrink-0 text-meta tabular-nums text-ink-muted">{count ?? 0}</span>
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
