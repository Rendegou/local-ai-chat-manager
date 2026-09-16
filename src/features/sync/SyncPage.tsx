/**
 * 同步页（规格 §19 Sync）：
 * 展示仓库 / 分支 / 远端 / 上次拉取推送 / 本地与远端变更，提供立即同步、打开仓库、查看日志，
 * 以及冲突处理（查看冲突文件、重试、中止 rebase）。
 */
import { useEffect, useState } from 'react'
import { openPath } from '@tauri-apps/plugin-opener'

import * as ipc from '../../lib/ipc'
import { formatBytes, formatDateTime, formatRelative } from '../../lib/format'
import { useSync } from '../../stores/sync'
import { useLibrary } from '../../stores/library'
import { Badge, Button, EmptyState, Field, PanelHeader, Spinner } from '../../components/ui'

export function SyncPage() {
  const { status, report, archives, running, progress, refresh, run, abortRebase, loadArchives, archiveOld, restore } =
    useSync()
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
    void ipc.onSyncProgress((step) => useSync.getState().setProgress(step)).then((fn) => {
      unlisten = fn
    })
    return () => unlisten?.()
  }, [])

  const repoConfigured = Boolean(status?.repo)
  const conflict = status?.conflict ?? report?.conflict ?? null

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PanelHeader
        title="同步"
        subtitle={status?.repo ?? '尚未配置同步仓库'}
        actions={
          <>
            <Button
              variant="ghost"
              onClick={() => void ipc.gitLog(30).then(setLog)}
              disabled={!status?.isRepo}
            >
              查看 Git 日志
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                if (status?.repo) void openPath(status.repo)
              }}
              disabled={!repoConfigured}
            >
              打开仓库
            </Button>
            <Button variant="primary" onClick={() => void run({ push: true })} disabled={running || !repoConfigured}>
              {running ? '同步中…' : '立即同步'}
            </Button>
          </>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {/* 冲突提示（规格 §14） */}
        {conflict ? (
          <div className="mb-4 rounded-md border border-amber-500/40 bg-amber-500/5 p-3">
            <div className="flex items-center gap-2 text-[12.5px] font-semibold text-amber-600 dark:text-amber-400">
              <Badge tone="warn">Sync Conflict</Badge>
              {conflict.message}
            </div>
            <div className="pt-1 text-[11.5px] text-ink-muted">
              不会自动合并，也不会丢弃任何一边。冲突文件：
            </div>
            <ul className="pt-1 font-mono text-[11px] text-ink-muted">
              {conflict.files.map((file) => (
                <li key={file}>· {file}</li>
              ))}
            </ul>
            <div className="flex gap-2 pt-2">
              {conflict.inRebase ? (
                <Button variant="danger" onClick={() => void abortRebase()}>
                  中止 Rebase
                </Button>
              ) : null}
              <Button onClick={() => void run({ push: true })} disabled={running}>
                重试同步
              </Button>
              {status?.repo ? (
                <Button
                  variant="ghost"
                  onClick={() => void openPath(status.repo as string)}
                >
                  打开仓库手动处理
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}

        {!repoConfigured ? (
          <EmptyState
            title="还没有绑定同步仓库"
            description="在「设置」里选择一个目录作为同步仓库（会自动 git init，可另配远端）。仓库与 AI 工具的数据目录完全隔离。"
          />
        ) : (
          <div className="grid gap-6 lg:grid-cols-2">
            {/* 仓库状态 */}
            <section className="rounded-md border border-line p-3">
              <div className="pb-2 text-[12px] font-semibold">仓库</div>
              <Field label="路径">
                <span className="font-mono text-[11.5px]">{status?.repo}</span>
              </Field>
              <Field label="分支">
                <span className="font-mono text-[11.5px]">{status?.branch || '—'}</span>
              </Field>
              <Field label="远端">
                <span className="font-mono text-[11.5px]">{status?.remote ?? '未配置'}</span>
              </Field>
              <Field label="git">
                <span className="font-mono text-[11.5px]">{status?.gitVersion ?? '未找到 git'}</span>
              </Field>
              <Field label="上次拉取">{formatDateTime(status?.lastPull)}</Field>
              <Field label="上次推送">{formatDateTime(status?.lastPush)}</Field>
              {status?.error ? (
                <div className="pt-2 text-[11.5px] text-amber-600 dark:text-amber-400">
                  {status.error}
                </div>
              ) : null}
            </section>

            {/* 变更概览 */}
            <section className="rounded-md border border-line p-3">
              <div className="pb-2 text-[12px] font-semibold">变更</div>
              <Field label="本地未提交">{status?.localChanges ?? 0} 个文件</Field>
              <Field label="待同步会话">{status?.pendingSessions ?? 0} 个</Field>
              <Field label="远端领先">
                {status?.behind ?? 0} 个提交{status?.ahead ? `（本地领先 ${status.ahead}）` : ''}
              </Field>
              <div className="pt-2">
                <div className="text-[11.5px] text-ink-faint">配置远端（例如私有仓库地址）</div>
                <div className="flex gap-2 pt-1">
                  <input
                    value={remoteInput}
                    onChange={(event) => setRemoteInput(event.target.value)}
                    placeholder="git@github.com:you/aichat-history.git"
                    className="min-w-0 flex-1 rounded-md border border-line bg-surface px-2 py-1.5 font-mono text-[11.5px] outline-none focus:border-accent-500"
                  />
                  <Button
                    onClick={() => void run({ push: false, setRemote: remoteInput })}
                    disabled={running || !remoteInput.trim()}
                  >
                    保存并同步
                  </Button>
                </div>
                <div className="pt-2 text-[11px] leading-5 text-amber-600 dark:text-amber-400">
                  ⚠ AI 会话可能包含源代码、命令输出、文件路径与敏感信息，请务必使用 Private Repository。
                </div>
              </div>
            </section>

            {/* 变更文件列表 */}
            {status && status.changes.length > 0 ? (
              <section className="rounded-md border border-line p-3 lg:col-span-2">
                <div className="pb-2 text-[12px] font-semibold">
                  未提交文件（{status.changes.length}）
                </div>
                <div className="max-h-56 overflow-y-auto font-mono text-[11px] text-ink-muted">
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
              </section>
            ) : null}

            {/* 同步步骤 */}
            {report ? (
              <section className="rounded-md border border-line p-3 lg:col-span-2">
                <div className="pb-2 text-[12px] font-semibold">
                  同步结果（耗时 {report.durationMs} ms）
                </div>
                {report.steps.map((step) => (
                  <div key={step.name} className="flex items-center gap-2 py-0.5 text-[11.5px]">
                    <span className={step.ok ? 'text-green-600 dark:text-green-400' : 'text-amber-600'}>
                      {step.ok ? '✓' : '✗'}
                    </span>
                    <span className="w-32 shrink-0 text-ink-muted">{step.name}</span>
                    <span className="min-w-0 flex-1 truncate">{step.detail}</span>
                    <span className="shrink-0 text-ink-faint">{step.durationMs} ms</span>
                  </div>
                ))}
              </section>
            ) : null}

            {/* 归档 */}
            <section className="rounded-md border border-line p-3 lg:col-span-2">
              <div className="flex items-center justify-between pb-2">
                <span className="text-[12px] font-semibold">归档（zstd）</span>
                <Button variant="ghost" onClick={() => void archiveOld()}>
                  归档长期未更新的会话
                </Button>
              </div>
              {archives.length === 0 ? (
                <div className="text-[11.5px] text-ink-faint">
                  还没有归档。归档会把旧会话压缩进 <code>archives/</code>，本地原始文件不受影响。
                </div>
              ) : (
                <div className="max-h-56 overflow-y-auto">
                  {archives.map((entry) => (
                    <div key={entry.relPath} className="flex items-center gap-2 py-1 text-[11.5px]">
                      <Badge>{entry.compression}</Badge>
                      <span className="truncate">{entry.title ?? entry.sessionId}</span>
                      <span className="ml-auto shrink-0 text-ink-faint">
                        {formatBytes(entry.sizeBytes)} · {formatRelative(entry.createdAt)}
                      </span>
                      <Button variant="ghost" onClick={() => void restore(entry.relPath)}>
                        恢复
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </div>
        )}

        {/* 数据源状态：帮助用户确认扫描范围 */}
        <section className="mt-4 rounded-md border border-line p-3">
          <div className="pb-2 text-[12px] font-semibold">数据源</div>
          {sources.length === 0 ? (
            <div className="text-[11.5px] text-ink-faint">尚未探测。点击顶部「扫描」开始。</div>
          ) : (
            sources.map((source) => (
              <Field key={source.id} label={source.displayName}>
                <span className="font-mono text-[11.5px]">{source.rootPath ?? '未找到'}</span>
                {source.found ? (
                  <Badge tone="muted">{source.notes ?? ''}</Badge>
                ) : (
                  <Badge tone="warn">未找到</Badge>
                )}
              </Field>
            ))
          )}
          <div className="pt-2">
            <Button variant="ghost" onClick={() => void loadSessions()}>
              刷新列表
            </Button>
          </div>
        </section>

        {progress ? <div className="pt-3 text-[11.5px] text-ink-faint">{progress}</div> : null}
        {running ? (
          <div className="pt-3">
            <Spinner label="同步进行中…" />
          </div>
        ) : null}
        {log !== null ? (
          <section className="mt-4 rounded-md border border-line p-3">
            <div className="flex items-center justify-between pb-2">
              <span className="text-[12px] font-semibold">Git 日志</span>
              <Button variant="ghost" onClick={() => setLog(null)}>
                关闭
              </Button>
            </div>
            <pre className="max-h-60 overflow-auto font-mono text-[11px] leading-5 text-ink-muted">
              {log || '（空仓库）'}
            </pre>
          </section>
        ) : null}
      </div>
    </div>
  )
}
