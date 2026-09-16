/**
 * 会话列表（中栏）。
 *
 * Phase 1 令牌化要点（规格 §3.2 / §6.1）：
 * - 标题提升到 13.5–14px，元数据统一 12px，不再出现 10.5px；
 * - 每行收敛为「标题 + 一行来源/项目/时间」两层，消息数与设备降到次级；
 * - 选中态用背景 + 焦点环 + 文字色，不只靠蓝点；
 * - 日期分组标题改为 sticky，但降低装饰感。
 */
import { useMemo } from 'react'

import { useVirtual } from '../../hooks/useVirtual'
import { dateGroupLabel, formatRelative, sourceLabel, syncStatusLabel } from '../../lib/format'
import { useLibrary } from '../../stores/library'
import type { SessionSummary } from '../../types/ipc'
import { EmptyState, StatusPill } from '../../components/ui'

/** 列表行：分组标题或会话行。 */
type Row =
  | { type: 'group'; label: string }
  | { type: 'session'; session: SessionSummary; index: number }

/** 同步状态 → 语义语气（仅用于「非仅本机」的会话）。 */
const SYNC_TONE: Record<string, 'success' | 'warning' | 'info' | 'neutral'> = {
  synced: 'success',
  modified: 'warning',
  remote: 'info',
  archived: 'neutral',
}

/** 行高：分组 30px（sticky 头），会话 56px（两层信息）。 */
const GROUP_HEIGHT = 30
const SESSION_HEIGHT = 56

export function SessionList() {
  const { sessions, total, loadingSessions, selectedId, selectSession, loadSessions, filter } =
    useLibrary()

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
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-line bg-panel px-3.5">
        <div className="flex items-baseline gap-2">
          <span className="text-lead text-ink">会话</span>
          <span className="text-meta tabular-nums text-ink-muted">
            {sessions.length}/{total}
          </span>
        </div>
      </div>

      {rows.length === 0 ? (
        <EmptyState
          title="没有会话"
          description="点击顶部「扫描」发现本机 Codex / Kimi Code 会话；若未探测到目录，可在设置中手工指定。"
        />
      ) : (
        <div ref={virtual.containerRef} className="min-h-0 flex-1 overflow-y-auto bg-panel">
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
                    <div className="sticky top-0 flex h-[30px] items-center bg-panel px-3.5 text-meta font-semibold text-ink-muted">
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
        <div className="border-t border-line px-3.5 py-1.5 text-meta text-ink-muted">
          正在查看已归档会话
        </div>
      ) : null}
    </>
  )
}

/**
 * 单条会话：**两层信息**（规格 §6.1）——标题；来源 / 项目 / 时间。
 *
 * 消息数与设备压缩到第二行的右侧，避免每行堆三层小字。
 * 选中态同时给出背景、左侧强调条与文字颜色，色盲与灰度下也能分辨。
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
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'true' : undefined}
      className={`flex h-[56px] w-full flex-col justify-center gap-1 border-b border-line/60 px-3.5 text-left transition-colors ${
        active ? 'bg-selected' : 'hover:bg-hover'
      }`}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <span
          aria-hidden="true"
          className={`h-3.5 w-0.5 shrink-0 rounded-full ${active ? 'bg-accent' : 'bg-transparent'}`}
        />
        <span className="min-w-0 flex-1 truncate text-body font-medium text-ink">
          {session.title ?? '无标题'}
        </span>
        {session.partial ? (
          <StatusPill tone="warning" title="存在未识别事件或损坏行">
            部分
          </StatusPill>
        ) : null}
        {session.archived ? <StatusPill tone="neutral">已归档</StatusPill> : null}
        {/* 只有「非仅本机」的会话才额外标注同步状态，避免每行都是噪声 */}
        {!session.archived && session.syncStatus !== 'local' ? (
          <StatusPill tone={SYNC_TONE[session.syncStatus] ?? 'neutral'}>
            {syncStatusLabel(session.syncStatus)}
          </StatusPill>
        ) : null}
      </div>
      <div className="flex min-w-0 items-center gap-2 pl-2 text-meta text-ink-muted">
        <span className={`shrink-0 ${session.source === 'kimi' ? 'text-kimi' : 'text-codex'}`}>
          {sourceLabel(session.source)}
        </span>
        <span className="min-w-0 flex-1 truncate">{session.projectPath ?? '未知项目'}</span>
        <span className="ml-auto shrink-0 tabular-nums">
          {session.messageCount} 条 · {formatRelative(session.updatedAt)}
        </span>
      </div>
    </button>
  )
}
