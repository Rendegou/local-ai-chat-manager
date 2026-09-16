/**
 * 应用外壳（规格 §5.1）：顶部工具栏分三个区域 + 页面主体 + 全局状态提示。
 *
 * 工具栏信息优先级：
 * - 左：产品名 + 当前资料库摘要（会话数 / 消息数）；
 * - 中：四个一级入口，用 segmented navigation 与普通按钮区分；
 * - 右：统一状态区（扫描进度 / 同步状态 / 数据源异常）+ 搜索 + 更多操作 + 扫描入口。
 *
 * 「扫描」不再永久占据主按钮：索引为空时它是主动作，之后退到「更多操作」，
 * 进度则进入统一状态区。
 */
import { useEffect } from 'react'

import * as ipc from '../lib/ipc'
import { useLibrary, type PageKey } from '../stores/library'
import { useSync } from '../stores/sync'
import { ConversationsPage } from '../features/conversations/ConversationsPage'
import { SearchPage } from '../features/search/SearchPage'
import { SyncPage } from '../features/sync/SyncPage'
import { SettingsPage } from '../features/settings/SettingsPage'
import {
  Button,
  IconButton,
  Menu,
  Notice,
  SegmentedNav,
  Spinner,
  StatusArea,
  StatusPill,
} from '../components/ui'
import { describeFilter, formatRelative } from '../lib/format'
import { useMinWidth } from '../hooks/useMediaQuery'

/** 导航项。 */
const NAV: Array<{ key: PageKey; label: string; hint: string }> = [
  { key: 'conversations', label: '会话', hint: '浏览本机与已同步的会话历史' },
  { key: 'search', label: '搜索', hint: '全文搜索所有会话' },
  { key: 'sync', label: '同步', hint: '通过 Git 在多台电脑之间同步' },
  { key: 'settings', label: '设置', hint: '数据目录 / 仓库 / 归档' },
]

export default function App() {
  const {
    page,
    setPage,
    theme,
    bootstrap,
    scanning,
    scanProgress,
    scan,
    error,
    setError,
    stats,
    sources,
    filter,
    filtersOpen,
    setFiltersOpen,
  } = useLibrary()
  const syncStatus = useSync((state) => state.status)
  // 宽窗口下三栏并排，来源栏常驻；窄窗口改为抽屉，由工具栏「筛选」按钮唤出
  const wideEnough = useMinWidth('xl')

  // 启动：加载设置 / 数据源 / 会话；订阅后端事件
  useEffect(() => {
    void bootstrap()
    void useSync.getState().refresh()

    const subscriptions: Array<() => void> = []
    void ipc
      .onScanProgress((progress) => {
        useLibrary.getState().setScanning(true, { done: progress.done, total: progress.total })
      })
      .then((unlisten) => subscriptions.push(unlisten))
    void ipc
      .onLibraryChanged(() => {
        // 文件监听 / 后台扫描完成后刷新列表与统计
        void useLibrary.getState().loadSessions()
        void useLibrary.getState().loadStats()
        void useLibrary.getState().loadProjects()
        void useSync.getState().refresh()
      })
      .then((unlisten) => subscriptions.push(unlisten))

    return () => subscriptions.forEach((unlisten) => unlisten())
  }, [bootstrap])

  // 主题：system 时跟随系统
  useEffect(() => {
    const root = document.documentElement
    const applyDark = (dark: boolean) => root.classList.toggle('dark', dark)
    if (theme === 'dark') applyDark(true)
    else if (theme === 'light') applyDark(false)
    else {
      const query = window.matchMedia('(prefers-color-scheme: dark)')
      applyDark(query.matches)
      const listener = (event: MediaQueryListEvent) => applyDark(event.matches)
      query.addEventListener('change', listener)
      return () => query.removeEventListener('change', listener)
    }
  }, [theme])

  const indexed = (stats?.sessions ?? 0) > 0
  const missingSources = sources.filter((source) => !source.found)
  const filterSummary = describeFilter(filter)
  const filtersActive = filterSummary !== '全部会话'

  return (
    <div className="flex h-full flex-col bg-canvas text-ink">
      <header className="flex h-13 shrink-0 items-center gap-3 border-b border-line bg-panel px-3.5 py-2">
        {/* 左：品牌 + 资料库摘要 */}
        <div className="flex min-w-0 items-baseline gap-2.5">
          <span className="text-title text-ink">Local Chats</span>
          <span className="truncate text-meta text-ink-muted">
            {stats ? `${stats.sessions} 会话 · ${stats.messages} 消息` : '索引未就绪'}
          </span>
        </div>

        {/* 中：一级导航 */}
        <div className="mx-auto flex items-center gap-2">
          <SegmentedNav
            items={NAV.map((item) => ({ key: item.key, label: item.label, hint: item.hint }))}
            current={page}
            onSelect={(key) => setPage(key as PageKey)}
          />
        </div>

        {/* 右：统一状态区 + 操作 */}
        <div className="flex shrink-0 items-center gap-2">
          <StatusArea>
            {scanning ? (
              <Spinner
                label={
                  scanProgress ? `扫描 ${scanProgress.done}/${scanProgress.total}` : '扫描中…'
                }
              />
            ) : null}
            {missingSources.length > 0 ? (
              <StatusPill tone="warning" title="未探测到数据目录，可在设置中手工指定">
                {missingSources.length} 个数据源未找到
              </StatusPill>
            ) : null}
            <StatusPill
              tone={syncStatus?.conflict ? 'danger' : syncStatus?.isRepo ? 'success' : 'neutral'}
              title={syncStatus?.conflict ? '存在同步冲突' : '同步状态'}
            >
              {syncStatus?.conflict
                ? '同步冲突'
                : syncStatus?.isRepo
                  ? `已同步 ${formatRelative(syncStatus.lastPush ?? syncStatus.lastPull)}`
                  : '未配置同步'}
            </StatusPill>
          </StatusArea>

          {page === 'conversations' ? (
            <Button
              tone={filtersActive ? 'secondary' : 'ghost'}
              size="sm"
              aria-expanded={!wideEnough ? filtersOpen : undefined}
              title="按来源 / 项目筛选会话"
              onClick={() => {
                if (wideEnough) {
                  // 宽窗口下来源栏常驻，这里只把筛选重置为全部
                  useLibrary.getState().resetFilter()
                } else {
                  setFiltersOpen(!filtersOpen)
                }
              }}
            >
              <span aria-hidden="true">⌗</span>
              {filtersActive ? filterSummary : wideEnough ? '全部会话' : '筛选'}
            </Button>
          ) : null}

          <IconButton label="搜索会话内容" onClick={() => setPage('search')}>
            <span aria-hidden="true">⌕</span>
          </IconButton>

          <Menu
            items={[
              { label: '立即扫描', onClick: () => void scan(false), hint: '增量' },
              { label: '重建索引', onClick: () => void scan(true), tone: 'danger', hint: '全量' },
              {
                label: '打开数据目录',
                onClick: () => {
                  void ipc.dataDir().then((dir) => {
                    if (dir) void import('@tauri-apps/plugin-opener').then((m) => m.openPath(dir))
                  })
                },
              },
              { label: '设置', onClick: () => setPage('settings') },
            ]}
          />

          {/* 首次使用（索引为空）时，「扫描」是主动作 */}
          {!indexed && !scanning ? (
            <Button tone="primary" onClick={() => void scan(false)}>
              扫描本地会话
            </Button>
          ) : null}
        </div>
      </header>

      {filtersOpen && !wideEnough && page === 'conversations' ? (
        <div className="border-b border-line bg-panel px-3.5 py-2">
          <Notice
            tone="info"
            title={`筛选：${filterSummary}`}
            actions={
              <>
                <Button size="sm" tone="ghost" onClick={() => useLibrary.getState().resetFilter()}>
                  清除筛选
                </Button>
                <Button size="sm" onClick={() => setFiltersOpen(false)}>
                  收起
                </Button>
              </>
            }
          >
            窄窗口下来源/项目栏收进抽屉；在会话页左侧抽屉中选择即可。
          </Notice>
        </div>
      ) : null}

      <main className="flex min-h-0 flex-1">
        {page === 'conversations' ? <ConversationsPage /> : null}
        {page === 'search' ? <SearchPage /> : null}
        {page === 'sync' ? <SyncPage /> : null}
        {page === 'settings' ? <SettingsPage /> : null}
      </main>

      {/* 错误提示：保留到用户关闭（失败反馈不应自动消失） */}
      {error ? (
        <div className="border-t border-line bg-canvas p-2">
          <Notice
            tone="danger"
            title={error.message}
            actions={
              <>
                <span className="text-tech text-ink-faint">{error.kind}</span>
                <Button tone="ghost" size="sm" onClick={() => setError(null)}>
                  关闭
                </Button>
              </>
            }
          >
            {error.detail ? <span className="text-tech">{error.detail}</span> : null}
          </Notice>
        </div>
      ) : null}
    </div>
  )
}
