/**
 * 搜索页（规格 §6.2）。
 *
 * 首屏只保留四个决策点：关键词、搜索、排序、（已启用的）筛选 chips。
 * 来源 / 项目 / 设备 / 日期 / 仅正文进入「高级筛选」，功能一个不少但不抢注意力。
 *
 * 验收：搜索首屏不再同时出现 8 个同权重控件；结果返回后保留查询与筛选状态。
 */
import { useMemo, useState } from 'react'

import * as ipc from '../../lib/ipc'
import { baseName, formatDateTime, formatRelative, sourceLabel } from '../../lib/format'
import { useLibrary } from '../../stores/library'
import type { SearchResponse, SessionFilter } from '../../types/ipc'
import {
  Button,
  Chip,
  DateInput,
  EmptyState,
  Icon,
  Notice,
  PanelHeader,
  Select,
  Spinner,
  StatusPill,
  TextInput,
  Toggle,
} from '../../components/ui'

/** 搜索页。 */
export function SearchPage() {
  const { machines, projects, setPage, selectSession } = useLibrary()
  const [text, setText] = useState('')
  const [order, setOrder] = useState<'relevance' | 'recent'>('relevance')
  // 高级筛选（默认收起，但状态始终保留）
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [source, setSource] = useState('')
  const [project, setProject] = useState('')
  const [machine, setMachine] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [messagesOnly, setMessagesOnly] = useState(false)
  // 结果
  const [response, setResponse] = useState<SearchResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  /** 起止日期校验：不通过就禁用搜索并给出原因（规格 §6.2）。 */
  const dateError =
    from && to && from > to ? '起始日期晚于结束日期，请调整后再搜索。' : null

  /** 已启用的筛选 → chips（首屏可见，可逐个移除）。 */
  const chips = useMemo(() => {
    const list: Array<{ key: string; label: string; clear: () => void }> = []
    if (source) {
      list.push({
        key: 'source',
        label: `来源：${sourceLabel(source)}`,
        clear: () => setSource(''),
      })
    }
    if (project) {
      list.push({
        key: 'project',
        label: `项目：${baseName(project) || project}`,
        clear: () => setProject(''),
      })
    }
    if (machine) {
      list.push({ key: 'machine', label: `设备：${machine.slice(0, 8)}`, clear: () => setMachine('') })
    }
    if (from || to) {
      list.push({
        key: 'range',
        label: `时间：${from || '不限'} ~ ${to || '不限'}`,
        clear: () => {
          setFrom('')
          setTo('')
        },
      })
    }
    if (messagesOnly) {
      list.push({ key: 'messagesOnly', label: '仅正文', clear: () => setMessagesOnly(false) })
    }
    return list
  }, [source, project, machine, from, to, messagesOnly])

  /** 一键清除筛选（保留关键词与排序）。 */
  const clearFilters = () => {
    setSource('')
    setProject('')
    setMachine('')
    setFrom('')
    setTo('')
    setMessagesOnly(false)
  }

  /** 执行搜索。 */
  const run = async (offset = 0) => {
    if (!text.trim() || dateError) {
      setResponse(null)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const filter: SessionFilter = {
        source: source || null,
        projectPath: project || null,
        machineId: machine || null,
        from: from ? `${from}T00:00:00Z` : null,
        to: to ? `${to}T23:59:59Z` : null,
        // 归档会话默认不参与搜索（在高级筛选里写明）
        includeArchived: false,
      }
      const result = await ipc.search({ text, filter, order, messagesOnly, limit: 50, offset })
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
          <Select
            value={order}
            onChange={(value) => setOrder(value as 'relevance' | 'recent')}
            aria-label="结果排序"
            options={[
              { value: 'relevance', label: '相关度' },
              { value: 'recent', label: '时间' },
            ]}
          />
        }
      />

      {/* 主搜索区：关键词 + 搜索 + 高级筛选入口 + 已启用筛选 chips */}
      <div className="border-b border-line bg-panel px-4 py-3">
        <div className="mx-auto w-full max-w-[920px]">
          <div className="flex items-center gap-2">
            <TextInput
              value={text}
              onChange={(event) => setText(event.target.value)}
              onEnter={() => void run(0)}
              placeholder="搜索关键词，例如：lazy deletion / Redisson watchdog"
              aria-label="搜索关键词"
              aria-invalid={Boolean(dateError)}
              autoFocus
              className="h-10 flex-1 text-lead"
            />
            <Button
              tone="primary"
              onClick={() => void run(0)}
              loading={loading}
              disabled={Boolean(dateError) || !text.trim()}
              className="h-10 px-4 text-lead"
            >
              搜索
            </Button>
            <Button
              tone={advancedOpen ? 'secondary' : 'ghost'}
              aria-expanded={advancedOpen}
              onClick={() => setAdvancedOpen((value) => !value)}
              className="h-10"
            >
              <Icon name="chevron" className={advancedOpen ? '' : '-rotate-90'} />
              高级筛选
              {chips.length > 0 ? ` (${chips.length})` : ''}
            </Button>
          </div>

          {chips.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1.5 pt-2.5">
              <span className="text-meta text-ink-muted">已启用：</span>
              {chips.map((chip) => (
                <Chip
                  key={chip.key}
                  onRemove={() => {
                    chip.clear()
                    setResponse(null)
                  }}
                >
                  {chip.label}
                </Chip>
              ))}
              <Button tone="ghost" size="sm" onClick={clearFilters}>
                清除全部
              </Button>
            </div>
          ) : null}

          {dateError ? (
            <div className="pt-2.5">
              <Notice tone="danger" title={dateError} />
            </div>
          ) : null}

          {/* 高级筛选：默认收起，功能与之前完全一致 */}
          {advancedOpen ? (
            <div className="mt-3 rounded-panel border border-line bg-canvas p-3">
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <label className="flex flex-col gap-1 text-meta text-ink-muted">
                  来源
                  <Select
                    value={source}
                    onChange={setSource}
                    options={[
                      { value: '', label: '全部数据源' },
                      { value: 'codex', label: 'Codex' },
                      { value: 'kimi', label: 'Kimi Code' },
                    ]}
                  />
                </label>
                <label className="flex flex-col gap-1 text-meta text-ink-muted">
                  项目
                  <Select
                    value={project}
                    onChange={setProject}
                    options={[
                      { value: '', label: '全部项目' },
                      ...projects.map((p) => ({
                        value: p.projectPath,
                        label: p.name || p.projectPath,
                      })),
                    ]}
                  />
                </label>
                <label className="flex flex-col gap-1 text-meta text-ink-muted">
                  设备
                  <Select
                    value={machine}
                    onChange={setMachine}
                    options={[
                      { value: '', label: '全部设备' },
                      ...machines.map((m) => ({ value: m, label: m.slice(0, 8) })),
                    ]}
                  />
                </label>
                <div className="flex items-end gap-2">
                  <label className="flex flex-1 flex-col gap-1 text-meta text-ink-muted">
                    起始
                    <DateInput value={from} onChange={(event) => setFrom(event.target.value)} />
                  </label>
                  <label className="flex flex-1 flex-col gap-1 text-meta text-ink-muted">
                    结束
                    <DateInput value={to} onChange={(event) => setTo(event.target.value)} />
                  </label>
                </div>
              </div>
              <div className="flex items-center justify-between pt-2.5">
                <Toggle
                  checked={messagesOnly}
                  onChange={setMessagesOnly}
                  label="只搜对话正文（排除工具输出与事件）"
                />
                <span className="text-meta text-ink-muted">已归档会话默认不参与搜索</span>
              </div>
            </div>
          ) : null}
        </div>
      </div>

      {/* 结果区 */}
      <div className="min-h-0 flex-1 overflow-y-auto bg-reading">
        {error ? (
          <div className="p-4">
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
        {!response && !loading ? (
          <EmptyState
            title="输入关键词开始搜索"
            description="在 100 万条消息规模下，普通关键词搜索通常在 300ms 内返回；支持多关键词（空格分隔）与前缀匹配。"
          />
        ) : null}
        {response && response.hits.length === 0 ? (
          <EmptyState
            title="没有匹配结果"
            description={`FTS5 查询：${response.matchQuery}。可尝试减少关键词或放宽筛选条件。`}
          />
        ) : null}
        <div className="mx-auto w-full max-w-[920px]">
          {response?.hits.map((hit) => (
            <button
              key={hit.messageId}
              type="button"
              onClick={() => {
                setPage('conversations')
                void selectSession(hit.sessionId)
              }}
              className="block w-full border-b border-line/60 px-4 py-2.5 text-left transition-colors hover:bg-hover"
            >
              <div className="flex min-w-0 items-center gap-2 text-meta text-ink-muted">
                <StatusPill tone={hit.source === 'kimi' ? 'kimi' : 'codex'}>
                  {sourceLabel(hit.source)}
                </StatusPill>
                <span className="min-w-0 flex-1 truncate text-ink">{hit.projectPath ?? '未知项目'}</span>
                <span className="min-w-0 flex-1 truncate">{hit.title ?? hit.sessionId}</span>
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
        </div>
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
