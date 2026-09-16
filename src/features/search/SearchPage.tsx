/**
 * 搜索页（规格 §6.2）。
 *
 * Phase 1 令牌化要点：
 * - 关键词输入成为页面主控件（高度与字号提升、进入页面自动聚焦）；
 * - 筛选控件与结果卡片统一到新的字号 / 语义色；
 * - 结构（主搜索 + 同行筛选 + 结果列表）在 Phase 3 重组为「主搜索 + 高级筛选」。
 */
import { useState } from 'react'

import * as ipc from '../../lib/ipc'
import { formatDateTime, formatRelative, sourceLabel } from '../../lib/format'
import { useLibrary } from '../../stores/library'
import type { SearchResponse } from '../../types/ipc'
import {
  Button,
  EmptyState,
  Notice,
  PanelHeader,
  Select,
  Spinner,
  StatusPill,
  TextInput,
} from '../../components/ui'

/** 搜索页。 */
export function SearchPage() {
  const { machines, projects, setPage, selectSession } = useLibrary()
  const [text, setText] = useState('')
  const [source, setSource] = useState('')
  const [project, setProject] = useState('')
  const [machine, setMachine] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [messagesOnly, setMessagesOnly] = useState(false)
  const [order, setOrder] = useState<'relevance' | 'recent'>('relevance')
  const [response, setResponse] = useState<SearchResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  /** 执行搜索。 */
  const run = async (offset = 0) => {
    if (!text.trim()) {
      setResponse(null)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const result = await ipc.search({
        text,
        filter: {
          source: source || null,
          projectPath: project || null,
          machineId: machine || null,
          from: from ? `${from}T00:00:00Z` : null,
          to: to ? `${to}T23:59:59Z` : null,
          includeArchived: false,
        },
        order,
        messagesOnly,
        limit: 50,
        offset,
      })
      setResponse((previous) =>
        offset > 0 && previous ? { ...result, hits: [...previous.hits, ...result.hits] } : result,
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-canvas">
      <PanelHeader
        title="搜索"
        meta={
          response ? `${response.hits.length} 条结果 · ${response.tookMs} ms` : '全文搜索会话内容'
        }
        actions={
          <>
            <Select
              value={order}
              onChange={(event) => setOrder(event.target.value as 'relevance' | 'recent')}
              aria-label="结果排序"
              options={[
                { value: 'relevance', label: '相关度' },
                { value: 'recent', label: '时间' },
              ]}
            />
            <Button tone="primary" onClick={() => void run(0)} loading={loading}>
              搜索
            </Button>
          </>
        }
      />

      {/* 关键词 + 筛选 */}
      <div className="border-b border-line bg-panel px-3.5 py-2.5">
        <div className="flex items-center gap-2">
          <div className="min-w-[280px] flex-1">
            <TextInput
              value={text}
              onChange={(event) => setText(event.target.value)}
              onEnter={() => void run(0)}
              placeholder="搜索关键词，例如：lazy deletion / Redisson watchdog"
              aria-label="搜索关键词"
              autoFocus
              className="h-9 text-lead"
            />
          </div>
          <Select
            value={source}
            onChange={(event) => setSource(event.target.value)}
            aria-label="按数据源筛选"
            options={[
              { value: '', label: '全部数据源' },
              { value: 'codex', label: 'Codex' },
              { value: 'kimi', label: 'Kimi Code' },
            ]}
          />
          <Select
            value={project}
            onChange={(event) => setProject(event.target.value)}
            aria-label="按项目筛选"
            options={[
              { value: '', label: '全部项目' },
              ...projects.map((p) => ({ value: p.projectPath, label: p.name || p.projectPath })),
            ]}
          />
          <Select
            value={machine}
            onChange={(event) => setMachine(event.target.value)}
            aria-label="按设备筛选"
            options={[
              { value: '', label: '全部设备' },
              ...machines.map((m) => ({ value: m, label: m.slice(0, 8) })),
            ]}
          />
          <label className="flex items-center gap-1.5 text-meta text-ink-muted">
            <input
              type="checkbox"
              checked={messagesOnly}
              onChange={(event) => setMessagesOnly(event.target.checked)}
              className="h-4 w-4 accent-accent"
            />
            仅正文
          </label>
        </div>
        <div className="flex items-center gap-2 pt-2">
          <label className="text-meta text-ink-muted" htmlFor="search-from">
            起始日期
          </label>
          <input
            id="search-from"
            type="date"
            value={from}
            onChange={(event) => setFrom(event.target.value)}
            className="rounded-control border border-line bg-canvas px-2 py-1 text-meta text-ink"
          />
          <label className="text-meta text-ink-muted" htmlFor="search-to">
            结束日期
          </label>
          <input
            id="search-to"
            type="date"
            value={to}
            onChange={(event) => setTo(event.target.value)}
            className="rounded-control border border-line bg-canvas px-2 py-1 text-meta text-ink"
          />
        </div>
      </div>

      {/* 结果 */}
      <div className="min-h-0 flex-1 overflow-y-auto bg-reading">
        {error ? (
          <div className="p-3.5">
            <Notice tone="danger" title="搜索失败">
              {error}
            </Notice>
          </div>
        ) : null}
        {loading && !response ? (
          <div className="p-4">
            <Spinner label="搜索中…" />
          </div>
        ) : null}
        {response && response.hits.length === 0 ? (
          <EmptyState
            title="没有匹配结果"
            description={`FTS5 查询：${response.matchQuery}。可尝试减少关键词或放宽筛选条件。`}
          />
        ) : null}
        {response?.hits.map((hit) => (
          <button
            key={hit.messageId}
            type="button"
            onClick={() => {
              setPage('conversations')
              void selectSession(hit.sessionId)
            }}
            className="block w-full border-b border-line/60 px-3.5 py-2.5 text-left transition-colors hover:bg-hover"
          >
            <div className="flex items-center gap-2 text-meta text-ink-muted">
              <StatusPill tone={hit.source === 'kimi' ? 'kimi' : 'codex'}>
                {sourceLabel(hit.source)}
              </StatusPill>
              <span className="truncate text-ink">{hit.projectPath ?? '未知项目'}</span>
              <span className="truncate">{hit.title ?? hit.sessionId}</span>
              <span className="ml-auto shrink-0">{formatRelative(hit.sessionUpdatedAt)}</span>
            </div>
            {/* snippet 为后端生成的高亮片段（含 <mark>） */}
            <div
              className="pt-1 text-body leading-6 text-ink [&_mark]:rounded [&_mark]:bg-warning/30"
              dangerouslySetInnerHTML={{ __html: escapeExceptMark(hit.snippet) }}
            />
            <div className="pt-0.5 text-tech text-ink-muted">
              {hit.role} · #{hit.sequence} · {formatDateTime(hit.timestamp)}
            </div>
          </button>
        ))}
        {response?.hasMore ? (
          <div className="flex justify-center py-3">
            <Button
              tone="ghost"
              size="sm"
              onClick={() => void run(response.hits.length)}
              loading={loading}
            >
              {loading ? '加载中…' : '加载更多'}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  )
}

/**
 * 只允许后端生成的 `<mark>` 标签，其余 HTML 一律转义。
 *
 * 会话正文来自本地文件，可能包含任意 HTML/脚本，直接 innerHTML 会造成注入，
 * 因此这里先整体转义，再把转义后的 `&lt;mark&gt;` 还原。
 */
function escapeExceptMark(snippet: string): string {
  const escaped = snippet
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
  return escaped.replace(/&lt;mark&gt;/g, '<mark>').replace(/&lt;\/mark&gt;/g, '</mark>')
}
