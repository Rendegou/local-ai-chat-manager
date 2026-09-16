/**
 * 会话阅读器（右栏）。
 *
 * Phase 1 令牌化要点（规格 §6.1 阅读器部分）：
 * - 正文成为视觉主轴：assistant 用 reading 表面，user 用轻微表面差异区分；
 * - 工具调用/结果改成 console-like 块（等宽 + 独立表面），与普通正文明确分层；
 * - 正文与元数据字号提升到 13.5px / 12px，时间与序号用 11px mono；
 * - 头部元数据不再全部挤在标题后面（主标题 + 一行 meta，其余进次级行）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import * as ipc from '../../lib/ipc'
import { formatDateTime, kindLabel, roleLabel, sourceLabel, syncStatusLabel } from '../../lib/format'
import { useVirtual } from '../../hooks/useVirtual'
import { useLibrary } from '../../stores/library'
import type { MessageRow } from '../../types/ipc'
import { Button, EmptyState, PanelHeader, Skeleton, StatusPill } from '../../components/ui'

/** 每次分页拉取的消息条数。 */
const PAGE_SIZE = 200
/** 单条消息超过该长度时折叠展示（索引侧已截断到 256KB）。 */
const COLLAPSE_THRESHOLD = 4000
/** 阅读宽度上限：过宽会显著降低长文可读性（规格 §5.2）。 */
const READING_MAX_WIDTH = 920

export function ConversationViewer() {
  const { selected, selectedId } = useLibrary()
  const [messages, setMessages] = useState<MessageRow[]>([])
  const [loading, setLoading] = useState(false)
  const [reachedEnd, setReachedEnd] = useState(false)
  const [toolVisible, setToolVisible] = useState(true)
  const loadingRef = useRef(false)

  // 会话切换时重置消息
  useEffect(() => {
    setMessages([])
    setReachedEnd(false)
    if (!selectedId) return
    let cancelled = false
    setLoading(true)
    loadingRef.current = true
    void ipc
      .getMessages(selectedId, 0, PAGE_SIZE)
      .then((rows) => {
        if (cancelled) return
        setMessages(rows)
        setReachedEnd(rows.length < PAGE_SIZE)
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false)
          loadingRef.current = false
        }
      })
    return () => {
      cancelled = true
    }
  }, [selectedId])

  /** 加载下一页（滚动到接近底部时触发）。 */
  const loadMore = useCallback(() => {
    if (!selectedId || loadingRef.current || reachedEnd) return
    loadingRef.current = true
    setLoading(true)
    void ipc
      .getMessages(selectedId, messages.length, PAGE_SIZE)
      .then((rows) => {
        setMessages((previous) => [...previous, ...rows])
        if (rows.length < PAGE_SIZE) setReachedEnd(true)
      })
      .finally(() => {
        setLoading(false)
        loadingRef.current = false
      })
  }, [selectedId, messages.length, reachedEnd])

  // 按开关过滤工具消息（默认显示，行为不变）
  const visible = useMemo(
    () =>
      toolVisible
        ? messages
        : messages.filter((m) => m.kind === 'message' || m.kind === 'reasoning_summary'),
    [messages, toolVisible],
  )

  const virtual = useVirtual({
    count: visible.length,
    estimatedHeight: 96,
    overscan: 4,
  })

  if (!selected) {
    return (
      <>
        <PanelHeader title="会话内容" />
        <div className="min-h-0 flex-1 overflow-hidden bg-reading">
          {selectedId ? (
            <div className="mx-auto max-w-[920px] px-5 py-4">
              <Skeleton lines={3} />
              <Skeleton className="w-3/4" lines={2} />
            </div>
          ) : (
            <EmptyState
              title="未选择会话"
              description="从中间列表选择一个会话即可查看完整对话（原始文件始终只读）。"
            />
          )}
        </div>
      </>
    )
  }

  return (
    <>
      <PanelHeader
        sticky
        title={selected.title ?? '无标题'}
        meta={
          <>
            <span className={selected.source === 'kimi' ? 'text-kimi' : 'text-codex'}>
              {sourceLabel(selected.source)}
            </span>
            <span className="px-1.5 text-ink-faint">·</span>
            <span className="text-tech">{selected.projectPath ?? '未知项目'}</span>
          </>
        }
        description={
          <span className="flex flex-wrap items-center gap-2">
            <span className="tabular-nums">{selected.messageCount} 条消息</span>
            <span className="text-ink-faint">·</span>
            <span>更新于 {formatDateTime(selected.updatedAt)}</span>
            <span className="text-ink-faint">·</span>
            <span>{syncStatusLabel(selected.syncStatus)}</span>
            {selected.partial ? (
              <StatusPill tone="warning" title="存在未识别事件或损坏行，原始内容仍在原始文件中">
                部分事件暂未识别
              </StatusPill>
            ) : null}
          </span>
        }
        actions={
          <Button
            tone={toolVisible ? 'secondary' : 'ghost'}
            size="sm"
            title="显示或隐藏工具调用与结果"
            aria-pressed={toolVisible}
            onClick={() => setToolVisible((value) => !value)}
          >
            {toolVisible ? '隐藏工具消息' : '显示工具消息'}
          </Button>
        }
      />

      <div ref={virtual.containerRef} className="min-h-0 flex-1 overflow-y-auto bg-reading">
        {visible.length === 0 ? (
          loading ? (
            <div className="mx-auto max-w-[920px] px-5 py-4">
              <Skeleton lines={4} />
            </div>
          ) : (
            <EmptyState title="没有可展示的消息" description="该会话可能只包含遥测事件。" />
          )
        ) : (
          <div
            className="mx-auto px-4 py-3"
            style={{ maxWidth: READING_MAX_WIDTH + 32, position: 'relative', height: virtual.totalSize }}
          >
            {virtual.items.map((item) => {
              const message = visible[item.index]
              if (!message) return null
              return (
                <div
                  key={message.id}
                  ref={virtual.measureRef(item.index)}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    right: 0,
                    transform: `translateY(${item.start}px)`,
                  }}
                >
                  <MessageBlock message={message} />
                </div>
              )
            })}
          </div>
        )}
        {!reachedEnd && visible.length > 0 ? (
          <div className="flex justify-center py-3">
            <Button tone="ghost" size="sm" onClick={loadMore} loading={loading}>
              {loading ? '加载中…' : `加载更多（已 ${messages.length}/${selected.messageCount}）`}
            </Button>
          </div>
        ) : null}
      </div>
    </>
  )
}

/**
 * 单条消息块。
 *
 * 视觉分工：
 * - user：轻微表面差异（accent 左条），表示「人说的话」；
 * - assistant 正文：阅读主轴，不加装饰；
 * - reasoning：次要语气 + 更小字号；
 * - tool_call / tool_result：console-like 块（等宽、独立表面、可横向滚动）；
 * - event：中性提示行。
 */
function MessageBlock({ message }: { message: MessageRow }) {
  const [expanded, setExpanded] = useState(false)
  const text = message.text ?? ''
  const isLong = text.length > COLLAPSE_THRESHOLD
  const shown = isLong && !expanded ? text.slice(0, COLLAPSE_THRESHOLD) : text

  const isTool = message.kind === 'tool_call' || message.kind === 'tool_result'
  const isUser = message.role === 'user'
  const isReasoning = message.kind === 'reasoning_summary'
  const isEvent = message.kind === 'event'

  // 容器语气
  const container = isTool
    ? 'border border-line bg-canvas/60'
    : isUser
      ? 'border-l-2 border-l-accent bg-accent/5'
      : isEvent
        ? 'border-l-2 border-l-line-strong bg-canvas/40'
        : 'border-l-2 border-l-transparent'

  // `[overflow-wrap:anywhere]` 而不是 `break-words`：
  // 前者会参与固有最小宽度计算，长路径 / 长 JSON 才不会把整个阅读区撑宽（200% 缩放时尤其明显）
  const bodyClass = isTool
    ? 'font-mono text-meta leading-5 whitespace-pre-wrap [overflow-wrap:anywhere]'
    : isReasoning
      ? 'text-meta italic leading-6 text-ink-muted whitespace-pre-wrap [overflow-wrap:anywhere]'
      : isEvent
        ? 'text-meta leading-6 text-ink-muted whitespace-pre-wrap [overflow-wrap:anywhere]'
        : 'text-body leading-6 whitespace-pre-wrap [overflow-wrap:anywhere]'

  return (
    <article className={`my-2 rounded-panel px-3 py-2 ${container}`}>
      <header className="flex items-center gap-2 pb-1 text-meta text-ink-muted">
        <span className="font-medium text-ink">{roleLabel(message.role)}</span>
        {message.kind !== 'message' ? <span>{kindLabel(message.kind)}</span> : null}
        {message.toolName ? <span className="text-tech text-ink">{message.toolName}</span> : null}
        <span className="ml-auto flex items-center gap-2 text-tech text-ink-muted">
          <span title="消息序号">#{message.sequence}</span>
          {message.timestamp ? <span>{formatDateTime(message.timestamp)}</span> : null}
        </span>
      </header>
      {text ? (
        <pre className={bodyClass}>{shown}</pre>
      ) : (
        <div className="text-meta text-ink-muted">（无文本内容）</div>
      )}
      {isLong ? (
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="mt-1 text-meta text-accent hover:underline"
        >
          {expanded ? '收起' : `展开全部（${text.length} 字符）`}
        </button>
      ) : null}
    </article>
  )
}
