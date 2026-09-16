/**
 * 同步页（规格 §6.3）。
 *
 * Phase 1 令牌化：把原来平铺的技术信息改成语义分组卡片（SectionCard）、
 * 只读信息用 Field、风险与冲突用 Notice。章节顺序与信息重组在 Phase 3。
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
  const { sources, loadSessions } = useLibrary()
  const [remoteInput, setRemoteInput] = useState('')
  const [log, setLog] = useState<string | null>(null)

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

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-canvas">
      <PanelHeader
        title="同步"
        meta={status?.repo ?? '尚未配置同步仓库'}
        actions={
          <>
            <Button
              tone="ghost"
              onClick={() => void ipc.gitLog(30).then(setLog)}
              disabled={!status?.isRepo}
            >
              查看 Git 日志
            </Button>
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
              disabled={!repoConfigured}
            >
              {running ? '同步中…' : '立即同步'}
            </Button>
          </>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <div className="mx-auto flex max-w-[980px] flex-col gap-3">
          {/* 冲突：不自动合并、不丢数据（规格 §14） */}
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
              description="在「设置」里选择一个目录作为同步仓库（会自动 git init，可另配远端）。仓库与 AI 工具的数据目录完全隔离。"
              primaryAction={
                <Button tone="primary" onClick={() => useLibrary.getState().setPage('settings')}>
                  去设置同步仓库
                </Button>
              }
            />
          ) : (
            <div className="grid gap-3 lg:grid-cols-2">
              <SectionCard title="仓库" description="同步目标是独立仓库，不会碰 AI 工具自己的数据目录">
                <Field label="路径" mono>
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
                {status?.error ? (
                  <div className="pt-2">
                    <Notice tone="warning">{status.error}</Notice>
                  </div>
                ) : null}
              </SectionCard>

              <SectionCard
                title="变更"
                description="本地未提交文件、待同步会话与远端领先提交数"
              >
                <Field label="本地未提交">{status?.localChanges ?? 0} 个文件</Field>
                <Field label="待同步会话">{status?.pendingSessions ?? 0} 个</Field>
                <Field label="远端领先">
                  {status?.behind ?? 0} 个提交
                  {status?.ahead ? `（本地领先 ${status.ahead}）` : ''}
                </Field>
                <div className="pt-3">
                  <div className="pb-1 text-meta text-ink-muted">配置远端（例如私有仓库地址）</div>
                  <div className="flex gap-2">
                    <TextInput
                      value={remoteInput}
                      onChange={(event) => setRemoteInput(event.target.value)}
                      aria-label="远端仓库地址"
                      placeholder="git@github.com:you/aichat-history.git"
                      className="font-mono text-meta"
                    />
                    <Button
                      onClick={() => void run({ push: false, setRemote: remoteInput })}
                      disabled={running || !remoteInput.trim()}
                    >
                      保存并同步
                    </Button>
                  </div>
                  <div className="pt-2">
                    <Notice tone="warning" title="请使用 Private Repository">
                      AI 会话可能包含源代码、命令输出、文件路径与敏感信息。
                    </Notice>
                  </div>
                </div>
              </SectionCard>

              {status && status.changes.length > 0 ? (
                <SectionCard
                  title={`未提交文件（${status.changes.length}）`}
                  className="lg:col-span-2"
                >
                  <div className="max-h-56 overflow-y-auto text-tech text-ink-muted">
                    {status.changes.map((change) => (
                      <div key={change.path} className="flex gap-2 py-0.5">
                        <span className="w-8 shrink-0 text-ink-faint">
                          {change.index}
                          {change.worktree}
                        </span>
                        <span className="truncate">{change.path}</span>
                      </div>
                    ))}
                  </div>
                </SectionCard>
              ) : null}

              {report ? (
                <SectionCard title="同步结果" description={`耗时 ${report.durationMs} ms`} className="lg:col-span-2">
                  {report.steps.map((step) => (
                    <div key={step.name} className="flex items-center gap-2 py-0.5 text-meta">
                      <StatusPill tone={step.ok ? 'success' : 'danger'}>
                        {step.ok ? '完成' : '失败'}
                      </StatusPill>
                      <span className="w-32 shrink-0 text-ink-muted">{step.name}</span>
                      <span className="min-w-0 flex-1 truncate text-ink">{step.detail}</span>
                      <span className="shrink-0 tabular-nums text-ink-muted">{step.durationMs} ms</span>
                    </div>
                  ))}
                </SectionCard>
              ) : null}

              <SectionCard
                title="归档（zstd）"
                description="归档把旧会话压进 archives/，本地原始文件不受影响"
                className="lg:col-span-2"
                actions={
                  <Button tone="ghost" size="sm" onClick={() => void archiveOld()}>
                    归档长期未更新的会话
                  </Button>
                }
              >
                {archives.length === 0 ? (
                  <div className="text-meta text-ink-muted">还没有归档。</div>
                ) : (
                  <div className="max-h-56 overflow-y-auto">
                    {archives.map((entry) => (
                      <div key={entry.relPath} className="flex items-center gap-2 py-1 text-body">
                        <StatusPill tone="neutral">{entry.compression}</StatusPill>
                        <span className="truncate text-ink">{entry.title ?? entry.sessionId}</span>
                        <span className="ml-auto shrink-0 text-meta text-ink-muted">
                          {formatBytes(entry.sizeBytes)} · {formatRelative(entry.createdAt)}
                        </span>
                        <Button tone="ghost" size="sm" onClick={() => void restore(entry.relPath)}>
                          恢复
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </SectionCard>
            </div>
          )}

          {/* 数据源健康：帮助用户确认扫描范围 */}
          <SectionCard
            title="数据源"
            description="扫描范围来自这些目录；手工指定后只扫描该目录"
            actions={
              <Button tone="ghost" size="sm" onClick={() => void loadSessions()}>
                刷新列表
              </Button>
            }
          >
            {sources.length === 0 ? (
              <div className="text-meta text-ink-muted">尚未探测。点击顶部「扫描」开始。</div>
            ) : (
              sources.map((source) => (
                <Field
                  key={source.id}
                  label={source.displayName}
                  mono
                  hint={source.notes ?? undefined}
                >
                  <span className="flex items-center gap-2">
                    <span className="truncate">{source.rootPath ?? '未找到'}</span>
                    <StatusPill tone={source.found ? 'success' : 'warning'}>
                      {source.found ? '可用' : '未找到'}
                    </StatusPill>
                  </span>
                </Field>
              ))
            )}
          </SectionCard>

          {progress ? (
            <div aria-live="polite" className="text-meta text-ink-muted">
              {progress}
            </div>
          ) : null}
          {running ? <Spinner label="同步进行中…" /> : null}

          {log !== null ? (
            <SectionCard
              title="Git 日志"
              actions={
                <Button tone="ghost" size="sm" onClick={() => setLog(null)}>
                  关闭
                </Button>
              }
            >
              <pre className="max-h-60 overflow-auto text-tech leading-5 text-ink-muted">
                {log || '（空仓库）'}
              </pre>
            </SectionCard>
          ) : null}
        </div>
      </div>
    </div>
  )
}
