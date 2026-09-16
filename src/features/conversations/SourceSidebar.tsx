/**
 * 左栏：数据源与项目筛选（规格 §19 Conversations 左侧）。
 */
import { useLibrary } from '../../stores/library'
import { Badge } from '../../components/ui'
import { baseName, formatRelative } from '../../lib/format'

export function SourceSidebar() {
  const { sources, projects, filter, setFilter, stats } = useLibrary()

  const sourceRow = (id: string) => sources.find((s) => s.id === id)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 数据源 */}
      <div className="border-b border-line p-2">
        <div className="px-1 pb-1 text-[10.5px] font-semibold uppercase tracking-wide text-ink-faint">
          数据源
        </div>
        <button
          type="button"
          onClick={() => setFilter({ source: null, projectPath: null, onlyArchived: false })}
          className={`flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-[12px] hover:bg-surface-raised ${
            !filter.source && !filter.projectPath ? 'bg-surface-raised font-medium' : 'text-ink-muted'
          }`}
        >
          <span>全部会话</span>
          <span className="text-[11px] text-ink-faint">{stats?.sessions ?? 0}</span>
        </button>
        {(['codex', 'kimi'] as const).map((id) => {
          const row = sourceRow(id)
          const active = filter.source === id && !filter.projectPath
          return (
            <button
              key={id}
              type="button"
              onClick={() => setFilter({ source: id, projectPath: null, onlyArchived: false })}
              className={`flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-[12px] hover:bg-surface-raised ${
                active ? 'bg-surface-raised font-medium' : 'text-ink-muted'
              }`}
              title={row?.rootPath ?? '未探测到目录'}
            >
              <span className="flex items-center gap-1.5 truncate">
                {row?.displayName ?? id}
                {row && !row.found ? <Badge tone="warn">未找到</Badge> : null}
              </span>
              <span className="text-[11px] text-ink-faint">{row?.sessionHint ?? 0}</span>
            </button>
          )
        })}
      </div>

      {/* 项目 */}
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex items-center justify-between px-3 pt-2 pb-1">
          <span className="text-[10.5px] font-semibold uppercase tracking-wide text-ink-faint">
            项目
          </span>
          <span className="text-[10.5px] text-ink-faint">{projects.length}</span>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          {projects.length === 0 ? (
            <div className="px-1 py-2 text-[11.5px] leading-5 text-ink-faint">
              还没有项目。点击右上角「扫描」发现本机会话历史。
            </div>
          ) : (
            projects.map((project) => {
              const active = filter.projectPath === project.projectPath
              return (
                <button
                  key={project.projectPath}
                  type="button"
                  title={project.projectPath}
                  onClick={() =>
                    setFilter({
                      projectPath: active ? null : project.projectPath,
                      source: null,
                      onlyArchived: false,
                    })
                  }
                  className={`flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-[12px] hover:bg-surface-raised ${
                    active ? 'bg-surface-raised font-medium' : 'text-ink-muted'
                  }`}
                >
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate">{project.name || baseName(project.projectPath)}</span>
                  </span>
                  <span className="shrink-0 text-[11px] text-ink-faint">{project.sessionCount}</span>
                </button>
              )
            })
          )}
        </div>
      </div>

      {/* 底部：索引概况 */}
      <div className="border-t border-line px-3 py-2 text-[10.5px] leading-5 text-ink-faint">
        <div className="flex justify-between">
          <span>会话</span>
          <span>{stats?.sessions ?? 0}</span>
        </div>
        <div className="flex justify-between">
          <span>消息</span>
          <span>{stats?.messages ?? 0}</span>
        </div>
        <div className="flex justify-between">
          <span>索引体积</span>
          <span>{stats ? `${(stats.bytesOnDisk / 1024 / 1024).toFixed(0)} MB` : '—'}</span>
        </div>
        {filter.projectPath ? (
          <div className="pt-1 text-ink-muted">
            最近更新：{formatRelative(projects.find((p) => p.projectPath === filter.projectPath)?.lastUpdated)}
          </div>
        ) : null}
      </div>
    </div>
  )
}
