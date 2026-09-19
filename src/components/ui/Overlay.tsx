/**
 * 浮层基础（docs/DESIGN.md §7「Dialog / Drawer / Dropdown」）。
 *
 * Drawer、Quick Search、Source Manager 都建在它上面，因此键盘与屏幕阅读器契约只实现一次：
 *
 * - portal 挂载到 `document.body`：脱离祖先的 `overflow` 裁切与 flex 布局，
 *   抽屉不会再被内容区的滚动容器切掉；
 * - `role="dialog"` + `aria-modal="true"` + `aria-labelledby`/`aria-label`；
 * - 打开时记住触发器，关闭后把焦点还回去；
 * - `Tab` / `Shift+Tab` 圈定在浮层内部（此前 Tab 会跑到遮罩背后的标题栏按钮上，
 *   视觉上焦点消失，继续按还可能触发「扫描本地会话」）；
 * - `Escape` 关闭；
 * - 背景 `#root` 设为 `inert`（对 AT 隐藏、不可聚焦、不可点击）；
 * - 遮罩是 `aria-hidden` 的普通元素，不是可聚焦按钮——键盘用户的关闭方式是 Escape，
 *   这样 Tab 序列里只剩下真正的控件；
 * - `overscroll-behavior: contain`，滚到底不再带着背景一起滚；
 * - `prefers-reduced-motion` 下入场动画被全局规则压成瞬时。
 */
import { useEffect, useId, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

import { Icon } from './Icon'

/**
 * 可聚焦元素选择器。
 *
 * 注意 `button:not([disabled])` 也会匹配 `tabindex="-1"` 的按钮——Quick Search 的
 * 结果项正是这种（视觉可点、但 Tab 序列要跳过，用 ↑/↓ 移动）。若不显式排除，
 * 焦点圈定算出的「最后一个元素」会是这些不可 Tab 的项，于是「在最后一项按 Tab 要回卷」
 * 这条规则永远不会触发，焦点直接逃到浮层背后的页面上。
 */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]'

/** 面板内真正处于 Tab 序列、可见、可聚焦的元素。 */
function focusableWithin(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (node) =>
      node.getAttribute('tabindex') !== '-1' &&
      !node.hasAttribute('disabled') &&
      node.getClientRects().length > 0,
  )
}

export interface OverlayProps {
  open: boolean
  onClose: () => void
  /** 无障碍名称（没有可见标题时使用） */
  label?: string
  /** 无障碍名称来源元素 id（有可见标题时优先用它） */
  labelledBy?: string
  /** 遮罩层完整类名（含定位）。默认铺满视口 */
  backdropClassName?: string
  /** 定位容器完整类名（含定位）。默认居中 */
  positionClassName?: string
  /** 面板完整类名（圆角/尺寸由调用方给，基类只负责材质与动效） */
  panelClassName?: string
  /** 面板上标记 `data-overlay-autofocus` 的元素会优先获得焦点 */
  children: ReactNode
}

/** 浮层容器：遮罩 + 焦点圈定 + portal。 */
export function Overlay({
  open,
  onClose,
  label,
  labelledBy,
  backdropClassName = 'absolute inset-0 bg-canvas/70',
  positionClassName = 'pointer-events-none absolute inset-0 flex items-center justify-center p-4',
  panelClassName = 'rounded-panel',
  children,
}: OverlayProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  const restoreRef = useRef<HTMLElement | null>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    if (!open) return
    restoreRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null

    // 背景设为 inert：既挡住 Tab，也让屏幕阅读器读不到浮层背后的内容
    const root = document.getElementById('root')
    const rootHadInert = root?.hasAttribute('inert') ?? false
    if (root && 'inert' in HTMLElement.prototype) root.setAttribute('inert', '')

    const raf = requestAnimationFrame(() => {
      const node = panelRef.current
      if (!node) return
      // 默认聚焦浮层本身（tabIndex=-1）：抽屉里的第一个可聚焦元素通常是右上角的关闭按钮，
      // 一打开就把焦点丢到「关闭」上既不符合意图，也会画出一圈没有含义的焦点环。
      // 需要「打开即输入」的浮层（Quick Search）用 data-overlay-autofocus 显式声明。
      const preferred = node.querySelector<HTMLElement>('[data-overlay-autofocus]')
      const target = preferred ?? node
      target.focus({ preventScroll: true })
    })

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onCloseRef.current()
        return
      }
      if (event.key !== 'Tab') return
      const node = panelRef.current
      if (!node) return
      const items = focusableWithin(node)
      if (items.length === 0) {
        event.preventDefault()
        node.focus({ preventScroll: true })
        return
      }
      const first = items[0]
      const last = items[items.length - 1]
      const active = document.activeElement
      const inside = active instanceof HTMLElement && node.contains(active)
      if (event.shiftKey) {
        if (!inside || active === first) {
          event.preventDefault()
          last.focus()
        }
      } else if (!inside || active === last) {
        event.preventDefault()
        first.focus()
      }
    }

    // 捕获阶段：抢在页面自身的快捷键（如 Ctrl+K 开关）之前处理 Escape
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      cancelAnimationFrame(raf)
      document.removeEventListener('keydown', onKeyDown, true)
      if (root && !rootHadInert) root.removeAttribute('inert')
      const restore = restoreRef.current
      restoreRef.current = null
      if (restore && document.contains(restore)) restore.focus({ preventScroll: true })
    }
  }, [open])

  if (!open) return null

  return createPortal(
    <div className="fixed inset-0 z-50">
      {/* 遮罩：点击关闭。aria-hidden 让它不进 Tab 序列——键盘用户走 Escape */}
      <div aria-hidden="true" onClick={onClose} className={backdropClassName} />
      <div className={positionClassName}>
        <div
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-label={labelledBy ? undefined : label}
          aria-labelledby={labelledBy}
          tabIndex={-1}
          className={`pointer-events-auto flex min-h-0 flex-col overflow-hidden overscroll-contain border border-line bg-overlay shadow-overlay animate-pop motion-reduce:animate-none outline-none ${panelClassName}`}
        >
          {children}
        </div>
      </div>
    </div>,
    document.body,
  )
}

/** 浮层标题栏：左标题 + 可选副标题 + 右关闭；`id` 供 `aria-labelledby` 使用。 */
export function OverlayHeader({
  id,
  title,
  subtitle,
  onClose,
  closeLabel,
  actions,
}: {
  id: string
  title: ReactNode
  subtitle?: ReactNode
  onClose: () => void
  closeLabel: string
  actions?: ReactNode
}) {
  return (
    <header className="flex shrink-0 items-start gap-3 border-b border-line px-4 py-3">
      <div className="min-w-0 flex-1">
        <h2 id={id} className="text-section text-ink">
          {title}
        </h2>
        {subtitle ? <p className="pt-0.5 text-meta text-ink-muted">{subtitle}</p> : null}
      </div>
      {actions}
      <button
        type="button"
        onClick={onClose}
        aria-label={closeLabel}
        title={closeLabel}
        className="-mr-1 -mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-control text-ink-muted transition-colors hover:bg-hover hover:text-ink"
      >
        <Icon name="close" size={14} />
      </button>
    </header>
  )
}

/** 浮层标题 id：`${prefix}-${useId()}`，保证同页多个浮层不撞 id。 */
export function useOverlayTitle(prefix: string): string {
  return `${prefix}-${useId()}`
}
