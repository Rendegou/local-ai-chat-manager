/**
 * 左栏：数据源与项目筛选（规格 §6.1）。
 *
 * Phase 1 只做令牌化：字号提升到 12/13.5px、状态改用 StatusPill、
 * 底部数据源健康区用语义色表达，层级结构调整在 Phase 2。
 */
import { useLibrary } from '../../stores/library'
import { StatusPill } from '../../components/ui'
import { baseName, formatRelative } from '../../lib/format'

export function SourceSidebar() {
  const { sources, projects, filter, setFilter, stats } = useLibrary()

  const sourceRow = (id: string) => sources.find((s) => s.id === id)

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-panel">
      {/* 数据源 */}
      <div className="border-b border-line px-2 py-2">
        <div className="px-1.5 pb-1 text-meta font-semibold uppercase tracking-wide text-ink-muted">
          数据源
        </div>
        <button
          type="button"
          aria-current={!filter.source && !filter.projectPath ? 'true' : undefined}
          onClick={() => setFilter({ source: null, projectPath: null, onlyArchived: false })}
          className={`flex w-full items-center justify-between rounded-control px-2 py-1.5 text-left text-body transition-colors ${
            !filter.source && !filter.projectPath
              ? 'bg-selected font-medium text-ink'
              : 'text-ink-muted hover:bg-hover hover:text-ink'
          }`}
        >
          <span>全部会话</span>
          <span className="text-meta tabular-nums text-ink-muted">{stats?.sessions ?? 0}</span>
        </button>
        {(['codex', 'kimi'] as const).map((id) => {
          const row = sourceRow(id)
          const active = filter.source === id && !filter.projectPath
          return (
            <button
              key={id}
              type="button"
              aria-current={active ? 'true' : undefined}
              onClick={() => setFilter({ source: id, projectPath: null, onlyArchived: false })}
              title={row?.rootPath ?? '未探测到目录'}
              className={`flex w-full items-center justify-between rounded-control px-2 py-1.5 text-left text-body transition-colors ${
                active ? 'bg-selected font-medium text-ink' : 'text-ink-muted hover:bg-hover hover:text-ink'
              }`}
            >
              <span className="flex min-w-0 items-center gap-1.5">
                <span aria-hidden="true" className={id === 'kimi' ? 'text-kimi' : 'text-codex'}>
                  {id === 'kimi' ? '◆' : '◇'}
                </span>
                <span className="truncate">{row?.displayName ?? id}</span>
              </span>
              <span className="shrink-0 text-meta tabular-nums text-ink-muted">
                {row?.sessionHint ?? 0}
              </span>
            </button>
          )
        })}
      </div>

      {/* 项目 */}
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex items-center justify-between px-3.5 pb-1 pt-2.5">
          <span className="text-meta font-semibold uppercase tracking-wide text-ink-muted">项目</span>
          <span className="text-meta tabular-nums text-ink-muted">{projects.length}</span>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          {projects.length === 0 ? (
            <div className="px-1.5 py-2 text-meta leading-5 text-ink-muted">
              还没有项目。点击顶部「扫描」发现本机会话历史。
            </div>
          ) : (
            projects.map((project) => {
              const active = filter.projectPath === project.projectPath
              return (
                <button
                  key={project.projectPath}
                  type="button"
                  title={project.projectPath}
                  aria-current={active ? 'true' : undefined}
                  onClick={() =>
                    setFilter({
                      projectPath: active ? null : project.projectPath,
                      source: null,
                      onlyArchived: false,
                    })
                  }
                  className={`flex w-full items-center justify-between rounded-control px-2 py-1.5 text-left text-body transition-colors ${
                    active ? 'bg-selected font-medium text-ink' : 'text-ink-muted hover:bg-hover hover:text-ink'
                  }`}
                >
                  <span className="truncate">{project.name || baseName(project.projectPath)}</span>
                  <span className="shrink-0 text-meta tabular-nums text-ink-muted">
                    {project.sessionCount}
                  </span>
                </button>
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
            {formatRelative(projects.find((p) => p.projectPath === filter.projectPath)?.lastUpdated)}
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
