/**
 * 溢出菜单：工具栏与页面里的「更多操作」（规格 §5.1）。
 *
 * 用 overlay 表面 + 阴影承载，符合「只有浮层才用阴影」的规则；
 * 支持 Esc 关闭、点击外部关闭、打开后聚焦第一项（键盘可用）。
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'

import { IconButton } from './Button'

/** 菜单项。 */
export interface MenuItem {
  label: string
  onClick: () => void
  /** 危险操作（如重建索引）单独标注 */
  tone?: 'default' | 'danger'
  disabled?: boolean
  /** 右侧补充说明 */
  hint?: string
}

/**
 * 更多操作菜单。
 *
 * `label` 必填：触发按钮是图标按钮，需要无障碍名称。
 */
export function Menu({
  label = '更多操作',
  items,
  glyph = '⋯',
}: {
  label?: string
  items: MenuItem[]
  glyph?: string
}) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const firstItemRef = useRef<HTMLButtonElement>(null)

  // 打开时聚焦第一项，关闭时不做额外处理（焦点留在触发按钮上）
  useEffect(() => {
    if (open) firstItemRef.current?.focus()
  }, [open])

  // 点击外部 / Esc 关闭
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  return (
    <div ref={containerRef} className="relative">
      <IconButton
        label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span aria-hidden="true">{glyph}</span>
      </IconButton>
      {open ? (
        <div
          role="menu"
          aria-label={label}
          className="absolute right-0 top-[calc(100%+6px)] z-30 min-w-[200px] rounded-overlay border border-line bg-overlay py-1 shadow-overlay"
        >
          {items.map((item, index) => (
            <button
              key={item.label}
              ref={index === 0 ? firstItemRef : undefined}
              type="button"
              role="menuitem"
              disabled={item.disabled}
              onClick={() => {
                setOpen(false)
                item.onClick()
              }}
              className={`flex w-full items-center gap-3 px-3 py-1.5 text-left text-body transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${
                item.tone === 'danger'
                  ? 'text-danger hover:bg-danger/12'
                  : 'text-ink hover:bg-hover'
              }`}
            >
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
              {item.hint ? <span className="text-meta text-ink-muted">{item.hint}</span> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

/** 分段式导航：一级入口用它承载，和普通按钮区分开（规格 §5.1）。 */
export function SegmentedNav({
  items,
  current,
  onSelect,
}: {
  items: Array<{ key: string; label: string; hint?: string }>
  current: string
  onSelect: (key: string) => void
}) {
  return (
    <nav
      aria-label="主导航"
      className="flex items-center gap-0.5 rounded-panel border border-line bg-canvas p-0.5"
    >
      {items.map((item) => {
        const active = item.key === current
        return (
          <button
            key={item.key}
            type="button"
            title={item.hint}
            aria-current={active ? 'page' : undefined}
            onClick={() => onSelect(item.key)}
            className={`rounded-control px-3 py-1 text-body transition-colors ${
              active
                ? 'bg-panel font-medium text-ink shadow-[0_1px_2px_oklch(0_0_0/0.18)]'
                : 'text-ink-muted hover:bg-hover hover:text-ink'
            }`}
          >
            {item.label}
          </button>
        )
      })}
    </nav>
  )
}

/** 工具栏右侧的统一状态区：把扫描 / 同步 / 数据源异常集中在一处（规格 §5.1）。 */
export function StatusArea({ children }: { children: ReactNode }) {
  return (
    <div aria-live="polite" className="flex items-center gap-2">
      {children}
    </div>
  )
}
