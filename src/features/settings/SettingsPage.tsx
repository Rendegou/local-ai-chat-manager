/**
 * 设置页（规格 §6.4；信息架构见 docs/DESIGN.md §10）。
 *
 * 分区导航 + 单分区内容的形态，取代过去「6 张卡片竖着堆成一条配置墙」：
 * 宽屏左侧 168px 列出五个分区，右侧只渲染当前分区（最大宽度 720px）；
 * 窄屏把分区导航收成页面顶部的 Select，表单单列。
 *
 * 数据源区不再是 8 个来源 × （Toggle + 路径输入 + 说明）的全展开，
 * 而是「每个已连接来源一行」+ 两个 Secondary 操作（添加来源 / 导入会话）；
 * 路径编辑与导入都收进 SourceManagerDrawer（DESIGN_AUDIT §2）。
 *
 * 错误策略：全局异步错误只在 App Shell 的 ErrorNotice 显示；这里只保留
 * 与设置流程直接相关的错误（例如目录选择失败）。
 */
import { useEffect, useState } from 'react'
import { open as openDialog } from '@tauri-apps/plugin-dialog'

import * as ipc from '../../lib/ipc'
import { formatTime } from '../../lib/format'
import { useSourceViews } from '../../lib/sources'
import { useLibrary } from '../../stores/library'
import { useT } from '../../lib/i18n'
import {
  Button,
  DirectoryInput,
  Dot,
  Field,
  FormField,
  Notice,
  PanelHeader,
  Section,
  Select,
  StatusPill,
  TextInput,
  Toggle,
} from '../../components/ui'
import { SourceManagerDrawer, sourceStatusLabel, type SourceManagerMode } from './SourceManagerDrawer'

/** 设置分区（顺序即左侧导航顺序）。 */
const SECTIONS = ['sources', 'sync', 'scan', 'appearance', 'diagnostics'] as const
type SectionKey = (typeof SECTIONS)[number]

/** 状态 → 色点语气（状态文字始终同时出现，不靠颜色单独表意）。 */
function statusDot(status: string): 'success' | 'warning' | 'danger' | 'neutral' {
  if (status === 'available') return 'success'
  if (status === 'partial') return 'warning'
  if (status === 'error') return 'danger'
  return 'neutral'
}

export function SettingsPage() {
  const t = useT()
  const {
    settings,
    settingsDraft,
    settingsDirty,
    patchSettingsDraft,
    saveSettingsDraft,
    resetSettingsDraft,
    scan,
    scanning,
    settingsSection: section,
    setSettingsSection,
    setAppearance,
  } = useLibrary()
  const views = useSourceViews()
  const setSection = (key: SectionKey) => setSettingsSection(key)
  const [dataPath, setDataPath] = useState('')
  const [machine, setMachine] = useState('')
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<string | null>(null)
  const [rebuildConfirm, setRebuildConfirm] = useState(false)
  /** 抽屉：null 表示关闭 */
  const [drawer, setDrawer] = useState<{ mode: SourceManagerMode; sourceId?: string } | null>(null)
  /** 设置流程自己的错误（全局错误由 App Shell 统一显示，不在这里重复） */
  const [localError, setLocalError] = useState<string | null>(null)
  // 草稿优先，没有草稿时用已保存设置
  const draft = settingsDraft ?? settings

  useEffect(() => {
    void ipc.dataDir().then(setDataPath)
    void ipc.machineId().then(setMachine)
  }, [])

  if (!draft) {
    return (
      <>
        <PanelHeader headingLevel={1} title={t('settings.title')} />
        <div className="p-4 text-body text-ink-muted">{t('settings.loading')}</div>
      </>
    )
  }

  const patch = patchSettingsDraft
  const connected = views.filter((view) => view.visibleInConnectedSettings)

  const pickDirectory = async (key: 'syncRepo') => {
    setLocalError(null)
    try {
      const selected = await openDialog({ directory: true, multiple: false, title: t('settings.pickDirectory') })
      if (typeof selected === 'string' && selected.trim()) patch({ [key]: selected })
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : String(error))
    }
  }

  const save = async () => {
    setSaving(true)
    const ok = await saveSettingsDraft()
    setSaving(false)
    if (ok) setSavedAt(new Date().toISOString())
  }

  const sectionLabels: Record<SectionKey, string> = {
    sources: t('settings.sectionSources'),
    sync: t('settings.sectionSync'),
    scan: t('settings.sectionScan'),
    appearance: t('settings.sectionAppearance'),
    diagnostics: t('settings.sectionDiagnostics'),
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-canvas">
      <PanelHeader
        headingLevel={1}
        title={t('settings.title')}
        meta={
          settingsDirty ? (
            <StatusPill tone="warning">{t('settings.dirty')}</StatusPill>
          ) : savedAt ? (
            t('settings.savedAt', { time: formatTime(new Date(savedAt)) })
          ) : (
            t('settings.hint')
          )
        }
        actions={
          <>
            <Button tone="ghost" onClick={() => resetSettingsDraft()} disabled={!settingsDirty || saving}>
              {t('settings.revert')}
            </Button>
            {/* 本页唯一的主操作 */}
            <Button tone="primary" onClick={() => void save()} loading={saving} disabled={!settingsDirty}>
              {saving ? t('settings.saving') : t('settings.save')}
            </Button>
          </>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="mx-auto flex w-full max-w-[960px] flex-col gap-4 p-4 lg:flex-row lg:gap-6">
          {/* 分区导航：≥1024px 常驻左侧 */}
          <nav aria-label={t('settings.navAria')} className="hidden w-[168px] shrink-0 lg:block">
            <div className="sticky top-0 flex flex-col gap-0.5">
              {SECTIONS.map((key) => (
                <button
                  key={key}
                  type="button"
                  aria-current={section === key ? 'true' : undefined}
                  onClick={() => setSection(key)}
                  className={`h-8 rounded-control px-2.5 text-left text-ui transition-colors ${
                    section === key
                      ? 'bg-selected font-medium text-ink'
                      : 'text-ink-muted hover:bg-hover hover:text-ink'
                  }`}
                >
                  {sectionLabels[key]}
                </button>
              ))}
            </div>
          </nav>

          {/* 窄屏：分区导航收成 Select */}
          <div className="lg:hidden">
            <Select
              value={section}
              onChange={(value) => setSection(value as SectionKey)}
              aria-label={t('settings.navAria')}
              options={SECTIONS.map((key) => ({ value: key, label: sectionLabels[key] }))}
            />
          </div>

          <div className="flex min-w-0 flex-1 flex-col gap-6 lg:max-w-[720px]">
            {localError ? <Notice tone="danger" title={localError} /> : null}

            {/* 1. 数据源 */}
            {section === 'sources' ? (
              <Section
                title={t('settings.connectedTitle')}
                description={t('settings.connectedDesc')}
                actions={
                  <>
                    <Button size="sm" onClick={() => setDrawer({ mode: 'add' })}>
                      {t('settings.addSource')}
                    </Button>
                    <Button size="sm" tone="ghost" onClick={() => setDrawer({ mode: 'import' })}>
                      {t('settings.importSessions')}
                    </Button>
                  </>
                }
              >
                {connected.length === 0 ? (
                  <p className="text-body text-ink-muted">{t('settings.connectedEmpty')}</p>
                ) : (
                  <div className="border-t border-line-subtle">
                    {connected.map((view) => (
                      <div
                        key={view.id}
                        className="flex items-center gap-3 border-b border-line-subtle py-2.5"
                      >
                        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                          <div className="flex min-w-0 items-center gap-2">
                            <Dot tone={statusDot(view.status)} />
                            <span className="min-w-0 truncate text-body text-ink">{view.displayName}</span>
                            {/* 用户自己接进来的来源要能一眼看出是自己的，而不是产品内置的 */}
                            {view.isCustom ? (
                              <StatusPill size="sm" tone="accent">
                                {t('settings.customBadge')}
                              </StatusPill>
                            ) : null}
                            <span className="shrink-0 text-meta text-ink-muted">
                              {sourceStatusLabel(view.status, view.enabled, t)}
                            </span>
                            <span className="shrink-0 text-meta tabular-nums text-ink-faint">
                              {t('settings.sourceSessions', { n: view.sessionCount })}
                            </span>
                          </div>
                          <span
                            className="min-w-0 truncate font-mono text-tech text-ink-faint"
                            title={view.rootPath ?? undefined}
                          >
                            {view.rootPath ?? t('settings.autoDiscovered')}
                          </span>
                        </div>
                        <Toggle
                          bare
                          label={view.displayName}
                          checked={view.enabled}
                          onChange={(enabled) =>
                            patch({
                              sources: {
                                ...draft.sources,
                                [view.id]: {
                                  enabled,
                                  path: draft.sources?.[view.id]?.path ?? null,
                                },
                              },
                            })
                          }
                        />
                        <Button
                          size="sm"
                          tone="ghost"
                          onClick={() => setDrawer({ mode: 'configure', sourceId: view.id })}
                        >
                          {t('settings.configure')}
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </Section>
            ) : null}

            {/* 2. 同步与隐私 */}
            {section === 'sync' ? (
              <Section title={t('settings.syncTitle')} description={t('settings.syncDesc')}>
                <FormField label={t('settings.repoDir')}>
                  {(props) => (
                    <DirectoryInput
                      {...props}
                      value={draft.syncRepo ?? ''}
                      onChange={(value) => patch({ syncRepo: value || null })}
                      placeholder="D:\AIChatRepo"
                      onBrowse={() => void pickDirectory('syncRepo')}
                    />
                  )}
                </FormField>
                <FormField label={t('settings.remoteUrl')} hint={t('settings.remoteUrlHint')}>
                  {(props) => (
                    <TextInput
                      {...props}
                      value={draft.remoteUrl ?? ''}
                      onChange={(event) => patch({ remoteUrl: event.target.value || null })}
                      placeholder="https://github.com/you/aichat-history.git"
                    />
                  )}
                </FormField>
                <FormField label={t('settings.gitExe')} hint={t('settings.gitExeHint')}>
                  {(props) => (
                    <TextInput
                      {...props}
                      value={draft.gitExe}
                      onChange={(event) => patch({ gitExe: event.target.value })}
                      placeholder="git"
                    />
                  )}
                </FormField>
                {/* 隐私是「风险」，属于允许使用 Notice 的场景 */}
                <Notice tone="warning" title={t('settings.privateRepoTitle')}>
                  {t('settings.privateRepoBody')}
                </Notice>
              </Section>
            ) : null}

            {/* 3. 扫描与归档 */}
            {section === 'scan' ? (
              <Section title={t('settings.scanTitle')} description={t('settings.scanDesc')}>
                <FormField label={t('settings.compression')}>
                  {(props) => (
                    <Select
                      {...props}
                      value={draft.archiveCompression}
                      onChange={(value) => patch({ archiveCompression: value as 'zstd' | 'gzip' })}
                      options={[
                        { value: 'zstd', label: t('settings.zstdLabel') },
                        { value: 'gzip', label: t('settings.gzipLabel') },
                      ]}
                    />
                  )}
                </FormField>
                <FormField label={t('settings.archiveDays')} hint={t('settings.archiveDaysHint')}>
                  {(props) => (
                    <TextInput
                      {...props}
                      value={String(draft.archiveAfterDays)}
                      onChange={(event) => patch({ archiveAfterDays: Number(event.target.value) || 0 })}
                      inputMode="numeric"
                      className="tabular-nums"
                    />
                  )}
                </FormField>
                <FormField label={t('settings.scanLimit')} hint={t('settings.scanLimitHint')}>
                  {(props) => (
                    <TextInput
                      {...props}
                      value={String(draft.scanBatchLimit)}
                      onChange={(event) => patch({ scanBatchLimit: Number(event.target.value) || 0 })}
                      inputMode="numeric"
                      className="tabular-nums"
                    />
                  )}
                </FormField>
              </Section>
            ) : null}

            {/* 4. 外观与行为 */}
            {section === 'appearance' ? (
              <Section title={t('settings.appearanceTitle')} description={t('settings.appearanceDesc')}>
                <Toggle
                  label={t('settings.keepRaw')}
                  description={t('settings.keepRawDesc')}
                  checked={draft.keepRawFiles}
                  onChange={(value) => patch({ keepRawFiles: value })}
                />
                <Toggle
                  label={t('settings.autoScan')}
                  description={t('settings.autoScanDesc')}
                  checked={draft.autoScanOnStart}
                  onChange={(value) => patch({ autoScanOnStart: value })}
                />
                <Toggle
                  label={t('settings.watch')}
                  description={t('settings.watchDesc')}
                  checked={draft.watchEnabled}
                  onChange={(value) => patch({ watchEnabled: value })}
                />
                <Toggle
                  label={t('settings.showArchived')}
                  checked={draft.showArchived}
                  onChange={(value) => patch({ showArchived: value })}
                />
                {/* 主题与语言即时生效并立即落盘：不进入「草稿 + 保存」流程，
                    否则会出现「界面已经变了，却被告知有未保存修改」的矛盾。 */}
                <p className="text-meta text-ink-muted">{t('settings.appearanceImmediate')}</p>
                <FormField label={t('settings.theme')}>
                  {(props) => (
                    <Select
                      {...props}
                      value={draft.theme}
                      onChange={(value) => void setAppearance({ theme: value as 'system' | 'light' | 'dark' })}
                      options={[
                        { value: 'system', label: t('settings.themeSystem') },
                        { value: 'light', label: t('settings.themeLight') },
                        { value: 'dark', label: t('settings.themeDark') },
                      ]}
                    />
                  )}
                </FormField>
                <FormField label={t('settings.language')}>
                  {(props) => (
                    <Select
                      {...props}
                      value={draft.language}
                      onChange={(value) => void setAppearance({ language: value as 'system' | 'zh' | 'en' })}
                      options={[
                        { value: 'system', label: t('settings.languageSystem') },
                        { value: 'zh', label: t('settings.languageZh') },
                        { value: 'en', label: t('settings.languageEn') },
                      ]}
                    />
                  )}
                </FormField>
              </Section>
            ) : null}

            {/* 5. 诊断与安全 */}
            {section === 'diagnostics' ? (
              <>
                <Section title={t('settings.diagnosticsTitle')} description={t('settings.diagnosticsDesc')}>
                  <Field label={t('settings.dataDir')} mono>
                    {dataPath}
                  </Field>
                  <Field label={t('settings.machineId')} mono>
                    {machine}
                  </Field>
                  <Field label={t('settings.indexSize')} mono>
                    {useLibrary.getState().stats
                      ? t('settings.bytes', { n: useLibrary.getState().stats?.bytesOnDisk ?? 0 })
                      : '—'}
                  </Field>
                  <div>
                    <Button onClick={() => void scan(false)} loading={scanning}>
                      {t('settings.scanNow')}
                    </Button>
                  </div>
                </Section>

                {/* 危险区是 Card 的正当用法之一（docs/DESIGN.md §7） */}
                <section className="rounded-panel border border-danger/35 bg-danger/6 p-4">
                  <h2 className="text-section text-danger">{t('settings.dangerTitle')}</h2>
                  <p className="pt-0.5 text-meta text-ink-muted">{t('settings.dangerDesc')}</p>
                  <p className="pt-2 text-body text-ink-muted">{t('settings.dangerBody')}</p>
                  {rebuildConfirm ? (
                    <div className="flex flex-wrap items-center gap-2 pt-3">
                      <span className="text-body text-danger">{t('settings.rebuildConfirm')}</span>
                      <Button
                        tone="danger"
                        onClick={() => {
                          setRebuildConfirm(false)
                          void scan(true)
                        }}
                      >
                        {t('settings.rebuildConfirmButton')}
                      </Button>
                      <Button tone="ghost" onClick={() => setRebuildConfirm(false)}>
                        {t('common.cancel')}
                      </Button>
                    </div>
                  ) : (
                    <div className="pt-3">
                      <Button tone="danger" onClick={() => setRebuildConfirm(true)}>
                        {t('settings.rebuild')}
                      </Button>
                    </div>
                  )}
                </section>
              </>
            ) : null}
          </div>
        </div>
      </div>

      {drawer ? (
        <SourceManagerDrawer
          initialMode={drawer.mode}
          initialSourceId={drawer.sourceId}
          onClose={() => setDrawer(null)}
        />
      ) : null}
    </div>
  )
}
