/**
 * 媒体查询 Hook：用于三栏 / 抽屉 / 两级视图的断点切换（规格 §5.2）。
 *
 * 与纯 CSS 响应式的区别：这里需要把断点结果带进交互逻辑（是否渲染抽屉、是否显示返回按钮），
 * 所以用 JS 读取 matchMedia 而不是藏几个 `hidden lg:block`。
 */
import { useEffect, useState } from 'react'

/** 断点（与 Tailwind 默认一致，避免两套标准）。 */
export const BREAKPOINTS = {
  sm: 640,
  md: 768,
  lg: 1024,
  xl: 1280,
} as const

/** 是否满足某个最小宽度。 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window === 'undefined' ? false : window.matchMedia(query).matches,
  )

  useEffect(() => {
    const media = window.matchMedia(query)
    const listener = (event: MediaQueryListEvent) => setMatches(event.matches)
    setMatches(media.matches)
    media.addEventListener('change', listener)
    return () => media.removeEventListener('change', listener)
  }, [query])

  return matches
}

/** 是否达到某个断点宽度。 */
export function useMinWidth(breakpoint: keyof typeof BREAKPOINTS): boolean {
  return useMediaQuery(`(min-width: ${BREAKPOINTS[breakpoint]}px)`)
}
