/**
 * 设置页（规格 §19 Settings）：
 * Codex / Kimi 数据目录、同步仓库、git 可执行文件、压缩格式、保留原始文件、扫描与监听开关。
 */
import { useEffect, useState } from 'react'
import { open as openDialog } from '@tauri-apps/plugin-dialog'

import * as ipc from '../../lib/ipc'
import { useLibrary } from '../../stores/library'
import type { AppSettings } from '../../types/ipc'
import { Button, Field, PanelHeader, Select, TextInput, Toggle } from '../../components/ui'

export function SettingsPage() {
  const { settings, updateSettings, scan, error, setError } = useLibrary()
  const [draft, setDraft] = useState<AppSettings | null>(settings)
  const [dataPath, setDataPath] = useState('')
  const [machine, setMachine] = useState('')
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<string | null>(null)

  useEffect(() => {
    setDraft(settings)
  }, [settings])

  useEffect(() => {
    void ipc.dataDir().then(setDataPath)
    void ipc.machineId().then(setMachine)
  }, [])

  if (!draft) {
    return (
      <>
        <PanelHeader title="设置" />
        <div className="p-4 text-[12px] text-ink-faint">加载中…</div>
      </>
    )
  }

  /** 修改草稿（不立即保存）。 */
  const patch = (values: Partial<AppSettings>) => setDraft({ ...draft, ...values })

  /** 选择目录。 */
  const pickDirectory = async (key: 'codexPath' | 'kimiPath' | 'syncRepo') => {
    const selected = await openDialog({ directory: true, multiple: false, title: '选择目录' })
    if (typeof selected === 'string') patch({ [key]: selected } as Partial<AppSettings>)
  }

  const save = async () => {
    setSaving(true)
    setError(null)
    const ok = await updateSettings(draft)
    setSaving(false)
    if (ok) {
      setSavedAt(new Date().toLocaleTimeString())
      // 目录可能变化，提示重新扫描
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PanelHeader
        title="设置"
        subtitle={savedAt ? `已保存 ${savedAt}` : '修改后点击「保存」'}
        actions={
          <>
            <Button variant="ghost" onClick={() => setDraft(settings)} disabled={saving}>
              还原
            </Button>
            <Button variant="primary" onClick={() => void save()} disabled={saving}>
              {saving ? '保存中…' : '保存'}
            </Button>
          </>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {error ? (
          <div className="mb-3 rounded-md border border-red-500/40 bg-red-500/5 px-3 py-2 text-[12px] text-red-600 dark:text-red-400">
            {error.message}
          </div>
        ) : null}

        <div className="grid gap-6 lg:grid-cols-2">
          {/* 数据源 */}
          <section className="rounded-md border border-line p-3">
            <div className="pb-2 text-[12px] font-semibold">数据源目录</div>
            <div className="text-[11px] leading-5 text-ink-faint">
              留空 = 自动发现（Kimi：KIMI_CODE_HOME → ~/.kimi-code；Codex：CODEX_HOME → ~/.codex）。
              一旦手工指定，就只扫描该目录。
            </div>
            <Field label="Codex 目录">
              <div className="flex gap-2">
                <TextInput
                  value={draft.codexPath ?? ''}
                  onChange={(value) => patch({ codexPath: value || null })}
                  placeholder="C:\\Users\\you\\.codex"
                />
                <Button onClick={() => void pickDirectory('codexPath')}>选择</Button>
              </div>
            </Field>
            <Field label="KimiCode 目录">
              <div className="flex gap-2">
                <TextInput
                  value={draft.kimiPath ?? ''}
                  onChange={(value) => patch({ kimiPath: value || null })}
                  placeholder="C:\\Users\\you\\.kimi-code"
                />
                <Button onClick={() => void pickDirectory('kimiPath')}>选择</Button>
              </div>
            </Field>
          </section>

          {/* 同步仓库 */}
          <section className="rounded-md border border-line p-3">
            <div className="pb-2 text-[12px] font-semibold">同步仓库</div>
            <Field label="仓库目录">
              <div className="flex gap-2">
                <TextInput
                  value={draft.syncRepo ?? ''}
                  onChange={(value) => patch({ syncRepo: value || null })}
                  placeholder="D:\\AIChatRepo"
                />
                <Button onClick={() => void pickDirectory('syncRepo')}>选择</Button>
              </div>
            </Field>
            <Field label="远端地址">
              <TextInput
                value={draft.remoteUrl ?? ''}
                onChange={(value) => patch({ remoteUrl: value || null })}
                placeholder="git@github.com:you/aichat-history.git（建议私有）"
              />
            </Field>
            <Field label="git 可执行文件">
              <TextInput
                value={draft.gitExe}
                onChange={(value) => patch({ gitExe: value })}
                placeholder="git"
              />
            </Field>
            <div className="pt-1 text-[11px] leading-5 text-amber-600 dark:text-amber-400">
              ⚠ AI 会话可能包含源代码、命令输出、文件路径和敏感信息，建议使用 Private Git Repository。
            </div>
          </section>

          {/* 归档与扫描 */}
          <section className="rounded-md border border-line p-3">
            <div className="pb-2 text-[12px] font-semibold">归档与扫描</div>
            <Field label="压缩格式">
              <Select
                value={draft.archiveCompression}
                onChange={(value) => patch({ archiveCompression: value as 'zstd' | 'gzip' })}
                options={[
                  { value: 'zstd', label: 'zstd（推荐：压缩快、解压更快）' },
                  { value: 'gzip', label: 'gzip（兼容性兜底）' },
                ]}
              />
            </Field>
            <Field label="归档阈值（天）">
              <TextInput
                value={String(draft.archiveAfterDays)}
                onChange={(value) => patch({ archiveAfterDays: Number(value) || 0 })}
              />
            </Field>
            <Field label="单轮扫描上限">
              <TextInput
                value={String(draft.scanBatchLimit)}
                onChange={(value) => patch({ scanBatchLimit: Number(value) || 0 })}
              />
            </Field>
            <div className="text-[11px] leading-5 text-ink-faint">
              扫描上限用于保护首次打开超大历史时的资源占用；0 表示不限制，剩余会话会在下次扫描继续。
            </div>
          </section>

          {/* 行为开关 */}
          <section className="rounded-md border border-line p-3">
            <div className="pb-2 text-[12px] font-semibold">行为</div>
            <Toggle
              label="保留原始会话文件"
              hint="写快照时同时复制原始 state.json / wire.jsonl（关闭后只同步归一化文本）"
              checked={draft.keepRawFiles}
              onChange={(value) => patch({ keepRawFiles: value })}
            />
            <Toggle
              label="启动时自动扫描"
              hint="增量扫描：未变化的会话不会被重新解析"
              checked={draft.autoScanOnStart}
              onChange={(value) => patch({ autoScanOnStart: value })}
            />
            <Toggle
              label="监听会话目录"
              hint="AI CLI 追加 JSONL 时自动更新索引（内部 900ms 去抖）"
              checked={draft.watchEnabled}
              onChange={(value) => patch({ watchEnabled: value })}
            />
            <Toggle
              label="列表显示已归档会话"
              checked={draft.showArchived}
              onChange={(value) => patch({ showArchived: value })}
            />
            <Field label="主题">
              <Select
                value={draft.theme}
                onChange={(value) => patch({ theme: value as 'system' | 'light' | 'dark' })}
                options={[
                  { value: 'system', label: '跟随系统' },
                  { value: 'light', label: '浅色' },
                  { value: 'dark', label: '深色' },
                ]}
              />
            </Field>
          </section>

          {/* 运行信息 */}
          <section className="rounded-md border border-line p-3 lg:col-span-2">
            <div className="pb-2 text-[12px] font-semibold">运行信息</div>
            <Field label="数据目录">
              <span className="font-mono text-[11.5px]">{dataPath}</span>
            </Field>
            <Field label="本机 machine id">
              <span className="font-mono text-[11.5px]">{machine}</span>
            </Field>
            <div className="flex gap-2 pt-2">
              <Button onClick={() => void scan(false)}>立即增量扫描</Button>
              <Button variant="danger" onClick={() => void scan(true)}>
                重建索引（全量重新解析）
              </Button>
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}
