/**
 * 快速搜索面板（Ctrl/Cmd + K）。
 *
 * 历史会话工具的核心动作是「找到某段之前的对话」——它值得一个随时可达的
 * 命令面板，而不是只能去搜索页。行为：
 * - 输入即查（防抖 200ms，复用全文搜索 IPC，最多 8 条）；
 * - ↑/↓ 移动、Enter 打开并定位到具体消息、Esc 关闭；
 * - 打开走 requestPage（设置页未保存草稿仍会先拦截）。
 *
 * 无障碍（docs/DESIGN_AUDIT.md §9）：浮层基础换成 `Overlay`，于是焦点圈定、
 * 背景 inert、Escape、焦点归还都由它统一提供；输入框补齐 combobox 契约——
 * `aria-controls` 指向 listbox、`aria-activedescendant` 指向当前项，
 * 结果数变化通过 `aria-live` 宣告。此前输入框与列表只有视觉关联，读屏软件接不上。
 */
import { useEffect, useId, useRef, useState } from 'react'

import * as ipc from '../../lib/ipc'
import { formatRelative, sourceLabel, sourceTone } from '../../lib/format'
import { useLibrary } from '../../stores/library'
import type { SearchHit } from '../../types/ipc'
import { Dot, Icon, Overlay } from '../../components/ui'
import { useT } from '../../lib/i18n'
import { escapeExceptMark } from './SearchPage'

/** 面板里最多展示的结果条数。 */
const MAX_HITS = 8

export function QuickSearch({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT()
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<SearchHit[]>([])
  const [loading, setLoading] = useState(false)
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const genRef = useRef(0)
  const listId = `quicksearch-list-${useId()}`
  const optionId = (index: number) => `${listId}-${index}`

  // 打开时重置并聚焦
  useEffect(() => {
    if (!open) return
    setQuery('')
    setHits([])
    setActive(0)
    requestAnimationFrame(() => inputRef.current?.focus())
  }, [open])

  // 输入即查（防抖 200ms）；过期响应直接丢弃
  useEffect(() => {
    if (!open) return
    const text = query.trim()
    if (!text) {
      setHits([])
      setLoading(false)
      return
    }
    setLoading(true)
    const gen = ++genRef.current
    const handle = window.setTimeout(() => {
      void ipc
        .search({ text, order: 'relevance', limit: MAX_HITS, offset: 0 })
        .then((response) => {
          if (genRef.current !== gen) return
          setHits(response.hits)
          setActive(0)
        })
        .catch(() => {
          if (genRef.current === gen) setHits([])
        })
        .finally(() => {
          if (genRef.current === gen) setLoading(false)
        })
    }, 200)
    return () => window.clearTimeout(handle)
  }, [query, open])

  if (!open) return null

  /** 打开结果：定位消息并跳到会话页。 */
  const openHit = (hit: SearchHit) => {
    const library = useLibrary.getState()
    library.setLocateMessage({ sessionId: hit.sessionId, sequence: hit.sequence })
    library.requestPage('conversations')
    void library.selectSession(hit.sessionId)
    onClose()
  }

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActive((index) => Math.min(index + 1, Math.max(0, hits.length - 1)))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActive((index) => Math.max(index - 1, 0))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const hit = hits[active]
      if (hit) openHit(hit)
    }
    // Escape 由 Overlay 统一处理
  }

  return (
    <Overlay
      open={open}
      onClose={onClose}
      label={t('quickSearch.dialogAria')}
      backdropClassName="absolute inset-0 bg-canvas/70"
      positionClassName="pointer-events-none absolute inset-x-0 top-[14vh] flex justify-center px-4"
      panelClassName="w-full max-w-[560px] rounded-overlay"
    >
      {/* 输入行 */}
      <div className="flex h-12 items-center gap-2.5 border-b border-line px-4">
        <Icon name="search" size={15} className="shrink-0 text-ink-faint" />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={t('quickSearch.placeholder')}
          aria-label={t('quickSearch.inputAria')}
          role="combobox"
          aria-expanded={hits.length > 0}
          aria-controls={hits.length > 0 ? listId : undefined}
          aria-activedescendant={hits.length > 0 ? optionId(active) : undefined}
          aria-autocomplete="list"
          data-overlay-autofocus
          className="min-w-0 flex-1 bg-transparent text-body text-ink outline-none placeholder:text-ink-faint"
        />
        <kbd className="shrink-0 rounded-chip border border-line px-1.5 py-0.5 text-micro text-ink-faint">
          Esc
        </kbd>
      </div>

      {/* 结果数宣告：读屏软件在输入后能听到「N 条结果」 */}
      <p aria-live="polite" className="sr-only">
        {query.trim() && !loading ? t('quickSearch.resultCount', { n: hits.length }) : ''}
      </p>

      {/* 结果区 */}
      {hits.length > 0 ? (
        <div
          id={listId}
          role="listbox"
          aria-label={t('quickSearch.resultsAria')}
          className="max-h-[46vh] overflow-y-auto overscroll-contain py-1"
        >
          {hits.map((hit, index) => (
            <button
              key={hit.messageId}
              id={optionId(index)}
              type="button"
              role="option"
              aria-selected={index === active}
              tabIndex={-1}
              onMouseEnter={() => setActive(index)}
              onClick={() => openHit(hit)}
              className={`block w-full px-4 py-2 text-left transition-colors ${
                index === active ? 'bg-selected' : ''
              }`}
            >
              <div className="flex min-w-0 items-center gap-2">
                <Dot tone={sourceTone(hit.source)} />
                <span className="shrink-0 text-meta text-ink-muted">{sourceLabel(hit.source)}</span>
                <span className="min-w-0 flex-1 truncate text-ui font-medium text-ink">
                  {hit.title ?? hit.sessionId}
                </span>
                {/* 时间用 ink-muted 而不是 ink-faint：选中行背景更亮，
                    faint 在它上面达不到 AA（audit 会报 3.9:1） */}
                <span className="shrink-0 text-meta tabular-nums text-ink-muted">
                  {formatRelative(hit.sessionUpdatedAt)}
                </span>
              </div>
              <div
                className="truncate pt-0.5 text-meta text-ink-muted [&_mark]:bg-transparent [&_mark]:font-medium [&_mark]:text-accent [&_mark]:p-0"
                dangerouslySetInnerHTML={{ __html: escapeExceptMark(hit.snippet) }}
              />
            </button>
          ))}
        </div>
      ) : query.trim() && !loading ? (
        <div className="px-4 py-6 text-center text-meta text-ink-muted">{t('quickSearch.noResults')}</div>
      ) : null}

      {/* 底部快捷键提示 */}
      <div className="flex items-center gap-3 border-t border-line-subtle px-4 py-2 text-micro text-ink-faint">
        <span>↑↓ {t('quickSearch.footerSelect')}</span>
        <span>Enter {t('quickSearch.footerOpen')}</span>
        <span>Esc {t('quickSearch.footerClose')}</span>
        <span className="ml-auto">{loading ? t('quickSearch.searching') : t('quickSearch.fullText')}</span>
      </div>
    </Overlay>
  )
}
