/**
 * 溢出菜单：工具栏与页面里的「更多操作」（规格 §5.1）。
 *
 * 用 overlay 表面 + 阴影承载，符合「只有浮层才用阴影」的规则；
 * 支持 Esc 关闭、点击外部关闭、打开后聚焦第一项（键盘可用）。
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'

import { t, useT } from '../../lib/i18n'
import { IconButton } from './Button'
import { Icon } from './Icon'

/** 菜单项内联的一组互斥选项（语言 / 主题这类二三项选择）。 */
export interface MenuChoice {
  label: string
  value: string
  onSelect: () => void
}

/** 菜单项。 */
export interface MenuItem {
  label: string
  /** 有 `choices` 时不需要（那一项本身不是可点命令，而是一组选项） */
  onClick?: () => void
  /** 危险操作（如重建索引）单独标注 */
  tone?: 'default' | 'danger'
  disabled?: boolean
  /** 右侧补充说明 */
  hint?: string
  /**
   * 内联选项：渲染成一排 `menuitemradio`，而不是一条可点命令。
   *
   * 为什么放在菜单里而不是再开一个二级菜单：语言、主题是「改完立刻见效」的偏好，
   * 值得一个随时可达的入口；而多一层子菜单在只有 2–3 个选项时只是多一次点击。
   */
  choices?: MenuChoice[]
  /** 内联选项当前选中的值 */
  current?: string
}

/**
 * 更多操作菜单。
 *
 * `label` 必填：触发按钮是图标按钮，需要无障碍名称。
 */
export function Menu({
  label = t('menu.more'),
  items,
  glyph,
}: {
  label?: string
  items: MenuItem[]
  /** 自定义触发图标；默认是三点「更多」图标 */
  glyph?: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  // 打开时聚焦菜单里的第一个可聚焦项（命令或内联选项都算），
  // 关闭时不做额外处理（焦点留在触发按钮上）。
  // 用查询而不是给第一项挂 ref：菜单项的顺序会变，而且内联选项项不是同一种角色。
  useEffect(() => {
    if (!open) return
    panelRef.current
      ?.querySelector<HTMLElement>('[role="menuitem"], [role="menuitemradio"]')
      ?.focus()
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
        {glyph ?? <Icon name="more" />}
      </IconButton>
      {open ? (
        <div
          ref={panelRef}
          role="menu"
          aria-label={label}
          className="absolute right-0 top-[calc(100%+6px)] z-30 min-w-[228px] animate-pop rounded-panel border border-line bg-overlay p-1 shadow-overlay"
        >
          {items.map((item, index) => (
            <div key={item.label}>
              {/* 危险操作与普通操作之间加分隔线（防误触的物理分区） */}
              {item.tone === 'danger' && index > 0 && items[index - 1]?.tone !== 'danger' ? (
                <div aria-hidden="true" className="mx-1 my-1 border-t border-line" />
              ) : null}
              {item.choices?.length ? (
                // 内联互斥选项：role="group" 是 role="menu" 里合法的容器，
                // 每一项用 menuitemradio + aria-checked（菜单内单选的标准写法）
                <div role="group" aria-label={item.label} className="px-2.5 py-1.5">
                  <div className="pb-1 text-meta text-ink-muted">{item.label}</div>
                  <div className="flex gap-1">
                    {item.choices.map((choice) => {
                      const selected = choice.value === item.current
                      return (
                        <button
                          key={choice.value}
                          type="button"
                          role="menuitemradio"
                          aria-checked={selected}
                          disabled={item.disabled}
                          onClick={() => {
                            choice.onSelect()
                            setOpen(false)
                          }}
                          className={`h-6 min-w-0 flex-1 truncate rounded-chip px-1.5 text-meta transition-colors disabled:cursor-not-allowed disabled:opacity-55 ${
                            selected
                              ? 'bg-accent/14 font-medium text-accent'
                              : 'text-ink-muted hover:bg-hover hover:text-ink'
                          }`}
                        >
                          {choice.label}
                        </button>
                      )
                    })}
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  role="menuitem"
                  disabled={item.disabled}
                  onClick={() => {
                    setOpen(false)
                    item.onClick?.()
                  }}
                  className={`flex w-full items-center gap-3 rounded-control px-2.5 py-1.5 text-left text-ui transition-colors disabled:cursor-not-allowed disabled:opacity-55 ${
                    item.tone === 'danger'
                      ? 'text-danger hover:bg-danger/12'
                      : 'text-ink hover:bg-hover'
                  }`}
                >
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  {item.hint ? <span className="text-meta text-ink-muted">{item.hint}</span> : null}
                </button>
              )}
            </div>
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
  const t = useT()
  return (
    <nav
      aria-label={t('nav.main')}
      className="nav-track flex items-center gap-1"
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
            className={`nav-item ${active ? 'nav-item-active' : ''}`}
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
