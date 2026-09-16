/**
 * 应用外壳：顶部工具栏 + 页面切换 + 全局状态提示。
 *
 * Phase 1（设计基础层）只做令牌化与原语替换：结构、数据流、交互行为保持不变。
 * 工具栏的信息优先级重组放到 Phase 2。
 */
import { useEffect } from 'react'

import * as ipc from '../lib/ipc'
import { useLibrary, type PageKey } from '../stores/library'
import { useSync } from '../stores/sync'
import { ConversationsPage } from '../features/conversations/ConversationsPage'
import { SearchPage } from '../features/search/SearchPage'
import { SyncPage } from '../features/sync/SyncPage'
import { SettingsPage } from '../features/settings/SettingsPage'
import { Button, IconButton, Notice, Spinner, StatusPill } from '../components/ui'
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
    <div className="flex h-full flex-col bg-canvas text-ink">
      {/* 顶部工具栏 */}
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-line bg-panel px-3.5">
        <div className="flex items-baseline gap-2.5">
          <span className="text-title text-ink">Local Chats</span>
          <span className="text-meta text-ink-muted">
            {stats ? `${stats.sessions} 会话 · ${stats.messages} 消息` : '索引未就绪'}
          </span>
        </div>

        <nav aria-label="主导航" className="flex items-center gap-0.5 pl-2">
          {NAV.map((item) => (
            <button
              key={item.key}
              type="button"
              title={item.hint}
              aria-current={page === item.key ? 'page' : undefined}
              onClick={() => setPage(item.key)}
              className={`rounded-control px-2.5 py-1.5 text-body transition-colors ${
                page === item.key
                  ? 'bg-selected font-medium text-ink'
                  : 'text-ink-muted hover:bg-hover hover:text-ink'
              }`}
            >
              {item.label}
            </button>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-2">
          {scanning ? (
            <Spinner
              label={scanProgress ? `扫描 ${scanProgress.done}/${scanProgress.total}` : '扫描中…'}
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
          <IconButton label="搜索会话内容" onClick={() => setPage('search')}>
            <span aria-hidden="true">⌕</span>
          </IconButton>
          <Button tone="primary" onClick={() => void scan(false)} loading={scanning}>
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
