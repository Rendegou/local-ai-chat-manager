/**
 * 来源管理抽屉（docs/DESIGN_AUDIT.md §2）。
 *
 * 设置页原来把 8 个来源全部展开成 Toggle + 状态 + 路径输入 + 说明，首屏几乎全被它吃掉，
 * 而其中大多数是「本机没装」的候选。这里把编辑动作收进抽屉，三种模式：
 *
 * - `add`：列出**尚未连接**的 Catalog 来源（≥6 个候选时提供搜索）；
 *   原生来源必须先选到一个有效目录才会变成手工配置来源；导入型来源直接进入导入模式。
 * - `configure`：编辑单个来源的 enabled / path。
 * - `import`：把 ImportPanel 搬进来（它原先也常驻在设置长页里）。
 *
 * 不使用卡片网格，只有紧凑列表与 divider。
 */
import { useEffect, useMemo, useState } from 'react'
import { open as openDialog } from '@tauri-apps/plugin-dialog'

import * as ipc from '../../lib/ipc'
import { useSourceViews } from '../../lib/sources'
import { useLibrary } from '../../stores/library'
import { useT } from '../../lib/i18n'
import {
  Button,
  Drawer,
  Field,
  FormField,
  Notice,
  PaneRow,
  StatusPill,
  TextInput,
  Toggle,
} from '../../components/ui'
import { ImportPanel } from './ImportPanel'

export type SourceManagerMode = 'add' | 'configure' | 'import'

/** 候选超过这个数量时才显示搜索框（少数几个来源加搜索框只是噪音）。 */
const SEARCH_THRESHOLD = 6

export function SourceManagerDrawer({
  initialMode = 'add',
  initialSourceId,
  onClose,
}: {
  initialMode?: SourceManagerMode
  initialSourceId?: string
  onClose: () => void
}) {
  const t = useT()
  const { sourceCatalog, settingsDraft, settings, patchSettingsDraft, setError } = useLibrary()
  const views = useSourceViews()
  const [mode, setMode] = useState<SourceManagerMode>(initialMode)
  const [sourceId, setSourceId] = useState<string | null>(initialSourceId ?? null)
  const [term, setTerm] = useState('')
  /** 抽屉内自己的错误（例如目录选择失败）；全局错误仍由 App Shell 统一显示。 */
  const [localError, setLocalError] = useState<string | null>(null)

  const draft = settingsDraft ?? settings
  const viewById = useMemo(() => new Map(views.map((view) => [view.id, view])), [views])
  const current = sourceId ? viewById.get(sourceId) : undefined

  // 当前来源被配置好后（不再是候选），configure 模式仍然要能打开它
  useEffect(() => {
    if (mode === 'configure' && sourceId && !viewById.has(sourceId)) setMode('add')
  }, [mode, sourceId, viewById])

  /** 候选 = 尚未连接的来源；未适配到本机平台的排在后面且不可添加。 */
  const candidates = views.filter((view) => !view.visibleInConnectedSettings)
  const filtered = term.trim()
    ? candidates.filter((view) =>
        `${view.displayName} ${view.id}`.toLowerCase().includes(term.trim().toLowerCase()),
      )
    : candidates

  /** 写入设置草稿（不直接保存；保存仍由设置页的显式动作完成）。 */
  const patchSource = (id: string, value: Partial<{ enabled: boolean; path: string | null }>) => {
    if (!draft) return
    const config = draft.sources?.[id] ?? { enabled: true, path: null }
    patchSettingsDraft({ sources: { ...draft.sources, [id]: { ...config, ...value } } })
  }

  /** 选择目录：原生来源必须拿到有效目录后才成为手工配置来源。 */
  const pickDirectory = async (id: string) => {
    setLocalError(null)
    try {
      const selected = await openDialog({
        directory: true,
        multiple: false,
        title: t('settings.pickSourceDir', { name: viewById.get(id)?.displayName ?? id }),
      })
      if (typeof selected === 'string' && selected.trim()) {
        patchSource(id, { path: selected, enabled: true })
        setMode('configure')
      }
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : String(error))
      setError(new ipc.IpcError(String(error)))
    }
  }

  const title =
    mode === 'import'
      ? t('settings.importTitle')
      : mode === 'configure' && current
        ? t('settings.configureTitle', { name: current.displayName })
        : t('settings.addSourceTitle')
  const subtitle =
    mode === 'import'
      ? undefined
      : mode === 'configure'
        ? undefined
        : t('settings.addSourceDesc')

  return (
    <Drawer title={title} subtitle={subtitle} onClose={onClose} widthClass="w-[420px]">
      <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
        {localError ? <Notice tone="danger" title={localError} /> : null}

        {mode === 'add' ? (
          <>
            {candidates.length > SEARCH_THRESHOLD ? (
              <TextInput
                value={term}
                onChange={(event) => setTerm(event.target.value)}
                placeholder={t('settings.addSourceSearch')}
                aria-label={t('settings.addSourceSearchAria')}
                className="shrink-0"
              />
            ) : null}

            {candidates.length === 0 ? (
              <p className="text-body text-ink-muted">{t('settings.addSourceEmpty')}</p>
            ) : filtered.length === 0 ? (
              <p className="text-body text-ink-muted">{t('settings.addSourceNoMatch')}</p>
            ) : (
              <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
                {filtered.map((view) => (
                  <div key={view.id} className="border-b border-line-subtle last:border-b-0">
                    <PaneRow
                      label={view.displayName}
                      trailing={
                        view.access === 'pending' ? (
                          <StatusPill size="sm" tone="neutral">
                            {t('settings.accessPending')}
                          </StatusPill>
                        ) : (
                          <span className="text-meta text-ink-faint">
                            {view.access === 'import' ? t('settings.accessImport') : t('settings.accessNative')}
                          </span>
                        )
                      }
                      title={view.description}
                      onClick={() => {
                        if (view.access === 'pending') return
                        if (view.access === 'import') {
                          setSourceId(view.id)
                          setMode('import')
                          return
                        }
                        void pickDirectory(view.id)
                      }}
                      className={view.access === 'pending' ? 'opacity-60' : ''}
                    />
                    <p className="px-2.5 pb-2 text-meta leading-5 text-ink-muted">{view.description}</p>
                  </div>
                ))}
              </div>
            )}
            <p className="shrink-0 border-t border-line-subtle pt-3 text-meta text-ink-muted">
              {t('settings.addSourceHint')}
            </p>
          </>
        ) : null}

        {mode === 'configure' && current ? (
          <>
            <Field label={t('settings.importSource')} mono>
              {current.id}
            </Field>
            <Toggle
              label={t('settings.enableSource')}
              checked={current.enabled}
              onChange={(enabled) => patchSource(current.id, { enabled })}
            />
            {current.access === 'native' ? (
              <>
                <FormField label={t('settings.sourceDir', { name: current.displayName })} hint={t('settings.pathHint')}>
                  {(props) => (
                    <TextInput
                      {...props}
                      value={draft?.sources?.[current.id]?.path ?? ''}
                      placeholder={t('settings.autoDiscover')}
                      onChange={(event) => patchSource(current.id, { path: event.target.value || null })}
                      className="font-mono text-meta"
                    />
                  )}
                </FormField>
                <div className="flex flex-wrap items-center gap-2">
                  <Button onClick={() => void pickDirectory(current.id)}>{t('settings.pickDirectory')}</Button>
                  <Button
                    tone="ghost"
                    disabled={!draft?.sources?.[current.id]?.path}
                    onClick={() => patchSource(current.id, { path: null })}
                  >
                    {t('settings.clearPath')}
                  </Button>
                </div>
              </>
            ) : (
              <p className="text-meta text-ink-muted">{current.description}</p>
            )}
            <div className="border-t border-line-subtle pt-3">
              <Button tone="ghost" onClick={() => setMode('add')}>
                {t('settings.backToAddSource')}
              </Button>
            </div>
          </>
        ) : null}

        {mode === 'import' ? (
          <>
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
              <ImportPanel catalog={sourceCatalog} initialSourceId={sourceId ?? ''} />
            </div>
            <div className="shrink-0 border-t border-line-subtle pt-3">
              <Button tone="ghost" onClick={() => setMode('add')}>
                {t('settings.backToAddSource')}
              </Button>
            </div>
          </>
        ) : null}
      </div>
    </Drawer>
  )
}

/** 供设置页复用的来源状态文案。 */
export function sourceStatusLabel(
  status: string,
  enabled: boolean,
  t: (key: string) => string,
): string {
  if (!enabled) return t('settings.disabled')
  if (status === 'available') return t('settings.statusAvailable')
  if (status === 'partial') return t('settings.statusPartial')
  if (status === 'error') return t('settings.statusError')
  return t('settings.statusMissing')
}
