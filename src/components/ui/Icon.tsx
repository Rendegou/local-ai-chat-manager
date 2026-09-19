/**
 * 图标：统一手 authored SVG，16 视窗、1.6px 圆头描边，currentColor 继承文字色。
 *
 * 只有一套笔触、一套栅格——不用 unicode 字形/emoji 充当图标（来源身份用 CSS 圆点，
 * 见 SourceDot）。新增图标时保持同样的笔画与圆角语言。
 */
import type { ReactNode } from 'react'

export type IconName =
  | 'search'
  | 'more'
  | 'filter'
  | 'copy'
  | 'refresh'
  | 'back'
  | 'close'
  | 'check'
  | 'warning'
  | 'info'
  | 'chevron'
  | 'folder'
  | 'external'
  | 'settings'
  | 'archive'
  | 'branch'
  | 'terminal'
  | 'chat'
  | 'menu'
  | 'minimize'
  | 'maximize'
  | 'restore'

/** 图标路径：stroke 类用描边，fill 类（仅 more 的圆点）用填充。 */
const PATHS: Record<IconName, ReactNode> = {
  search: (
    <>
      <circle cx="7" cy="7" r="4.2" />
      <path d="M10.2 10.2 13.6 13.6" />
    </>
  ),
  more: (
    <>
      <circle cx="3.4" cy="8" r="1.25" fill="currentColor" stroke="none" />
      <circle cx="8" cy="8" r="1.25" fill="currentColor" stroke="none" />
      <circle cx="12.6" cy="8" r="1.25" fill="currentColor" stroke="none" />
    </>
  ),
  filter: <path d="M2.8 4.2h10.4L9.5 8.7v3.4l-3 1.7V8.7L2.8 4.2Z" strokeLinejoin="round" />,
  copy: (
    <>
      <rect x="5.6" y="5.6" width="7.4" height="7.4" rx="1.8" />
      <path d="M10.4 5.6V4.4a1.6 1.6 0 0 0-1.6-1.6H4.4a1.6 1.6 0 0 0-1.6 1.6v4.4a1.6 1.6 0 0 0 1.6 1.6h1.2" />
    </>
  ),
  refresh: (
    <>
      <path d="M13.2 8a5.2 5.2 0 1 1-1.53-3.67" />
      <path d="M13.4 2.6v2.3h-2.3" />
    </>
  ),
  back: <path d="M9.8 3.4 5.2 8l4.6 4.6" />,
  close: <path d="M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6" />,
  check: <path d="M3.2 8.4l3.1 3.1 6.5-7.2" />,
  warning: (
    <>
      <path d="M8 2.6 14.2 13.2H1.8L8 2.6Z" strokeLinejoin="round" />
      <path d="M8 6.4v3" />
      <circle cx="8" cy="11.2" r="0.9" fill="currentColor" stroke="none" />
    </>
  ),
  info: (
    <>
      <circle cx="8" cy="8" r="5.4" />
      <path d="M8 7.4v3.2" />
      <circle cx="8" cy="5" r="0.9" fill="currentColor" stroke="none" />
    </>
  ),
  /* 向下 chevron；其它方向用 className 旋转（如 -rotate-90 = 向右） */
  chevron: <path d="M5 6.2 8 9.2l3-3" />,
  folder: (
    <path
      d="M14.7 12.7a1.3 1.3 0 0 1-1.4 1.3H2.7a1.3 1.3 0 0 1-1.4-1.3V3.3A1.3 1.3 0 0 1 2.7 2h3.3l1.3 2h6a1.3 1.3 0 0 1 1.4 1.3v7.4Z"
      strokeLinejoin="round"
    />
  ),
  external: (
    <>
      <path d="M9.6 2.8H4.2a1.4 1.4 0 0 0-1.4 1.4v7.6a1.4 1.4 0 0 0 1.4 1.4h7.6a1.4 1.4 0 0 0 1.4-1.4V6.4" />
      <path d="M9.8 2.8h3.4v3.4" />
      <path d="M12.9 3.1 7.4 8.6" />
    </>
  ),
  /* 设置：滑杆（比齿轮更贴近「调整参数」的语义） */
  settings: (
    <>
      <path d="M2.6 5.2h10.8" />
      <path d="M2.6 10.8h10.8" />
      <circle cx="5.8" cy="5.2" r="1.6" />
      <circle cx="10.2" cy="10.8" r="1.6" />
    </>
  ),
  archive: (
    <>
      <rect x="2.6" y="2.8" width="10.8" height="3" rx="1" />
      <path d="M3.6 5.8v5.6a1.2 1.2 0 0 0 1.2 1.2h6.4a1.2 1.2 0 0 0 1.2-1.2V5.8" />
      <path d="M6.8 8.4h2.4" />
    </>
  ),
  /* Git 分支 */
  branch: (
    <>
      <circle cx="4.6" cy="4" r="1.6" />
      <circle cx="4.6" cy="12" r="1.6" />
      <circle cx="11.4" cy="5.8" r="1.6" />
      <path d="M4.6 5.6v4.8" />
      <path d="M11.4 7.4a3.2 3.2 0 0 1-3.2 3.2H6.8" />
    </>
  ),
  terminal: (
    <>
      <path d="M4.4 4.6 8 8l-3.6 3.4" />
      <path d="M8.8 11.4h3" />
    </>
  ),
  /* 会话气泡 */
  chat: (
    <path
      d="M13.4 10.6a1.3 1.3 0 0 1-1.3 1.3H5.6l-3 2V3.9a1.3 1.3 0 0 1 1.3-1.3h8.2a1.3 1.3 0 0 1 1.3 1.3v6.7Z"
      strokeLinejoin="round"
    />
  ),
  /* 抽屉菜单（窄窗口） */
  menu: <path d="M2.6 4.4h10.8M2.6 8h10.8M2.6 11.6h10.8" />,
  /* 窗口控制（自绘标题栏）：最小化横线 / 最大化方框 / 还原叠框 */
  minimize: <path d="M3.4 8h9.2" />,
  maximize: <rect x="3.4" y="3.4" width="9.2" height="9.2" rx="1.2" />,
  restore: (
    <>
      <path d="M5.6 5.6V3.8a1.2 1.2 0 0 1 1.2-1.2h5.4a1.2 1.2 0 0 1 1.2 1.2v5.4a1.2 1.2 0 0 1-1.2 1.2h-1.8" />
      <rect x="2.6" y="5.6" width="7.8" height="7.8" rx="1.2" />
    </>
  ),
}

export function Icon({
  name,
  size = 14,
  className = '',
}: {
  name: IconName
  size?: number
  className?: string
}) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`shrink-0 ${className}`}
    >
      {PATHS[name]}
    </svg>
  )
}

/**
 * 身份 / 状态圆点：不靠字形表达，用一枚色点（始终伴随文字标签出现，
 * 不承担独立语义）。tone 对应语义色或来源色。
 */
export function Dot({
  tone = 'neutral',
  className = '',
}: {
  tone?: 'neutral' | 'accent' | 'codex' | 'kimi' | 'success' | 'warning' | 'danger'
  className?: string
}) {
  const color =
    tone === 'accent'
      ? 'bg-accent'
      : tone === 'codex'
        ? 'bg-codex'
        : tone === 'kimi'
          ? 'bg-kimi'
          : tone === 'success'
            ? 'bg-success'
            : tone === 'warning'
              ? 'bg-warning'
              : tone === 'danger'
                ? 'bg-danger'
                : 'bg-ink-faint'
  return <span aria-hidden="true" className={`h-1.5 w-1.5 shrink-0 rounded-full ${color} ${className}`} />
}
