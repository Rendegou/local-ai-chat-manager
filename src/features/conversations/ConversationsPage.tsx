/**
 * 会话页（规格 §19 Conversations）：
 * 左：数据源 + 项目筛选；中：会话列表（虚拟滚动）；右：会话内容（虚拟滚动 + 分页加载）。
 */
import { useEffect } from 'react'

import { useLibrary } from '../../stores/library'
import { ConversationViewer } from './ConversationViewer'
import { SessionList } from './SessionList'
import { SourceSidebar } from './SourceSidebar'

export function ConversationsPage() {
  const { page, selectedId, selectSession, sessions } = useLibrary()

  // 会话列表加载完成后自动选中第一条「有消息」的会话：
  // 优先展示有内容的会话（有些会话只有遥测事件，"0 条消息"，落在上面会看到空白页）
  useEffect(() => {
    if (page !== 'conversations' || selectedId) return
    const first = sessions.find((session) => session.messageCount > 0) ?? sessions[0]
    if (first) void selectSession(first.id)
  }, [page, selectedId, sessions, selectSession])

  return (
    <div className="flex min-h-0 flex-1">
      {/* 左侧：数据源 / 项目 */}
      <aside className="hidden w-56 shrink-0 flex-col border-r border-line bg-surface-sunken lg:flex">
        <SourceSidebar />
      </aside>
      {/* 中间：会话列表 */}
      <section className="flex w-[340px] shrink-0 flex-col border-r border-line">
        <SessionList />
      </section>
      {/* 右侧：会话内容 */}
      <section className="flex min-w-0 flex-1 flex-col">
        <ConversationViewer />
      </section>
    </div>
  )
}
