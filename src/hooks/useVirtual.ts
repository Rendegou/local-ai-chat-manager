/**
 * 轻量虚拟列表（规格 §22：不在 React 里渲染 10 万个 DOM 节点）。
 *
 * 支持两种模式：
 * - 固定行高（会话列表）：只按滚动位置计算可视窗口；
 * - 变高行（消息列表）：对未测量过的行使用估算高度，渲染后用 ResizeObserver 回填真实高度。
 *
 * 只渲染「可视区 + overscan」，因此会话列表 1w+、消息列表 10w+ 都能保持 60fps。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

/** 虚拟列表参数。 */
export interface VirtualOptions {
  /** 条目总数 */
  count: number
  /**
   * 固定行高；传函数时按行返回不同高度（例如「分组标题 + 会话行」混合列表）。
   * 不传则进入变高模式：使用估算高度并在渲染后测量真实高度。
   */
  itemHeight?: number | ((index: number) => number)
  /** 变高模式的初始估算高度 */
  estimatedHeight?: number
  /** 上下各多渲染几行，减少快速滚动白屏 */
  overscan?: number
}

/** 单个条目的定位信息。 */
export interface VirtualItem {
  index: number
  start: number
  size: number
}

/** 虚拟列表返回值。 */
export interface VirtualResult {
  /**
   * 滚动容器 ref（挂到 overflow: auto 的元素上）。
   *
   * 用回调 ref 而不是 `useRef`：容器常常是「有数据后才渲染」的，
   * 用对象 ref 时首次挂载拿不到节点，监听器就永远不会装上（列表会一直空白）。
   */
  containerRef: (node: HTMLDivElement | null) => void
  /** 内容总高度 */
  totalSize: number
  /** 当前需要渲染的条目 */
  items: VirtualItem[]
  /** 变高模式：把测量函数挂到每个条目上 */
  measureRef: (index: number) => (node: HTMLElement | null) => void
  /** 滚动到指定下标 */
  scrollToIndex: (index: number, align?: 'start' | 'center') => void
  /** 当前可视起始下标（用于「滚动到底部加载更多」） */
  visibleEnd: number
}

/**
 * 变高虚拟列表实现。
 *
 * 高度缓存用 `Map<number, number>`；前缀和按需重算（仅在测量结果变化时），
 * 对已加载的几千条消息来说成本极低。
 */
export function useVirtual(options: VirtualOptions): VirtualResult {
  const { count, itemHeight, estimatedHeight = 96, overscan = 6 } = options
  const [container, setContainer] = useState<HTMLDivElement | null>(null)
  const containerRef = useCallback((node: HTMLDivElement | null) => setContainer(node), [])
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(0)
  // 测量到的高度（仅变高模式使用）
  const [heights, setHeights] = useState<Map<number, number>>(() => new Map())
  const observers = useRef<Map<number, ResizeObserver>>(new Map())

  /** 取第 index 行的高度（函数式高度或测量值）。 */
  const heightOf = useCallback(
    (index: number): number => {
      if (typeof itemHeight === 'function') return itemHeight(index)
      if (typeof itemHeight === 'number') return itemHeight
      return heights.get(index) ?? estimatedHeight
    },
    [itemHeight, heights, estimatedHeight],
  )

  // 监听滚动与容器尺寸（容器挂载 / 卸载时自动重建监听）
  useEffect(() => {
    if (!container) return
    const onScroll = () => setScrollTop(container.scrollTop)
    container.addEventListener('scroll', onScroll, { passive: true })
    const resize = new ResizeObserver(() => setViewportHeight(container.clientHeight))
    resize.observe(container)
    setViewportHeight(container.clientHeight)
    return () => {
      container.removeEventListener('scroll', onScroll)
      resize.disconnect()
    }
  }, [container])

  // 内容变化时清理过期测量（列表被替换 / 截断）
  useEffect(() => {
    setHeights((previous) => {
      if (previous.size === 0) return previous
      const next = new Map<number, number>()
      previous.forEach((value, key) => {
        if (key < count) next.set(key, value)
      })
      return next.size === previous.size ? previous : next
    })
  }, [count])

  /** 计算每个条目的起点与高度（前缀和）。 */
  const { offsets, totalSize } = useMemo(() => {
    const starts = new Float64Array(count + 1)
    let cursor = 0
    for (let index = 0; index < count; index += 1) {
      starts[index] = cursor
      cursor += heightOf(index)
    }
    starts[count] = cursor
    return { offsets: starts, totalSize: cursor }
  }, [count, heightOf])

  /** 二分查找第一个可见条目。 */
  const items = useMemo(() => {
    if (count === 0 || viewportHeight === 0) return []
    let low = 0
    let high = count - 1
    let first = 0
    while (low <= high) {
      const mid = (low + high) >> 1
      if (offsets[mid + 1] > scrollTop) {
        first = mid
        high = mid - 1
      } else {
        low = mid + 1
      }
    }
    const start = Math.max(0, first - overscan)
    const visible: VirtualItem[] = []
    const limit = scrollTop + viewportHeight
    for (let index = start; index < count; index += 1) {
      if (offsets[index] > limit && visible.length > 0) break
      visible.push({
        index,
        start: offsets[index],
        size: offsets[index + 1] - offsets[index],
      })
      if (offsets[index] > limit && index - start > overscan) break
    }
    // 尾部再补 overscan 行
    const lastIndex = visible.length > 0 ? visible[visible.length - 1].index : start
    for (let index = lastIndex + 1; index <= Math.min(count - 1, lastIndex + overscan); index += 1) {
      visible.push({ index, start: offsets[index], size: offsets[index + 1] - offsets[index] })
    }
    return visible
  }, [count, offsets, scrollTop, viewportHeight, overscan])

  /** 变高模式：测量真实高度并回填。 */
  const measureRef = useCallback(
    (index: number) => (node: HTMLElement | null) => {
      if (typeof itemHeight === 'number' || typeof itemHeight === 'function' || !node) return
      const existing = observers.current.get(index)
      if (existing) {
        existing.disconnect()
        observers.current.delete(index)
      }
      const observer = new ResizeObserver((entries) => {
        const height = entries[0]?.contentRect.height
        if (height == null) return
        setHeights((previous) => {
          if (Math.abs((previous.get(index) ?? -1) - height) < 1) return previous
          const next = new Map(previous)
          next.set(index, height)
          return next
        })
      })
      observer.observe(node)
      observers.current.set(index, observer)
    },
    [itemHeight],
  )

  // 卸载时断开所有观察者
  useEffect(() => {
    const map = observers.current
    return () => {
      map.forEach((observer) => observer.disconnect())
      map.clear()
    }
  }, [])

  /** 滚动到指定条目（搜索结果跳转 / 定位）。 */
  const scrollToIndex = useCallback(
    (index: number, align: 'start' | 'center' = 'start') => {
      if (!container || index < 0 || index >= count) return
      const top = offsets[index]
      const size = offsets[index + 1] - offsets[index]
      container.scrollTop = align === 'center' ? top - container.clientHeight / 2 + size / 2 : top
    },
    [container, count, offsets],
  )

  const visibleEnd = items.length > 0 ? items[items.length - 1].index : 0

  return { containerRef, totalSize, items, measureRef, scrollToIndex, visibleEnd }
}
