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
import { useEffect, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'

import * as ipc from '../lib/ipc'
import { useLibrary, type PageKey } from '../stores/library'
import { useSync } from '../stores/sync'
import { ConversationsPage } from '../features/conversations/ConversationsPage'
import { SearchPage } from '../features/search/SearchPage'
import { SyncPage } from '../features/sync/SyncPage'
import { SettingsPage } from '../features/settings/SettingsPage'
import {
  Button,
  Icon,
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
import appIcon from '../assets/brand-icon.png'

/** 导航项。 */
const NAV: Array<{ key: PageKey; label: string; hint: string }> = [
  { key: 'conversations', label: '会话', hint: '浏览本机与已同步的会话历史' },
  { key: 'search', label: '搜索', hint: '全文搜索所有会话' },
  { key: 'sync', label: '同步', hint: '通过 Git 在多台电脑之间同步' },
  { key: 'settings', label: '设置', hint: '数据目录 / 仓库 / 归档' },
]

/** 是否在真实 Tauri 窗口里（纯浏览器里隐藏窗口控制、拖动也不生效）。 */
const IS_TAURI = '__TAURI_INTERNALS__' in window
const WINDOW_STATE_CHANGED = 'aichat-window-state-changed'

function notifyWindowStateChanged() {
  window.dispatchEvent(new Event(WINDOW_STATE_CHANGED))
}

/**
 * 惰性取当前窗口：mock 浏览器（截图 QA）里 __TAURI_INTERNALS__ 是被伪造的，
 * getCurrentWindow() 可能直接抛错；所有窗口调用都经这里，失败即静默 no-op。
 */
function safeWindow() {
  if (!IS_TAURI) return null
  try {
    return getCurrentWindow()
  } catch {
    return null
  }
}

/**
 * 自绘标题栏拖动（无边框窗口）：
 * 点按头部空白处拖动窗口；交互控件（按钮/输入框/菜单等）不触发拖动；
 * 双击空白处切换最大化。最大化状态也必须把拖动交给系统，Windows 会在拖动时还原窗口；
 * 不用 data-tauri-drag-region——区域内有大量按钮，手动过滤交互边界更可控。
 */
function onCaptionMouseDown(event: ReactMouseEvent<HTMLElement>) {
  const win = safeWindow()
  if (event.button !== 0 || !win) return
  const target = event.target as HTMLElement
  if (target.closest('button, a, input, select, textarea, label, [role="button"], [role="menu"], [role="listbox"]')) {
    return
  }
  event.preventDefault()
  if (event.detail === 2) {
    void win.toggleMaximize().then(notifyWindowStateChanged).catch(() => {})
  } else {
    // 不预先拦截最大化窗口：startDragging 会走 Windows 原生标题栏拖动语义，
    // 从屏幕顶部拖下时自动恢复为普通窗口。
    void win.startDragging().then(notifyWindowStateChanged).catch(() => {})
  }
}

/** 窗口控制按钮（最小化 / 最大化-还原 / 关闭）：贴在窗口右上角，样式随主题。 */
function WindowControls() {
  const [maximized, setMaximized] = useState(false)
  useEffect(() => {
    const win = safeWindow()
    if (!win) return
    const refresh = () => {
      void win.isMaximized().then((value) => setMaximized(Boolean(value))).catch(() => {})
    }
    refresh()
    window.addEventListener(WINDOW_STATE_CHANGED, refresh)
    return () => window.removeEventListener(WINDOW_STATE_CHANGED, refresh)
  }, [])
  if (!IS_TAURI) return null
  const toggleMaximize = () => {
    const win = safeWindow()
    if (!win) return
    void win
      .toggleMaximize()
      .then(() => win.isMaximized())
      .then((value) => setMaximized(Boolean(value)))
      .catch(() => {})
  }
  return (
    <div className="-my-[9px] -mr-[16px] ml-1 flex self-stretch">
      <button
        type="button"
        aria-label="最小化"
        title="最小化"
        className="win-btn"
        onClick={() => void safeWindow()?.minimize().catch(() => {})}
      >
        <Icon name="minimize" size={14} />
      </button>
      <button
        type="button"
        aria-label={maximized ? '还原窗口' : '最大化'}
        title={maximized ? '还原' : '最大化'}
        className="win-btn"
        onClick={toggleMaximize}
      >
        <Icon name={maximized ? 'restore' : 'maximize'} size={14} />
      </button>
      <button
        type="button"
        aria-label="关闭"
        title="关闭"
        className="win-btn win-btn-close"
        onClick={() => void safeWindow()?.close().catch(() => {})}
      >
        <Icon name="close" size={14} />
      </button>
    </div>
  )
}

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
    pendingPage,
    confirmLeaveSettings,
    cancelLeaveSettings,
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
        // 后端在扫描结束时还会发一次 done=total 的「完成」事件；
        // 它可能在 scan() 返回之后才送达——若据此把 scanning 置回 true，转圈就永远停不下来。
        if (progress.done >= progress.total) {
          useLibrary.getState().setScanning(false)
        } else {
          useLibrary.getState().setScanning(true, { done: progress.done, total: progress.total })
        }
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
    <div className="app-shell flex h-full flex-col text-ink">
      {/* 极端缩放（200%）下工具栏允许换行：宁可占两行，也不要整页横向滚动；
          无边框窗口下整个头部同时是拖动区（双击空白切换最大化） */}
      <header className="app-header select-none" onMouseDown={onCaptionMouseDown}>
        {/* 左：品牌 + 资料库摘要 */}
        <div className="app-brand">
          <span className="app-brand-icon">
            <img src={appIcon} alt="" className="h-5 w-5 rounded-[5px]" />
          </span>
          <span className="app-brand-copy">
            <span className="app-brand-title">Local Chats</span>
            <span className="app-brand-meta">
              {stats ? `${stats.sessions} 个会话 · ${stats.messages} 条消息` : '本地索引尚未就绪'}
            </span>
          </span>
        </div>

        {/* 中：一级导航（窄到放不下时换行到第二行） */}
        <div className="app-primary-nav flex min-w-0 items-center">
          <SegmentedNav
            items={NAV.map((item) => ({ key: item.key, label: item.label, hint: item.hint }))}
            current={page}
            onSelect={(key) => useLibrary.getState().requestPage(key as PageKey)}
          />
        </div>

        {/* 右：统一状态区 + 操作 */}
        <div className="app-actions">
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
              <Icon name="filter" />
              {filtersActive ? filterSummary : wideEnough ? '全部会话' : '筛选'}
            </Button>
          ) : null}

          <IconButton label="搜索会话内容" onClick={() => setPage('search')}>
            <Icon name="search" />
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

        {/* 窗口控制（无边框窗口）：最小化 / 最大化 / 关闭，贴在右上角 */}
        <WindowControls />
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

      {/* 设置页有未保存草稿时，离开前先确认（规格 §6.4） */}
      {pendingPage ? (
        <div className="border-b border-line bg-panel px-3.5 py-2">
          <Notice
            tone="warning"
            title="设置有未保存的修改"
            actions={
              <>
                <Button
                  size="sm"
                  onClick={() => {
                    void useLibrary.getState().saveSettingsDraft().then((ok) => {
                      if (ok) confirmLeaveSettings()
                    })
                  }}
                  title="保存当前修改并前往目标页面"
                >
                  保存并离开
                </Button>
                <Button size="sm" onClick={confirmLeaveSettings}>
                  放弃修改
                </Button>
                <Button size="sm" tone="ghost" onClick={cancelLeaveSettings}>
                  留在本页
                </Button>
              </>
            }
          >
            修改尚未保存，离开后不会生效。
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
