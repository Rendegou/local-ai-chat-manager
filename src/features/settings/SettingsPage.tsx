/**
 * 设置页（规格 §6.4）。
 *
 * 分组顺序：数据源 → 同步与隐私 → 扫描与归档 → 外观与行为 → 诊断信息 → Danger Zone。
 * 页面主体限制最大宽度，避免宽屏上表单被无限拉长；草稿保存在 store 中，
 * 这样外壳（App）在离开页面前可以拦截并询问。
 */
import { useEffect, useState } from 'react'
import { open as openDialog } from '@tauri-apps/plugin-dialog'

import * as ipc from '../../lib/ipc'
import { useLibrary } from '../../stores/library'
import {
  Button,
  DirectoryInput,
  Field,
  FormField,
  Notice,
  PanelHeader,
  SectionCard,
  Select,
  StatusPill,
  TextInput,
  Toggle,
} from '../../components/ui'

export function SettingsPage() {
  const {
    settings,
    settingsDraft,
    settingsDirty,
    patchSettingsDraft,
    saveSettingsDraft,
    resetSettingsDraft,
    scan,
    scanning,
    error,
    setError,
  } = useLibrary()
  const [dataPath, setDataPath] = useState('')
  const [machine, setMachine] = useState('')
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<string | null>(null)
  const [rebuildConfirm, setRebuildConfirm] = useState(false)
  // 草稿优先，没有草稿时用已保存设置
  const draft = settingsDraft ?? settings

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

  const patch = patchSettingsDraft

  /** 选择目录。 */
  const pickDirectory = async (key: 'codexPath' | 'kimiPath' | 'cursorPath' | 'zcodePath' | 'syncRepo') => {
    const selected = await openDialog({ directory: true, multiple: false, title: '选择目录' })
    if (typeof selected === 'string') patch({ [key]: selected })
  }

  const save = async () => {
    setSaving(true)
    setError(null)
    const ok = await saveSettingsDraft()
    setSaving(false)
    if (ok) setSavedAt(new Date().toLocaleTimeString())
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-canvas">
      <PanelHeader
        title="设置"
        meta={
          settingsDirty ? (
            <StatusPill tone="warning">有未保存的修改</StatusPill>
          ) : savedAt ? (
            `已保存 ${savedAt}`
          ) : (
            '修改后点击「保存」'
          )
        }
        actions={
          <>
            <Button
              tone="ghost"
              onClick={() => resetSettingsDraft()}
              disabled={!settingsDirty || saving}
            >
              还原
            </Button>
            <Button
              tone="primary"
              onClick={() => void save()}
              loading={saving}
              disabled={!settingsDirty}
            >
              {saving ? '保存中…' : '保存'}
            </Button>
          </>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        <div className="mx-auto flex w-full max-w-[980px] flex-col gap-4">
          {error ? (
            <Notice tone="danger" title={error.message}>
              {error.kind}
            </Notice>
          ) : null}

          {/* 1. 数据源 */}
          <SectionCard
            title="数据源"
            description="留空 = 自动发现（Kimi：~/.kimi-code；Codex：~/.codex；Cursor：%APPDATA%\Cursor；ZCode：~/.zcode）"
          >
            <FormField label="Codex 目录" hint="手工指定后只扫描该目录，不再自动发现其他位置">
              {(props) => (
                <DirectoryInput
                  {...props}
                  value={draft.codexPath ?? ''}
                  onChange={(value) => patch({ codexPath: value || null })}
                  placeholder="C:\Users\you\.codex"
                  onBrowse={() => void pickDirectory('codexPath')}
                />
              )}
            </FormField>
            <FormField label="KimiCode 目录" hint="通常是 ~/.kimi-code">
              {(props) => (
                <DirectoryInput
                  {...props}
                  value={draft.kimiPath ?? ''}
                  onChange={(value) => patch({ kimiPath: value || null })}
                  placeholder="C:\Users\you\.kimi-code"
                  onBrowse={() => void pickDirectory('kimiPath')}
                />
              )}
            </FormField>
            <FormField label="Cursor 目录" hint="通常是 %APPDATA%\Cursor\User\globalStorage（会话存于 state.vscdb）">
              {(props) => (
                <DirectoryInput
                  {...props}
                  value={draft.cursorPath ?? ''}
                  onChange={(value) => patch({ cursorPath: value || null })}
                  placeholder="C:\Users\you\AppData\Roaming\Cursor\User\globalStorage"
                  onBrowse={() => void pickDirectory('cursorPath')}
                />
              )}
            </FormField>
            <FormField label="ZCode 目录" hint="通常是 ~/.zcode/v2/sessions">
              {(props) => (
                <DirectoryInput
                  {...props}
                  value={draft.zcodePath ?? ''}
                  onChange={(value) => patch({ zcodePath: value || null })}
                  placeholder="C:\Users\you\.zcode\v2\sessions"
                  onBrowse={() => void pickDirectory('zcodePath')}
                />
              )}
            </FormField>
          </SectionCard>

          {/* 2. 同步与隐私 */}
          <SectionCard
            title="同步与隐私"
            description="Git 只管理独立仓库，绝不直接操作 AI 工具的数据目录"
          >
            <FormField label="仓库目录">
              {(props) => (
                <DirectoryInput
                  {...props}
                  value={draft.syncRepo ?? ''}
                  onChange={(value) => patch({ syncRepo: value || null })}
                  placeholder="D:\AIChatRepo"
                  onBrowse={() => void pickDirectory('syncRepo')}
                />
              )}
            </FormField>
            <FormField label="远端地址" hint="支持 https://（推荐，凭据交给系统 Git Credential Manager）或 git@（需已配置 SSH key）">
              {(props) => (
                <TextInput
                  {...props}
                  value={draft.remoteUrl ?? ''}
                  onChange={(event) => patch({ remoteUrl: event.target.value || null })}
                  placeholder="https://github.com/you/aichat-history.git"
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
                AI 会话可能包含源代码、命令输出、文件路径和敏感信息；客户端会强制跳过凭证类目录。
              </Notice>
            </div>
          </SectionCard>

          {/* 3. 扫描与归档 */}
          <SectionCard
            title="扫描与归档"
            description="扫描只读取本机会话文件；归档只影响同步仓库，本地原始文件始终保留"
          >
            <FormField label="压缩格式">
              {(props) => (
                <Select
                  {...props}
                  value={draft.archiveCompression}
                  onChange={(value) => patch({ archiveCompression: value as 'zstd' | 'gzip' })}
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
                  onChange={(event) => patch({ archiveAfterDays: Number(event.target.value) || 0 })}
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
                  onChange={(event) => patch({ scanBatchLimit: Number(event.target.value) || 0 })}
                  inputMode="numeric"
                />
              )}
            </FormField>
          </SectionCard>

          {/* 4. 外观与行为 */}
          <SectionCard title="外观与行为" description="监听与自动扫描都只影响索引，不改动原始文件">
            <Toggle
              label="额外保留原始会话副本"
              description="默认关闭以节省 Git 空间；开启会同时上传 raw 文件。关闭并保存后，下次同步会清理本机快照中的 raw，不影响 Codex / Kimi 原文件"
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
                  onChange={(value) => patch({ theme: value as 'system' | 'light' | 'dark' })}
                  options={[
                    { value: 'system', label: '跟随系统' },
                    { value: 'light', label: '浅色' },
                    { value: 'dark', label: '深色' },
                  ]}
                />
              )}
            </FormField>
          </SectionCard>

          {/* 5. 诊断信息 */}
          <SectionCard title="诊断信息" description="排查问题时把这些信息一起提供">
            <Field label="数据目录" mono>
              {dataPath}
            </Field>
            <Field label="本机 machine id" mono>
              {machine}
            </Field>
            <Field label="索引体积" mono>
              {useLibrary.getState().stats
                ? `${useLibrary.getState().stats?.bytesOnDisk} 字节`
                : '—'}
            </Field>
            <div className="flex gap-2 pt-3">
              <Button onClick={() => void scan(false)} loading={scanning}>
                立即增量扫描
              </Button>
            </div>
          </SectionCard>

          {/* 6. Danger Zone */}
          <SectionCard
            tone="danger"
            title="Danger Zone"
            description="以下操作会重建索引，请确认影响范围后再执行"
          >
            <div className="text-body text-ink-muted">
              重建索引会**清空本地索引并重新解析全部会话**：不改动 AI 工具的原始文件，
              也不改动同步仓库；但会话较多时可能需要数分钟，期间列表会逐步恢复。
            </div>
            {rebuildConfirm ? (
              <div className="flex flex-wrap items-center gap-2 pt-3">
                <span className="text-body text-danger">确认要重建索引吗？</span>
                <Button
                  tone="danger"
                  onClick={() => {
                    setRebuildConfirm(false)
                    void scan(true)
                  }}
                >
                  确认重建
                </Button>
                <Button tone="ghost" onClick={() => setRebuildConfirm(false)}>
                  取消
                </Button>
              </div>
            ) : (
              <div className="pt-3">
                <Button tone="danger" onClick={() => setRebuildConfirm(true)}>
                  重建索引…
                </Button>
              </div>
            )}
          </SectionCard>
        </div>
      </div>
    </div>
  )
}
