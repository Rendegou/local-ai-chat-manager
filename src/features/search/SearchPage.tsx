/**
 * 搜索页（规格 §6.2）。
 *
 * 首屏只保留四个决策点：关键词、搜索、排序、（已启用的）筛选 chips。
 * 来源 / 项目 / 设备 / 日期 / 仅正文进入「高级筛选」，功能一个不少但不抢注意力。
 *
 * 条件与结果的一致性（docs/DESIGN_AUDIT.md §5）：状态分成 draft / applied 两组。
 * - 关键词：改动后必须按 Enter / 点搜索才提交；
 * - 排序与筛选：已有结果且关键词未变时 250ms 后**自动重查**，期间保留旧结果并显示
 *   「正在更新结果…」；
 * - `appliedCriteria` 只在新请求成功后才更新，结果数永远描述的是屏幕上这批结果；
 * - 每个请求带序号，旧响应返回时直接丢弃——否则连续改两次筛选会让结果和控件永久错位。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import * as ipc from '../../lib/ipc'
import { baseName, formatDateTime, formatRelative, sourceLabel, sourceTone } from '../../lib/format'
import { useSourceViews } from '../../lib/sources'
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
import { useT } from '../../lib/i18n'

/** 一次查询的完整条件（draft 与 applied 用的是同一个形状）。 */
interface SearchCriteria {
  order: 'relevance' | 'recent'
  source: string
  project: string
  machine: string
  from: string
  to: string
  messagesOnly: boolean
}

const EMPTY_CRITERIA: SearchCriteria = {
  order: 'relevance',
  source: '',
  project: '',
  machine: '',
  from: '',
  to: '',
  messagesOnly: false,
}

/** 每页结果条数。 */
const PAGE_SIZE = 50
/** 筛选变化后的自动重查延迟。 */
const AUTO_REFRESH_MS = 250

/** 只比较会影响查询结果的条件（order 也影响结果顺序，必须包含）。 */
function sameCriteria(a: SearchCriteria, b: SearchCriteria): boolean {
  return (
    a.order === b.order &&
    a.source === b.source &&
    a.project === b.project &&
    a.machine === b.machine &&
    a.from === b.from &&
    a.to === b.to &&
    a.messagesOnly === b.messagesOnly
  )
}

function toFilter(criteria: SearchCriteria): SessionFilter {
  return {
    source: criteria.source || null,
    projectPath: criteria.project || null,
    machineId: criteria.machine || null,
    from: criteria.from ? `${criteria.from}T00:00:00Z` : null,
    to: criteria.to ? `${criteria.to}T23:59:59Z` : null,
    // 归档会话默认不参与搜索（在高级筛选里写明）
    includeArchived: false,
  }
}

/** 搜索页。 */
export function SearchPage() {
  const t = useT()
  const { machines, projects, setPage, selectSession, setLocateMessage } = useLibrary()
  const sourceViews = useSourceViews()
  /** 有历史的来源才值得作为筛选项——否则列出来只会让人选中一个必然零结果的条件 */
  const searchSources = sourceViews.filter((view) => view.visibleInSearch)

  // ---- 编辑中的条件（draft） ----
  const [draftText, setDraftText] = useState('')
  const [draftCriteria, setDraftCriteria] = useState<SearchCriteria>(EMPTY_CRITERIA)
  const [advancedOpen, setAdvancedOpen] = useState(false)

  // ---- 产生当前结果的条件（applied） ----
  const [appliedText, setAppliedText] = useState('')
  const [appliedCriteria, setAppliedCriteria] = useState<SearchCriteria>(EMPTY_CRITERIA)

  // ---- 结果与加载状态 ----
  const [response, setResponse] = useState<SearchResponse | null>(null)
  const [loadingInitial, setLoadingInitial] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const requestSeqRef = useRef(0)
  /** 自动重查需要知道「当前是否有结果」，但又不想把 response 放进 execute 的依赖 */
  const hasResponseRef = useRef(false)
  hasResponseRef.current = Boolean(response)

  const patchCriteria = (patch: Partial<SearchCriteria>) =>
    setDraftCriteria((current) => ({ ...current, ...patch }))

  /** 起止日期校验：不通过就禁用搜索并给出原因（规格 §6.2）。 */
  const dateError =
    draftCriteria.from && draftCriteria.to && draftCriteria.from > draftCriteria.to
      ? t('search.dateError')
      : null

  /** 执行查询。`seq` 保证只有最新一次请求能写回状态。 */
  const execute = useCallback(
    async (text: string, criteria: SearchCriteria, offset: number) => {
      const trimmed = text.trim()
      if (!trimmed) {
        setResponse(null)
        setAppliedText('')
        setAppliedCriteria(criteria)
        return
      }
      const seq = ++requestSeqRef.current
      if (offset === 0) {
        if (hasResponseRef.current) setRefreshing(true)
        else setLoadingInitial(true)
      } else {
        setLoadingMore(true)
      }
      setError(null)
      try {
        const result = await ipc.search({
          text: trimmed,
          filter: toFilter(criteria),
          order: criteria.order,
          messagesOnly: criteria.messagesOnly,
          limit: PAGE_SIZE,
          offset,
        })
        // 旧请求返回：直接丢弃，不能覆盖更新的结果
        if (seq !== requestSeqRef.current) return
        setResponse((previous) =>
          offset > 0 && previous ? { ...result, hits: [...previous.hits, ...result.hits] } : result,
        )
        setAppliedText(trimmed)
        setAppliedCriteria(criteria)
      } catch (err) {
        if (seq !== requestSeqRef.current) return
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        if (seq === requestSeqRef.current) {
          setLoadingInitial(false)
          setRefreshing(false)
          setLoadingMore(false)
        }
      }
    },
    [],
  )

  /** 显式提交（Enter / 搜索按钮 / 清除筛选）。 */
  const submit = () => {
    if (dateError) return
    void execute(draftText, draftCriteria, 0)
  }

  /**
   * 排序与筛选变化后自动重查。
   *
   * 三个前置条件缺一不可：已有结果、关键词没有被改动（否则会用一个用户没提交的关键词去查）、
   * 条件确实变了。防抖 250ms 让「连续改两个筛选」只发一次请求。
   */
  useEffect(() => {
    if (!response) return
    if (draftText.trim() !== appliedText) return
    if (sameCriteria(draftCriteria, appliedCriteria)) return
    const handle = window.setTimeout(() => {
      void execute(draftText, draftCriteria, 0)
    }, AUTO_REFRESH_MS)
    return () => window.clearTimeout(handle)
  }, [draftCriteria, draftText, appliedText, appliedCriteria, response, execute])

  /** 关键词被改动但还没提交：结果仍然是旧关键词的，必须说明。 */
  const keywordDirty = Boolean(response) && draftText.trim() !== appliedText
  /** 条件已改、新结果还没回来。 */
  const criteriaPending = Boolean(response) && !sameCriteria(draftCriteria, appliedCriteria)

  /** 已启用的筛选 → chips（首屏可见，可逐个移除）。移除只改 draft，重查走同一套自动刷新逻辑。 */
  const chips = useMemo(() => {
    const list: Array<{ key: string; label: string; clear: () => void }> = []
    if (draftCriteria.source) {
      const view = searchSources.find((item) => item.id === draftCriteria.source)
      list.push({
        key: 'source',
        label: t('search.chipSource', { label: view?.displayName ?? sourceLabel(draftCriteria.source) }),
        clear: () => patchCriteria({ source: '' }),
      })
    }
    if (draftCriteria.project) {
      list.push({
        key: 'project',
        label: t('search.chipProject', {
          label: baseName(draftCriteria.project) || draftCriteria.project,
        }),
        clear: () => patchCriteria({ project: '' }),
      })
    }
    if (draftCriteria.machine) {
      list.push({
        key: 'machine',
        label: t('search.chipMachine', { label: draftCriteria.machine.slice(0, 8) }),
        clear: () => patchCriteria({ machine: '' }),
      })
    }
    if (draftCriteria.from || draftCriteria.to) {
      list.push({
        key: 'range',
        label: t('search.chipRange', {
          from: draftCriteria.from || t('search.anyDate'),
          to: draftCriteria.to || t('search.anyDate'),
        }),
        clear: () => patchCriteria({ from: '', to: '' }),
      })
    }
    if (draftCriteria.messagesOnly) {
      list.push({
        key: 'messagesOnly',
        label: t('search.chipMessagesOnly'),
        clear: () => patchCriteria({ messagesOnly: false }),
      })
    }
    return list
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftCriteria, searchSources, t])

  /** 一键清除筛选（保留关键词与排序）。 */
  const clearFilters = () =>
    patchCriteria({ source: '', project: '', machine: '', from: '', to: '', messagesOnly: false })

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-canvas">
      <PanelHeader
        headingLevel={1}
        title={t('search.title')}
        meta={
          // 结果数永远描述屏幕上这批结果；更新中另有独立提示，不在这里混合两种状态
          response ? t('search.metaResults', { n: response.hits.length, ms: response.tookMs }) : t('search.metaIdle')
        }
        actions={
          <Select
            value={draftCriteria.order}
            onChange={(value) => patchCriteria({ order: value as 'relevance' | 'recent' })}
            aria-label={t('search.sortAria')}
            options={[
              { value: 'relevance', label: t('search.sortRelevance') },
              { value: 'recent', label: t('search.sortRecent') },
            ]}
          />
        }
      />

      {/* 主搜索区：关键词 + 搜索 + 高级筛选入口 + 已启用筛选 chips */}
      <div className="border-b border-line-subtle bg-panel px-4 py-3">
        <div className="mx-auto w-full max-w-[980px]">
          <div className="flex items-center gap-2">
            <TextInput
              value={draftText}
              onChange={(event) => setDraftText(event.target.value)}
              onEnter={submit}
              placeholder={t('search.placeholder')}
              aria-label={t('search.keywordAria')}
              aria-invalid={Boolean(dateError)}
              autoFocus
              className="flex-1 text-body"
            />
            {/* 本页唯一的主操作 */}
            <Button
              tone="primary"
              size="lg"
              onClick={submit}
              loading={loadingInitial}
              disabled={Boolean(dateError) || !draftText.trim()}
            >
              {t('search.run')}
            </Button>
            <Button
              tone={advancedOpen ? 'secondary' : 'ghost'}
              size="lg"
              aria-expanded={advancedOpen}
              onClick={() => setAdvancedOpen((value) => !value)}
            >
              <Icon name="chevron" className={advancedOpen ? '' : '-rotate-90'} />
              {t('search.advanced')}
              {chips.length > 0 ? ` (${chips.length})` : ''}
            </Button>
          </div>

          {chips.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1.5 pt-2.5">
              <span className="text-meta text-ink-muted">{t('search.activeFilters')}</span>
              {chips.map((chip) => (
                <Chip key={chip.key} onRemove={chip.clear}>
                  {chip.label}
                </Chip>
              ))}
              <Button tone="ghost" size="sm" onClick={clearFilters}>
                {t('search.clearAll')}
              </Button>
            </div>
          ) : null}

          {dateError ? (
            <div className="pt-2.5">
              <Notice tone="danger" title={dateError} />
            </div>
          ) : null}

          {/* 高级筛选：默认收起，内联 section（不再是卡片） */}
          {advancedOpen ? (
            <div className="mt-3 border-t border-line-subtle pt-3">
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
                <label className="flex min-w-0 flex-col gap-1 text-meta text-ink-muted">
                  {t('search.sourceLabel')}
                  <Select
                    value={draftCriteria.source}
                    onChange={(value) => patchCriteria({ source: value })}
                    placeholder={t('search.allSources')}
                    options={[
                      { value: '', label: t('search.allSources') },
                      ...searchSources.map((view) => ({ value: view.id, label: view.displayName })),
                    ]}
                  />
                  {searchSources.length === 0 ? (
                    <span className="text-meta text-ink-faint">{t('search.noSourceHistory')}</span>
                  ) : null}
                </label>
                <label className="flex min-w-0 flex-col gap-1 text-meta text-ink-muted">
                  {t('search.projectLabel')}
                  <Select
                    value={draftCriteria.project}
                    onChange={(value) => patchCriteria({ project: value })}
                    options={[
                      { value: '', label: t('search.allProjects') },
                      ...projects.map((p) => ({ value: p.projectPath, label: p.name || p.projectPath })),
                    ]}
                  />
                </label>
                <label className="flex min-w-0 flex-col gap-1 text-meta text-ink-muted">
                  {t('search.machineLabel')}
                  <Select
                    value={draftCriteria.machine}
                    onChange={(value) => patchCriteria({ machine: value })}
                    options={[
                      { value: '', label: t('search.allMachines') },
                      ...machines.map((m) => ({ value: m, label: m.slice(0, 8) })),
                    ]}
                  />
                </label>
                <label className="flex min-w-0 flex-col gap-1 text-meta text-ink-muted">
                  {t('search.fromLabel')}
                  <DateInput
                    value={draftCriteria.from}
                    onChange={(event) => patchCriteria({ from: event.target.value })}
                  />
                </label>
                <label className="flex min-w-0 flex-col gap-1 text-meta text-ink-muted">
                  {t('search.toLabel')}
                  <DateInput
                    value={draftCriteria.to}
                    onChange={(event) => patchCriteria({ to: event.target.value })}
                  />
                </label>
              </div>
              <div className="flex items-center justify-between pt-2.5">
                <Toggle
                  checked={draftCriteria.messagesOnly}
                  onChange={(value) => patchCriteria({ messagesOnly: value })}
                  label={t('search.messagesOnly')}
                />
                <span className="text-meta text-ink-muted">{t('search.archivedExcluded')}</span>
              </div>
            </div>
          ) : null}
        </div>
      </div>

      {/* 结果区 */}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain bg-reading">
        {/*
         * 三种「结果与条件不一致」的状态，各自说清自己是什么：
         * 关键词没提交 / 条件在重查 / 已同步。
         */}
        <div aria-live="polite" className="sr-only">
          {refreshing ? t('search.refreshing') : ''}
        </div>
        {keywordDirty || criteriaPending || refreshing ? (
          <div className="flex items-center gap-2 border-b border-line-subtle px-4 py-1.5">
            {refreshing || criteriaPending ? <Spinner size="sm" /> : null}
            <span
              className={`text-meta ${keywordDirty ? 'text-warning' : 'text-ink-muted'}`}
            >
              {keywordDirty
                ? t('search.keywordDirty')
                : refreshing || criteriaPending
                  ? t('search.refreshing')
                  : t('search.appliedCriteria')}
            </span>
          </div>
        ) : null}

        {error ? (
          <div className="p-4">
            <Notice tone="danger" title={t('search.failed')}>
              {error}
            </Notice>
          </div>
        ) : null}
        {loadingInitial && !response ? (
          <div className="p-4">
            <Spinner label={t('search.searching')} />
          </div>
        ) : null}
        {!response && !loadingInitial ? (
          <EmptyState title={t('search.emptyTitle')} description={t('search.emptyDescription')} />
        ) : null}
        {response && response.hits.length === 0 ? (
          <EmptyState
            title={t('search.noResults')}
            description={t('search.noResultsDesc', { query: response.matchQuery })}
          />
        ) : null}
        {/* 结果列表：仅在有结果时渲染容器——空的 py-4 容器会把空状态顶出 32px 的幽灵滚动条 */}
        {response && response.hits.length > 0 ? (
          <div
            className={`mx-auto w-full max-w-[980px] px-4 py-4 transition-opacity ${
              refreshing || criteriaPending ? 'opacity-60' : ''
            }`}
          >
            {response.hits.map((hit) => (
              <button
                key={hit.messageId}
                type="button"
                onClick={() => {
                  // 定位到具体消息：阅读器直接加载目标前后文窗口并居中高亮
                  setLocateMessage({ sessionId: hit.sessionId, sequence: hit.sequence })
                  setPage('conversations')
                  void selectSession(hit.sessionId)
                }}
                className="block w-full border-b border-line-subtle px-3 py-2.5 text-left transition-colors hover:bg-hover"
              >
                {/* 第一行：来源 + 会话标题 + 时间（项目路径降到第三行，不再与标题抢宽度） */}
                <div className="flex min-w-0 items-center gap-2">
                  <StatusPill size="sm" tone={sourceTone(hit.source)}>
                    {sourceLabel(hit.source)}
                  </StatusPill>
                  <span className="min-w-0 flex-1 truncate text-body font-medium text-ink">
                    {hit.title ?? hit.sessionId}
                  </span>
                  <span className="shrink-0 text-meta tabular-nums text-ink-muted">
                    {formatRelative(hit.sessionUpdatedAt)}
                  </span>
                </div>
                {/* snippet 为后端生成的高亮片段（含 <mark>，样式走全局 mark 规则） */}
                <div
                  className="pt-1 text-body leading-6 text-ink-muted"
                  dangerouslySetInnerHTML={{ __html: escapeExceptMark(hit.snippet) }}
                />
                <div className="flex min-w-0 items-center gap-1.5 pt-1 text-meta text-ink-faint">
                  <span className="min-w-0 flex-1 truncate">
                    {hit.projectPath ?? t('format.unknownProject')}
                  </span>
                  <span className="shrink-0 text-tech">
                    {hit.role} · #{hit.sequence} · {formatDateTime(hit.timestamp)}
                  </span>
                </div>
              </button>
            ))}
          </div>
        ) : null}
        {response?.hasMore ? (
          <div className="flex justify-center py-3">
            <Button
              tone="ghost"
              size="sm"
              onClick={() => void execute(appliedText, appliedCriteria, response.hits.length)}
              loading={loadingMore}
            >
              {loadingMore ? t('search.loading') : t('search.loadMore')}
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
export function escapeExceptMark(snippet: string): string {
  const escaped = snippet
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
  return escaped.replace(/&lt;mark&gt;/g, '<mark>').replace(/&lt;\/mark&gt;/g, '</mark>')
}
