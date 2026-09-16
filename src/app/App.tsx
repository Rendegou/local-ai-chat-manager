/**
 * 应用外壳：顶部工具栏 + 左侧导航 + 页面切换 + 全局提示。
 *
 * 视觉取向（规格 §19）：极简工具风，顶部一行放应用名、搜索入口与同步状态。
 */
import { useEffect } from 'react'

import * as ipc from '../lib/ipc'
import { useLibrary, type PageKey } from '../stores/library'
import { useSync } from '../stores/sync'
import { ConversationsPage } from '../features/conversations/ConversationsPage'
import { SearchPage } from '../features/search/SearchPage'
import { SyncPage } from '../features/sync/SyncPage'
import { SettingsPage } from '../features/settings/SettingsPage'
import { Badge, Button, Spinner } from '../components/ui'
import { formatRelative } from '../lib/format'

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
  } = useLibrary()
  const syncStatus = useSync((state) => state.status)

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

  const missingSources = sources.filter((source) => !source.found)

  return (
    <div className="flex h-full flex-col bg-surface text-ink">
      {/* 顶部工具栏 */}
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-line px-3">
        <div className="flex items-baseline gap-2">
          <span className="text-[13px] font-semibold">Local Chats</span>
          <span className="text-[11px] text-ink-faint">
            {stats ? `${stats.sessions} 会话 · ${stats.messages} 消息` : '索引未就绪'}
          </span>
        </div>

        <nav className="flex items-center gap-0.5 pl-2">
          {NAV.map((item) => (
            <button
              key={item.key}
              type="button"
              title={item.hint}
              onClick={() => setPage(item.key)}
              className={`rounded-md px-2.5 py-1.5 text-[12px] transition-colors ${
                page === item.key
                  ? 'bg-surface-sunken font-medium text-ink'
                  : 'text-ink-muted hover:bg-surface-sunken'
              }`}
            >
              {item.label}
            </button>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-2">
          {scanning ? (
            <Spinner
              label={
                scanProgress ? `扫描 ${scanProgress.done}/${scanProgress.total}` : '扫描中…'
              }
            />
          ) : null}
          {missingSources.length > 0 ? (
            <Badge tone="warn" title="未探测到数据目录，可在设置中手工指定">
              {missingSources.length} 个数据源未找到
            </Badge>
          ) : null}
          <Badge
            tone={syncStatus?.conflict ? 'warn' : 'muted'}
            title={syncStatus?.conflict ? '存在同步冲突' : '同步状态'}
          >
            {syncStatus?.conflict
              ? '冲突'
              : syncStatus?.isRepo
                ? `同步 ${formatRelative(syncStatus.lastPush ?? syncStatus.lastPull)}`
                : '未配置同步'}
          </Badge>
          <Button variant="ghost" onClick={() => setPage('search')} title="全文搜索">
            搜索
          </Button>
          <Button variant="primary" onClick={() => void scan(false)} disabled={scanning}>
            {scanning ? '扫描中' : '扫描'}
          </Button>
        </div>
      </header>

      {/* 页面主体 */}
      <main className="flex min-h-0 flex-1">
        {page === 'conversations' ? <ConversationsPage /> : null}
        {page === 'search' ? <SearchPage /> : null}
        {page === 'sync' ? <SyncPage /> : null}
        {page === 'settings' ? <SettingsPage /> : null}
      </main>

      {/* 错误提示条（结构化错误的人话信息） */}
      {error ? (
        <div className="flex items-center gap-2 border-t border-line bg-red-500/10 px-3 py-2 text-[12px] text-red-600 dark:text-red-400">
          <span className="truncate">{error.message}</span>
          <span className="ml-auto shrink-0 font-mono text-[10.5px] text-ink-faint">
            {error.kind}
          </span>
          <Button variant="ghost" onClick={() => setError(null)}>
            关闭
          </Button>
        </div>
      ) : null}
    </div>
  )
}
