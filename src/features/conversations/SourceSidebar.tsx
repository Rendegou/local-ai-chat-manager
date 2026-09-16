/**
 * 来源/项目栏（规格 §6.1）。
 *
 * 结构：顶部「全部会话」→ 数据源（带专属标识与计数）→ 项目列表（悬停出现复制路径）→
 * 底部数据源健康状态。空状态直接给出「扫描」与「打开设置」两个动作。
 *
 * 行组件统一走 ui/Rows.tsx 的 SectionLabel + SidebarRow。
 */
import { useState } from 'react'

import { useLibrary } from '../../stores/library'
import { Button, Dot, Icon, IconButton, SectionLabel, SidebarRow, StatusPill } from '../../components/ui'
import { baseName, formatRelative } from '../../lib/format'

export function SourceSidebar() {
  const { sources, projects, filter, setFilter, stats, scan, scanning } = useLibrary()
  const [copied, setCopied] = useState<string | null>(null)

  const sourceRow = (id: string) => sources.find((s) => s.id === id)

  /** 复制项目路径（失败时静默，避免打断浏览）。 */
  const copyPath = (path: string) => {
    void navigator.clipboard?.writeText(path).then(() => {
      setCopied(path)
      window.setTimeout(() => setCopied((value) => (value === path ? null : value)), 1200)
    })
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-panel">
      {/* 数据源 */}
      <div className="border-b border-line px-2 pb-2">
        <SectionLabel>数据源</SectionLabel>
        <SidebarRow
          active={!filter.source && !filter.projectPath}
          onClick={() => setFilter({ source: null, projectPath: null, onlyArchived: false })}
          label="全部会话"
          count={stats?.sessions ?? 0}
        />
        {(['codex', 'kimi'] as const).map((id) => {
          const row = sourceRow(id)
          return (
            <SidebarRow
              key={id}
              active={filter.source === id && !filter.projectPath}
              onClick={() => setFilter({ source: id, projectPath: null, onlyArchived: false })}
              title={row?.rootPath ?? '未探测到目录'}
              icon={<Dot tone={id === 'kimi' ? 'kimi' : 'codex'} />}
              label={row?.displayName ?? id}
              count={row?.sessionHint ?? 0}
            />
          )
        })}
      </div>

      {/* 项目 */}
      <div className="flex min-h-0 flex-1 flex-col">
        <SectionLabel trailing={projects.length}>项目</SectionLabel>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          {projects.length === 0 ? (
            <div className="flex flex-col items-start gap-2 px-1.5 py-2">
              <p className="text-meta leading-5 text-ink-muted">
                还没有项目。扫描本机 Codex / Kimi Code 会话后，这里会按项目分组。
              </p>
              <Button size="sm" tone="primary" onClick={() => void scan(false)} loading={scanning}>
                扫描
              </Button>
              <Button size="sm" tone="ghost" onClick={() => useLibrary.getState().setPage('settings')}>
                打开设置
              </Button>
            </div>
          ) : (
            projects.map((project) => {
              const active = filter.projectPath === project.projectPath
              return (
                <div key={project.projectPath} className="group flex items-center gap-0.5 pr-1">
                  <SidebarRow
                    className="flex-1"
                    active={active}
                    onClick={() =>
                      setFilter({
                        projectPath: active ? null : project.projectPath,
                        source: null,
                        onlyArchived: false,
                      })
                    }
                    title={project.projectPath}
                    label={project.name || baseName(project.projectPath)}
                    count={project.sessionCount}
                  />
                  {/* 悬停出现；键盘聚焦时同样可见 */}
                  <IconButton
                    label={copied === project.projectPath ? '已复制路径' : '复制项目路径'}
                    size="sm"
                    onClick={() => copyPath(project.projectPath)}
                    className="opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                  >
                    <Icon name={copied === project.projectPath ? 'check' : 'copy'} size={12} />
                  </IconButton>
                </div>
              )
            })
          )}
        </div>
      </div>

      {/* 底部：索引概况 + 数据源健康 */}
      <div className="border-t border-line px-3.5 py-2.5">
        <div className="flex items-center justify-between py-0.5 text-meta text-ink-muted">
          <span>会话</span>
          <span className="tabular-nums text-ink">{stats?.sessions ?? 0}</span>
        </div>
        <div className="flex items-center justify-between py-0.5 text-meta text-ink-muted">
          <span>消息</span>
          <span className="tabular-nums text-ink">{stats?.messages ?? 0}</span>
        </div>
        <div className="flex items-center justify-between py-0.5 text-meta text-ink-muted">
          <span>索引体积</span>
          <span className="tabular-nums text-ink">
            {stats ? `${(stats.bytesOnDisk / 1024 / 1024).toFixed(0)} MB` : '—'}
          </span>
        </div>
        {filter.projectPath ? (
          <div className="pt-1.5 text-meta text-ink-muted">
            最近更新：
            {formatRelative(
              projects.find((p) => p.projectPath === filter.projectPath)?.lastUpdated,
            )}
          </div>
        ) : null}
        <div className="flex flex-wrap gap-1 pt-2">
          {sources.map((source) => (
            <StatusPill
              key={source.id}
              tone={source.found ? (source.id === 'kimi' ? 'kimi' : 'codex') : 'warning'}
              title={source.rootPath ?? source.notes ?? ''}
            >
              {source.displayName}
              {source.found ? '' : ' 未找到'}
            </StatusPill>
          ))}
        </div>
      </div>
    </div>
  )
}
