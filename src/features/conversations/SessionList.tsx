/**
 * 会话列表（中栏）：按日期分组 + 虚拟滚动（规格 §22：不渲染上万个 DOM 节点）。
 */
import { useMemo } from 'react'

import { useVirtual } from '../../hooks/useVirtual'
import { dateGroupLabel, formatRelative, sourceLabel, syncStatusLabel } from '../../lib/format'
import { useLibrary } from '../../stores/library'
import type { SessionSummary } from '../../types/ipc'
import { Badge, EmptyState, Spinner } from '../../components/ui'

/** 列表行：分组标题或会话行。 */
type Row =
  | { type: 'group'; label: string }
  | { type: 'session'; session: SessionSummary; index: number }

/** 行高：分组 26px，会话 58px。 */
const GROUP_HEIGHT = 26
const SESSION_HEIGHT = 58

export function SessionList() {
  const {
    sessions,
    total,
    loadingSessions,
    selectedId,
    selectSession,
    loadSessions,
    filter,
  } = useLibrary()

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
      list.push({ type: 'session', session, index })
    })
    return list
  }, [sessions])

  const virtual = useVirtual({
    count: rows.length,
    itemHeight: (index) => (rows[index]?.type === 'group' ? GROUP_HEIGHT : SESSION_HEIGHT),
    overscan: 8,
  })

  // 滚动接近底部时自动加载下一页（总数据可能上万个会话）
  const hasMore = sessions.length < total
  if (hasMore && virtual.visibleEnd > rows.length - 6 && !loadingSessions) {
    void loadSessions(true)
  }

  return (
    <>
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-line px-3">
        <div className="flex items-baseline gap-2">
          <span className="text-[12.5px] font-semibold">会话</span>
          <span className="text-[11.5px] text-ink-faint">
            {sessions.length}/{total}
          </span>
        </div>
        {loadingSessions ? <Spinner /> : null}
      </div>

      {rows.length === 0 ? (
        <EmptyState
          title="没有会话"
          description="点击顶部「扫描」发现本机 Codex / Kimi Code 会话；若未探测到目录，可在设置中手工指定。"
        />
      ) : (
        <div ref={virtual.containerRef} className="min-h-0 flex-1 overflow-y-auto">
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
                    <div className="flex h-[26px] items-center bg-surface px-3 text-[10.5px] font-semibold uppercase tracking-wide text-ink-faint">
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
      )}

      {filter.onlyArchived ? (
        <div className="border-t border-line px-3 py-1.5 text-[11px] text-ink-faint">
          正在查看已归档会话
        </div>
      ) : null}
    </>
  )
}

/** 单条会话：标题 + 元信息（数据源 / 项目 / 机器 / 时间）。 */
function SessionRow({
  session,
  active,
  onClick,
}: {
  session: SessionSummary
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex h-[58px] w-full flex-col justify-center gap-1 border-b border-line/60 px-3 text-left hover:bg-surface-sunken ${
        active ? 'bg-surface-sunken' : ''
      }`}
    >
      <div className="flex items-center gap-1.5">
        <span
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${active ? 'bg-accent-500' : 'bg-transparent'}`}
        />
        <span className="truncate text-[12.5px] font-medium text-ink">
          {session.title ?? '无标题'}
        </span>
        {session.partial ? <Badge tone="warn" title="存在未识别事件或损坏行">部分</Badge> : null}
        {session.archived ? <Badge tone="muted">已归档</Badge> : null}
      </div>
      <div className="flex items-center gap-2 pl-3 text-[11px] text-ink-faint">
        <span>{sourceLabel(session.source)}</span>
        <span className="truncate">{session.projectPath ?? '未知项目'}</span>
        <span className="ml-auto shrink-0">{formatRelative(session.updatedAt)}</span>
      </div>
      <div className="flex items-center gap-2 pl-3 text-[10.5px] text-ink-faint">
        <span>{session.messageCount} 条消息</span>
        <span>{syncStatusLabel(session.syncStatus)}</span>
        {session.machineId ? <span className="truncate">{session.machineId.slice(0, 8)}</span> : null}
      </div>
    </button>
  )
}
