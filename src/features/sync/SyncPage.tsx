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
    refresh,
    run,
    abortRebase,
    loadArchives,
    archiveOld,
    restore,
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

  /** 根据状态给出「推荐的下一步」（规格 §6.3 第 2 点）。 */
  const nextStep = (() => {
    if (conflict) {
      return {
        tone: 'danger' as const,
        title: '先处理同步冲突',
        body: '存在未合并文件。仓库不会被自动合并，也不会丢弃任何一边。',
      }
    }
    if (!repoConfigured) {
      return {
        tone: 'info' as const,
        title: '先绑定同步仓库',
        body: '选择一个目录作为同步仓库（会自动 git init），之后才能在多台电脑之间同步。',
      }
    }
    if (!status?.remote) {
      return {
        tone: 'warning' as const,
        title: '还没有配置远端',
        body: '只配置仓库不配置远端时，同步只能在本机提交，无法跨设备。',
      }
    }
    if (pending > 0 || changes > 0) {
      return {
        tone: 'accent' as const,
        title: `有 ${pending} 个会话待同步`,
        body: '点击「立即同步」写入快照、提交并推送；冲突时不会自动合并。',
      }
    }
    return {
      tone: 'success' as const,
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

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <div className="mx-auto flex w-full max-w-[860px] flex-col gap-3">
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
                  nextStep.tone === 'accent' ? (
                    <Button size="sm" tone="primary" onClick={() => void run({ push: true })} disabled={running}>
                      立即同步
                    </Button>
                  ) : nextStep.tone === 'warning' ? (
                    <Button size="sm" onClick={() => void run({ push: false, setRemote: remoteInput })} disabled={!remoteInput.trim()}>
                      保存远端并同步
                    </Button>
                  ) : nextStep.tone === 'info' ? (
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
                <div className="grid gap-x-6 sm:grid-cols-3">
                  <Field label="待同步会话">
                    <span className="tabular-nums">{pending} 个</span>
                  </Field>
                  <Field label="本地未提交">
                    <span className="tabular-nums">{changes} 个文件</span>
                  </Field>
                  <Field label="本地领先">
                    <span className="tabular-nums">{status?.ahead ?? 0} 个提交</span>
                  </Field>
                </div>
                <div className="pt-2">
                  <FormlessRemoteInput
                    value={remoteInput}
                    onChange={setRemoteInput}
                    onSubmit={() => void run({ push: false, setRemote: remoteInput })}
                    disabled={running || !remoteInput.trim()}
                  />
                </div>
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
                    <div key={step.name} className="flex items-center gap-2 py-0.5 text-meta">
                      <StatusPill tone={step.ok ? 'success' : 'danger'}>
                        {step.ok ? '完成' : '失败'}
                      </StatusPill>
                      <span className="w-32 shrink-0 text-ink-muted">{step.name}</span>
                      <span className="min-w-0 flex-1 truncate text-ink">{step.detail}</span>
                      <span className="shrink-0 tabular-nums text-ink-muted">
                        {step.durationMs} ms
                      </span>
                    </div>
                  ))}
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
                            <div key={entry.relPath} className="flex items-center gap-2 py-1 text-body">
                              <StatusPill tone="neutral">{entry.compression}</StatusPill>
                              <span className="min-w-0 flex-1 truncate text-ink">
                                {entry.title ?? entry.sessionId}
                              </span>
                              <span className="ml-auto shrink-0 text-meta text-ink-muted">
                                {formatBytes(entry.sizeBytes)} · {formatRelative(entry.createdAt)}
                              </span>
                              <Button
                                tone="ghost"
                                size="sm"
                                onClick={() => void restore(entry.relPath)}
                              >
                                恢复
                              </Button>
                            </div>
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
                        <pre className="max-h-48 overflow-auto text-tech leading-5 text-ink-muted">
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
        placeholder="git@github.com:you/aichat-history.git（填写后可直接保存并同步）"
        className="font-mono text-meta"
      />
      <Button onClick={onSubmit} disabled={disabled}>
        保存远端
      </Button>
    </div>
  )
}
