/**
 * 会话查看器（右栏）：
 * - 消息按需分页加载（大会话不会整体进入前端内存，规格 §22）；
 * - 变高虚拟滚动，10 万条消息也只渲染可视区域；
 * - 工具调用 / 结果 / 推理摘要 / 事件分组折叠展示。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import * as ipc from '../../lib/ipc'
import { formatDateTime, kindLabel, roleLabel, sourceLabel, syncStatusLabel } from '../../lib/format'
import { useVirtual } from '../../hooks/useVirtual'
import { useLibrary } from '../../stores/library'
import type { MessageRow } from '../../types/ipc'
import { Badge, Button, EmptyState, PanelHeader, Spinner } from '../../components/ui'

/** 每次分页拉取的消息条数。 */
const PAGE_SIZE = 200
/** 单条消息超过该长度时折叠展示（索引侧已截断到 256KB）。 */
const COLLAPSE_THRESHOLD = 4000

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

  // 按开关过滤工具消息（默认显示）
  const visible = useMemo(
    () =>
      toolVisible
        ? messages
        : messages.filter((m) => m.kind === 'message' || m.kind === 'reasoning_summary'),
    [messages, toolVisible],
  )

  const virtual = useVirtual({
    count: visible.length,
    estimatedHeight: 92,
    overscan: 4,
  })

  if (!selected) {
    return (
      <>
        <PanelHeader title="会话内容" />
        <EmptyState
          title={selectedId ? '正在加载…' : '未选择会话'}
          description="从中间列表选择一个会话即可查看完整对话（原始文件始终只读）。"
        />
      </>
    )
  }

  const meta = [
    sourceLabel(selected.source),
    selected.projectPath ?? '未知项目',
    `${selected.messageCount} 条消息`,
    formatDateTime(selected.updatedAt),
    syncStatusLabel(selected.syncStatus),
  ].filter(Boolean)

  return (
    <>
      <PanelHeader
        title={selected.title ?? '无标题'}
        subtitle={meta.join(' · ')}
        actions={
          <>
            {selected.partial ? (
              <Badge tone="warn" title="存在未识别事件或损坏行，原始内容仍在原始文件中">
                部分事件暂未识别
              </Badge>
            ) : null}
            <Button
              variant={toolVisible ? 'default' : 'ghost'}
              title="显示或隐藏工具调用与结果"
              onClick={() => setToolVisible((value) => !value)}
            >
              {toolVisible ? '隐藏工具消息' : '显示工具消息'}
            </Button>
          </>
        }
      />

      <div ref={virtual.containerRef} className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {visible.length === 0 ? (
          loading ? (
            <Spinner label="加载消息…" />
          ) : (
            <EmptyState title="没有可展示的消息" description="该会话可能只包含遥测事件。" />
          )
        ) : (
          <div style={{ height: virtual.totalSize, position: 'relative' }}>
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
                  <MessageBubble message={message} />
                </div>
              )
            })}
          </div>
        )}
        {!reachedEnd && visible.length > 0 ? (
          <div className="flex justify-center py-3">
            <Button variant="ghost" onClick={loadMore} disabled={loading}>
              {loading ? '加载中…' : `加载更多（已 ${messages.length}/${selected.messageCount}）`}
            </Button>
          </div>
        ) : null}
      </div>
    </>
  )
}

/** 消息展示：按角色着色，长内容默认折叠。 */
function MessageBubble({ message }: { message: MessageRow }) {
  const [expanded, setExpanded] = useState(false)
  const text = message.text ?? ''
  const isLong = text.length > COLLAPSE_THRESHOLD
  const shown = isLong && !expanded ? text.slice(0, COLLAPSE_THRESHOLD) : text

  const roleTone: Record<string, string> = {
    user: 'border-l-accent-500 bg-accent-500/5',
    assistant: 'border-l-line',
    tool: 'border-l-amber-500/60 bg-amber-500/5',
    system: 'border-l-line bg-surface-sunken',
    developer: 'border-l-line',
    unknown: 'border-l-line',
  }

  return (
    <div
      className={`my-1.5 rounded-r border-l-2 px-3 py-2 ${
        roleTone[message.role] ?? 'border-l-line'
      }`}
    >
      <div className="flex items-center gap-2 pb-1 text-[10.5px] text-ink-faint">
        <span className="font-medium text-ink-muted">{roleLabel(message.role)}</span>
        {message.kind !== 'message' ? <span>{kindLabel(message.kind)}</span> : null}
        {message.toolName ? (
          <span className="font-mono text-[10.5px] text-ink-muted">{message.toolName}</span>
        ) : null}
        <span className="ml-auto">#{message.sequence}</span>
        {message.timestamp ? <span>{formatDateTime(message.timestamp)}</span> : null}
      </div>
      {text ? (
        <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words font-sans text-[12.5px] leading-6 text-ink">
          {shown}
          {isLong && !expanded ? '…' : ''}
        </pre>
      ) : (
        <div className="text-[12px] text-ink-faint">（无文本内容）</div>
      )}
      {isLong ? (
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="mt-1 text-[11px] text-accent-600 hover:underline dark:text-accent-400"
        >
          {expanded ? '收起' : `展开全部（${text.length} 字符）`}
        </button>
      ) : null}
    </div>
  )
}
