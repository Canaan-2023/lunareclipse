/**
 * 为什么存在：工作区需要界面化增删改与切换（存 workspaces.json），随项目而非随账号，
 * 独立成设置区块便于管理。
 * 作用：工作区列表的增删改/重命名/切换默认，并展示已收藏源列表。
 */
import { useState, useEffect } from 'react'
import { Trash2, Folder, FolderOpen, Check, Pencil, FolderPlus } from 'lucide-react'
import type { WorkspaceConfig, WorkspaceItem } from '@shared/types'
import { Field } from '../Field'
import { useT } from '../../../i18n/useT'

export function WorkspaceConfigSection() {
  const t = useT()
  const [config, setConfig] = useState<WorkspaceConfig | null>(null)
  const [selectedId, setSelectedId] = useState<string>('')
  const [editingId, setEditingId] = useState<string>('') // 正在重命名的工作区 ID
  const [editingName, setEditingName] = useState<string>('') // 重命名输入框值
  const [adding, setAdding] = useState(false)
  const [newName, setNewName] = useState('')
  const [newPath, setNewPath] = useState('')
  const [msg, setMsg] = useState<{ text: string; kind: 'ok' | 'err' } | null>(null)
  const [busy, setBusy] = useState(false)

  // 首次加载
  useEffect(() => {
    const api = window.lunareclipse
    if (!api || !api.workspace) return
    api.workspace.list().then((cfg: WorkspaceConfig) => {
      setConfig(cfg)
      setSelectedId(cfg.activeWorkspaceId)
    })
  }, [])

  const flash = (text: string, kind: 'ok' | 'err' = 'ok') => {
    setMsg({ text, kind })
    setTimeout(() => setMsg(null), 3000)
  }

  const refresh = async (cfg?: WorkspaceConfig) => {
    const api = window.lunareclipse
    if (!api || !api.workspace) return
    const next: WorkspaceConfig = cfg ?? await api.workspace.list()
    setConfig(next)
    if (!next.workspaces.find((w) => w.id === selectedId)) {
      setSelectedId(next.activeWorkspaceId)
    }
  }

  const handleSelectDir = async () => {
    const api = window.lunareclipse
    if (!api || !api.workspace) return
    const res = await api.workspace.selectDir()
    if (res.ok && res.path) {
      setNewPath(res.path)
      // 默认名称取目录名
      const segs = res.path.replace(/\\/g, '/').split('/').filter(Boolean)
      if (segs.length > 0 && !newName) setNewName(segs[segs.length - 1])
    }
  }

  const handleAdd = async () => {
    const api = window.lunareclipse
    if (!api || !api.workspace) return
    if (!newPath.trim()) {
      flash(t('settings.wsSelectDirFirst'), 'err')
      return
    }
    setBusy(true)
    const res = await api.workspace.add(newName.trim() || t('settings.wsUnnamed'), newPath.trim())
    setBusy(false)
    if (res.ok && res.config) {
      await refresh(res.config)
      setAdding(false)
      setNewName('')
      setNewPath('')
      flash(t('settings.wsAdded'))
    } else {
      flash(t('settings.wsAddFail', { error: res.error ?? t('settings.wsUnknownError') }), 'err')
    }
  }

  const handleRemove = async (id: string) => {
    const api = window.lunareclipse
    if (!api || !api.workspace) return
    // 破坏性操作护栏：删除会把工作区从配置中移除（激活态一并切换），且无撤销入口，
    // 先 confirm 再执行（项目删除类操作统一惯例）。主进程 remove 仅改配置不删磁盘文件。
    const ws = config?.workspaces.find((w) => w.id === id)
    if (!confirm(`删除工作区「${ws?.name ?? id}」？此操作仅移除列表配置，不会删除磁盘文件。`)) return
    setBusy(true)
    const res = await api.workspace.remove(id)
    setBusy(false)
    if (res.ok && res.config) {
      await refresh(res.config)
      flash(t('settings.wsDeleted'))
    } else {
      flash(t('settings.wsDeleteFail', { error: res.error ?? t('settings.wsUnknownError') }), 'err')
    }
  }

  const handleSetActive = async (id: string) => {
    const api = window.lunareclipse
    if (!api || !api.workspace) return
    setBusy(true)
    const res = await api.workspace.setActive(id)
    setBusy(false)
    if (res.ok && res.config) {
      await refresh(res.config)
      flash(t('settings.wsSwitched'))
    } else {
      flash(t('settings.wsSwitchFail', { error: res.error ?? t('settings.wsUnknownError') }), 'err')
    }
  }

  const startRename = (ws: WorkspaceItem) => {
    setEditingId(ws.id)
    setEditingName(ws.name)
  }

  const commitRename = async () => {
    const api = window.lunareclipse
    if (!api || !api.workspace || !editingId) return
    const trimmed = editingName.trim()
    if (!trimmed) {
      setEditingId('')
      return
    }
    setBusy(true)
    const res = await api.workspace.rename(editingId, trimmed)
    setBusy(false)
    if (res.ok && res.config) {
      await refresh(res.config)
    } else {
      flash(t('settings.wsRenameFail', { error: res.error ?? t('settings.wsUnknownError') }), 'err')
    }
    setEditingId('')
    setEditingName('')
  }

  const inputCls = 'h-8 w-full rounded-btn border border-border bg-bg-elevated px-2.5 text-caption text-fg-primary focus:border-accent focus:outline-none'
  const btnCls = 'rounded-btn px-3 py-1.5 text-caption transition-all duration-150 active:scale-95'

  const activeWs = config?.workspaces.find((w) => w.id === config.activeWorkspaceId) ?? null

  return (
    <div className="space-y-4">
      {/* 顶部说明 + 操作 */}
      <div className="flex items-center justify-between">
        <div className="flex flex-col gap-0.5">
          <div className="flex items-center gap-2 text-caption uppercase tracking-wider text-fg-muted">
            <Folder size={12} />
            {t('settings.wsAiWorkspace')}
          </div>
          {activeWs && (
            <div className="text-[11px] text-fg-muted">
              {t('settings.wsActiveLabel')}<span className="text-fg-secondary">{activeWs.name}</span>
              <span className="ml-1.5 text-fg-muted">{t('settings.wsPathParen', { path: activeWs.path })}</span>
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          {msg && (
            <span className={`text-[11px] ${msg.kind === 'ok' ? 'text-accent' : 'text-danger'}`}>
              {msg.text}
            </span>
          )}
          {!adding ? (
            <button
              onClick={() => setAdding(true)}
              className={`${btnCls} flex items-center gap-1 border border-border-subtle text-fg-secondary hover:text-accent`}
            >
              <FolderPlus size={12} /> {t('settings.wsAdd')}
            </button>
          ) : (
            <button
              onClick={() => { setAdding(false); setNewName(''); setNewPath('') }}
              className={`${btnCls} border border-border-subtle text-fg-muted hover:text-fg-secondary`}
            >
              {t('common.cancel')}
            </button>
          )}
        </div>
      </div>

      {/* 添加表单 */}
      {adding && (
        <div className="space-y-3 rounded-card border border-border-subtle bg-bg-elevated p-3">
          <Field label={t('settings.wsNameField')}>
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder={t('settings.wsNamePh')}
              className={inputCls}
            />
          </Field>
          <Field label={t('settings.wsPathField')}>
            <div className="flex gap-2">
              <input
                type="text"
                value={newPath}
                onChange={(e) => setNewPath(e.target.value)}
                placeholder={t('settings.wsPathPh')}
                className={`${inputCls} flex-1`}
              />
              <button
                onClick={handleSelectDir}
                className={`${btnCls} shrink-0 border border-border-subtle text-fg-secondary hover:text-accent`}
              >
                {t('settings.wsSelectDir')}
              </button>
            </div>
          </Field>
          <div className="flex justify-end gap-2">
            <button
              onClick={handleAdd}
              disabled={busy || !newPath.trim()}
              className={`${btnCls} bg-accent text-accent-fg disabled:opacity-40`}
            >
              {busy ? t('settings.wsProcessing') : t('settings.wsConfirmAdd')}
            </button>
          </div>
        </div>
      )}

      {/* 工作区列表 */}
      <div className="space-y-1.5">
        {config?.workspaces.map((ws) => {
          const isActive = ws.id === config.activeWorkspaceId
          const isEditing = editingId === ws.id
          return (
            <div
              key={ws.id}
              className={`rounded-card border px-3 py-2.5 transition-colors ${
                isActive
                  ? 'border-accent/40 bg-accent/5'
                  : 'border-border-subtle bg-bg-elevated hover:bg-bg-muted/40'
              }`}
            >
              <div className="flex items-center gap-2">
                {/* 激活图标 */}
                <span className="shrink-0">
                  {isActive ? (
                    <FolderOpen size={14} className="text-accent" />
                  ) : (
                    <Folder size={14} className="text-fg-muted" />
                  )}
                </span>

                {/* 名称（可重命名） */}
                {isEditing ? (
                  <input
                    type="text"
                    value={editingName}
                    onChange={(e) => setEditingName(e.target.value)}
                    onBlur={commitRename}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') { e.preventDefault(); commitRename() }
                      if (e.key === 'Escape') { setEditingId(''); setEditingName('') }
                    }}
                    autoFocus
                    className="h-6 flex-1 rounded-btn border border-accent bg-bg-base px-2 text-caption text-fg-primary focus:outline-none"
                  />
                ) : (
                  <button
                    onClick={() => setSelectedId(ws.id)}
                    onDoubleClick={() => startRename(ws)}
                    className="flex-1 truncate text-left text-body text-fg-primary"
                    title={isActive ? t('settings.wsActiveDblRename') : t('settings.wsSelectDblRename')}
                  >
                    {ws.name}
                  </button>
                )}

                {/* 激活徽章 */}
                {isActive && !isEditing && (
                  <span className="flex items-center gap-1 rounded-full bg-accent/15 px-2 py-0.5 text-[10px] text-accent">
                    <Check size={9} />
                    {t('settings.wsActiveBadge')}
                  </span>
                )}

                {/* 操作按钮 */}
                {!isEditing && (
                  <div className="flex items-center gap-1">
                    {!isActive && (
                      <button
                        onClick={() => handleSetActive(ws.id)}
                        disabled={busy}
                        className="rounded-btn px-2 py-0.5 text-[11px] text-fg-muted transition-colors hover:bg-accent/10 hover:text-accent disabled:opacity-40"
                        title={t('settings.wsSwitchToActive')}
                      >
                        {t('settings.wsSwitch')}
                      </button>
                    )}
                    <button
                      onClick={() => startRename(ws)}
                      disabled={busy}
                      className="rounded-btn p-1 text-fg-muted transition-colors hover:bg-bg-muted hover:text-fg-primary disabled:opacity-40"
                      title={t('settings.wsRename')}
                      aria-label={t('settings.wsRename')}
                    >
                      <Pencil size={11} />
                    </button>
                    <button
                      onClick={() => window.lunareclipse?.openFile?.(ws.path)}
                      className="rounded-btn p-1 text-fg-muted transition-colors hover:bg-bg-muted hover:text-accent"
                      title={t('settings.wsOpenInFinder')}
                      aria-label={t('settings.wsOpenInFinder')}
                    >
                      <FolderOpen size={11} />
                    </button>
                    <button
                      onClick={() => handleRemove(ws.id)}
                      disabled={busy || (config?.workspaces.length ?? 0) <= 1}
                      className="rounded-btn p-1 text-fg-muted transition-colors hover:bg-danger/10 hover:text-danger disabled:opacity-40"
                      title={(config?.workspaces.length ?? 0) <= 1 ? t('settings.wsKeepOne') : t('common.delete')}
                      aria-label={(config?.workspaces.length ?? 0) <= 1 ? t('settings.wsKeepOne') : t('common.delete')}
                    >
                      <Trash2 size={11} />
                    </button>
                  </div>
                )}
              </div>
              {/* 路径 */}
              <div className="mt-1 truncate pl-6 text-[11px] text-fg-muted">
                {ws.path}
              </div>
              {/* 创建时间 */}
              <div className="mt-0.5 pl-6 text-[10px] text-fg-muted/70">
                {t('settings.wsCreatedAt', { time: new Date(ws.createdAt).toLocaleString() })}
              </div>
            </div>
          )
        })}
        {config && config.workspaces.length === 0 && (
          <div className="text-caption text-fg-muted">{t('settings.wsEmptyState')}</div>
        )}
      </div>

      {/* 说明 */}
      <div className="rounded-btn bg-bg-muted/50 px-3 py-2 text-[11px] text-fg-muted leading-relaxed">
        <div className="mb-1 font-medium text-fg-secondary">{t('settings.wsAboutTitle')}</div>
        {t('settings.wsAboutDesc')}<code className="rounded bg-bg-muted px-1">.lunareclipse/skills/</code>{t('settings.wsAboutDesc2')}
      </div>
    </div>
  )
}

/* ====== 莉莉丝桌宠连接设置 ====== */

