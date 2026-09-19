/**
 * 全局导航 Rail（docs/DESIGN_AUDIT.md §4）。
 *
 * 它只回答一个问题：「我在产品的哪个区域」。会话上下文（来源 / 项目）是另一件事，
 * 由会话页的 SourcePane 负责——两者过去合并在一条 208px 竖条里，导致在搜索页、
 * 同步页、设置页也一直占着 208px 宽度和大部分高度，而其中的来源/项目列表
 * 对那三个页面毫无作用。
 *
 * 形态：
 * - 72px 宽，icon 在上、中文标签在下（不做纯 icon 导航——图标语义不足以独立承担）；
 * - active = 完整中性背景 + 较强文字 + font-semibold，**没有左侧铜条、没有阴影**；
 * - `aria-current="page"`；
 * - 跳转一律走 `requestPage`，保留设置页的未保存草稿拦截。
 */
import { useLibrary, type PageKey } from '../stores/library'
import { Icon, type IconName } from '../components/ui'
import { useT } from '../lib/i18n'

/** 一级入口（顺序即产品顺序，不要按字母或使用频率重排）。 */
const ITEMS: Array<{ key: PageKey; icon: IconName }> = [
  { key: 'conversations', icon: 'chat' },
  { key: 'search', icon: 'search' },
  { key: 'sync', icon: 'refresh' },
  { key: 'settings', icon: 'settings' },
]

export function AppNavRail({ variant = 'rail' }: { variant?: 'rail' | 'list' }) {
  const t = useT()
  const page = useLibrary((state) => state.page)

  // 窄窗口抽屉里换成横向行：72px 竖条在 240px 抽屉里会显得悬空
  if (variant === 'list') {
    return (
      <nav aria-label={t('nav.main')} className="flex flex-col gap-0.5">
        {ITEMS.map((item) => {
          const active = page === item.key
          return (
            <button
              key={item.key}
              type="button"
              aria-current={active ? 'page' : undefined}
              onClick={() => useLibrary.getState().requestPage(item.key)}
              className={`flex h-9 items-center gap-2.5 rounded-control px-2.5 text-left text-ui transition-colors ${
                active
                  ? 'bg-selected font-semibold text-ink'
                  : 'text-ink-muted hover:bg-hover hover:text-ink'
              }`}
            >
              <Icon name={item.icon} size={16} />
              <span className="min-w-0 flex-1 truncate">{t(`nav.${item.key}`)}</span>
            </button>
          )
        })}
      </nav>
    )
  }

  return (
    <nav aria-label={t('nav.main')} className="app-rail">
      {ITEMS.map((item) => {
        const active = page === item.key
        return (
          <button
            key={item.key}
            type="button"
            aria-current={active ? 'page' : undefined}
            onClick={() => useLibrary.getState().requestPage(item.key)}
            className={`rail-item ${active ? 'rail-item-active' : ''}`}
          >
            <Icon name={item.icon} size={16} />
            <span className="max-w-full truncate">{t(`nav.${item.key}`)}</span>
          </button>
        )
      })}
    </nav>
  )
}
