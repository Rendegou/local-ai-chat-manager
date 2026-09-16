/**
 * 会话页（规格 §5.2 / §6.1）：响应式三栏工作区。
 *
 * 三种布局：
 * - ≥1280px：来源/项目栏（224px）+ 会话列表（350px）+ 正文，三栏并排；
 * - 1024–1280px：来源栏收进抽屉（由工具栏「筛选」按钮唤出），列表 + 正文并排；
 * - <1024px：两级视图——先看列表，选中会话后进入正文，可返回列表。
 *
 * 关键约束（规格验收）：**任何断点都不能让筛选功能消失**。
 */
import { useEffect } from 'react'

import { useLibrary } from '../../stores/library'
import { useMinWidth } from '../../hooks/useMediaQuery'
import { Drawer, Icon, IconButton } from '../../components/ui'
import { ConversationViewer } from './ConversationViewer'
import { SessionList } from './SessionList'
import { SourceSidebar } from './SourceSidebar'

export function ConversationsPage() {
  const { page, selectedId, selectSession, sessions, filtersOpen, setFiltersOpen } = useLibrary()
  // 三栏并排 / 抽屉（lg 以上但不足 xl）/ 两级视图（lg 以下）
  const threeColumn = useMinWidth('xl')
  const listAndDetail = useMinWidth('lg')

  // 会话列表加载完成后自动选中第一条「有消息」的会话（仅宽窗口，窄窗口先进列表）
  useEffect(() => {
    if (page !== 'conversations' || selectedId || !listAndDetail) return
    const first = sessions.find((session) => session.messageCount > 0) ?? sessions[0]
    if (first) void selectSession(first.id)
  }, [page, selectedId, sessions, selectSession, listAndDetail])

  // 窄窗口下切换会话后自动隐藏抽屉，避免遮挡正文
  useEffect(() => {
    if (filtersOpen && !threeColumn) setFiltersOpen(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId])

  /** 两级视图：未选会话时只看列表。 */
  const showList = listAndDetail || !selectedId
  const showDetail = listAndDetail || Boolean(selectedId)

  return (
    <div className="workspace-grid flex min-h-0 min-w-0 flex-1 bg-canvas">
      {/* 来源/项目栏：宽窗口常驻，窄窗口变成抽屉 */}
      {threeColumn ? (
        <aside className="workspace-panel flex w-[232px] shrink-0 flex-col">
          <SourceSidebar />
        </aside>
      ) : filtersOpen ? (
        <Drawer title="筛选" onClose={() => setFiltersOpen(false)}>
          <SourceSidebar />
        </Drawer>
      ) : null}

      {/* 会话列表 */}
      {showList ? (
        <section className="workspace-panel flex w-[360px] shrink-0 flex-col max-lg:w-full">
          <SessionList />
        </section>
      ) : null}

      {/* 会话正文 */}
      {showDetail ? (
        <section className="workspace-panel reading-panel flex min-w-0 flex-1 flex-col">
          {/* 两级视图下提供「返回列表」 */}
          {!listAndDetail && selectedId ? (
            <div className="flex items-center gap-2 border-b border-line bg-panel px-3 py-1.5">
              <IconButton label="返回会话列表" size="sm" onClick={() => void selectSession(null)}>
                <Icon name="back" />
              </IconButton>
              <span className="text-meta text-ink-muted">返回列表</span>
            </div>
          ) : null}
          <ConversationViewer />
        </section>
      ) : null}
    </div>
  )
}
