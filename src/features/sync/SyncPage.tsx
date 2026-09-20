/**
 * 同步页（规格 §6.3；信息架构见 docs/DESIGN.md §10）。
 *
 * 重构要点（docs/DESIGN_AUDIT.md §6）：
 * 1. Header 只留「刷新」和「打开仓库」——原来 Header 和「下一步」提示里各有一颗
 *    「立即同步」，用户看到两个语义完全相同的主按钮；
 * 2. 独立的「下一步」Notice 被合并进一个扁平 `SyncSummary`，按**决策顺序**排列：
 *    仓库 → 远端 → 分支 → 最近拉取/推送 → 待同步会话/字节/本地变更/ahead·behind
 *    → 隐私提示 → 推荐下一步 → 唯一主操作。
 *    原先把「待同步会话数」「预计写入字节」放在按钮**下方**，等于先让人按按钮再告诉他
 *    会推送多少数据离开本机；
 * 3. 主操作按状态唯一决定，`clean` 状态不显示强 Primary；
 * 4. 普通状态不再使用大型彩色 Notice——只有错误、冲突、隐私风险才用。
 */
import { useEffect, useState } from 'react'
import { openPath } from '@tauri-apps/plugin-opener'

import * as ipc from '../../lib/ipc'
import { formatBytes, formatDateTime, formatDuration, formatRelative } from '../../lib/format'
import { useT } from '../../lib/i18n'
import { useSync } from '../../stores/sync'
import { useLibrary } from '../../stores/library'
import { useSourceViews } from '../../lib/sources'
import type { GitCommit } from '../../types/ipc'
import {
  Button,
  EmptyState,
  Field,
  Icon,
  IconButton,
  ListRow,
  Notice,
  PanelHeader,
  Section,
  Spinner,
  StatusPill,
  TextInput,
} from '../../components/ui'

/** 唯一主操作的种类；null = 当前状态不需要强 Primary（clean / conflict）。 */
type PrimaryKind = 'settings' | 'saveRemote' | 'sync' | 'retry' | null

export function SyncPage() {
  const t = useT()
  const {
    status,
    report,
    archives,
    running,
    progress,
    error,
    refresh,
    run,
    abortRebase,
    loadArchives,
    archiveOld,
    restore,
    clearError,
  } = useSync()
  const { loadSessions, setPage } = useLibrary()
  // 用 SourceView 而不是裸的 SourceRow：它带上了 catalog 的可翻译描述，
  // 而未发现来源的说明就不再需要后端把中文塞进 notes
  const sourceViews = useSourceViews()
  const [remoteInput, setRemoteInput] = useState('')
  const [log, setLog] = useState<GitCommit[] | null>(null)
  const [logBusy, setLogBusy] = useState(false)
  const [advancedOpen, setAdvancedOpen] = useState(false)

  useEffect(() => {
    void refresh()
    void loadArchives()
  }, [refresh, loadArchives])

  // 后端推送的同步步骤
  useEffect(() => {
    let unlisten: (() => void) | undefined
    void ipc
      .onSyncProgress((step) => useSync.getState().setProgress(step))
      .then((fn) => {
        unlisten = fn
      })
    return () => unlisten?.()
  }, [])

  const repoConfigured = Boolean(status?.repo)
  const conflict = status?.conflict ?? report?.conflict ?? null
  const pending = status?.pendingSessions ?? 0
  const changes = status?.localChanges ?? 0
  const ahead = status?.ahead ?? 0
  // 设置里已保存远端地址时，同步会自动应用，视为已配置
  const remoteConfigured = Boolean(status?.remote || status?.settingsRemote)
  const failedSteps = report?.steps.filter((step) => !step.ok) ?? []
  const pushAuthFailed = failedSteps.some((step) => step.detail.includes('publickey'))
  /** 真的有数据会离开本机时才提醒隐私——clean 状态下这条提醒只是噪音。 */
  const willSendData = pending > 0 || changes > 0 || ahead > 0

  /** 唯一主操作：状态决定种类，同一屏内绝不超过一个。 */
  const primary: PrimaryKind = (() => {
    if (conflict) return null
    if (!repoConfigured) return 'settings'
    if (!remoteConfigured) return 'saveRemote'
    if (failedSteps.length > 0) return 'retry'
    if (pending > 0 || changes > 0 || ahead > 0) return 'sync'
    if (status?.remote && !status?.lastPush) return 'sync'
    return null
  })()

  /** 推荐下一步的说明文案（纯文本，不再是一整块彩色 Notice）。 */
  const nextStepText = (() => {
    if (conflict) return t('sync.nextConflictBody')
    if (!repoConfigured) return t('sync.nextBindBody')
    if (!remoteConfigured) return t('sync.nextRemoteBody')
    if (failedSteps.length > 0) return t('sync.nextFailedBody')
    if (pending > 0) return t('sync.nextPendingBody')
    if (status?.remote && !status?.lastPush) return t('sync.nextPushBody')
    if (ahead > 0) return t('sync.nextAheadBody')
    return t('sync.cleanBody')
  })()

  /** 渲染唯一主操作。 */
  const primaryButton = primary ? (
    <Button
      tone="primary"
      loading={running}
      disabled={
        primary === 'saveRemote' ? !remoteInput.trim() : !repoConfigured && primary !== 'settings'
      }
      onClick={() => {
        if (primary === 'settings') {
          setPage('settings')
          return
        }
        if (primary === 'saveRemote') {
          void run({ push: false, setRemote: remoteInput })
          return
        }
        void run({ push: true })
      }}
    >
      {running
        ? t('sync.syncing')
        : primary === 'settings'
          ? t('sync.goSettings')
          : primary === 'saveRemote'
            ? t('sync.saveRemoteAndSync')
            : primary === 'retry'
              ? t('sync.retrySync')
              : t('sync.syncNow')}
    </Button>
  ) : null

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-canvas">
      <PanelHeader
        headingLevel={1}
        title={t('sync.title')}
        meta={
          <span className="flex items-center gap-2">
            <span className="truncate text-tech">{status?.repo ?? t('sync.noRepo')}</span>
            {status?.isRepo ? (
              <StatusPill tone={conflict ? 'danger' : 'success'}>
                {conflict ? t('sync.conflictPending') : t('sync.repoOk')}
              </StatusPill>
            ) : null}
          </span>
        }
        actions={
          <>
            <IconButton
              label={t('sync.refresh')}
              onClick={() => void refresh()}
              className={running ? 'opacity-55' : ''}
            >
              <Icon name="refresh" />
            </IconButton>
            <Button
              tone="ghost"
              onClick={() => {
                if (status?.repo) void openPath(status.repo)
              }}
              disabled={!repoConfigured}
            >
              {t('sync.openRepo')}
            </Button>
          </>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4">
        <div className="mx-auto flex w-full max-w-[820px] flex-col gap-6">
          {/* 同步执行/刷新失败：此前静默不可见，失败反馈必须持续到用户看到 */}
          {error ? (
            <Notice
              tone="danger"
              title={error.message}
              actions={
                <IconButton label={t('sync.dismissError')} size="sm" onClick={clearError}>
                  <Icon name="close" />
                </IconButton>
              }
            >
              {error.detail ?? error.kind}
            </Notice>
          ) : null}

          {/* 冲突：可靠性样板，永远排在最前面 */}
          {conflict ? (
            <Notice
              tone="danger"
              title="Sync Conflict"
              actions={
                <>
                  {conflict.inRebase ? (
                    <Button tone="danger" size="sm" onClick={() => void abortRebase()}>
                      {t('sync.abortRebase')}
                    </Button>
                  ) : null}
                  <Button size="sm" onClick={() => void run({ push: true })} disabled={running}>
                    {t('sync.retrySync')}
                  </Button>
                  {status?.repo ? (
                    <Button
                      tone="ghost"
                      size="sm"
                      onClick={() => {
                        if (status?.repo) void openPath(status.repo)
                      }}
                    >
                      {t('sync.openRepo')}
                    </Button>
                  ) : null}
                </>
              }
            >
              <div>{conflict.message}</div>
              <div className="pt-1 text-meta text-ink-muted">{t('sync.conflictNote')}</div>
              <ul className="pt-0.5 text-tech text-ink-muted">
                {conflict.files.map((file) => (
                  <li key={file}>· {file}</li>
                ))}
              </ul>
            </Notice>
          ) : null}

          {/* 步骤级失败（推送认证失败、拉取失败等）：不抛错也要有持续到用户看到的反馈 */}
          {!conflict && failedSteps.length > 0 ? (
            <Notice tone="danger" title={t('sync.nextFailedTitle')}>
              <ul>
                {failedSteps.map((step) => (
                  <li key={step.name}>
                    · {step.name}：{step.detail || t('sync.unknownReason')}
                  </li>
                ))}
              </ul>
              {pushAuthFailed ? (
                <div className="pt-1 text-meta text-ink-muted">{t('sync.sshHint')}</div>
              ) : null}
            </Notice>
          ) : null}

          {!repoConfigured ? (
            <EmptyState
              title={t('sync.emptyTitle')}
              description={t('sync.emptyDescription')}
              primaryAction={
                <Button tone="primary" onClick={() => setPage('settings')}>
                  {t('sync.emptyPrimary')}
                </Button>
              }
              secondaryAction={
                <Button tone="ghost" onClick={() => void loadSessions()}>
                  {t('sync.emptySecondary')}
                </Button>
              }
            />
          ) : (
            <>
              {/*
               * 扁平同步概览：决策所需的信息全部排在唯一主操作**之前**，
               * 顺序固定为 仓库 → 远端 → 分支 → 时间 → 规模 → 隐私 → 下一步 → 动作。
               */}
              <section
                aria-labelledby="sync-summary-title"
                className="flex flex-col border-b border-line pb-6"
              >
                <h2 id="sync-summary-title" className="text-section text-ink">
                  {t('sync.summaryTitle')}
                </h2>
                <p className="pb-2 pt-0.5 text-meta text-ink-muted">{t('sync.summaryDesc')}</p>

                <div className="grid gap-x-6 sm:grid-cols-2">
                  <Field label={t('sync.fieldRepo')} mono>
                    {status?.repo ?? '—'}
                  </Field>
                  <Field label={t('sync.fieldBranch')} mono>
                    {status?.branch || '—'}
                  </Field>
                  <Field label={t('sync.fieldRemote')} mono>
                    {status?.remote ?? t('sync.notConfigured')}
                  </Field>
                  <Field label="git" mono>
                    {status?.gitVersion ?? t('sync.noGit')}
                  </Field>
                  <Field label={t('sync.lastPull')}>{formatDateTime(status?.lastPull)}</Field>
                  <Field label={t('sync.lastPush')}>{formatDateTime(status?.lastPush)}</Field>
                </div>

                {/* 规模：会不会有数据离开本机、有多少 */}
                <div className="grid gap-x-6 border-t border-line-subtle pt-2 sm:grid-cols-4">
                  <Field label={t('sync.pendingSessions')}>
                    <span className="tabular-nums">{t('sync.countUnit', { n: pending })}</span>
                  </Field>
                  <Field label={t('sync.pendingBytes')}>
                    <span className="tabular-nums">
                      {t('sync.approx', { bytes: formatBytes(status?.pendingBytes ?? 0) })}
                    </span>
                  </Field>
                  <Field label={t('sync.localChanges')}>
                    <span className="tabular-nums">{t('sync.filesCount', { n: changes })}</span>
                  </Field>
                  <Field label={t('sync.ahead')}>
                    <span className="tabular-nums">{t('sync.commitsCount', { n: ahead })}</span>
                  </Field>
                </div>

                {!remoteConfigured ? (
                  <div className="pt-2">
                    <FormlessRemoteInput
                      value={remoteInput}
                      onChange={setRemoteInput}
                      onSubmit={() => void run({ push: false, setRemote: remoteInput })}
                      disabled={running || !remoteInput.trim()}
                    />
                  </div>
                ) : null}

                {/* 隐私：只在真的有内容会离开本机时出现 */}
                {willSendData ? (
                  <div className="pt-3">
                    <Notice tone="warning" title={t('sync.privacyTitle')}>
                      {t('sync.privacyBody')}
                    </Notice>
                  </div>
                ) : null}

                <div className="flex flex-wrap items-center justify-between gap-3 pt-4">
                  <p className="min-w-0 flex-1 text-body text-ink-muted">{nextStepText}</p>
                  {/* 唯一主操作；clean 状态下 primary 为 null，这里显示弱化的状态文字 */}
                  {primaryButton ?? (
                    <span className="shrink-0 text-meta text-success">{t('sync.cleanState')}</span>
                  )}
                </div>
              </section>

              {/* 上一次同步结果 */}
              {report ? (
                <Section title={t('sync.reportTitle')} description={t('sync.reportDuration', { ms: report.durationMs })}>
                  {report.steps.map((step) => (
                    <ListRow
                      key={step.name}
                      leading={
                        <StatusPill size="sm" tone={step.ok ? 'success' : 'danger'}>
                          {step.ok ? t('sync.stepOk') : t('sync.stepFailed')}
                        </StatusPill>
                      }
                      title={step.name}
                      subtitle={step.detail}
                      trailing={
                        <span className="text-meta tabular-nums text-ink-muted">
                          {formatDuration(step.durationMs)}
                        </span>
                      }
                    />
                  ))}
                  {report.snapshot.written > 0 ? (
                    <div>
                      <div className="text-meta tabular-nums text-ink-muted">
                        {t('sync.snapshotSummary', {
                          n: report.snapshot.written,
                          bytes: formatBytes(report.snapshot.bytes),
                        })}
                      </div>
                      <ul className="max-h-40 overflow-y-auto overscroll-contain pt-1">
                        {report.snapshot.files.slice(0, 20).map((file) => (
                          <li key={file.relPath} className="flex items-baseline justify-between gap-3">
                            <span className="truncate text-tech text-ink-muted">{file.relPath}</span>
                            <span className="shrink-0 text-meta tabular-nums text-ink-muted">
                              {formatBytes(file.bytes)}
                            </span>
                          </li>
                        ))}
                        {report.snapshot.files.length > 20 ? (
                          <li className="text-meta text-ink-muted">
                            {t('sync.snapshotTotal', { n: report.snapshot.files.length })}
                          </li>
                        ) : null}
                      </ul>
                    </div>
                  ) : null}
                </Section>
              ) : null}

              {/* 归档与高级诊断（默认收起） */}
              <Section
                title={t('sync.advancedTitle')}
                description={t('sync.advancedDesc')}
                actions={
                  <Button
                    tone="ghost"
                    size="sm"
                    aria-expanded={advancedOpen}
                    onClick={() => setAdvancedOpen((value) => !value)}
                  >
                    {advancedOpen ? t('sync.collapse') : t('sync.expand')}
                  </Button>
                }
              >
                {advancedOpen ? (
                  <div className="flex flex-col gap-4">
                    <div>
                      <div className="flex items-center justify-between pb-1">
                        <span className="text-body text-ink">
                          {t('sync.archives', { n: archives.length })}
                        </span>
                        <Button tone="ghost" size="sm" onClick={() => void archiveOld()}>
                          {t('sync.archiveOld')}
                        </Button>
                      </div>
                      {archives.length === 0 ? (
                        <div className="text-meta text-ink-muted">{t('sync.noArchives')}</div>
                      ) : (
                        <div className="max-h-48 overflow-y-auto overscroll-contain">
                          {archives.map((entry) => (
                            <ListRow
                              key={entry.relPath}
                              leading={
                                <StatusPill size="sm" tone="neutral">
                                  {entry.compression}
                                </StatusPill>
                              }
                              title={entry.title ?? entry.sessionId}
                              trailing={
                                <>
                                  <span className="text-meta tabular-nums text-ink-muted">
                                    {formatBytes(entry.sizeBytes)} · {formatRelative(entry.createdAt)}
                                  </span>
                                  <Button tone="ghost" size="sm" onClick={() => void restore(entry.relPath)}>
                                    {t('sync.restore')}
                                  </Button>
                                </>
                              }
                            />
                          ))}
                        </div>
                      )}
                    </div>

                    {status && status.changes.length > 0 ? (
                      <div>
                        <div className="pb-1 text-body text-ink">
                          {t('sync.uncommitted', { n: status.changes.length })}
                        </div>
                        <div className="max-h-40 overflow-y-auto overscroll-contain text-tech text-ink-muted">
                          {status.changes.map((change) => (
                            <div key={change.path} className="flex gap-2 py-0.5">
                              <span className="w-8 shrink-0 text-ink-faint">
                                {change.index}
                                {change.worktree}
                              </span>
                              <span className="min-w-0 flex-1 truncate">{change.path}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : null}

                    <div>
                      <div className="flex items-center justify-between pb-1">
                        <span className="text-body text-ink">{t('sync.gitLog')}</span>
                        <Button
                          tone="ghost"
                          size="sm"
                          loading={logBusy}
                          disabled={!status?.isRepo}
                          onClick={() => {
                            setLogBusy(true)
                            void ipc
                              .gitLog(30)
                              .then(setLog)
                              .finally(() => setLogBusy(false))
                          }}
                        >
                          {t('sync.readLog')}
                        </Button>
                      </div>
                      {log === null ? (
                        <div className="text-meta text-ink-muted">{t('sync.clickToRead')}</div>
                      ) : log.length === 0 ? (
                        <div className="text-meta text-ink-muted">{t('sync.emptyRepo')}</div>
                      ) : (
                        <div className="max-h-72 overflow-y-auto overscroll-contain">
                          {log.map((commit) => (
                            <div
                              key={commit.hash}
                              className="flex items-baseline gap-2 border-b border-line-subtle py-1.5 last:border-b-0"
                            >
                              <span className="shrink-0 font-mono text-tech text-ink-faint">
                                {commit.shortHash}
                              </span>
                              <span className="min-w-0 flex-1">
                                <span
                                  className="block truncate text-ui text-ink"
                                  title={commit.subject}
                                >
                                  {commit.subject}
                                </span>
                                <span className="flex flex-wrap items-center gap-x-2 text-tech text-ink-muted">
                                  <span>{commit.author}</span>
                                  <span className="tabular-nums">{formatDateTime(commit.date)}</span>
                                  {commit.refs ? <span className="text-accent">{commit.refs}</span> : null}
                                </span>
                              </span>
                              {/* 「哪几条是本地独有的」是同步页最该回答的问题之一 */}
                              {commit.unpushed ? (
                                <StatusPill size="sm" tone="warning">
                                  {t('sync.commitUnpushed')}
                                </StatusPill>
                              ) : null}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    <div>
                      <div className="pb-1 text-body text-ink">{t('sync.sourcesTitle')}</div>
                      {sourceViews.length === 0 ? (
                        <div className="text-meta text-ink-muted">{t('sync.notDetected')}</div>
                      ) : (
                        sourceViews.map((view) => (
                          <Field
                            key={view.id}
                            label={view.displayName}
                            mono
                            hint={
                              /* 优先显示真实探测结果（可翻译）；没有就退回来源说明。
                                 说明本身也在字典里，所以英文界面不会露出中文。 */
                              view.notesText.length > 0 ? (
                                <span>{view.notesText.map((note) => t.text(note)).join('；')}</span>
                              ) : (
                                <span>{t.text(view.description)}</span>
                              )
                            }
                          >
                            <span className="flex items-center gap-2">
                              <span className="min-w-0 flex-1 truncate">
                                {view.rootPath ?? t('sync.notFound')}
                              </span>
                              <StatusPill tone={view.found ? 'success' : 'warning'}>
                                {view.found ? t('sync.available') : t('sync.notFound')}
                              </StatusPill>
                            </span>
                          </Field>
                        ))
                      )}
                    </div>
                  </div>
                ) : null}
              </Section>
            </>
          )}

          {progress ? (
            <div aria-live="polite" className="text-meta text-ink-muted">
              {progress}
            </div>
          ) : null}
          {running ? <Spinner label={t('sync.running')} /> : null}
        </div>
      </div>
    </div>
  )
}

/** 远端地址输入（仅在需要配置时出现，避免常驻表单占位）。 */
function FormlessRemoteInput({
  value,
  onChange,
  onSubmit,
  disabled,
}: {
  value: string
  onChange: (value: string) => void
  onSubmit: () => void
  disabled: boolean
}) {
  const t = useT()
  return (
    <div className="flex items-center gap-2">
      <TextInput
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onEnter={onSubmit}
        aria-label={t('sync.remoteAria')}
        placeholder={t('sync.remotePlaceholder')}
        className="font-mono text-meta"
      />
      <Button onClick={onSubmit} disabled={disabled}>
        {t('sync.saveRemote')}
      </Button>
    </div>
  )
}
