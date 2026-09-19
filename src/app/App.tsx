/**
 * 应用外壳：46px 桌面标题栏 + 全局导航 Rail + 页面主体 + 全局状态提示。
 *
 * 结构（docs/DESIGN.md §10）：
 * ```
 * [skip link → #main-content]
 * ┌── 46px 标题栏：品牌 · 扫描进度 · needsAttention · 快速搜索 · 同步 · 更多 · 窗口控制 ──┐
 * ├─ Rail（72px，≥768px 恒在）─┬─ 页面主体 ───────────────────────────────────────────┤
 * ```
 *
 * 标题栏信息优先级（顶部只放「需要随时够到」的东西）：
 * - 左：窄窗口导航按钮 + 品牌；
 * - 右：扫描进度 / 需要处理的数据源 / 搜索 / 同步状态 / 更多操作 / 窗口控制。
 *
 * 与会话上下文的分工：
 * - 全局导航（我在哪个区域）→ Rail，所有页面都有；
 * - 会话上下文（我在看哪个来源/项目的会话）→ 会话页自己的 SourcePane，
 *   进入搜索 / 同步 / 设置时完全不渲染。
 *
 * 数据源警告只统计 `SourceView.needsAttention`——「产品支持但本机未安装」是正常状态，
 * 不再是警告（docs/DESIGN_AUDIT.md §1）。
 */
import { useEffect, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'

import * as ipc from '../lib/ipc'
import { useLibrary } from '../stores/library'
import { useSync } from '../stores/sync'
import { useSourceViews } from '../lib/sources'
import { ConversationsPage } from '../features/conversations/ConversationsPage'
import { SearchPage } from '../features/search/SearchPage'
import { QuickSearch } from '../features/search/QuickSearch'
import { SyncPage } from '../features/sync/SyncPage'
import { SettingsPage } from '../features/settings/SettingsPage'
import { AppNavRail } from './AppNavRail'
import { Button, Drawer, Icon, IconButton, Menu, Notice, Spinner } from '../components/ui'
import { LanguageProvider, resolveLanguage, useT } from '../lib/i18n'
import { useMinWidth } from '../hooks/useMediaQuery'
import appIcon from '../assets/brand-icon.png'

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
  const t = useT()
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
    <div className="-mr-[12px] ml-1 flex self-stretch">
      <button
        type="button"
        aria-label={t('app.minimize')}
        title={t('app.minimize')}
        className="win-btn"
        onClick={() => void safeWindow()?.minimize().catch(() => {})}
      >
        <Icon name="minimize" size={14} />
      </button>
      <button
        type="button"
        aria-label={maximized ? t('app.restoreWindow') : t('app.maximize')}
        title={maximized ? t('app.restore') : t('app.maximize')}
        className="win-btn"
        onClick={toggleMaximize}
      >
        <Icon name={maximized ? 'restore' : 'maximize'} size={14} />
      </button>
      <button
        type="button"
        aria-label={t('common.close')}
        title={t('common.close')}
        className="win-btn win-btn-close"
        onClick={() => void safeWindow()?.close().catch(() => {})}
      >
        <Icon name="close" size={14} />
      </button>
    </div>
  )
}

export default function App() {
  const t = useT()
  const {
    page,
    theme,
    language,
    bootstrap,
    scanning,
    scanProgress,
    scan,
    error,
    setError,
    stats,
    pendingPage,
    confirmLeaveSettings,
    cancelLeaveSettings,
    setAppearance,
  } = useLibrary()
  const syncStatus = useSync((state) => state.status)
  const sourceViews = useSourceViews()
  // ≥768px：Rail 常驻；<768px：Rail 收进标题栏导航抽屉（与会话上下文抽屉互相独立）
  const railVisible = useMinWidth('md')
  const navigationOpen = useLibrary((state) => state.navigationOpen)
  // Ctrl/Cmd + K 快速搜索面板
  const [quickOpen, setQuickOpen] = useState(false)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setQuickOpen((value) => !value)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

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
  // 只有「真的需要处理」的来源才报警：部分解析 / 读取失败 / 手工配置后目录消失。
  // 单纯「产品支持但本机没装」是正常状态，不再计数。
  const attention = sourceViews.filter((view) => view.needsAttention)
  const syncDot = syncStatus?.conflict
    ? 'bg-danger'
    : syncStatus?.isRepo
      ? 'bg-success'
      : 'bg-ink-faint'
  const syncHint = syncStatus?.conflict
    ? t('app.syncConflict')
    : syncStatus?.isRepo
      ? t('app.syncOk')
      : t('app.syncUnset')

  return (
    <LanguageProvider language={resolveLanguage(language)}>
    <div className="app-shell flex h-full flex-col text-ink">
      {/* 键盘用户的第一个 Tab 落点：跳过整条导航直达内容 */}
      <a href="#main-content" className="skip-link">
        {t('app.skipToContent')}
      </a>

      {/* 无边框窗口下整个头部同时是拖动区（双击空白切换最大化） */}
      <header className="app-header select-none" onMouseDown={onCaptionMouseDown}>
        {/* 窄窗口（<768px）：全局导航收进抽屉 */}
        {!railVisible ? (
          <IconButton
            label={navigationOpen ? t('app.navigationTitle') : t('app.openNavigation')}
            aria-expanded={navigationOpen}
            aria-haspopup="dialog"
            onClick={() => useLibrary.getState().setNavigationOpen(!navigationOpen)}
          >
            <Icon name="menu" />
          </IconButton>
        ) : null}

        {/* 左：品牌（小图标 + 产品名） */}
        <div className="app-brand">
          {/* 显式宽高：避免图片加载完成前的布局跳动 */}
          <img src={appIcon} alt="" width={18} height={18} className="h-[18px] w-[18px] rounded-chip" />
          <span className="app-brand-title">Local Chats</span>
        </div>

        {/* 右：状态 + 操作 + 窗口控制 */}
        <div className="app-actions">
          {scanning ? (
            <Spinner
              label={scanProgress ? t('app.scanProgress', { done: scanProgress.done, total: scanProgress.total }) : t('app.scanning')}
            />
          ) : null}
          {attention.length > 0 ? (
            <IconButton
              label={t('app.attentionSources', { n: attention.length })}
              onClick={() => useLibrary.getState().requestPage('settings')}
            >
              <Icon name="warning" className="text-warning" />
            </IconButton>
          ) : null}

          <IconButton label={t('app.quickSearch')} onClick={() => setQuickOpen(true)}>
            <Icon name="search" />
          </IconButton>

          <IconButton
            label={t('app.syncLabel', { hint: syncHint })}
            onClick={() => useLibrary.getState().requestPage('sync')}
          >
            <span className="relative">
              <Icon name="refresh" />
              <span
                aria-hidden="true"
                className={`absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full ${syncDot}`}
              />
            </span>
          </IconButton>

          {/* 「设置」不再出现在这里：Rail 已经是一级入口，重复入口只会让人犹豫。
              但主题与语言是「改完立刻见效」的偏好，埋在设置第 4 个分区里太深，
              所以在这里给它们一个随时可达的内联入口（走 setAppearance，立即落盘）。 */}
          <Menu
            items={[
              { label: t('menu.scanNow'), onClick: () => void scan(false), hint: t('menu.scanNowHint') },
              { label: t('menu.rebuildIndex'), onClick: () => void scan(true), tone: 'danger', hint: t('menu.rebuildIndexHint') },
              {
                label: t('menu.openDataDir'),
                onClick: () => {
                  void ipc.dataDir().then((dir) => {
                    if (dir) void import('@tauri-apps/plugin-opener').then((m) => m.openPath(dir))
                  })
                },
              },
              {
                label: t('menu.language'),
                current: language,
                choices: [
                  { value: 'system', label: t('settings.languageSystem'), onSelect: () => void setAppearance({ language: 'system' }) },
                  { value: 'zh', label: t('settings.languageZh'), onSelect: () => void setAppearance({ language: 'zh' }) },
                  { value: 'en', label: t('settings.languageEn'), onSelect: () => void setAppearance({ language: 'en' }) },
                ],
              },
              {
                label: t('menu.theme'),
                current: theme,
                choices: [
                  { value: 'system', label: t('settings.themeSystem'), onSelect: () => void setAppearance({ theme: 'system' }) },
                  { value: 'light', label: t('settings.themeLight'), onSelect: () => void setAppearance({ theme: 'light' }) },
                  { value: 'dark', label: t('settings.themeDark'), onSelect: () => void setAppearance({ theme: 'dark' }) },
                ],
              },
            ]}
          />

          {/* 首次使用（索引为空）时，「扫描」是主动作 */}
          {!indexed && !scanning ? (
            <Button tone="primary" size="sm" onClick={() => void scan(false)}>
              {t('app.scanLocalChats')}
            </Button>
          ) : null}
        </div>

        {/* 窗口控制（无边框窗口）：最小化 / 最大化 / 关闭，贴在右上角 */}
        <WindowControls />
      </header>

      {/* 设置页有未保存草稿时，离开前先确认（规格 §6.4） */}
      {pendingPage ? (
        <div className="border-b border-line bg-panel px-4 py-2">
          <Notice
            tone="warning"
            title={t('notice.unsavedTitle')}
            actions={
              <>
                <Button
                  size="sm"
                  onClick={() => {
                    void useLibrary.getState().saveSettingsDraft().then((ok) => {
                      if (ok) confirmLeaveSettings()
                    })
                  }}
                  title={t('notice.saveAndLeaveTitle')}
                >
                  {t('notice.saveAndLeave')}
                </Button>
                <Button size="sm" onClick={confirmLeaveSettings}>
                  {t('notice.discard')}
                </Button>
                <Button size="sm" tone="ghost" onClick={cancelLeaveSettings}>
                  {t('notice.stay')}
                </Button>
              </>
            }
          >
            {t('notice.unsavedBody')}
          </Notice>
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1">
        {/* 全局导航：≥768px 常驻。它不含来源/项目——那是会话页自己的事 */}
        {railVisible ? <AppNavRail /> : null}

        <main id="main-content" className="flex min-w-0 flex-1">
          {page === 'conversations' ? <ConversationsPage /> : null}
          {page === 'search' ? <SearchPage /> : null}
          {page === 'sync' ? <SyncPage /> : null}
          {page === 'settings' ? <SettingsPage /> : null}
        </main>
      </div>

      {/* Ctrl/Cmd + K 快速搜索 */}
      <QuickSearch open={quickOpen} onClose={() => setQuickOpen(false)} />

      {/* <768px 的全局导航抽屉：与会话上下文抽屉是两套完全独立的状态 */}
      {!railVisible && navigationOpen ? (
        <Drawer
          title={t('app.navigationTitle')}
          onClose={() => useLibrary.getState().setNavigationOpen(false)}
          widthClass="w-[240px]"
        >
          <div className="px-2 py-1">
            <AppNavRail variant="list" />
          </div>
        </Drawer>
      ) : null}

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
                  {t('common.close')}
                </Button>
              </>
            }
          >
            {error.detail ? <span className="text-tech">{error.detail}</span> : null}
          </Notice>
        </div>
      ) : null}
    </div>
    </LanguageProvider>
  )
}
