/**
 * 组件画廊（dev-only 设计验收工具）。
 *
 * 用法：`http://localhost:1420/?gallery&theme=dark|light`
 * 每个组件连同全部状态陈列在它所属于的表面上；组件在这里过关后才允许进页面。
 * 截图：node tools/gallery_shot.mjs --out .ui-shots/gallery
 */
import { useEffect, useState, type ReactNode } from 'react'

import {
  Button,
  Chip,
  DateInput,
  DirectoryInput,
  Dot,
  EmptyState,
  Field,
  FormField,
  Icon,
  IconButton,
  Menu,
  Notice,
  PanelHeader,
  SectionCard,
  SegmentedNav,
  Select,
  Skeleton,
  Spinner,
  StatusPill,
  TextInput,
  Toggle,
  type IconName,
  type Tone,
} from '../components/ui'
import type { MessageRow, SessionSummary } from '../types/ipc'
import { MessageBlock } from '../features/conversations/ConversationViewer'
import { SessionRow } from '../features/conversations/SessionList'

/* ---------------- 展架 ---------------- */

function Section({
  id,
  title,
  hint,
  surface = 'bg-canvas',
  children,
}: {
  id: string
  title: string
  hint?: string
  surface?: string
  children: ReactNode
}) {
  return (
    <section id={id} className="border-b border-line">
      <div className="border-b border-line/60 bg-panel px-6 py-3">
        <h2 className="text-lead text-ink">{title}</h2>
        {hint ? <p className="pt-0.5 text-meta text-ink-muted">{hint}</p> : null}
      </div>
      <div className={`px-6 py-5 ${surface}`}>{children}</div>
    </section>
  )
}

/** 状态格：标签 + 一格展品。 */
function Cell({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-micro uppercase tracking-wider text-ink-faint">{label}</div>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
    </div>
  )
}

/* ---------------- 演示数据 ---------------- */

const DEMO_SESSION: SessionSummary = {
  id: 'kimi:machine-a:demo-1',
  source: 'kimi',
  externalId: 'demo-1',
  title: 'Redis watchdog 续期失败排查',
  projectPath: '/home/dev/work/web-dashboard',
  createdAt: '2026-09-16T06:33:00Z',
  updatedAt: new Date(Date.now() - 32 * 60_000).toISOString(),
  machineId: 'machine-a',
  messageCount: 8,
  partial: false,
  archived: false,
  syncStatus: 'local',
  primaryFile: null,
  contentHash: null,
}

function demoMessage(partial: Partial<MessageRow>): MessageRow {
  return {
    id: `m-${partial.sequence ?? 0}`,
    sessionId: 'demo',
    sequence: 0,
    role: 'assistant',
    kind: 'message',
    text: null,
    toolName: null,
    timestamp: '2026-09-16T06:35:00Z',
    raw: null,
    ...partial,
  }
}

const DEMO_MESSAGES: Array<{ label: string; message: MessageRow }> = [
  {
    label: 'user · 染色实体卡',
    message: demoMessage({
      sequence: 0,
      role: 'user',
      text: '线上偶发 key 提前过期，怀疑是 watchdog 续期失败，帮我看下日志和时间线。',
    }),
  },
  {
    label: 'assistant · 开放正文',
    message: demoMessage({
      sequence: 2,
      text: '从日志看每次失败前都有一次 `Connection reset by peer`。续期是异步线程发起的，连接池被占满时会超时，导致 TTL 没有被刷新。',
    }),
  },
  {
    label: 'reasoning · 引文细线',
    message: demoMessage({
      sequence: 1,
      kind: 'reasoning_summary',
      text: '先梳理约束，再看实现细节。',
    }),
  },
  {
    label: 'tool_call · 终端块',
    message: demoMessage({
      sequence: 3,
      kind: 'tool_call',
      toolName: 'shell',
      text: '{"command":["rg","-n","\\"fn\\"","read_line\\"","src/"]}',
    }),
  },
  {
    label: 'tool_result · 终端块',
    message: demoMessage({
      sequence: 4,
      role: 'tool',
      kind: 'tool_result',
      toolName: 'shell',
      text: 'src/parser/mod.rs:12:pub fn read_line(buf: &mut Vec<u8>) -> Option<Line> {',
    }),
  },
  {
    label: 'event · 弱化行',
    message: demoMessage({
      sequence: 5,
      kind: 'event',
      text: 'token_count: 1842',
    }),
  },
]

const ICONS: IconName[] = [
  'search',
  'more',
  'filter',
  'copy',
  'refresh',
  'back',
  'close',
  'check',
  'warning',
  'info',
  'chevron',
  'folder',
  'external',
  'settings',
  'archive',
  'branch',
  'terminal',
]

const TONES: Tone[] = ['neutral', 'accent', 'success', 'warning', 'danger', 'info', 'codex', 'kimi']

/* ---------------- 画廊 ---------------- */

export function Gallery() {
  const [segment, setSegment] = useState('conversations')
  const [toggleOn, setToggleOn] = useState(true)
  const [orderDemo, setOrderDemo] = useState('relevance')
  const [sourceDemo, setSourceDemo] = useState('')

  // 主题由查询参数控制（截图脚本传入），默认深色
  useEffect(() => {
    const theme = new URLSearchParams(window.location.search).get('theme') ?? 'dark'
    document.documentElement.classList.toggle('dark', theme !== 'light')
  }, [])

  return (
    <div className="min-h-full bg-canvas text-ink">
      <header className="sticky top-0 z-10 border-b border-line bg-panel px-6 py-3">
        <h1 className="text-title text-ink">组件画廊</h1>
        <p className="pt-0.5 text-meta text-ink-muted">
          每个组件 × 全部状态 × 所在表面。?theme=light 切换浅色。
        </p>
      </header>

      {/* 1. 排版 */}
      <Section id="type" title="排版" hint="字重 × 字号 × 字距的层级，CJK 与拉丁混排">
        <div className="flex max-w-3xl flex-col gap-3">
          <div className="text-title text-ink">页面标题 Title 16/620 — Redis 续期排查</div>
          <div className="text-lead text-ink">面板标题 Lead 14/560 — 会话列表</div>
          <div className="text-body text-ink">
            正文 Body 13.5/400 — 从日志看每次失败前都有一次 Connection reset by peer。
          </div>
          <div className="text-body font-medium text-ink">控件强调 Body 13.5/500 — 立即同步</div>
          <div className="text-meta text-ink-muted">
            元数据 Meta 12/400 — /home/dev/projects/redis-go · 8 条 · 今天 06:38
          </div>
          <div className="text-tech text-ink-muted">
            技术标识 Tech 11 mono — #0001 · 2026-09-16 06:35:25 · 0123456789
          </div>
        </div>
      </Section>

      {/* 2. 图标 */}
      <Section id="icons" title="图标" hint="16 视窗、1.6px 圆头描边，currentColor">
        <div className="flex flex-wrap items-end gap-4">
          {ICONS.map((name) => (
            <div key={name} className="flex flex-col items-center gap-1">
              <Icon name={name} size={16} className="text-ink" />
              <span className="text-micro text-ink-faint">{name}</span>
            </div>
          ))}
          <div className="flex items-center gap-2 pl-4">
            <Dot tone="codex" />
            <Dot tone="kimi" />
            <Dot tone="accent" />
            <Dot tone="neutral" />
          </div>
        </div>
      </Section>

      {/* 3. 按钮 */}
      <Section id="buttons" title="按钮" hint="四种语气 × 两种尺寸 × 状态" surface="bg-panel">
        <div className="flex flex-col gap-4">
          <Cell label="语气 / md">
            <Button tone="primary">立即同步</Button>
            <Button>打开仓库</Button>
            <Button tone="ghost">隐藏工具消息</Button>
            <Button tone="danger">重建索引</Button>
          </Cell>
          <Cell label="语气 / sm">
            <Button tone="primary" size="sm">扫描</Button>
            <Button size="sm">清除筛选</Button>
            <Button tone="ghost" size="sm">收起</Button>
            <Button tone="danger" size="sm">中止 Rebase</Button>
          </Cell>
          <Cell label="带图标">
            <Button tone="primary" icon={<Icon name="refresh" />}>立即同步</Button>
            <Button icon={<Icon name="folder" />}>选择</Button>
            <Button tone="ghost" icon={<Icon name="external" />}>打开仓库</Button>
          </Cell>
          <Cell label="状态">
            <Button loading>同步中…</Button>
            <Button disabled>立即同步</Button>
            <Button tone="primary" loading>保存中…</Button>
            <Button tone="danger" disabled>重建索引</Button>
          </Cell>
          <Cell label="IconButton">
            <IconButton label="搜索"><Icon name="search" /></IconButton>
            <IconButton label="刷新"><Icon name="refresh" /></IconButton>
            <IconButton label="关闭" size="sm"><Icon name="close" /></IconButton>
            <IconButton label="禁用" disabled><Icon name="copy" /></IconButton>
          </Cell>
        </div>
      </Section>

      {/* 4. 表单控件 */}
      <Section id="inputs" title="表单控件" hint="输入 / 自绘下拉 / 拨杆开关 / 筛选片" surface="bg-panel">
        <div className="grid max-w-3xl gap-4 sm:grid-cols-2">
          <Cell label="TextInput">
            <TextInput placeholder="搜索关键词，例如：lazy deletion" aria-label="示例输入" />
          </Cell>
          <Cell label="TextInput · 图标内嵌">
            <TextInput
              icon={<Icon name="search" size={13} />}
              defaultValue="watchdog"
              aria-label="搜索输入"
            />
          </Cell>
          <Cell label="TextInput · 禁用 / 校验失败">
            <TextInput disabled value="不可编辑" readOnly aria-label="禁用输入" />
            <TextInput defaultValue="2026-13-45" aria-invalid aria-label="错误输入" />
          </Cell>
          <Cell label="Select（点击展开）">
            <Select
              aria-label="排序"
              value={orderDemo}
              onChange={setOrderDemo}
              options={[
                { value: 'relevance', label: '相关度' },
                { value: 'recent', label: '时间', hint: '最新优先' },
              ]}
            />
            <Select
              aria-label="来源"
              value={sourceDemo}
              onChange={setSourceDemo}
              options={[
                { value: '', label: '全部数据源' },
                { value: 'codex', label: 'Codex' },
                { value: 'kimi', label: 'Kimi Code' },
              ]}
            />
          </Cell>
          <Cell label="Toggle">
            <Toggle checked={toggleOn} onChange={setToggleOn} label="保留原始会话文件" />
            <Toggle checked={false} onChange={() => {}} label="关闭态" />
            <Toggle checked disabled onChange={() => {}} label="禁用" />
          </Cell>
          <Cell label="DateInput">
            <DateInput defaultValue="2026-09-01" aria-label="起始日期" />
          </Cell>
          <Cell label="Chip">
            <Chip onRemove={() => {}}>来源：Codex</Chip>
            <Chip onRemove={() => {}}>2026-09-01 → 2026-09-16</Chip>
          </Cell>
          <Cell label="DirectoryInput">
            <DirectoryInput
              value="D:\AIChatRepo"
              onChange={() => {}}
              onBrowse={() => {}}
              placeholder="选择目录"
            />
          </Cell>
        </div>
      </Section>

      {/* 5. 导航与浮层 */}
      <Section id="nav" title="导航与浮层" hint="分段导航 / 菜单" surface="bg-panel">
        <div className="flex flex-wrap items-center gap-6">
          <SegmentedNav
            items={[
              { key: 'conversations', label: '会话' },
              { key: 'search', label: '搜索' },
              { key: 'sync', label: '同步' },
              { key: 'settings', label: '设置' },
            ]}
            current={segment}
            onSelect={setSegment}
          />
          <Menu
            label="更多操作"
            items={[
              { label: '立即扫描', onClick: () => {}, hint: '增量' },
              { label: '重建索引', onClick: () => {}, tone: 'danger', hint: '全量' },
              { label: '打开数据目录', onClick: () => {} },
            ]}
          />
        </div>
      </Section>

      {/* 6. 列表行 */}
      <Section id="rows" title="列表行" hint="会话行：默认 / 选中 / 部分解析 / 已归档 / 长标题" surface="bg-panel">
        <div className="max-w-sm">
          <div className="flex h-[30px] items-center px-3.5 text-meta font-semibold text-ink-muted">
            今天
          </div>
          <SessionRow session={DEMO_SESSION} active={false} onClick={() => {}} />
          <SessionRow session={DEMO_SESSION} active onClick={() => {}} />
          <SessionRow
            session={{ ...DEMO_SESSION, id: 'a', partial: true, source: 'codex', title: '实现 RESP3 协议解析器' }}
            active={false}
            onClick={() => {}}
          />
          <SessionRow
            session={{ ...DEMO_SESSION, id: 'b', archived: true, syncStatus: 'archived', title: '文章详情页 SEO 元信息' }}
            active={false}
            onClick={() => {}}
          />
          <SessionRow
            session={{
              ...DEMO_SESSION,
              id: 'c',
              syncStatus: 'modified',
              title: '把「会话发现 → 增量索引 → 全文搜索 → 多机同步」串成一条链路，标题非常非常非常长',
            }}
            active={false}
            onClick={() => {}}
          />
        </div>
      </Section>

      {/* 7. 消息物件 */}
      <Section id="messages" title="消息物件" hint="用户 / 助手 / 推理 / 工具 / 事件" surface="bg-reading-glow">
        <div className="mx-auto max-w-2xl">
          {DEMO_MESSAGES.map(({ label, message }) => (
            <div key={label}>
              <div className="pt-3 text-micro uppercase tracking-wider text-ink-faint">{label}</div>
              <MessageBlock message={message} />
            </div>
          ))}
        </div>
      </Section>

      {/* 8. 反馈 */}
      <Section id="feedback" title="反馈" hint="状态胶囊 / 提示条 / 加载 / 骨架 / 空状态" surface="bg-panel">
        <div className="flex max-w-3xl flex-col gap-4">
          <Cell label="StatusPill 全语气">
            {TONES.map((tone) => (
              <StatusPill key={tone} tone={tone}>
                {tone}
              </StatusPill>
            ))}
          </Cell>
          <Cell label="Notice">
            <div className="flex w-full flex-col gap-2">
              <Notice tone="info" title="有 2 个会话待同步">
                点击「立即同步」写入快照、提交并推送。
              </Notice>
              <Notice tone="success" title="已是最新状态" />
              <Notice tone="warning" title="建议使用 Private Git Repository">
                AI 会话可能包含源代码与敏感信息。
              </Notice>
              <Notice tone="danger" title="Sync Conflict" />
            </div>
          </Cell>
          <Cell label="加载">
            <Spinner label="同步进行中…" />
            <Spinner size="sm" />
            <div className="w-48">
              <Skeleton lines={3} />
            </div>
          </Cell>
        </div>
        <div className="mt-4 h-56 max-w-xl rounded-panel border border-line/60">
          <EmptyState
            title="没有会话"
            description="点击顶部「扫描」发现本机 Codex / Kimi Code 会话。"
            primaryAction={<Button tone="primary" size="sm">扫描</Button>}
            secondaryAction={<Button tone="ghost" size="sm">打开设置</Button>}
          />
        </div>
      </Section>

      {/* 9. 面板与字段 */}
      <Section id="cards" title="面板与字段" hint="PanelHeader / SectionCard / FormField / Field" surface="bg-canvas">
        <div className="flex max-w-3xl flex-col gap-4">
          <div className="rounded-panel border border-line/60">
            <PanelHeader
              title="会话内容"
              meta="Kimi Code · /home/dev/work/web-dashboard"
              description="8 条消息 · 更新于 2026-09-16 06:38:39 · 仅本机"
              actions={<Button size="sm" tone="ghost">隐藏工具消息</Button>}
            />
            <div className="bg-reading px-4 py-3 text-body text-ink-muted">正文区域</div>
          </div>
          <SectionCard title="数据源" description="留空 = 自动发现">
            <FormField label="Codex 目录" hint="手工指定后只扫描该目录">
              {(props) => <TextInput {...props} placeholder="~/.codex" />}
            </FormField>
            <FormField label="远端地址" error="远端仓库不可达，请检查地址与凭证">
              {(props) => <TextInput {...props} defaultValue="git@github.com:you/aichat-history.git" />}
            </FormField>
          </SectionCard>
          <SectionCard title="危险区" tone="danger" description="重建索引会清空并重新解析全部会话">
            <Field label="索引体积" mono>
              247 MB
            </Field>
            <Button tone="danger" size="sm">重建索引</Button>
          </SectionCard>
        </div>
      </Section>
    </div>
  )
}
