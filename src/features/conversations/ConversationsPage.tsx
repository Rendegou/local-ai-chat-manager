/**
 * 会话页（工作区主视图）：会话上下文栏 + 会话列表 + 正文。
 *
 * 布局：
 * - `≥1280px`：SourcePane（208px，常驻）+ 会话列表（336px）+ 正文；
 * - `768–1279px`：会话列表 + 正文；SourcePane 由列表头的「来源与项目」按钮打开抽屉；
 * - `<768px`：两级视图——先看列表，选中会话后进入正文，可返回列表。
 *
 * 关键约束（规格验收）：**任何断点都不能让筛选功能消失**——窄窗口下来源/项目抽屉
 * 由会话列表头部的按钮唤出，全局导航则由标题栏的导航按钮唤出，两者互不干扰。
 */
import { useEffect } from 'react'

import { useLibrary } from '../../stores/library'
import { useMinWidth } from '../../hooks/useMediaQuery'
import { Drawer, Icon, IconButton } from '../../components/ui'
import { useT } from '../../lib/i18n'
import { ConversationViewer } from './ConversationViewer'
import { SessionList } from './SessionList'
import { SourcePane } from './SourcePane'

export function ConversationsPage() {
  const t = useT()
  const { selectedId, selectSession, sessions, sourcePaneOpen, setSourcePaneOpen } = useLibrary()
  const listAndDetail = useMinWidth('lg')
  // ≥1280px 才让上下文栏常驻；以下用抽屉，避免把列表和正文压得过窄
  const panePersistent = useMinWidth('xl')

  // 会话列表加载完成后自动选中第一条「有消息」的会话（仅宽窗口，窄窗口先进列表）
  useEffect(() => {
    if (selectedId || !listAndDetail) return
    const first = sessions.find((session) => session.messageCount > 0) ?? sessions[0]
    if (first) void selectSession(first.id)
  }, [selectedId, sessions, selectSession, listAndDetail])

  // 窄窗口下切换会话后自动收起上下文抽屉，避免遮挡正文
  useEffect(() => {
    setSourcePaneOpen(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId])

  /** 两级视图：未选会话时只看列表。 */
  const showList = listAndDetail || !selectedId
  const showDetail = listAndDetail || Boolean(selectedId)

  return (
    <div className="flex min-h-0 min-w-0 flex-1 bg-canvas">
      {/*
       * 会话页的一级标题：视觉上由「会话列表」栏头承担，但窄窗口两级视图下
       * 列表会被正文替换掉，页面就会失去 h1。这里固定放一个屏幕阅读器可见的 h1，
       * 保证任何断点下页面都有且只有一个一级标题。
       */}
      <h1 className="sr-only">{t('nav.conversations')}</h1>

      {/* 会话上下文（来源 / 项目）：只在会话页存在，进入其他页面就完全消失 */}
      {panePersistent ? (
        <aside className="app-source-pane flex w-[var(--app-source-pane-w)] shrink-0 flex-col">
          <SourcePane />
        </aside>
      ) : null}

      {/* 会话列表 */}
      {showList ? (
        <section className="flex w-[336px] shrink-0 flex-col border-r border-line bg-panel max-lg:w-full max-lg:border-r-0">
          <SessionList />
        </section>
      ) : null}

      {/* 会话正文 */}
      {showDetail ? (
        <section className="reading-panel flex min-w-0 flex-1 flex-col">
          {/* 两级视图下提供「返回列表」 */}
          {!listAndDetail && selectedId ? (
            <div className="flex items-center gap-2 border-b border-line px-3 py-1.5">
              <IconButton label={t('sessionList.backAria')} size="sm" onClick={() => void selectSession(null)}>
                <Icon name="back" />
              </IconButton>
              <span className="text-meta text-ink-muted">{t('sessionList.back')}</span>
            </div>
          ) : null}
          <ConversationViewer />
        </section>
      ) : null}

      {/* 窄窗口的上下文抽屉：与全局导航抽屉是两套独立状态 */}
      {!panePersistent && sourcePaneOpen ? (
        <Drawer
          title={t('sidebar.title')}
          onClose={() => setSourcePaneOpen(false)}
          widthClass="w-[264px]"
        >
          <SourcePane />
        </Drawer>
      ) : null}
    </div>
  )
}
