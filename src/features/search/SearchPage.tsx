/**
 * 搜索页（规格 §18、§19 Search）：FTS5 全文搜索 + 结构化筛选。
 *
 * 结果显示「项目 / 会话 + 匹配消息片段（上下文高亮）」，点击可跳转到该会话。
 */
import { useState } from 'react'

import * as ipc from '../../lib/ipc'
import { formatDateTime, formatRelative, sourceLabel } from '../../lib/format'
import { useLibrary } from '../../stores/library'
import type { SearchResponse } from '../../types/ipc'
import { Badge, Button, EmptyState, PanelHeader, Select, Spinner, TextInput } from '../../components/ui'

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
        offset > 0 && previous
          ? { ...result, hits: [...previous.hits, ...result.hits] }
          : result,
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PanelHeader
        title="搜索"
        subtitle={response ? `${response.hits.length} 条结果 · ${response.tookMs} ms` : '全文搜索会话内容'}
        actions={
          <>
            <Select
              value={order}
              onChange={(value) => setOrder(value as 'relevance' | 'recent')}
              options={[
                { value: 'relevance', label: '相关度' },
                { value: 'recent', label: '时间' },
              ]}
            />
            <Button variant="primary" onClick={() => void run(0)} disabled={loading}>
              搜索
            </Button>
          </>
        }
      />

      {/* 筛选区 */}
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
        <div className="min-w-[260px] flex-1">
          <TextInput
            value={text}
            onChange={setText}
            onEnter={() => void run(0)}
            placeholder="搜索关键词，例如：lazy deletion / Redisson watchdog"
            autoFocus
          />
        </div>
        <Select
          value={source}
          onChange={setSource}
          options={[
            { value: '', label: '全部数据源' },
            { value: 'codex', label: 'Codex' },
            { value: 'kimi', label: 'Kimi Code' },
          ]}
        />
        <Select
          value={project}
          onChange={setProject}
          options={[
            { value: '', label: '全部项目' },
            ...projects.map((p) => ({ value: p.projectPath, label: p.name || p.projectPath })),
          ]}
        />
        <Select
          value={machine}
          onChange={setMachine}
          options={[
            { value: '', label: '全部设备' },
            ...machines.map((m) => ({ value: m, label: m.slice(0, 8) })),
          ]}
        />
        <input
          type="date"
          value={from}
          onChange={(event) => setFrom(event.target.value)}
          className="rounded-md border border-line bg-surface px-2 py-1.5 text-[12px] text-ink"
          title="起始日期"
        />
        <input
          type="date"
          value={to}
          onChange={(event) => setTo(event.target.value)}
          className="rounded-md border border-line bg-surface px-2 py-1.5 text-[12px] text-ink"
          title="结束日期"
        />
        <label className="flex items-center gap-1.5 text-[11.5px] text-ink-muted">
          <input
            type="checkbox"
            checked={messagesOnly}
            onChange={(event) => setMessagesOnly(event.target.checked)}
            className="h-3.5 w-3.5 accent-accent-600"
          />
          仅正文
        </label>
      </div>

      {/* 结果区 */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {error ? <div className="p-4 text-[12px] text-red-500">{error}</div> : null}
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
            className="block w-full border-b border-line/60 px-3 py-2 text-left hover:bg-surface-sunken"
          >
            <div className="flex items-center gap-2 text-[11px] text-ink-faint">
              <Badge tone="accent">{sourceLabel(hit.source)}</Badge>
              <span className="truncate font-medium text-ink-muted">
                {hit.projectPath ?? '未知项目'}
              </span>
              <span className="truncate">{hit.title ?? hit.sessionId}</span>
              <span className="ml-auto shrink-0">{formatRelative(hit.sessionUpdatedAt)}</span>
            </div>
            {/* snippet 为后端生成的高亮片段（含 <mark>） */}
            <div
              className="pt-1 text-[12.5px] leading-6 text-ink [&_mark]:rounded [&_mark]:bg-accent-400/30"
              dangerouslySetInnerHTML={{ __html: escapeExceptMark(hit.snippet) }}
            />
            <div className="pt-0.5 text-[10.5px] text-ink-faint">
              {hit.role} · #{hit.sequence} · {formatDateTime(hit.timestamp)}
            </div>
          </button>
        ))}
        {response?.hasMore ? (
          <div className="flex justify-center py-3">
            <Button variant="ghost" onClick={() => void run(response.hits.length)} disabled={loading}>
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
