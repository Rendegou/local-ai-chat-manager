/**
 * 设置页（规格 §6.4）。
 *
 * Phase 1 令牌化：字段改用 FormField（真正绑定 label/hint/error）、分组改用 SectionCard、
 * 提示改用 Notice。分组重排、未保存保护、Danger Zone 在 Phase 3 处理。
 */
import { useEffect, useState } from 'react'
import { open as openDialog } from '@tauri-apps/plugin-dialog'

import * as ipc from '../../lib/ipc'
import { useLibrary } from '../../stores/library'
import type { AppSettings } from '../../types/ipc'
import {
  Button,
  Field,
  FormField,
  Notice,
  PanelHeader,
  SectionCard,
  Select,
  TextInput,
  Toggle,
} from '../../components/ui'

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
        <div className="p-4 text-body text-ink-muted">加载中…</div>
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
    if (ok) setSavedAt(new Date().toLocaleTimeString())
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-canvas">
      <PanelHeader
        title="设置"
        meta={savedAt ? `已保存 ${savedAt}` : '修改后点击「保存」'}
        actions={
          <>
            <Button tone="ghost" onClick={() => setDraft(settings)} disabled={saving}>
              还原
            </Button>
            <Button tone="primary" onClick={() => void save()} loading={saving}>
              {saving ? '保存中…' : '保存'}
            </Button>
          </>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <div className="mx-auto flex max-w-[980px] flex-col gap-3">
          {error ? (
            <Notice tone="danger" title={error.message}>
              {error.kind}
            </Notice>
          ) : null}

          <div className="grid gap-3 lg:grid-cols-2">
            {/* 数据源 */}
            <SectionCard
              title="数据源目录"
              description="留空 = 自动发现（Kimi：KIMI_CODE_HOME → ~/.kimi-code；Codex：CODEX_HOME → ~/.codex）"
            >
              <FormField
                label="Codex 目录"
                hint="手工指定后只扫描该目录，不再自动发现其他位置"
              >
                {(props) => (
                  <div className="flex gap-2">
                    <TextInput
                      {...props}
                      value={draft.codexPath ?? ''}
                      onChange={(event) => patch({ codexPath: event.target.value || null })}
                      placeholder="C:\\Users\\you\\.codex"
                    />
                    <Button onClick={() => void pickDirectory('codexPath')}>选择</Button>
                  </div>
                )}
              </FormField>
              <FormField label="KimiCode 目录" hint="通常是 ~/.kimi-code">
                {(props) => (
                  <div className="flex gap-2">
                    <TextInput
                      {...props}
                      value={draft.kimiPath ?? ''}
                      onChange={(event) => patch({ kimiPath: event.target.value || null })}
                      placeholder="C:\\Users\\you\\.kimi-code"
                    />
                    <Button onClick={() => void pickDirectory('kimiPath')}>选择</Button>
                  </div>
                )}
              </FormField>
            </SectionCard>

            {/* 同步仓库 */}
            <SectionCard
              title="同步仓库"
              description="Git 只管理这个独立仓库，绝不直接操作 AI 工具的数据目录"
            >
              <FormField label="仓库目录">
                {(props) => (
                  <div className="flex gap-2">
                    <TextInput
                      {...props}
                      value={draft.syncRepo ?? ''}
                      onChange={(event) => patch({ syncRepo: event.target.value || null })}
                      placeholder="D:\\AIChatRepo"
                    />
                    <Button onClick={() => void pickDirectory('syncRepo')}>选择</Button>
                  </div>
                )}
              </FormField>
              <FormField label="远端地址" hint="支持 GitHub / GitLab / Gitea / 自建 Git">
                {(props) => (
                  <TextInput
                    {...props}
                    value={draft.remoteUrl ?? ''}
                    onChange={(event) => patch({ remoteUrl: event.target.value || null })}
                    placeholder="git@github.com:you/aichat-history.git"
                  />
                )}
              </FormField>
              <FormField label="git 可执行文件" hint="默认从 PATH 查找 git">
                {(props) => (
                  <TextInput
                    {...props}
                    value={draft.gitExe}
                    onChange={(event) => patch({ gitExe: event.target.value })}
                    placeholder="git"
                  />
                )}
              </FormField>
              <div className="pt-2">
                <Notice tone="warning" title="建议使用 Private Git Repository">
                  AI 会话可能包含源代码、命令输出、文件路径和敏感信息。
                </Notice>
              </div>
            </SectionCard>

            {/* 归档与扫描 */}
            <SectionCard title="归档与扫描" description="归档只影响同步仓库，本地原始文件始终保留">
              <FormField label="压缩格式">
                {(props) => (
                  <Select
                    {...props}
                    value={draft.archiveCompression}
                    onChange={(event) =>
                      patch({ archiveCompression: event.target.value as 'zstd' | 'gzip' })
                    }
                    options={[
                      { value: 'zstd', label: 'zstd（推荐：压缩快、解压更快）' },
                      { value: 'gzip', label: 'gzip（兼容性兜底）' },
                    ]}
                  />
                )}
              </FormField>
              <FormField label="归档阈值（天）" hint="超过该天数未更新的会话可批量归档">
                {(props) => (
                  <TextInput
                    {...props}
                    value={String(draft.archiveAfterDays)}
                    onChange={(event) =>
                      patch({ archiveAfterDays: Number(event.target.value) || 0 })
                    }
                    inputMode="numeric"
                  />
                )}
              </FormField>
              <FormField
                label="单轮扫描上限"
                hint="保护首次打开超大历史时的资源占用；0 表示不限制，剩余会话下次继续"
              >
                {(props) => (
                  <TextInput
                    {...props}
                    value={String(draft.scanBatchLimit)}
                    onChange={(event) =>
                      patch({ scanBatchLimit: Number(event.target.value) || 0 })
                    }
                    inputMode="numeric"
                  />
                )}
              </FormField>
            </SectionCard>

            {/* 行为 */}
            <SectionCard title="行为" description="扫描与监听都只读取本机会话文件">
              <Toggle
                label="保留原始会话文件"
                description="写快照时同时复制原始 state.json / wire.jsonl（关闭后只同步归一化文本）"
                checked={draft.keepRawFiles}
                onChange={(value) => patch({ keepRawFiles: value })}
              />
              <Toggle
                label="启动时自动扫描"
                description="增量扫描：未变化的会话不会被重新解析"
                checked={draft.autoScanOnStart}
                onChange={(value) => patch({ autoScanOnStart: value })}
              />
              <Toggle
                label="监听会话目录"
                description="AI CLI 追加 JSONL 时自动更新索引（内部 900ms 去抖）"
                checked={draft.watchEnabled}
                onChange={(value) => patch({ watchEnabled: value })}
              />
              <Toggle
                label="列表显示已归档会话"
                checked={draft.showArchived}
                onChange={(value) => patch({ showArchived: value })}
              />
              <FormField label="主题">
                {(props) => (
                  <Select
                    {...props}
                    value={draft.theme}
                    onChange={(event) =>
                      patch({ theme: event.target.value as 'system' | 'light' | 'dark' })
                    }
                    options={[
                      { value: 'system', label: '跟随系统' },
                      { value: 'light', label: '浅色' },
                      { value: 'dark', label: '深色' },
                    ]}
                  />
                )}
              </FormField>
            </SectionCard>
          </div>

          {/* 诊断 */}
          <SectionCard title="运行信息" description="索引是缓存，可随时重建；原始文件与同步仓库不受影响">
            <Field label="数据目录" mono>
              {dataPath}
            </Field>
            <Field label="本机 machine id" mono>
              {machine}
            </Field>
            <div className="flex gap-2 pt-3">
              <Button onClick={() => void scan(false)}>立即增量扫描</Button>
              <Button tone="danger" onClick={() => void scan(true)}>
                重建索引（全量重新解析）
              </Button>
            </div>
          </SectionCard>
        </div>
      </div>
    </div>
  )
}
