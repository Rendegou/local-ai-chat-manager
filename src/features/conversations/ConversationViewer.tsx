/**
 * 会话阅读器（右栏）。
 *
 * Phase 1 令牌化要点（规格 §6.1 阅读器部分）：
 * - 正文成为视觉主轴：assistant 用 reading 表面，user 用轻微表面差异区分；
 * - 工具调用/结果改成 console-like 块（等宽 + 独立表面），与普通正文明确分层；
 * - 正文与元数据字号提升到 13.5px / 12px，时间与序号用 11px mono；
 * - 头部元数据不再全部挤在标题后面（主标题 + 一行 meta，其余进次级行）。
 *
 * 分页与定位：
 * - 双向自动翻页：接近底部/顶部时自动加载，没有手动「加载更多」按钮；
 * - 搜索跳转（store.locateMessage）用 get_messages_around 直接加载目标前后文窗口，
 *   滚动居中并短暂高亮；从窗口继续向上/向下滚动都能接着翻页；
 * - 测量缓存按消息 id 存（useVirtual 的 rowKey）：隐藏工具消息、顶部插入都不会错位。
 */
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import * as ipc from '../../lib/ipc'
import { formatDateTime, kindLabel, roleLabel, sourceLabel, sourceTextClass, syncStatusLabel } from '../../lib/format'
import { useVirtual } from '../../hooks/useVirtual'
import { useLibrary } from '../../stores/library'
import type { MessageRow } from '../../types/ipc'
import { Button, Dot, EmptyState, Icon, IconButton, PanelHeader, Skeleton, Spinner, StatusPill } from '../../components/ui'

/** 每次分页拉取的消息条数。 */
const PAGE_SIZE = 200
/** 单条消息超过该长度时折叠展示（索引侧已截断到 256KB）。 */
const COLLAPSE_THRESHOLD = 4000
/** 阅读宽度上限：过宽会显著降低长文可读性（规格 §5.2）。 */
const READING_MAX_WIDTH = 920

export function ConversationViewer() {
  const { selected, selectedId, locateMessage, setLocateMessage } = useLibrary()
  const [messages, setMessages] = useState<MessageRow[]>([])
  const [loading, setLoading] = useState(false) // 初始 / 窗口重载
  const [loadingMore, setLoadingMore] = useState(false) // 向下翻页
  const [loadingEarlier, setLoadingEarlier] = useState(false) // 向上翻页
  const [reachedEnd, setReachedEnd] = useState(false)
  const [reachedStart, setReachedStart] = useState(true)
  const [toolVisible, setToolVisible] = useState(true)
  const [highlightSeq, setHighlightSeq] = useState<number | null>(null)
  const pagingRef = useRef(false) // 分页请求互斥（任何方向同一时刻只跑一个）
  const loadGen = useRef(0) // 加载代数：会话切换后，旧请求的落地一律丢弃
  const locateGen = useRef(0) // 定位代数：会话切换后，旧定位的修正计时器作废
  const prependRef = useRef(false) // 下一次渲染是 prepend：渲染后按总高差补偿滚动
  const scrollerRef = useRef<HTMLDivElement | null>(null)

  // 会话切换时重置并加载首批（有搜索定位请求则直接加载目标前后文窗口）
  useEffect(() => {
    const gen = ++loadGen.current
    locateGen.current += 1
    pagingRef.current = false // 强制释放互斥锁：旧会话的在途请求由 gen 守卫丢弃
    setMessages([])
    setReachedEnd(false)
    setReachedStart(true)
    setHighlightSeq(null)
    if (!selectedId) return
    pagingRef.current = true
    setLoading(true)
    const target = useLibrary.getState().locateMessage
    const isWindow = Boolean(target && target.sessionId === selectedId)
    const request = isWindow
      ? ipc.getMessagesAround(selectedId, target!.sequence, PAGE_SIZE / 2, PAGE_SIZE / 2)
      : ipc.getMessages(selectedId, 0, PAGE_SIZE)
    void request
      .then((rows) => {
        if (loadGen.current !== gen) return
        setMessages(rows)
        setReachedStart(!isWindow || rows.length === 0 || rows[0].sequence <= 0)
        // 居中窗口在靠近会话开头时会因下界截断而少于 PAGE_SIZE + 1，
        // 返回条数不足不能证明已经到达末尾。先保持可继续向下加载，
        // loadMore 会用最后一条 sequence 做一次可靠的边界探测。
        setReachedEnd(isWindow ? rows.length === 0 : rows.length < PAGE_SIZE)
      })
      .finally(() => {
        if (loadGen.current === gen) {
          pagingRef.current = false
          setLoading(false)
        }
      })
  }, [selectedId])

  /** 向下翻页（接近末尾时自动触发）：按序列号区间取下一页，与初始加载方式无关。 */
  const loadMore = useCallback(() => {
    if (!selectedId || pagingRef.current || reachedEnd || messages.length === 0) return
    const lastSeq = messages[messages.length - 1].sequence
    pagingRef.current = true
    setLoadingMore(true)
    const gen = loadGen.current
    void ipc
      .getMessagesAround(selectedId, lastSeq, 0, PAGE_SIZE)
      .then((rows) => {
        if (loadGen.current !== gen) return
        const fresh = rows.filter((row) => row.sequence > lastSeq)
        if (fresh.length === 0) setReachedEnd(true)
        else setMessages((previous) => [...previous, ...fresh])
      })
      .finally(() => {
        if (loadGen.current === gen) {
          pagingRef.current = false
          setLoadingMore(false)
        }
      })
  }, [selectedId, messages, reachedEnd])

  /** 向上翻页（定位窗口场景下接近顶部时自动触发）。 */
  const loadEarlier = useCallback(() => {
    if (!selectedId || pagingRef.current || reachedStart || messages.length === 0) return
    const firstSeq = messages[0].sequence
    if (firstSeq <= 0) {
      setReachedStart(true)
      return
    }
    pagingRef.current = true
    setLoadingEarlier(true)
    const gen = loadGen.current
    void ipc
      .getMessagesAround(selectedId, firstSeq, PAGE_SIZE, 0)
      .then((rows) => {
        if (loadGen.current !== gen) return
        const fresh = rows.filter((row) => row.sequence < firstSeq)
        if (fresh.length === 0) {
          setReachedStart(true)
        } else {
          prependRef.current = true
          setMessages((previous) => [...fresh, ...previous])
        }
      })
      .finally(() => {
        if (loadGen.current === gen) {
          pagingRef.current = false
          setLoadingEarlier(false)
        }
      })
  }, [selectedId, messages, reachedStart])

  // 按开关过滤工具消息（默认显示，行为不变）
  const visible = useMemo(
    () =>
      toolVisible
        ? messages
        : messages.filter((m) => m.kind === 'message' || m.kind === 'reasoning_summary'),
    [messages, toolVisible],
  )

  // 测量缓存按消息 id 存：过滤切换 / 顶部插入时下标平移但高度不错位
  const visibleRef = useRef<MessageRow[]>(visible)
  visibleRef.current = visible
  const rowKey = useCallback((index: number) => visibleRef.current[index]?.id ?? index, [])

  const virtual = useVirtual({
    count: visible.length,
    // 估算高度贴近真实均值（消息头 + 两三行正文 + 间距），减少测量回填时的纠正幅度
    estimatedHeight: 132,
    overscan: 6,
    // 切换会话时丢弃旧会话的测量缓存，并回到顶部
    resetKey: selectedId,
    rowKey,
  })

  // 包一层容器 ref：useVirtual 拿滚动状态，这里 prepend 补偿要用同一个节点
  const containerRef = useCallback(
    (node: HTMLDivElement | null) => {
      scrollerRef.current = node
      virtual.containerRef(node)
    },
    [virtual.containerRef],
  )

  const scrollToIndexRef = useRef(virtual.scrollToIndex)
  scrollToIndexRef.current = virtual.scrollToIndex

  // prepend 后按总高差补偿滚动：上方新增的行不该把正在读的内容顶走。
  // 新行的估算误差由 RO 回填 + useVirtual 的 anchoring 继续修正（读实时 scrollTop）。
  const prevTotalRef = useRef(0)
  useLayoutEffect(() => {
    if (prependRef.current && scrollerRef.current) {
      const delta = virtual.totalSize - prevTotalRef.current
      if (delta > 0) scrollerRef.current.scrollTop += delta
      prependRef.current = false
    }
    prevTotalRef.current = virtual.totalSize
  }, [virtual.totalSize])

  // 接近末尾自动加载下一页（替代手动「加载更多」按钮）
  useEffect(() => {
    if (loading || loadingMore || reachedEnd || visible.length === 0) return
    if (virtual.visibleEnd >= visible.length - 10) loadMore()
  }, [virtual.visibleEnd, visible.length, loading, loadingMore, reachedEnd, loadMore])

  // 定位窗口场景：接近顶部自动补更早的消息
  useEffect(() => {
    if (loading || loadingEarlier || reachedStart || visible.length === 0) return
    if (virtual.visibleStart <= 8) loadEarlier()
  }, [virtual.visibleStart, visible.length, loading, loadingEarlier, reachedStart, loadEarlier])

  // 卸载时作废未完成的定位修正计时器
  useEffect(
    () => () => {
      locateGen.current += 1
    },
    [],
  )

  // 搜索定位：目标进入已加载范围后滚动居中 + 短暂高亮；
  // 同会话二次定位且目标不在范围内时，以目标为中心重载窗口。
  useEffect(() => {
    if (!locateMessage || locateMessage.sessionId !== selectedId) return
    // 用 pagingRef（实时 ref）而不是 loading（state）：挂载当批 effect 里 loading 还是旧值，
    // 会把「初始窗口加载在途」误判成「空会话」而提前清掉定位请求
    if (pagingRef.current) return
    if (messages.length === 0) {
      setLocateMessage(null)
      return
    }
    const target = locateMessage.sequence
    const first = messages[0].sequence
    const last = messages[messages.length - 1].sequence
    if (target < first || target > last) {
      if (pagingRef.current) return
      pagingRef.current = true
      setLoading(true)
      const gen = loadGen.current
      void ipc
        .getMessagesAround(selectedId, target, PAGE_SIZE / 2, PAGE_SIZE / 2)
        .then((rows) => {
          if (loadGen.current !== gen) return
          setMessages(rows)
          setReachedStart(rows.length === 0 || rows[0].sequence <= 0)
          // 同上：窗口总长度同时受前向下界与后向末尾影响，不能据此区分是哪一侧被截断。
          setReachedEnd(rows.length === 0)
        })
        .finally(() => {
          if (loadGen.current === gen) {
            pagingRef.current = false
            setLoading(false)
          }
        })
      return
    }
    // 目标可能被「隐藏工具消息」过滤掉：取序列号最近的后继
    let index = visible.findIndex((m) => m.sequence >= target)
    if (index === -1) index = visible.length - 1
    const sequence = visible[index]?.sequence ?? target
    setLocateMessage(null)
    scrollToIndexRef.current(index, 'center')
    // 周围行高陆续回填会改变偏移，两次修正确保最终居中
    const gen = ++locateGen.current
    for (const ms of [120, 400]) {
      window.setTimeout(() => {
        if (locateGen.current === gen) scrollToIndexRef.current(index, 'center')
      }, ms)
    }
    setHighlightSeq(sequence)
    window.setTimeout(() => {
      if (locateGen.current === gen) setHighlightSeq(null)
    }, 2400)
  }, [locateMessage, selectedId, loading, messages, visible, setLocateMessage])

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
            <span className={sourceTextClass(selected.source)}>
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

      <div className="relative min-h-0 flex-1">
        <div
          ref={containerRef}
          data-scroll-region="conversation-reader"
          className="h-full overflow-y-auto bg-reading-glow"
        >
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
              className="conversation-stream mx-auto px-5 py-5"
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
                    <MessageBlock message={message} located={message.sequence === highlightSeq} />
                  </div>
                )
              })}
            </div>
          )}
          {/* 底部：向下翻页进行中的指示；长会话加载完毕给一行安静的收尾 */}
          {loadingMore ? (
            <div className="flex justify-center py-3">
              <Spinner label="加载更多消息…" />
            </div>
          ) : null}
          {!loadingMore && reachedEnd && messages.length > PAGE_SIZE ? (
            <div className="py-3 text-center text-meta text-ink-faint">
              已加载全部 {messages.length} 条消息
            </div>
          ) : null}
        </div>
        {/* 向上翻页指示：浮在视口顶部不占文档流（占位的话出现/消失会把内容顶动） */}
        {loadingEarlier ? (
          <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex justify-center py-2">
            <Spinner label="加载更早的消息…" />
          </div>
        ) : null}
      </div>
    </>
  )
}

/**
 * 单条消息块 —— 消息流的三种「物件」（石墨工作台核心）：
 * - user：染色实体卡（msg-user），「人说的话」一眼可辨；
 * - assistant：开放正文，阅读主轴，无容器装饰，行高放宽到 1.75；
 * - reasoning：引文细线 + 斜体次要语气；
 * - tool_call / tool_result：内陷终端块（msg-term）——带头栏（工具名 / 类型 / 折叠），
 *   默认展开（不改变既有默认行为），点击头栏可折叠单块；
 * - event：弱化单行，不占消息卡高度。
 *
 * 每条消息头栏右置 hover 出现的「复制内容」按钮（键盘聚焦时同样可见）。
 *
 * memo：滚动会触发虚拟列表高频重渲染，消息对象引用不变时不重渲染正文块。
 */
const MessageBlock = memo(function MessageBlock({
  message,
  located = false,
}: {
  message: MessageRow
  /** 搜索定位的目标消息：短暂高亮闪一下（见 index.css .msg-located） */
  located?: boolean
}) {
  const [expanded, setExpanded] = useState(false)
  const [collapsed, setCollapsed] = useState(false)
  const [copied, setCopied] = useState(false)
  const text = message.text ?? ''
  const isLong = text.length > COLLAPSE_THRESHOLD
  const shown = isLong && !expanded ? text.slice(0, COLLAPSE_THRESHOLD) : text

  const isToolCall = message.kind === 'tool_call'
  const isTool = isToolCall || message.kind === 'tool_result'
  const isUser = message.role === 'user' && message.kind === 'message'
  const isReasoning = message.kind === 'reasoning_summary'

  const copyText = () => {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
    })
  }

  const copyButton = text ? (
    <IconButton
      label={copied ? '已复制' : '复制内容'}
      size="sm"
      onClick={copyText}
      className="opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
    >
      <Icon name={copied ? 'check' : 'copy'} size={12} />
    </IconButton>
  ) : null

  // 事件：一行弱字 + 色点，不进入消息节奏
  if (message.kind === 'event') {
    return (
      <div
        className={`my-2 flex items-baseline gap-2.5 px-1 text-meta text-ink-faint ${located ? 'msg-located' : ''}`}
      >
        <Dot className="translate-y-[-1px]" />
        <span className="min-w-0 flex-1 whitespace-pre-wrap [overflow-wrap:anywhere]">
          {text || kindLabel(message.kind)}
        </span>
        <MsgTime message={message} />
      </div>
    )
  }

  // `[overflow-wrap:anywhere]` 而不是 `break-words`：
  // 前者会参与固有最小宽度计算，长路径 / 长 JSON 才不会把整个阅读区撑宽（200% 缩放时尤其明显）
  const bodyClass = isTool
    ? 'px-3 py-2 font-mono text-meta leading-[1.65] text-ink whitespace-pre-wrap [overflow-wrap:anywhere]'
    : isReasoning
      ? 'pt-0.5 text-meta italic leading-6 text-ink-muted whitespace-pre-wrap [overflow-wrap:anywhere]'
      : 'pt-1 text-body leading-[1.75] text-ink whitespace-pre-wrap [overflow-wrap:anywhere]'

  // 工具块：头栏（折叠开关）+ 等宽内容区
  if (isTool) {
    return (
      <article className={`msg-term group my-2.5 ${located ? 'msg-located' : ''}`}>
        <div className={`flex items-center gap-1 pr-1.5 ${collapsed ? '' : 'border-b border-line/50'}`}>
          <button
            type="button"
            aria-expanded={!collapsed}
            onClick={() => setCollapsed((value) => !value)}
            className="flex min-w-0 flex-1 items-center gap-2 rounded-t-[inherit] px-3 py-1.5 text-left transition-colors hover:bg-hover/60"
          >
            <span aria-hidden="true" className="font-mono text-meta leading-none text-accent">
              {isToolCall ? '$' : '↵'}
            </span>
            {message.toolName ? (
              <span className="truncate font-mono text-meta font-medium text-ink">
                {message.toolName}
              </span>
            ) : null}
            <span className="shrink-0 text-meta text-ink-muted">{kindLabel(message.kind)}</span>
            <Icon
              name="chevron"
              size={11}
              className={`shrink-0 text-ink-faint transition-transform ${collapsed ? '-rotate-90' : ''}`}
            />
            <MsgTime message={message} />
          </button>
          {copyButton}
        </div>
        {collapsed ? null : text ? (
          <pre className={bodyClass}>{shown}</pre>
        ) : (
          <div className="px-3 py-2 text-meta text-ink-muted">（无文本内容）</div>
        )}
        {!collapsed && isLong ? (
          <button
            type="button"
            onClick={() => setExpanded((value) => !value)}
            className="mx-3 mb-2 text-meta text-accent hover:underline"
          >
            {expanded ? '收起' : `展开全部（${text.length} 字符）`}
          </button>
        ) : null}
      </article>
    )
  }

  const container = isUser
    ? 'msg-user my-4 px-4 py-3'
    : isReasoning
      ? 'msg-reason my-4 py-0.5'
      : 'message-assistant my-5'

  return (
    <article className={`group ${container} ${located ? 'msg-located' : ''}`}>
      <header className="msg-head">
        <span
          className={
            isUser
              ? 'font-semibold text-accent'
              : isReasoning
                ? 'text-ink-faint'
                : 'font-medium text-ink'
          }
        >
          {isReasoning ? kindLabel(message.kind) : roleLabel(message.role)}
        </span>
        {!isReasoning && message.kind !== 'message' ? (
          <span className="text-ink-muted">{kindLabel(message.kind)}</span>
        ) : null}
        {copyButton}
        <MsgTime message={message} />
      </header>
      {text ? (
        <pre className={bodyClass}>{shown}</pre>
      ) : (
        <div className="pt-0.5 text-meta text-ink-muted">（无文本内容）</div>
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
})

/** 序号 + 时间：tabular mono 右置，安静但可核对。 */
function MsgTime({ message }: { message: MessageRow }) {
  return (
    <span className="msg-time">
      <span title="消息序号">#{message.sequence}</span>
      {message.timestamp ? <span> · {formatDateTime(message.timestamp)}</span> : null}
    </span>
  )
}

/* 组件画廊（?gallery）需要单独陈列这个页面级组件 */
export { MessageBlock }
