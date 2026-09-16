/**
 * 会话列表（中栏）。
 *
 * Phase 1 令牌化要点（规格 §3.2 / §6.1）：
 * - 标题提升到 13.5–14px，元数据统一 12px，不再出现 10.5px；
 * - 每行收敛为「标题 + 一行来源/项目/时间」两层，消息数与设备降到次级；
 * - 选中态用背景 + 焦点环 + 文字色，不只靠蓝点；
 * - 日期分组头吸附在列表视口顶部（absolute 行容器里 sticky 不生效，改用覆盖层实现）。
 */
import { useMemo } from 'react'

import { useVirtual } from '../../hooks/useVirtual'
import { dateGroupLabel, formatRelative, sourceLabel, syncStatusLabel } from '../../lib/format'
import { useLibrary } from '../../stores/library'
import type { SessionSummary } from '../../types/ipc'
import { Dot, EmptyState, StatusPill } from '../../components/ui'

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
      list.push({ type: 'session', session, index, group: lastGroup })
    })
    return list
  }, [sessions])

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

  return (
    <>
      <div className="flex h-12 shrink-0 items-center justify-between px-4">
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
        <div className="relative min-h-0 flex-1">
          <div ref={virtual.containerRef} className="h-full overflow-y-auto bg-panel">
            <div style={{ height: virtual.totalSize, position: 'relative' }}>
              {virtual.items.map((item) => {
                const row = rows[item.index]
                if (!row) return null
                return (
                  <div
                    key={`${item.index}`}
                    className={row.type === 'session' ? 'px-2 py-1' : ''}
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
                      <div className="flex h-[30px] items-center bg-panel px-4.5 text-meta font-medium text-ink-faint">
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
            <div className="pointer-events-none absolute inset-x-0 top-0 flex h-[30px] items-center border-b border-line/60 bg-panel px-4.5 text-meta font-medium text-ink-faint">
              {currentGroup}
            </div>
          ) : null}
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
 * 组件级重设计（批次 3）：
 * - 行是「物件」不是「表格行」：圆角、两侧内缩（容器 px-1.5），行间靠间距与背景区分；
 * - 选中态 = 填充表面 + 左侧 inset 强调条（box-shadow，文字不位移）；
 * - 状态徽标压缩为 sm 尺寸，只在需要时出现（部分解析 / 已归档 / 非本机同步态）。
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
      data-row="session"
      onClick={onClick}
      aria-current={active ? 'true' : undefined}
      className={`session-row flex h-full w-full flex-col justify-center gap-1 rounded-panel px-3.5 text-left ${
        active ? 'session-row-active' : ''
      }`}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate text-body font-medium text-ink">
          {session.title ?? '无标题'}
        </span>
        {session.partial ? (
          <StatusPill size="sm" tone="warning" title="存在未识别事件或损坏行">
            部分
          </StatusPill>
        ) : null}
        {session.archived ? (
          <StatusPill size="sm" tone="neutral">
            已归档
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
        <Dot tone={session.source === 'kimi' ? 'kimi' : 'codex'} />
        <span className="shrink-0">{sourceLabel(session.source)}</span>
        <span className="min-w-0 flex-1 truncate">{session.projectPath ?? '未知项目'}</span>
        <span className="ml-auto shrink-0 tabular-nums">
          {session.messageCount} 条 · {formatRelative(session.updatedAt)}
        </span>
      </div>
    </button>
  )
}

/* 组件画廊（?gallery）需要单独陈列这个页面级组件 */
export { SessionRow }
