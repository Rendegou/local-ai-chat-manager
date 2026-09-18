/**
 * 同步页（规格 §6.3）。
 *
 * 按「风险与任务顺序」重组，而不是技术信息平铺：
 * 1. 仓库与同步健康状态；
 * 2. 推荐的下一步操作；
 * 3. 待同步内容摘要（含隐私提醒）；
 * 4. 上一次同步结果；
 * 5. 归档 / 日志 / 高级诊断（默认收起）。
 *
 * 冲突处理保持原有可靠性文案（不自动合并、不丢数据），并放在最显眼的位置。
 */
import { useEffect, useState } from 'react'
import { openPath } from '@tauri-apps/plugin-opener'

import * as ipc from '../../lib/ipc'
import { formatBytes, formatDateTime, formatRelative } from '../../lib/format'
import { useSync } from '../../stores/sync'
import { useLibrary } from '../../stores/library'
import {
  Button,
  EmptyState,
  Field,
  Icon,
  IconButton,
  ListRow,
  Notice,
  PanelHeader,
  SectionCard,
  Spinner,
  StatusPill,
  TextInput,
} from '../../components/ui'

export function SyncPage() {
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
  const { sources, loadSessions, setPage } = useLibrary()
  const [remoteInput, setRemoteInput] = useState('')
  const [log, setLog] = useState<string | null>(null)
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
  // 设置里已保存远端地址时，同步会自动应用，视为已配置
  const remoteConfigured = Boolean(status?.remote || status?.settingsRemote)
  const failedSteps = report?.steps.filter((step) => !step.ok) ?? []
  const pushAuthFailed = failedSteps.some((step) => step.detail.includes('publickey'))

  /** 根据状态给出「推荐的下一步」（规格 §6.3 第 2 点）。 */
  const nextStep = (() => {
    if (conflict) {
      return {
        tone: 'danger' as const,
        action: null,
        title: '先处理同步冲突',
        body: '存在未合并文件。仓库不会被自动合并，也不会丢弃任何一边。',
      }
    }
    if (!repoConfigured) {
      return {
        tone: 'info' as const,
        action: 'settings' as const,
        title: '先绑定同步仓库',
        body: '选择一个目录作为同步仓库（会自动 git init），之后才能在多台电脑之间同步。',
      }
    }
    if (!remoteConfigured) {
      return {
        tone: 'warning' as const,
        action: 'saveRemote' as const,
        title: '还没有配置远端',
        body: '只配置仓库不配置远端时，同步只能在本机提交，无法跨设备。',
      }
    }
    if (failedSteps.length > 0) {
      return {
        tone: 'danger' as const,
        action: 'sync' as const,
        title: '上一次同步未完全成功',
        body: '本地提交已完成，但有步骤失败（见上方详情）。修复后点击「立即同步」重试。',
      }
    }
    if (pending > 0 || changes > 0) {
      return {
        tone: 'accent' as const,
        action: 'sync' as const,
        title: `有 ${pending} 个会话待同步`,
        body: '点击「立即同步」写入快照、提交并推送；冲突时不会自动合并。',
      }
    }
    if (status?.remote && !status?.lastPush) {
      return {
        tone: 'warning' as const,
        action: 'sync' as const,
        title: '还没有成功推送到远端',
        body: '远端已配置但首次推送尚未成功。点击「立即同步」重试；认证失败时优先换用 https:// 地址。',
      }
    }
    if ((status?.ahead ?? 0) > 0) {
      return {
        tone: 'warning' as const,
        action: 'sync' as const,
        title: `本地有 ${status?.ahead ?? 0} 个提交未推送`,
        body: '提交已在本地仓库，但远端还没有。点击「立即同步」推送。',
      }
    }
    return {
      tone: 'success' as const,
      action: null,
      title: '已是最新状态',
      body: '本机会话都已写入仓库，远端也没有新的提交。',
    }
  })()

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-canvas">
      <PanelHeader
        title="同步"
        meta={
          <span className="flex items-center gap-2">
            <span className="text-tech">{status?.repo ?? '尚未配置同步仓库'}</span>
            {status?.isRepo ? (
              <StatusPill tone={conflict ? 'danger' : 'success'}>
                {conflict ? '冲突待处理' : '仓库正常'}
              </StatusPill>
            ) : null}
          </span>
        }
        actions={
          <>
            <IconButton
              label="刷新同步状态"
              onClick={() => void refresh()}
              className={running ? 'opacity-50' : ''}
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
              打开仓库
            </Button>
            <Button
              tone="primary"
              onClick={() => void run({ push: true })}
              loading={running}
              disabled={!repoConfigured || Boolean(conflict)}
            >
              {running ? '同步中…' : '立即同步'}
            </Button>
          </>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        <div className="mx-auto flex w-full max-w-[980px] flex-col gap-4">
          {/* 同步执行/刷新失败：此前静默不可见，失败反馈必须持续到用户看到 */}
          {error ? (
            <Notice
              tone="danger"
              title={error.message}
              actions={
                <IconButton label="关闭错误提示" size="sm" onClick={clearError}>
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
                      中止 Rebase
                    </Button>
                  ) : null}
                  <Button size="sm" onClick={() => void run({ push: true })} disabled={running}>
                    重试同步
                  </Button>
                  {status?.repo ? (
                    <Button
                      tone="ghost"
                      size="sm"
                      onClick={() => {
                        if (status?.repo) void openPath(status.repo)
                      }}
                    >
                      打开仓库
                    </Button>
                  ) : null}
                </>
              }
            >
              <div>{conflict.message}</div>
              <div className="pt-1 text-meta text-ink-muted">
                不会自动合并，也不会丢弃任何一边。冲突文件：
              </div>
              <ul className="pt-0.5 text-tech text-ink-muted">
                {conflict.files.map((file) => (
                  <li key={file}>· {file}</li>
                ))}
              </ul>
            </Notice>
          ) : null}

          {/* 步骤级失败（推送认证失败、拉取失败等）：不抛错也要有持续到用户看到的反馈 */}
          {!conflict && failedSteps.length > 0 ? (
            <Notice
              tone="danger"
              title="上一次同步未完全成功"
              actions={
                <Button size="sm" onClick={() => void run({ push: true })} disabled={running}>
                  重试同步
                </Button>
              }
            >
              <ul>
                {failedSteps.map((step) => (
                  <li key={step.name}>
                    · {step.name}：{step.detail || '未知原因'}
                  </li>
                ))}
              </ul>
              {pushAuthFailed ? (
                <div className="pt-1 text-meta text-ink-muted">
                  SSH 地址需要本机已配置 key。建议把远端改成 https:// 地址（凭据交给系统 Git
                  Credential Manager，首次推送会弹窗登录），或先在终端配置 SSH key。
                </div>
              ) : null}
            </Notice>
          ) : null}

          {!repoConfigured ? (
            <EmptyState
              title="还没有绑定同步仓库"
              description="在「设置 → 同步与隐私」里选择一个目录作为同步仓库。仓库与 AI 工具的数据目录完全隔离。"
              primaryAction={
                <Button tone="primary" onClick={() => setPage('settings')}>
                  去设置同步仓库
                </Button>
              }
              secondaryAction={
                <Button tone="ghost" onClick={() => void loadSessions()}>
                  跳过，先浏览本机会话
                </Button>
              }
            />
          ) : (
            <>
              {/* 1. 同步健康 */}
              <SectionCard
                title="同步健康"
                description="当前仓库、远端与最近一次同步时间"
                actions={
                  <StatusPill
                    tone={nextStep.tone === 'danger' ? 'danger' : status?.behind ? 'warning' : 'success'}
                  >
                    {status?.behind ? `远端领先 ${status.behind}` : '无待拉取提交'}
                  </StatusPill>
                }
              >
                <div className="grid gap-x-6 sm:grid-cols-2">
                  <Field label="仓库路径" mono>
                    {status?.repo ?? '—'}
                  </Field>
                  <Field label="分支" mono>
                    {status?.branch || '—'}
                  </Field>
                  <Field label="远端" mono>
                    {status?.remote ?? '未配置'}
                  </Field>
                  <Field label="git" mono>
                    {status?.gitVersion ?? '未找到 git'}
                  </Field>
                  <Field label="上次拉取">{formatDateTime(status?.lastPull)}</Field>
                  <Field label="上次推送">{formatDateTime(status?.lastPush)}</Field>
                </div>
                {status?.error ? (
                  <div className="pt-2">
                    <Notice tone="warning">{status.error}</Notice>
                  </div>
                ) : null}
              </SectionCard>

              {/* 2. 推荐的下一步 */}
              <Notice
                tone={nextStep.tone === 'accent' ? 'info' : nextStep.tone}
                title={nextStep.title}
                actions={
                  nextStep.action === 'sync' ? (
                    <Button size="sm" onClick={() => void run({ push: true })} disabled={running}>
                      立即同步
                    </Button>
                  ) : nextStep.action === 'saveRemote' ? (
                    <Button size="sm" onClick={() => void run({ push: false, setRemote: remoteInput })} disabled={!remoteInput.trim()}>
                      保存远端并同步
                    </Button>
                  ) : nextStep.action === 'settings' ? (
                    <Button size="sm" onClick={() => setPage('settings')}>
                      去设置
                    </Button>
                  ) : null
                }
              >
                {nextStep.body}
              </Notice>

              {/* 3. 待同步摘要 + 隐私提醒 */}
              <SectionCard title="待同步内容" description="点击「立即同步」后会发生的事">
                <div className="grid gap-x-6 sm:grid-cols-4">
                  <Field label="待同步会话">
                    <span className="tabular-nums">{pending} 个</span>
                  </Field>
                  <Field label="预计写入">
                    <span className="tabular-nums">约 {formatBytes(status?.pendingBytes ?? 0)}</span>
                  </Field>
                  <Field label="本地未提交">
                    <span className="tabular-nums">{changes} 个文件</span>
                  </Field>
                  <Field label="本地领先">
                    <span className="tabular-nums">{status?.ahead ?? 0} 个提交</span>
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
                <div className="pt-2">
                  <Notice tone="warning" title="提醒：同步内容会离开本机">
                    AI 会话可能包含源代码、命令输出、内网地址与密钥，请使用 Private Repository；
                    客户端不会读取或提交 credentials 类目录。
                  </Notice>
                </div>
              </SectionCard>

              {/* 4. 上一次同步结果 */}
              {report ? (
                <SectionCard title="上一次同步结果" description={`耗时 ${report.durationMs} ms`}>
                  {report.steps.map((step) => (
                    <ListRow
                      key={step.name}
                      leading={
                        <StatusPill size="sm" tone={step.ok ? 'success' : 'danger'}>
                          {step.ok ? '完成' : '失败'}
                        </StatusPill>
                      }
                      title={step.name}
                      subtitle={step.detail}
                      trailing={
                        <span className="text-meta tabular-nums text-ink-muted">
                          {step.durationMs} ms
                        </span>
                      }
                    />
                  ))}
                  {report.snapshot.written > 0 ? (
                    <div className="pt-2">
                      <div className="text-meta text-ink-muted">
                        本次写入 {report.snapshot.written} 个会话目录，共{' '}
                        {formatBytes(report.snapshot.bytes)}
                      </div>
                      <ul className="max-h-40 overflow-y-auto pt-1">
                        {report.snapshot.files.slice(0, 20).map((file) => (
                          <li
                            key={file.relPath}
                            className="flex items-baseline justify-between gap-3"
                          >
                            <span className="truncate text-tech text-ink-muted">
                              {file.relPath}
                            </span>
                            <span className="shrink-0 text-meta tabular-nums text-ink-muted">
                              {formatBytes(file.bytes)}
                            </span>
                          </li>
                        ))}
                        {report.snapshot.files.length > 20 ? (
                          <li className="text-meta text-ink-muted">
                            … 共 {report.snapshot.files.length} 个会话目录
                          </li>
                        ) : null}
                      </ul>
                    </div>
                  ) : null}
                </SectionCard>
              ) : null}

              {/* 5. 高级诊断（默认收起） */}
              <SectionCard
                title="归档与高级诊断"
                description="归档历史会话、查看未提交文件、Git 日志与数据源"
                actions={
                  <Button
                    tone="ghost"
                    size="sm"
                    aria-expanded={advancedOpen}
                    onClick={() => setAdvancedOpen((value) => !value)}
                  >
                    {advancedOpen ? '收起' : '展开'}
                  </Button>
                }
              >
                {advancedOpen ? (
                  <div className="flex flex-col gap-3">
                    <div>
                      <div className="flex items-center justify-between pb-1">
                        <span className="text-body text-ink">归档（{archives.length}）</span>
                        <Button tone="ghost" size="sm" onClick={() => void archiveOld()}>
                          归档长期未更新的会话
                        </Button>
                      </div>
                      {archives.length === 0 ? (
                        <div className="text-meta text-ink-muted">还没有归档。</div>
                      ) : (
                        <div className="max-h-48 overflow-y-auto">
                          {archives.map((entry) => (
                            <ListRow
                              key={entry.relPath}
                              leading={<StatusPill size="sm" tone="neutral">{entry.compression}</StatusPill>}
                              title={entry.title ?? entry.sessionId}
                              trailing={
                                <>
                                  <span className="text-meta tabular-nums text-ink-muted">
                                    {formatBytes(entry.sizeBytes)} · {formatRelative(entry.createdAt)}
                                  </span>
                                  <Button tone="ghost" size="sm" onClick={() => void restore(entry.relPath)}>
                                    恢复
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
                          未提交文件（{status.changes.length}）
                        </div>
                        <div className="max-h-40 overflow-y-auto text-tech text-ink-muted">
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
                        <span className="text-body text-ink">Git 日志</span>
                        <Button
                          tone="ghost"
                          size="sm"
                          onClick={() => void ipc.gitLog(30).then(setLog)}
                          disabled={!status?.isRepo}
                        >
                          读取最近提交
                        </Button>
                      </div>
                      {log !== null ? (
                        <pre className="max-h-48 overflow-y-auto text-tech leading-5 text-ink-muted whitespace-pre-wrap [overflow-wrap:anywhere]">
                          {log || '（空仓库）'}
                        </pre>
                      ) : (
                        <div className="text-meta text-ink-muted">点击右侧按钮读取。</div>
                      )}
                    </div>

                    <div>
                      <div className="pb-1 text-body text-ink">数据源</div>
                      {sources.length === 0 ? (
                        <div className="text-meta text-ink-muted">尚未探测。</div>
                      ) : (
                        sources.map((source) => (
                          <Field
                            key={source.id}
                            label={source.displayName}
                            mono
                            hint={source.notes ?? undefined}
                          >
                            <span className="flex items-center gap-2">
                              <span className="min-w-0 flex-1 truncate">
                                {source.rootPath ?? '未找到'}
                              </span>
                              <StatusPill tone={source.found ? 'success' : 'warning'}>
                                {source.found ? '可用' : '未找到'}
                              </StatusPill>
                            </span>
                          </Field>
                        ))
                      )}
                    </div>
                  </div>
                ) : null}
              </SectionCard>
            </>
          )}

          {progress ? (
            <div aria-live="polite" className="text-meta text-ink-muted">
              {progress}
            </div>
          ) : null}
          {running ? <Spinner label="同步进行中…" /> : null}
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
  return (
    <div className="flex items-center gap-2">
      <TextInput
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onEnter={onSubmit}
        aria-label="远端仓库地址"
        placeholder="https://github.com/you/aichat-history.git（也支持 git@，保存后直接同步）"
        className="font-mono text-meta"
      />
      <Button onClick={onSubmit} disabled={disabled}>
        保存远端
      </Button>
    </div>
  )
}
