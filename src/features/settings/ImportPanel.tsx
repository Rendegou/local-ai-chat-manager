/**
 * 导入会话面板（住在 Source Manager 抽屉的 import 模式里）。
 *
 * 相比上一版修掉三件事（docs/DESIGN_AUDIT.md §3、§10.5）：
 *
 * 1. **初始来源为空**。旧实现硬编码 `doubao-work`，一旦 catalog 里没有这个 id，
 *    Select 会把 `findIndex` 的 -1 抬成 0 并显示第一个选项（Codex），
 *    于是「界面显示 Codex、真正写入 doubao-work」——一个静默的数据归属错误。
 *    现在未选择合法来源时下游三个动作全部禁用。
 * 2. **选项只包含导入型来源与自定义来源**，不再把原生读取的来源混进导入列表。
 * 3. **预览不再双层无界渲染**。会话摘要列表走虚拟化，
 *    消息区域用受限分页（每页 5 条），不再 `sessions.map` 里套 `messages.map`。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { save as saveDialog } from '@tauri-apps/plugin-dialog'

import { useVirtual } from '../../hooks/useVirtual'
import { Button, FormField, Notice, Select, StatusPill, TextInput } from '../../components/ui'
import * as ipc from '../../lib/ipc'
import { useLibrary } from '../../stores/library'
import { useT } from '../../lib/i18n'
import type { ImportPreview, ImportReport, SourceDefinition } from '../../types/ipc'

/** 预览里每个会话一次展示多少条消息（点「显示更多」递增）。 */
const MESSAGE_PAGE = 5
/** 会话摘要行高（虚拟列表固定行高）。 */
const SESSION_ROW_HEIGHT = 46

export function ImportPanel({
  catalog,
  initialSourceId = '',
}: {
  catalog: SourceDefinition[]
  /** 由「添加来源」传入的预选来源；为空时保持「未选择」 */
  initialSourceId?: string
}) {
  const t = useT()
  const [source, setSource] = useState(initialSourceId)
  const [custom, setCustom] = useState('')
  const [text, setText] = useState('')
  const [fileName, setFileName] = useState('')
  const [preview, setPreview] = useState<ImportPreview | null>(null)
  const [report, setReport] = useState<ImportReport | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [selectedSession, setSelectedSession] = useState(0)
  const [messagePage, setMessagePage] = useState(1)
  const token = useRef<string | null>(null)
  const mounted = useRef(true)

  /** 只有导入型来源可以出现在这里；自定义来源是显式的一项。 */
  const options = useMemo(
    () => [
      ...catalog
        .filter((item) => item.access === 'import')
        .map((item) => ({ value: item.id, label: item.displayName })),
      { value: 'custom', label: t('settings.importCustom') },
    ],
    [catalog, t],
  )

  const sourceId = source === 'custom' ? custom.trim() : source
  // 「来源标识」必须是小写字母/数字/短横线，否则后端无法作为目录名使用
  const customValid = source !== 'custom' || /^[a-z0-9][a-z0-9-]*$/.test(custom.trim())
  /** 未选择合法来源时，下载模板 / 预览 / 确认全部禁用。 */
  const sourceReady = Boolean(sourceId) && customValid
  const locked = busy || !!preview

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      if (token.current) void ipc.cancelImport(token.current).catch(() => {})
    }
  }, [])

  // 预选来源变化时（从「添加来源」进入）同步一次
  useEffect(() => {
    if (initialSourceId) setSource(initialSourceId)
  }, [initialSourceId])

  const run = async (action: () => Promise<void>) => {
    setBusy(true)
    setError('')
    try {
      await action()
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : String(e))
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  const cancel = () => {
    if (token.current) void ipc.cancelImport(token.current).catch(() => {})
    token.current = null
    setPreview(null)
  }

  const download = (format: string) =>
    void run(async () => {
      if (!sourceReady) return
      const path = await saveDialog({
        title: t('settings.importTemplateTitle'),
        defaultPath: `conversation-example.${format === 'markdown' ? 'md' : 'json'}`,
      })
      if (path) await ipc.saveImportTemplate(path, sourceId, format)
    })

  /* ---------------- 预览：会话摘要（虚拟化）+ 单会话消息（受限分页） ---------------- */

  const sessions = preview?.sessions ?? []
  const virtual = useVirtual({ count: sessions.length, itemHeight: SESSION_ROW_HEIGHT, overscan: 4 })
  const activeSession = sessions[Math.min(selectedSession, Math.max(0, sessions.length - 1))]
  const visibleMessages = activeSession ? activeSession.messages.slice(0, messagePage * MESSAGE_PAGE) : []

  if (preview) {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-3">
        <p className="shrink-0 text-body text-ink" role="status">
          {t('settings.importPreviewSummary', { n: preview.sessions.length, failed: preview.failed })}
        </p>

        {/* 左：会话摘要（虚拟列表）；右：所选会话的消息（受限分页） */}
        <div className="flex min-h-[280px] flex-1 gap-3">
          <div className="flex min-h-0 w-[46%] flex-col border border-line">
            <div ref={virtual.containerRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
              <div style={{ height: virtual.totalSize, position: 'relative' }}>
                {virtual.items.map((item) => {
                  const session = sessions[item.index]
                  if (!session) return null
                  const active = item.index === Math.min(selectedSession, sessions.length - 1)
                  return (
                    <div
                      key={`${session.externalId}-${item.index}`}
                      style={{
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        right: 0,
                        transform: `translateY(${item.start}px)`,
                        height: item.size,
                      }}
                    >
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedSession(item.index)
                          setMessagePage(1)
                        }}
                        aria-current={active ? 'true' : undefined}
                        className={`flex h-full w-full flex-col justify-center gap-0.5 border-b border-line-subtle px-2.5 text-left transition-colors ${
                          active ? 'bg-selected' : 'hover:bg-hover'
                        }`}
                      >
                        <span className="truncate text-ui font-medium text-ink">
                          {session.title || t('settings.importUntitled')}
                        </span>
                        <span className="flex items-center gap-1.5 text-meta tabular-nums text-ink-muted">
                          {t('viewer.messageCount', { n: session.messageCount })}
                          {session.partial ? (
                            <StatusPill size="sm" tone="warning">
                              {t('settings.statusPartial')}
                            </StatusPill>
                          ) : null}
                        </span>
                      </button>
                    </div>
                  )
                })}
              </div>
            </div>
          </div>

          <div className="flex min-h-0 flex-1 flex-col border border-line">
            {activeSession ? (
              <>
                <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2.5">
                  {visibleMessages.map((message, index) => (
                    <div key={index} className="border-b border-line-subtle py-2 last:border-b-0">
                      <p className="text-meta font-medium text-ink-muted">
                        {message.role}
                        {message.timestamp ? ` · ${message.timestamp}` : ''}
                      </p>
                      <p className="whitespace-pre-wrap break-words text-body text-ink">{message.text}</p>
                      {message.attachments.length > 0 ? (
                        <p className="text-meta text-ink-muted">
                          {t('settings.importAttachments', { n: message.attachments.length })}
                        </p>
                      ) : null}
                    </div>
                  ))}
                </div>
                {activeSession.messages.length > visibleMessages.length ? (
                  <div className="shrink-0 border-t border-line-subtle p-2">
                    <Button size="sm" tone="ghost" onClick={() => setMessagePage((page) => page + 1)}>
                      {t('settings.importShowMore', {
                        n: activeSession.messages.length - visibleMessages.length,
                      })}
                    </Button>
                  </div>
                ) : null}
              </>
            ) : (
              <p className="p-2.5 text-meta text-ink-muted">{t('settings.importPickSession')}</p>
            )}
          </div>
        </div>

        {preview.warnings.length > 0 ? (
          <Notice tone="warning" title={t('settings.importSkippedTitle')}>
            {preview.warnings.join('；')}
          </Notice>
        ) : null}

        <div className="flex shrink-0 flex-wrap gap-2">
          <Button disabled={busy} onClick={cancel}>
            {t('settings.importBack')}
          </Button>
          <Button
            tone="primary"
            loading={busy}
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const pending = token.current
                if (!pending) return
                token.current = null
                try {
                  const result = await ipc.confirmImport(pending)
                  if (mounted.current) {
                    setReport(result)
                    setText('')
                    setFileName('')
                  }
                  const store = useLibrary.getState()
                  await Promise.all([
                    store.loadSources(),
                    store.loadSessions(),
                    store.loadStats(),
                    store.loadProjects(),
                  ])
                } finally {
                  if (mounted.current) setPreview(null)
                }
              })
            }
          >
            {t('settings.importConfirm', { n: preview.sessions.length })}
          </Button>
        </div>

        {error ? <Notice tone="danger" title={t('settings.importFailed')}>{error}</Notice> : null}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <FormField label={t('settings.importSource')}>
        {(props) => (
          <Select
            {...props}
            value={source}
            disabled={locked}
            placeholder={t('settings.importPickSource')}
            onChange={(value) => {
              setSource(value)
              setReport(null)
            }}
            options={options}
          />
        )}
      </FormField>

      {source === 'custom' ? (
        <FormField label={t('settings.importSourceId')} hint={t('settings.importSourceIdHint')}>
          {(props) => (
            <TextInput
              {...props}
              value={custom}
              disabled={locked}
              onChange={(event) => setCustom(event.target.value)}
              aria-invalid={Boolean(custom) && !customValid}
            />
          )}
        </FormField>
      ) : null}

      {source === 'doubao-work' ? (
        <Notice title={t('settings.importDoubaoTitle')} tone="info">
          {t('settings.importDoubaoBody')}
        </Notice>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button disabled={busy || !sourceReady} onClick={() => download('json')}>
          {t('settings.importDownloadJson')}
        </Button>
        <Button disabled={busy || !sourceReady} onClick={() => download('markdown')}>
          {t('settings.importDownloadMd')}
        </Button>
      </div>

      <FormField
        label={t('settings.importFile')}
        hint={fileName ? t('settings.importContentLoaded', { name: fileName }) : t('settings.importFileHint')}
      >
        {(props) => (
          <>
            {/* 原生 file input 会自带「未选择文件」文案，直接显示会和 FormField 的
                「选择文件」标签连成「选择文件 未选择文件」；这里把它隐藏，只留自绘按钮。 */}
            <input
              {...props}
              id={`${props.id}-input`}
              type="file"
              accept=".json,.md,.markdown"
              disabled={busy || !sourceReady}
              className="sr-only"
              onChange={(event) => {
                const file = event.target.files?.[0]
                if (!file) return
                void run(async () => {
                  if (file.size > 16 * 1024 * 1024) throw new Error(t('settings.importTooLarge'))
                  const value = await file.text()
                  if (mounted.current) {
                    setText(value)
                    setFileName(file.name)
                    setReport(null)
                  }
                })
              }}
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button
                disabled={busy || !sourceReady}
                onClick={() => {
                  const node = document.getElementById(`${props.id}-input`)
                  if (node instanceof HTMLInputElement) node.click()
                }}
              >
                {t('settings.importChooseFile')}
              </Button>
              <span className="min-w-0 truncate text-meta text-ink-muted">
                {fileName || t('settings.importNoFile')}
              </span>
            </div>
          </>
        )}
      </FormField>

      <FormField
        label={t('settings.importContent')}
        hint={fileName ? t('settings.importContentLoaded', { name: fileName }) : t('settings.importContentHint')}
      >
        {(props) => (
          <textarea
            {...props}
            rows={8}
            value={text}
            disabled={busy}
            spellCheck={false}
            className="field w-full min-w-0 p-3 font-mono text-body text-ink"
            placeholder={t('settings.importPlaceholder')}
            onChange={(event) => {
              setText(event.target.value)
              setReport(null)
            }}
          />
        )}
      </FormField>

      <div>
        <Button
          tone="primary"
          loading={busy}
          disabled={!text.trim() || !sourceReady || busy}
          onClick={() =>
            void run(async () => {
              setReport(null)
              const result = await ipc.previewImport(sourceId, text)
              if (!mounted.current) {
                await ipc.cancelImport(result.token)
                return
              }
              token.current = result.token
              setSelectedSession(0)
              setMessagePage(1)
              setPreview(result)
            })
          }
        >
          {t('settings.importPreview')}
        </Button>
      </div>

      {error ? <Notice tone="danger" title={t('settings.importFailed')}>{error}</Notice> : null}
      {report ? (
        <div role="status">
          <Notice
            tone={report.failed ? 'warning' : 'success'}
            title={t('settings.importReport', {
              success: report.success,
              duplicates: report.duplicates,
              failed: report.failed,
              partial: report.partial,
            })}
          >
            {report.warnings.length ? report.warnings.join('；') : t('settings.importSaved')}
          </Notice>
        </div>
      ) : null}
    </div>
  )
}
