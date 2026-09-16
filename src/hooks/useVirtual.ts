/**
 * 轻量虚拟列表（规格 §22：不在 React 里渲染 10 万个 DOM 节点）。
 *
 * 支持两种模式：
 * - 固定行高（会话列表）：只按滚动位置计算可视窗口；
 * - 变高行（消息列表）：对未测量过的行使用估算高度，渲染后用 ResizeObserver 回填真实高度。
 *
 * 只渲染「可视区 + overscan」，因此会话列表 1w+、消息列表 10w+ 都能保持 60fps。
 *
 * 变高模式的滚动稳定性（否则阅读器滚动时会「抽搐」）：
 * - 所有行共用一个 ResizeObserver，回调成批处理（不再每行每次渲染都断开/重建观察者）；
 * - 回填高度时，若该行整体位于视口上方，按高度差同步修正 scrollTop（scroll anchoring），
 *   视口内内容保持不动——向上翻、向下滚都不跳。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

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
  /**
   * 内容身份（如会话 id）：变化时丢弃全部测量缓存。
   * 不丢弃的话，旧内容的高度会错配到新内容的同一下标上，
   * 表现就是切换会话后消息流先错一下再逐块纠正。
   */
  resetKey?: unknown
  /**
   * 行标识（如消息 id）：提供后测量缓存按标识而不是下标存储。
   * 下标会因过滤切换 / 顶部插入（prepend）而平移，标识不会——
   * 这两个场景下按下标缓存的高度会整体错位，必须按标识。
   * 注意：提供 rowKey 后不再按 count 裁剪缓存（身份清理由 resetKey 负责）。
   */
  rowKey?: (index: number) => string | number
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
  /** 第一个完整可见条目的下标（不含 overscan；用于「滚动到顶部加载更早」与 sticky 分组头） */
  visibleStart: number
}

/**
 * 变高虚拟列表实现。
 *
 * 高度缓存用 `Map<number, number>`；前缀和按需重算（仅在测量结果变化时），
 * 对已加载的几千条消息来说成本极低。
 */
export function useVirtual(options: VirtualOptions): VirtualResult {
  const { count, itemHeight, estimatedHeight = 96, overscan = 6, resetKey, rowKey } = options
  const [container, setContainer] = useState<HTMLDivElement | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(0)
  // 测量到的高度（仅变高模式使用）；heightsRef 是同一份数据的同步镜像，供观察者回调读取。
  // 键：默认是下标；提供 rowKey 时是行标识（下标会因过滤/prepend 平移，标识不会）。
  const [heights, setHeights] = useState<Map<string | number, number>>(() => new Map())
  const heightsRef = useRef<Map<string | number, number>>(new Map())
  // 单个共用 ResizeObserver + 行 ↔ 节点双向映射（回调里靠它找回行号）
  const observerRef = useRef<ResizeObserver | null>(null)
  const nodeOfIndex = useRef(new Map<number, HTMLElement>())
  const indexOfNode = useRef(new Map<HTMLElement, number>())
  const refCallbacks = useRef(new Map<number, (node: HTMLElement | null) => void>())
  const containerElRef = useRef<HTMLDivElement | null>(null)
  const scrollTopRef = useRef(0)
  const offsetsRef = useRef<Float64Array>(new Float64Array(0))
  const estimatedHeightRef = useRef(estimatedHeight)
  estimatedHeightRef.current = estimatedHeight
  const rowKeyRef = useRef(rowKey)
  rowKeyRef.current = rowKey

  const containerRef = useCallback((node: HTMLDivElement | null) => {
    containerElRef.current = node
    setContainer(node)
  }, [])

  /** 第 index 行的缓存键。 */
  const keyOf = useCallback(
    (index: number): string | number => rowKeyRef.current?.(index) ?? index,
    [],
  )

  /** 取第 index 行的高度（函数式高度或测量值）。 */
  const heightOf = useCallback(
    (index: number): number => {
      if (typeof itemHeight === 'function') return itemHeight(index)
      if (typeof itemHeight === 'number') return itemHeight
      return heights.get(keyOf(index)) ?? estimatedHeight
    },
    [itemHeight, heights, estimatedHeight, keyOf],
  )

  // 监听滚动与容器尺寸（容器挂载 / 卸载时自动重建监听）
  useEffect(() => {
    if (!container) return
    const onScroll = () => {
      scrollTopRef.current = container.scrollTop
      setScrollTop(container.scrollTop)
    }
    container.addEventListener('scroll', onScroll, { passive: true })
    const resize = new ResizeObserver(() => setViewportHeight(container.clientHeight))
    resize.observe(container)
    setViewportHeight(container.clientHeight)
    scrollTopRef.current = container.scrollTop
    return () => {
      container.removeEventListener('scroll', onScroll)
      resize.disconnect()
    }
  }, [container])

  // 内容身份变化（切换会话）：丢弃旧测量缓存。
  // 用 layout effect：必须赶在 ResizeObserver 回调（布局后、绘制前）之前清空，
  // 否则旧高度与新测量会混在一起。
  useLayoutEffect(() => {
    heightsRef.current = new Map()
    setHeights(new Map())
  }, [resetKey])

  // 内容变化时清理过期测量（列表被替换 / 截断）。
  // 提供 rowKey 时跳过：键与下标无关，过滤/prepend 都不构成「过期」，清理由 resetKey 负责。
  useLayoutEffect(() => {
    if (rowKey) return
    const previous = heightsRef.current
    if (previous.size === 0) return
    let dirty = false
    const next = new Map<string | number, number>()
    previous.forEach((value, key) => {
      if (typeof key === 'number' && key < count) next.set(key, value)
      else dirty = true
    })
    if (dirty) {
      heightsRef.current = next
      setHeights(new Map(next))
    }
  }, [count, rowKey])

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

  // 观察者回调读取的是 ref 镜像，渲染提交后立刻同步（同样在 RO 回调之前）
  useLayoutEffect(() => {
    offsetsRef.current = offsets
  }, [offsets])

  /** 成批处理测量结果；视口上方的行高变化按差值修正 scrollTop，保持阅读位置不动。 */
  const handleMeasurements = useCallback(
    (entries: ResizeObserverEntry[]) => {
      let deltaAbove = 0
      let changed = false
      for (const entry of entries) {
        const node = entry.target as HTMLElement
        const index = indexOfNode.current.get(node)
        if (index == null) continue
        const height = entry.contentRect.height
        const key = keyOf(index)
        const previous = heightsRef.current.get(key) ?? estimatedHeightRef.current
        if (Math.abs(previous - height) < 1) continue
        heightsRef.current.set(key, height)
        changed = true
        // 该行整体位于视口上方：它变高/变矮会把视口内容往下顶/往上拉。
        // 读 DOM 上的实时 scrollTop 而不是 ref：prepend 补偿等布局效应刚改过
        // scrollTop 时，scroll 事件还没送达，ref 是旧值，锚定判断会漏算。
        const starts = offsetsRef.current
        const liveScrollTop = containerElRef.current?.scrollTop ?? scrollTopRef.current
        if (index < starts.length && starts[index] + previous <= liveScrollTop + 1) {
          deltaAbove += height - previous
        }
      }
      if (!changed) return
      const scroller = containerElRef.current
      if (scroller && deltaAbove !== 0) {
        const next = scroller.scrollTop + deltaAbove
        scroller.scrollTop = next
        scrollTopRef.current = next
        setScrollTop(next)
      }
      setHeights(new Map(heightsRef.current))
    },
    [keyOf],
  )

  /** 变高模式：每个条目一个（缓存的）ref 回调，挂到共用观察者上。 */
  const measureRef = useCallback(
    (index: number) => {
      if (typeof itemHeight === 'number' || typeof itemHeight === 'function') return () => {}
      let callback = refCallbacks.current.get(index)
      if (!callback) {
        callback = (node: HTMLElement | null) => {
          const oldNode = nodeOfIndex.current.get(index)
          if (oldNode && oldNode !== node) {
            observerRef.current?.unobserve(oldNode)
            indexOfNode.current.delete(oldNode)
            nodeOfIndex.current.delete(index)
          }
          if (node) {
            if (!observerRef.current) {
              observerRef.current = new ResizeObserver(handleMeasurements)
            }
            nodeOfIndex.current.set(index, node)
            indexOfNode.current.set(node, index)
            observerRef.current.observe(node)
          }
        }
        refCallbacks.current.set(index, callback)
      }
      return callback
    },
    [itemHeight, handleMeasurements],
  )

  // 卸载时断开观察者并清空映射
  useEffect(() => {
    return () => {
      observerRef.current?.disconnect()
      observerRef.current = null
      nodeOfIndex.current.clear()
      indexOfNode.current.clear()
    }
  }, [])

  /** 二分查找第一个可见条目。 */
  const { items, firstVisible } = useMemo(() => {
    if (count === 0 || viewportHeight === 0) return { items: [] as VirtualItem[], firstVisible: 0 }
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
    return { items: visible, firstVisible: first }
  }, [count, offsets, scrollTop, viewportHeight, overscan])

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

  return { containerRef, totalSize, items, measureRef, scrollToIndex, visibleEnd, visibleStart: firstVisible }
}
