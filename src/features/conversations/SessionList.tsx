/**
 * 会话列表（中栏）。
 *
 * 平坦工作台要点：
 * - 行是整列平铺的 list row：无圆角、无投影，行间 1px hairline（--line-subtle）；
 * - 选中态 = 整行中性背景 + 标题对比度提升（没有左侧铜条，见 docs/DESIGN.md §8）；
 * - 信息三级：标题 14/500 → 来源/项目/时间 12/400；
 * - 日期分组头吸附在列表视口顶部（absolute 行容器里 sticky 不生效，改用覆盖层实现）；
 * - 头部带标题过滤框（接线到后端 filter.text 的标题 LIKE 查询）与激活筛选指示。
 */
import { useEffect, useMemo, useState } from 'react'

import { useVirtual } from '../../hooks/useVirtual'
import { useMinWidth } from '../../hooks/useMediaQuery'
import { dateGroupLabel, describeFilter, formatRelative, sourceLabel, sourceTone, syncStatusLabel } from '../../lib/format'
import { useLanguage, useT } from '../../lib/i18n'
import { useLibrary } from '../../stores/library'
import type { SessionSummary } from '../../types/ipc'
import { Dot, EmptyState, Icon, StatusPill } from '../../components/ui'

/** 列表行：分组标题或会话行（会话行带上所属分组，供吸附头显示当前组）。 */
type Row =
  | { type: 'group'; label: string }
  | { type: 'session'; session: SessionSummary; index: number; group: string }

/** 同步状态 → 语义语气（仅用于「非仅本机」的会话）。 */
const SYNC_TONE: Record<string, 'success' | 'warning' | 'info' | 'neutral'> = {
  synced: 'success',
  modified: 'warning',
  remote: 'info',
  archived: 'neutral',
}

/** 行高：分组 30px（sticky 头），会话 68px（两层信息 + 行间呼吸）。 */
const GROUP_HEIGHT = 30
const SESSION_HEIGHT = 68

export function SessionList() {
  const t = useT()
  // 日期分组标题随语言变化，rows 的 memo 需要依赖它
  const language = useLanguage()
  const {
    sessions,
    total,
    loadingSessions,
    selectedId,
    selectSession,
    loadSessions,
    filter,
    setFilter,
    resetFilter,
    sourcePaneOpen,
    setSourcePaneOpen,
  } = useLibrary()
  /** 与 ConversationsPage 同一个断点：≥1280px 时上下文栏常驻，列表头不再需要入口 */
  const panePersistent = useMinWidth('xl')
  /** 标题过滤框的本地值：防抖 300ms 后写入 filter.text */
  const [query, setQuery] = useState(filter.text ?? '')

  // 扁平化：日期分组 + 会话行（虚拟列表只认一维下标）
  const rows = useMemo(() => {
    const list: Row[] = []
    let lastGroup = ''
    sessions.forEach((session, index) => {
      const label = dateGroupLabel(session.updatedAt ?? session.createdAt)
      if (label !== lastGroup) {
        list.push({ type: 'group', label })
        lastGroup = label
      }
      list.push({ type: 'session', session, index, group: lastGroup })
    })
    return list
  }, [sessions, language])

  const virtual = useVirtual({
    count: rows.length,
    itemHeight: (index) => (rows[index]?.type === 'group' ? GROUP_HEIGHT : SESSION_HEIGHT),
    overscan: 8,
  })

  // 吸附分组头：虚拟列表的行容器是 absolute 定位，`sticky` 在里面不生效——
  // 改为按第一个完整可见行推算当前分组，用覆盖层固定在列表视口顶部。
  const firstRow = rows[Math.min(virtual.visibleStart, rows.length - 1)]
  const currentGroup = !firstRow
    ? null
    : firstRow.type === 'group'
      ? firstRow.label
      : firstRow.group

  // 滚动接近底部时自动加载下一页（总数据可能上万个会话）
  const hasMore = sessions.length < total
  if (hasMore && virtual.visibleEnd > rows.length - 6 && !loadingSessions) {
    void loadSessions(true)
  }

  // 外部重置筛选（侧栏「全部会话」等）时同步清空过滤框
  useEffect(() => {
    setQuery(filter.text ?? '')
  }, [filter.text])

  // 防抖写入标题过滤（后端 listSessions 的 filter.text = 标题 LIKE）
  useEffect(() => {
    const handle = window.setTimeout(() => {
      const text = query.trim()
      if ((filter.text ?? '') !== text) setFilter({ text: text || null })
    }, 300)
    return () => window.clearTimeout(handle)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query])

  const filterSummary = describeFilter(filter)
  // 不依赖文案比较（i18n 下「全部会话」会变）：直接按筛选字段判断
  const filterActive = Boolean(
    filter.source || filter.projectPath || filter.onlyArchived || filter.from || filter.to,
  )

  return (
    <>
      <div className="shrink-0 border-b border-line-subtle">
        <div className="flex h-11 items-center justify-between gap-2 px-3">
          <div className="flex min-w-0 items-baseline gap-2">
            <h2 className="min-w-0 truncate text-section text-ink">{t('sessionList.title')}</h2>
            <span className="shrink-0 text-meta tabular-nums text-ink-faint">
              {sessions.length}/{total}
            </span>
          </div>
          {/* 来源与项目：≥1280px 时源栏常驻，这个入口就没有意义 */}
          {!panePersistent ? (
            <button
              type="button"
              aria-haspopup="dialog"
              aria-expanded={sourcePaneOpen}
              onClick={() => setSourcePaneOpen(true)}
              className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-control border border-line px-2 text-meta text-ink-muted transition-colors hover:border-line-strong hover:text-ink"
            >
              <Icon name="filter" size={12} />
              {t('sidebar.open')}
            </button>
          ) : null}
        </div>
        <div className="px-3 pb-2.5">
          <div className="field flex h-8 items-center gap-2 px-2.5">
            <Icon name="search" size={13} className="shrink-0 text-ink-faint" />
            <input
              type="text"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('sessionList.filterPlaceholder')}
              aria-label={t('sessionList.filterAria')}
              className="min-w-0 flex-1 bg-transparent text-ui text-ink outline-none placeholder:text-ink-faint"
            />
            {query ? (
              <button
                type="button"
                aria-label={t('sessionList.clearFilter')}
                onClick={() => setQuery('')}
                className="shrink-0 text-ink-faint transition-colors hover:text-ink"
              >
                <Icon name="close" size={12} />
              </button>
            ) : null}
          </div>
        </div>
        {filterActive ? (
          <div className="flex items-center gap-2 px-3 pb-2 text-meta text-ink-muted">
            <Icon name="filter" size={12} className="shrink-0 text-accent" />
            <span className="min-w-0 flex-1 truncate">{filterSummary}</span>
            <button
              type="button"
              onClick={resetFilter}
              className="shrink-0 text-accent transition-colors hover:underline"
            >
              {t('sessionList.clear')}
            </button>
          </div>
        ) : null}
      </div>

      {rows.length === 0 ? (
        <EmptyState
          title={t('sessionList.emptyTitle')}
          description={t('sessionList.emptyDescription')}
        />
      ) : (
        <div className="relative min-h-0 flex-1">
          <div ref={virtual.containerRef} className="h-full overflow-y-auto">
            <div style={{ height: virtual.totalSize, position: 'relative' }}>
              {virtual.items.map((item) => {
                const row = rows[item.index]
                if (!row) return null
                return (
                  <div
                    key={`${item.index}`}
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      right: 0,
                      transform: `translateY(${item.start}px)`,
                      height: item.size,
                    }}
                  >
                    {row.type === 'group' ? (
                      <div className="flex h-[30px] items-center px-4 text-micro font-medium uppercase tracking-[0.08em] text-ink-faint">
                        {row.label}
                      </div>
                    ) : (
                      <SessionRow
                        session={row.session}
                        active={selectedId === row.session.id}
                        onClick={() => void selectSession(row.session.id)}
                      />
                    )}
                  </div>
                )
              })}
            </div>
          </div>
          {/* 当前分组吸附头：与流内分组行同高同样式，覆盖在其上方；不拦截点击 */}
          {currentGroup ? (
            <div className="pointer-events-none absolute inset-x-0 top-0 flex h-[30px] items-center border-b border-line-subtle bg-panel px-4 text-micro font-medium uppercase tracking-[0.08em] text-ink-faint">
              {currentGroup}
            </div>
          ) : null}
        </div>
      )}

      {filter.onlyArchived ? (
        <div className="border-t border-line-subtle px-4 py-1.5 text-meta text-ink-muted">
          {t('sessionList.viewingArchived')}
        </div>
      ) : null}
    </>
  )
}

/**
 * 单条会话：两层信息——标题；来源 / 项目 / 时间与消息数。
 *
 * 平坦行：整列平铺、行间 hairline；选中 = 整行中性背景 + 标题对比度提升；
 * 状态徽标压缩为 sm 尺寸，只在需要时出现（部分解析 / 已归档 / 非本机同步态）。
 */
function SessionRow({
  session,
  active,
  onClick,
}: {
  session: SessionSummary
  active: boolean
  onClick: () => void
}) {
  const t = useT()
  return (
    <button
      type="button"
      data-row="session"
      onClick={onClick}
      aria-current={active ? 'true' : undefined}
      className={`session-row flex h-full w-full flex-col justify-center gap-1 px-4 text-left ${
        active ? 'session-row-active' : ''
      }`}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <span
          className={`session-row-title min-w-0 flex-1 truncate text-body ${
            active ? 'font-medium' : 'font-medium text-ink'
          }`}
        >
          {session.title ?? t('sessionList.untitled')}
        </span>
        {session.partial ? (
          <StatusPill size="sm" tone="warning" title={t('sessionList.partialTitle')}>
            {t('sessionList.partial')}
          </StatusPill>
        ) : null}
        {session.archived ? (
          <StatusPill size="sm" tone="neutral">
            {t('sessionList.archived')}
          </StatusPill>
        ) : null}
        {/* 只有「非仅本机」的会话才额外标注同步状态，避免每行都是噪声 */}
        {!session.archived && session.syncStatus !== 'local' ? (
          <StatusPill size="sm" tone={SYNC_TONE[session.syncStatus] ?? 'neutral'}>
            {syncStatusLabel(session.syncStatus)}
          </StatusPill>
        ) : null}
      </div>
      <div className="flex min-w-0 items-center gap-1.5 text-meta text-ink-muted">
        <Dot tone={sourceTone(session.source)} />
        <span className="shrink-0">{sourceLabel(session.source)}</span>
        <span className="min-w-0 flex-1 truncate">{session.projectPath ?? t('format.unknownProject')}</span>
        <span className="ml-auto shrink-0 tabular-nums text-ink-faint">
          {t('sessionList.rowMeta', { n: session.messageCount, time: formatRelative(session.updatedAt) })}
        </span>
      </div>
    </button>
  )
}

/* 组件画廊（?gallery）需要单独陈列这个页面级组件 */
export { SessionRow }
