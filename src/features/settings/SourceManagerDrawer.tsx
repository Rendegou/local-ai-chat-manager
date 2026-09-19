/**
 * 来源管理抽屉（docs/DESIGN_AUDIT.md §2、docs/DESIGN.md §9）。
 *
 * 设置页原来把 8 个来源全部展开成 Toggle + 状态 + 路径输入 + 说明，首屏几乎全被它吃掉，
 * 而其中大多数是「本机没装」的候选。这里把编辑动作收进抽屉，四种模式：
 *
 * - `add`：列出**尚未连接**的 Catalog 来源（≥6 个候选时提供搜索）。
 *   原生来源必须先选到有效目录；导入型来源进导入模式；**待适配**（pending）的来源
 *   不可直接连接，但给一个「用自定义来源接入」的入口——把「我们还没做」直接接上
 *   「那我自己接」的动作。
 * - `custom`：创建或编辑一个用户自定义来源（目录 + 字段映射 + 试解析）。
 * - `configure`：编辑单个来源；有字段映射的走 `custom`，否则编辑 enabled / path。
 * - `import`：把 ImportPanel 搬进来。
 *
 * 不使用卡片网格，只有紧凑列表与 divider。
 */
import { useEffect, useMemo, useState } from 'react'
import { open as openDialog } from '@tauri-apps/plugin-dialog'

import * as ipc from '../../lib/ipc'
import { useSourceViews } from '../../lib/sources'
import { useLibrary } from '../../stores/library'
import { useT } from '../../lib/i18n'
import type { FieldMapping, GenericPreview, SourceConfig } from '../../types/ipc'
import {
  Button,
  Drawer,
  Field,
  FormField,
  Notice,
  PaneRow,
  Select,
  StatusPill,
  TextInput,
  Toggle,
} from '../../components/ui'
import { ImportPanel } from './ImportPanel'

export type SourceManagerMode = 'add' | 'configure' | 'import' | 'custom'

/** 候选超过这个数量时才显示搜索框（少数几个来源加搜索框只是噪音）。 */
const SEARCH_THRESHOLD = 6

/** 与 Rust `FieldMapping::default()` 保持一致。 */
const DEFAULT_MAPPING: FieldMapping = {
  layout: 'jsonl',
  messagesPath: 'messages',
  roleField: 'role',
  textField: 'content',
  timeField: 'timestamp',
  toolField: '',
  titleField: '',
  projectField: '',
  roleMap: {},
  extensions: ['jsonl'],
  maxDepth: 8,
}

/**
 * 显示名 → 来源标识（slug）。
 *
 * 规则与 Rust 的 `SourceKind::parse` 对齐：小写字母/数字/短横线，不以短横线结尾。
 * 前端先校验一次是为了即时反馈；后端 `save_settings` 还会再校验一次。
 */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
}

/** 是否是被 Windows 保留的设备名（与后端同一份名单）。 */
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/
/** 来源标识合法性。 */
function validSlug(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 64 &&
    /^[a-z0-9][a-z0-9-]*$/.test(value) &&
    !value.endsWith('-') &&
    !RESERVED.test(value)
  )
}

/** 「a, b」/「.jsonl」→ 扩展名数组。 */
function parseExtensions(value: string): string[] {
  return value
    .split(/[,，\s]+/)
    .map((item) => item.trim().replace(/^\./, ''))
    .filter(Boolean)
}

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

  // ---- 自定义来源表单状态 ----
  const [customName, setCustomName] = useState('')
  const [customId, setCustomId] = useState('')
  /** 标识是否由显示名自动派生（用户手改过就不再覆盖） */
  const [idTouched, setIdTouched] = useState(false)
  const [customPath, setCustomPath] = useState('')
  const [mapping, setMapping] = useState<FieldMapping>(DEFAULT_MAPPING)
  const [extensionsText, setExtensionsText] = useState('jsonl')
  const [roleMapText, setRoleMapText] = useState('')
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [preview, setPreview] = useState<GenericPreview | null>(null)
  const [previewBusy, setPreviewBusy] = useState(false)

  const draft = settingsDraft ?? settings
  const viewById = useMemo(() => new Map(views.map((view) => [view.id, view])), [views])
  const current = sourceId ? viewById.get(sourceId) : undefined

  // 当前来源被配置好后（不再是候选），configure 模式仍然要能打开它
  useEffect(() => {
    if (mode === 'configure' && sourceId && !viewById.has(sourceId)) setMode('add')
  }, [mode, sourceId, viewById])

  /** 候选 = 尚未连接的来源。 */
  const candidates = views.filter((view) => !view.visibleInConnectedSettings)
  const filtered = term.trim()
    ? candidates.filter((view) =>
        `${view.displayName} ${view.id}`.toLowerCase().includes(term.trim().toLowerCase()),
      )
    : candidates

  /** 写入设置草稿（不直接保存；保存仍由设置页的显式动作完成）。 */
  const patchSource = (id: string, value: Partial<SourceConfig>) => {
    if (!draft) return
    const config = draft.sources?.[id] ?? { enabled: true, path: null }
    patchSettingsDraft({ sources: { ...draft.sources, [id]: { ...config, ...value } } })
  }

  /** 进入自定义来源表单：`view` 为空表示新建。 */
  const openCustomForm = (view?: { id: string; displayName: string; isCustom: boolean }) => {
    setLocalError(null)
    setPreview(null)
    setAdvancedOpen(false)
    const existing = view ? draft?.sources?.[view.id] : undefined
    if (view && existing?.mapping) {
      // 编辑已有自定义来源
      setSourceId(view.id)
      setCustomName(existing.displayName ?? view.displayName)
      setCustomId(view.id)
      setIdTouched(true)
      setCustomPath(existing.path ?? '')
      setMapping({ ...DEFAULT_MAPPING, ...existing.mapping })
      setExtensionsText(existing.mapping.extensions.join(', '))
      setRoleMapText(
        Object.entries(existing.mapping.roleMap ?? {})
          .map(([from, to]) => `${from}=${to}`)
          .join(', '),
      )
    } else {
      // 新建（或把某个 pending 工具接进来）
      const name = view?.displayName ?? ''
      setSourceId(null)
      setCustomName(name)
      setCustomId(slugify(name))
      setIdTouched(Boolean(view))
      setCustomPath('')
      setMapping(DEFAULT_MAPPING)
      setExtensionsText(DEFAULT_MAPPING.extensions.join(', '))
      setRoleMapText('')
    }
    setMode('custom')
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

  /** 表单里的映射（扩展名与角色映射从文本解析出来）。 */
  const formMapping: FieldMapping = {
    ...mapping,
    extensions: parseExtensions(extensionsText),
    roleMap: Object.fromEntries(
      roleMapText
        .split(/[,，]/)
        .map((pair) => pair.split('='))
        .filter((parts) => parts.length === 2 && parts[0].trim() && parts[1].trim())
        .map((parts) => [parts[0].trim().toLowerCase(), parts[1].trim()]),
    ),
  }

  /** 前端侧的保存前置校验（后端还会再校验一次）。 */
  const customErrors = (() => {
    const errors: string[] = []
    if (!customName.trim()) errors.push(t('settings.customNameRequired'))
    if (!validSlug(customId)) errors.push(t('settings.customIdInvalid'))
    // 不能占用已有内置来源的标识，否则两个适配器会同 id 抢同一批会话
    const collision = sourceCatalog.find((def) => def.id === customId && def.access !== 'pending')
    if (collision && customId !== sourceId) errors.push(t('settings.customIdTaken', { name: collision.displayName }))
    if (!customPath.trim()) errors.push(t('settings.customPathRequired'))
    if (!formMapping.roleField.trim() || !formMapping.textField.trim()) {
      errors.push(t('settings.customFieldRequired'))
    }
    if (formMapping.layout === 'json' && !formMapping.messagesPath.trim()) {
      errors.push(t('settings.customPathRequired'))
    }
    if (formMapping.extensions.length === 0) errors.push(t('settings.customExtRequired'))
    return errors
  })()

  /** 试解析：走真实的后端实现，所以填错字段会在这里就暴露。 */
  const runPreview = async () => {
    setPreviewBusy(true)
    setLocalError(null)
    try {
      setPreview(await ipc.previewGenericSource(customId, customPath, formMapping))
    } catch (error) {
      setPreview(null)
      setLocalError(error instanceof Error ? error.message : String(error))
    } finally {
      setPreviewBusy(false)
    }
  }

  /** 保存自定义来源：写进设置草稿，回到列表。 */
  const saveCustom = () => {
    const id = customId
    patchSource(id, {
      enabled: true,
      path: customPath.trim(),
      displayName: customName.trim(),
      mapping: formMapping,
    })
    setSourceId(id)
    setMode('configure')
  }

  const title =
    mode === 'import'
      ? t('settings.importTitle')
      : mode === 'custom'
        ? sourceId
          ? t('settings.customEditTitle', { name: customName })
          : t('settings.customTitle')
        : mode === 'configure' && current
          ? t('settings.configureTitle', { name: current.displayName })
          : t('settings.addSourceTitle')
  const subtitle =
    mode === 'import' || mode === 'configure' || mode === 'custom'
      ? undefined
      : t('settings.addSourceDesc')

  return (
    <Drawer title={title} subtitle={subtitle} onClose={onClose} widthClass="w-[460px]">
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

            {/* 自定义来源是「满足所有人」的入口，放在列表最前面 */}
            <button
              type="button"
              onClick={() => openCustomForm()}
              className="shrink-0 rounded-panel border border-line px-3 py-2 text-left transition-colors hover:border-line-strong hover:bg-hover"
            >
              <span className="flex items-center gap-2">
                <span className="min-w-0 flex-1 text-body font-medium text-ink">
                  {t('settings.customEntry')}
                </span>
                <StatusPill size="sm" tone="accent">
                  {t('settings.customBadge')}
                </StatusPill>
              </span>
              <span className="block pt-0.5 text-meta leading-5 text-ink-muted">
                {t('settings.customEntryHint')}
              </span>
            </button>

            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
              {candidates.length === 0 ? (
                <p className="text-body text-ink-muted">{t('settings.addSourceEmpty')}</p>
              ) : filtered.length === 0 ? (
                <p className="text-body text-ink-muted">{t('settings.addSourceNoMatch')}</p>
              ) : (
                filtered.map((view) => (
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
                    <p className="px-2.5 text-meta leading-5 text-ink-muted">{view.description}</p>
                    {/* 还没适配 ≠ 永远不能用：把「我们还没做」直接接上「那我自己接」 */}
                    {view.access === 'pending' ? (
                      <div className="px-2.5 pb-2 pt-1">
                        <Button size="sm" tone="ghost" onClick={() => openCustomForm(view)}>
                          {t('settings.useCustomSource')}
                        </Button>
                      </div>
                    ) : (
                      <div className="pb-1.5" />
                    )}
                  </div>
                ))
              )}
            </div>
            <p className="shrink-0 border-t border-line-subtle pt-3 text-meta text-ink-muted">
              {t('settings.addSourceHint')}
            </p>
          </>
        ) : null}

        {mode === 'custom' ? (
          <>
            <FormField label={t('settings.customName')}>
              {(props) => (
                <TextInput
                  {...props}
                  value={customName}
                  placeholder={t('settings.customNamePlaceholder')}
                  onChange={(event) => {
                    setCustomName(event.target.value)
                    if (!idTouched) setCustomId(slugify(event.target.value))
                  }}
                />
              )}
            </FormField>
            <FormField label={t('settings.customSourceId')} hint={t('settings.importSourceIdHint')}>
              {(props) => (
                <TextInput
                  {...props}
                  value={customId}
                  placeholder="my-agent"
                  aria-invalid={Boolean(customId) && !validSlug(customId)}
                  className="font-mono text-meta"
                  onChange={(event) => {
                    setIdTouched(true)
                    setCustomId(slugify(event.target.value))
                  }}
                />
              )}
            </FormField>
            <FormField label={t('settings.customDir')}>
              {(props) => (
                <div className="flex items-center gap-1.5">
                  <TextInput
                    {...props}
                    value={customPath}
                    placeholder="~/.my-agent/sessions"
                    className="flex-1 font-mono text-meta"
                    onChange={(event) => setCustomPath(event.target.value)}
                  />
                  <Button
                    onClick={() =>
                      void (async () => {
                        try {
                          const selected = await openDialog({
                            directory: true,
                            multiple: false,
                            title: t('settings.pickDirectory'),
                          })
                          if (typeof selected === 'string' && selected.trim()) {
                            setCustomPath(selected)
                            setPreview(null)
                          }
                        } catch (error) {
                          setLocalError(error instanceof Error ? error.message : String(error))
                        }
                      })()
                    }
                  >
                    {t('settings.pickDirectory')}
                  </Button>
                </div>
              )}
            </FormField>

            <FormField label={t('settings.customLayout')}>
              {(props) => (
                <Select
                  {...props}
                  value={mapping.layout}
                  onChange={(value) => {
                    const layout = value as 'jsonl' | 'json'
                    setMapping((current) => ({ ...current, layout }))
                    // 布局决定默认扩展名：改布局后扩展名往往也要跟着改
                    setExtensionsText((current) =>
                      current.trim() === 'jsonl' || current.trim() === 'json'
                        ? layout
                        : current,
                    )
                  }}
                  options={[
                    { value: 'jsonl', label: t('settings.customLayoutJsonl') },
                    { value: 'json', label: t('settings.customLayoutJson') },
                  ]}
                />
              )}
            </FormField>

            {mapping.layout === 'json' ? (
              <FormField label={t('settings.customMessagesPath')} hint={t('settings.customMessagesPathHint')}>
                {(props) => (
                  <TextInput
                    {...props}
                    value={mapping.messagesPath}
                    className="font-mono text-meta"
                    onChange={(event) => setMapping((c) => ({ ...c, messagesPath: event.target.value }))}
                  />
                )}
              </FormField>
            ) : null}

            <div className="grid grid-cols-2 gap-3">
              <FormField label={t('settings.customRoleField')}>
                {(props) => (
                  <TextInput
                    {...props}
                    value={mapping.roleField}
                    className="font-mono text-meta"
                    onChange={(event) => setMapping((c) => ({ ...c, roleField: event.target.value }))}
                  />
                )}
              </FormField>
              <FormField label={t('settings.customTextField')}>
                {(props) => (
                  <TextInput
                    {...props}
                    value={mapping.textField}
                    className="font-mono text-meta"
                    onChange={(event) => setMapping((c) => ({ ...c, textField: event.target.value }))}
                  />
                )}
              </FormField>
            </div>

            <FormField label={t('settings.customTimeField')} hint={t('settings.customOptionalHint')}>
              {(props) => (
                <TextInput
                  {...props}
                  value={mapping.timeField}
                  className="font-mono text-meta"
                  onChange={(event) => setMapping((c) => ({ ...c, timeField: event.target.value }))}
                />
              )}
            </FormField>

            <div>
              <Button
                tone="ghost"
                size="sm"
                aria-expanded={advancedOpen}
                onClick={() => setAdvancedOpen((value) => !value)}
              >
                {advancedOpen ? t('common.collapse') : t('common.expand')} {t('settings.customAdvanced')}
              </Button>
            </div>

            {advancedOpen ? (
              <div className="flex flex-col gap-3 border-l-2 border-line pl-3">
                <div className="grid grid-cols-2 gap-3">
                  <FormField label={t('settings.customTitleField')}>
                    {(props) => (
                      <TextInput
                        {...props}
                        value={mapping.titleField}
                        className="font-mono text-meta"
                        onChange={(event) => setMapping((c) => ({ ...c, titleField: event.target.value }))}
                      />
                    )}
                  </FormField>
                  <FormField label={t('settings.customProjectField')}>
                    {(props) => (
                      <TextInput
                        {...props}
                        value={mapping.projectField}
                        className="font-mono text-meta"
                        onChange={(event) => setMapping((c) => ({ ...c, projectField: event.target.value }))}
                      />
                    )}
                  </FormField>
                </div>
                <FormField label={t('settings.customToolField')} hint={t('settings.customOptionalHint')}>
                  {(props) => (
                    <TextInput
                      {...props}
                      value={mapping.toolField}
                      className="font-mono text-meta"
                      onChange={(event) => setMapping((c) => ({ ...c, toolField: event.target.value }))}
                    />
                  )}
                </FormField>
                <FormField label={t('settings.customExtensions')} hint={t('settings.customExtensionsHint')}>
                  {(props) => (
                    <TextInput
                      {...props}
                      value={extensionsText}
                      className="font-mono text-meta"
                      onChange={(event) => {
                        setExtensionsText(event.target.value)
                        setPreview(null)
                      }}
                    />
                  )}
                </FormField>
                <FormField label={t('settings.customRoleMap')} hint={t('settings.customRoleMapHint')}>
                  {(props) => (
                    <TextInput
                      {...props}
                      value={roleMapText}
                      placeholder="bot=assistant, human=user"
                      className="font-mono text-meta"
                      onChange={(event) => setRoleMapText(event.target.value)}
                    />
                  )}
                </FormField>
                <FormField label={t('settings.customMaxDepth')}>
                  {(props) => (
                    <TextInput
                      {...props}
                      value={String(mapping.maxDepth)}
                      inputMode="numeric"
                      className="tabular-nums"
                      onChange={(event) =>
                        setMapping((c) => ({
                          ...c,
                          maxDepth: Math.min(32, Math.max(1, Number(event.target.value) || 1)),
                        }))
                      }
                    />
                  )}
                </FormField>
              </div>
            ) : null}

            {/* 试解析结果：填错映射要在这里就看得见，而不是扫描完才发现一条都没有 */}
            {preview ? (
              <div className="rounded-panel border border-line p-3">
                <div className="text-body text-ink" role="status">
                  {t('settings.customPreviewSummary', {
                    files: preview.filesFound,
                    sessions: preview.sessionsSampled,
                    messages: preview.messages,
                  })}
                </div>
                {preview.messages === 0 ? (
                  <p className="pt-1 text-meta text-warning">{t('settings.customPreviewEmpty')}</p>
                ) : null}
                {preview.samples.map((sample) => (
                  <div key={sample.file} className="border-t border-line-subtle pt-2 first:border-t-0 first:pt-0">
                    <div className="min-w-0 truncate pt-2 font-mono text-tech text-ink-faint" title={sample.file}>
                      {sample.title ?? sample.file}
                    </div>
                    {sample.messages.map((message, index) => (
                      <div key={index} className="pt-1.5">
                        <div className="text-meta text-ink-muted">
                          {message.role}
                          {message.kind !== 'message' ? ` · ${message.kind}` : ''}
                          {message.timestamp ? ` · ${message.timestamp}` : ''}
                        </div>
                        <div className="line-clamp-2 text-meta leading-5 text-ink">{message.text}</div>
                      </div>
                    ))}
                  </div>
                ))}
                {preview.warnings.length > 0 ? (
                  <div className="pt-2">
                    <Notice tone="warning" title={t('settings.customPreviewWarnings')}>
                      {preview.warnings.join('；')}
                    </Notice>
                  </div>
                ) : null}
              </div>
            ) : null}

            {customErrors.length > 0 ? (
              <ul className="text-meta text-ink-muted">
                {customErrors.map((error) => (
                  <li key={error}>· {error}</li>
                ))}
              </ul>
            ) : null}

            <div className="flex flex-wrap gap-2 border-t border-line-subtle pt-3">
              <Button
                onClick={() => void runPreview()}
                loading={previewBusy}
                disabled={!customPath.trim() || !validSlug(customId) || previewBusy}
              >
                {t('settings.customPreviewAction')}
              </Button>
              <Button
                tone="primary"
                onClick={saveCustom}
                disabled={customErrors.length > 0}
              >
                {t('settings.customSave')}
              </Button>
              <Button tone="ghost" onClick={() => setMode('add')}>
                {t('common.cancel')}
              </Button>
            </div>
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
            {current.isCustom ? (
              <>
                <Field label={t('settings.customDir')} mono>
                  {draft?.sources?.[current.id]?.path ?? ''}
                </Field>
                <div className="flex flex-wrap items-center gap-2">
                  <Button onClick={() => openCustomForm(current)}>{t('settings.customEditMapping')}</Button>
                  <Button
                    tone="ghost"
                    onClick={() => {
                      if (!draft) return
                      const rest = { ...draft.sources }
                      delete rest[current.id]
                      patchSettingsDraft({ sources: rest })
                      setMode('add')
                    }}
                    title={t('settings.customRemoveHint')}
                  >
                    {t('settings.customRemove')}
                  </Button>
                </div>
                <p className="text-meta text-ink-muted">{t('settings.customRemoveHint')}</p>
              </>
            ) : current.access === 'native' ? (
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
