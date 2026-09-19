/**
 * 会话上下文栏（数据源 / 项目 / 统计）。
 *
 * 与全局导航（`app/AppNavRail`）严格分开（docs/DESIGN_AUDIT.md §4）：
 * 这一栏只回答「我正在看哪个来源、哪个项目的会话」，因此**只在会话页渲染**。
 * 进入搜索 / 同步 / 设置时它完全不存在，不再占用 208px 宽度和大部分高度。
 *
 * 数据源来自 `useSourceViews()` 的 `visibleInSidebar` 子集：
 * 只有「本机探测到 / 手工配置过 / 索引里有历史」的来源才出现。
 * 产品支持但本机没装的工具（Cursor、Claude…）不在这里占据一行假数据——
 * 它们只在设置的「添加来源」里作为候选出现（docs/DESIGN_AUDIT.md §1）。
 */
import { useState } from 'react'

import { useLibrary } from '../../stores/library'
import { useSourceViews } from '../../lib/sources'
import { Button, Dot, Icon, IconButton, PaneRow, SectionLabel } from '../../components/ui'
import { baseName, formatBytes, sourceTone } from '../../lib/format'
import { useT } from '../../lib/i18n'

export function SourcePane() {
  const t = useT()
  const { projects, filter, setFilter, stats, scan, scanning, setSourcePaneOpen } = useLibrary()
  const sourceViews = useSourceViews()
  const [copied, setCopied] = useState<string | null>(null)

  const sidebarSources = sourceViews.filter((view) => view.visibleInSidebar)

  /** 来源/项目筛选：筛选是会话页的概念，选完顺手收起抽屉（常驻模式下是 no-op）。 */
  const applyFilter = (patch: Parameters<typeof setFilter>[0]) => {
    setFilter(patch)
    setSourcePaneOpen(false)
  }

  /** 复制项目路径（失败时静默，避免打断浏览）。 */
  const copyPath = (path: string) => {
    void navigator.clipboard?.writeText(path).then(() => {
      setCopied(path)
      window.setTimeout(() => setCopied((value) => (value === path ? null : value)), 1200)
    })
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {/* 数据源 */}
      <div className="px-2 pb-2 pt-1">
        <SectionLabel>{t('sidebar.sources')}</SectionLabel>
        <PaneRow
          active={!filter.source && !filter.projectPath}
          onClick={() => applyFilter({ source: null, projectPath: null, onlyArchived: false })}
          label={t('sidebar.allChats')}
          count={stats?.sessions ?? 0}
        />
        {sidebarSources.map((source) => (
          // 有历史但本机未安装的来源继续显示（否则这些会话在界面上无处可去），
          // 但它必须自报身份：路径位显示「本机未安装 · 仅有历史会话」，不伪装成已安装。
          <PaneRow
            key={source.id}
            active={filter.source === source.id && !filter.projectPath}
            onClick={() => applyFilter({ source: source.id, projectPath: null, onlyArchived: false })}
            title={
              source.rootPath ?? (source.found ? t('sidebar.dirNotDetected') : t('sidebar.historyOnly'))
            }
            icon={<Dot tone={sourceTone(source.id)} />}
            label={source.displayName}
            count={source.sessionCount}
          />
        ))}
      </div>

      {/* 项目 */}
      <div className="flex min-h-0 flex-1 flex-col">
        <SectionLabel trailing={projects.length}>{t('sidebar.projects')}</SectionLabel>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-2">
          {projects.length === 0 ? (
            <div className="flex flex-col items-start gap-2 px-1.5 py-2">
              <p className="text-meta leading-5 text-ink-muted">{t('sidebar.emptyProjects')}</p>
              <Button size="sm" onClick={() => void scan(false)} loading={scanning}>
                {t('sidebar.scan')}
              </Button>
              <Button
                size="sm"
                tone="ghost"
                onClick={() => useLibrary.getState().requestPage('settings')}
              >
                {t('sidebar.openSettings')}
              </Button>
            </div>
          ) : (
            projects.map((project) => {
              const active = filter.projectPath === project.projectPath
              return (
                <div key={project.projectPath} className="group flex items-center gap-0.5 pr-1">
                  <PaneRow
                    className="flex-1"
                    active={active}
                    onClick={() =>
                      applyFilter({
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
                    label={copied === project.projectPath ? t('sidebar.copiedPath') : t('sidebar.copyPath')}
                    size="sm"
                    onClick={() => copyPath(project.projectPath)}
                    className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                  >
                    <Icon name={copied === project.projectPath ? 'check' : 'copy'} size={12} />
                  </IconButton>
                </div>
              )
            })
          )}
        </div>
      </div>

      {/* 底部：索引统计（纯文本一行，不做成卡片） */}
      <div className="shrink-0 border-t border-line-subtle px-3 py-2 text-meta tabular-nums text-ink-faint">
        {stats
          ? t('sidebar.stats', {
              sessions: stats.sessions,
              messages: stats.messages,
              bytes: formatBytes(stats.bytesOnDisk),
            })
          : t('sidebar.indexNotReady')}
      </div>
    </div>
  )
}
