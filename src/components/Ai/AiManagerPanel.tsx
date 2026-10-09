/**
 * 为什么存在：系统支持多 AI 并存且区分系统/自定义语义（系统 AI 只读定制、自定义 AI 全量管理），
 * 需要一个集中管理入口来注册与维护各 AI 实体。
 * @category 多 AI 子系统
 * @summary AI 管理面板（右侧抽屉）：AI 列表 / 创建 / 编辑 / 提示词 / 停用。

 * 数据源：appStore.ais（登录/打开面板时经 loadAis 从主进程 aiList 拉取）。
 * 操作走 window.lunareclipse.ai.*（P1 已接线）：register/update/deactivate/reactivate/getPrompt/savePrompt。

 * 分组语义：
 * - 系统 AI（kind='system'）：只读展示，提供「提示词」定制（副本为空回退内置模板），不可改名/停用
 * - 自定义 AI（kind='custom'）：全部操作可用
 */
import { useEffect, useMemo, useState } from 'react'
import { Sparkles, X, Plus, ArrowLeft, Loader2, Pencil, FileText, Power, RotateCcw, Save, Trash2, RefreshCw, Bot, AlertTriangle, Brain, Database, Fingerprint, MessageSquare, Users, Wrench, Archive } from 'lucide-react'
import { useAppStore } from '../../stores/appStore'
import { useT } from '../../i18n/useT'
import { DEFAULT_AI_ID } from '@shared/types'
import type { AiRecord } from '../../../electron/main/models/ai-registry'
import { AiAvatar, AvatarPicker, aiAvatarFallback } from './AiAvatar'
// 默认头像兜底口径统一在 AiAvatar 定义，此处转发保持旧导入路径兼容
export { aiAvatarFallback } from './AiAvatar'

type View = 'list' | 'create' | 'edit' | 'prompt'

/** 会话归属 AI 名解析（会话头 / 会话列表小标共用）：ais 缺省回退 config.aiName */
export function resolveAiName(
  aiId: number | undefined,
  ais: AiRecord[],
  fallback: string
): { name: string; avatar?: string; kind?: string } {
  const rec = ais.find((a) => a.id === (aiId ?? DEFAULT_AI_ID))
  if (!rec) return { name: fallback }
  return { name: rec.name, avatar: rec.avatar, kind: rec.kind }
}

export function AiManagerPanel() {
  const open = useAppStore((s) => s.activeDrawer === 'ai' && !s.vizPanelOpen && !s.settingsOpen)
  const closeDrawer = useAppStore((s) => s.closeDrawer)
  const ais = useAppStore((s) => s.ais)
  const loadAis = useAppStore((s) => s.loadAis)
  const t = useT()

  const [view, setView] = useState<View>('list')
  const [selected, setSelected] = useState<AiRecord | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  // AI 代理全局开关（social 域 ai-agent 配置）
  const [proxyOn, setProxyOn] = useState<boolean | null>(null)
  const [proxyBusy, setProxyBusy] = useState(false)
  // 删除确认弹层：目标 AI / 删除中
  const [removeTarget, setRemoveTarget] = useState<AiRecord | null>(null)
  const [removing, setRemoving] = useState(false)

  // 打开面板时刷新注册表（登录态下 loadAis 静默失败不阻塞）
  useEffect(() => {
    if (open) void loadAis()
  }, [open, loadAis])

  // 打开面板时读取 AI 代理全局开关
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setProxyBusy(true)
    window.lunareclipse
      .aiAgentGetGlobal()
      .then((r) => {
        if (!cancelled) setProxyOn(r.ok ? (r.enabled ?? false) : null)
      })
      .catch(() => {
        if (!cancelled) setProxyOn(null)
      })
      .finally(() => {
        if (!cancelled) setProxyBusy(false)
      })
    return () => {
      cancelled = true
    }
  }, [open])

  const toggleProxy = async () => {
    if (proxyBusy || proxyOn === null) return
    const next = !proxyOn
    setProxyBusy(true)
    try {
      const r = await window.lunareclipse.aiAgentSetGlobal(next)
      if (r.ok) setProxyOn(next)
      else setError(r.error ?? t('ai.proxyToggleFail'))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setProxyBusy(false)
    }
  }

  // 删除确认弹层：Esc 关闭（与遮罩点击、关闭按钮三途径一致，键盘可达）
  useEffect(() => {
    if (!removeTarget) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !removing) setRemoveTarget(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [removeTarget, removing])

  const systemAis = useMemo(() => ais.filter((a) => a.kind === 'system'), [ais])
  const customAis = useMemo(() => ais.filter((a) => a.kind !== 'system'), [ais])

  if (!open) return null

  const run = async (fn: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await fn()
      await loadAis()
      return true
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      return false
    } finally {
      setBusy(false)
    }
  }

  const goList = () => {
    setView('list')
    setSelected(null)
    setError(null)
    setNotice(null)
  }

  /** 删除确认弹层中的「确认删除」：调用 ai:remove 级联清除该 AI 全部工作域，成功后展示清除统计反馈 */
  const confirmRemove = async () => {
    if (!removeTarget || removing) return
    setRemoving(true)
    setError(null)
    setNotice(null)
    try {
      const res = await window.lunareclipse.aiRemove(removeTarget.id)
      if (!res?.ok) throw new Error(res?.error ?? t('ai.deleteFail'))
      const removed = res.removed
      if (removed) {
        setNotice(
          t('ai.deletedSummary', {
            name: removeTarget.name,
            dirs: removed.dirs.length,
            files: removed.files.length,
            sessions: removed.sessions.length
          })
        )
      } else {
        setNotice(t('ai.deleted', { name: removeTarget.name }))
      }
      await loadAis()
      setRemoveTarget(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setRemoving(false)
    }
  }

  return (
    <div className="flex h-full w-full flex-col bg-bg-surface">
      {/* 顶部工具栏 */}
      <div className="flex items-center gap-2 border-b border-border-subtle px-3 py-2">
        {view !== 'list' ? (
          <button
            onClick={goList}
            className="flex h-6 w-6 items-center justify-center rounded-btn text-fg-muted transition-all duration-150 hover:bg-bg-muted hover:text-fg-primary active:scale-95"
            title={t('ai.back')}
            aria-label={t('ai.back')}
          >
            <ArrowLeft size={14} />
          </button>
        ) : (
          <Sparkles size={14} className="shrink-0 text-accent" />
        )}
        <span className="mr-1 truncate text-caption font-medium text-fg-primary">
          {view === 'prompt' && selected ? t('ai.promptOf', { name: selected.name }) : view === 'edit' ? t('ai.editTitle') : view === 'create' ? t('ai.createTitle') : t('ai.title')}
        </span>
        {view === 'list' && ais.length > 0 && (
          <span className="rounded-full bg-bg-muted px-1.5 py-0.5 text-[10px] text-fg-muted">
            {ais.length}
          </span>
        )}
        <div className="flex-1" />
        {/* 刷新 */}
        <button
          onClick={() => void run(() => Promise.resolve())}
          disabled={busy}
          className="flex h-7 w-7 items-center justify-center rounded-btn text-fg-muted transition-all duration-150 hover:bg-bg-muted hover:text-fg-primary disabled:opacity-30"
          title={t('ai.refresh')}
          aria-label={t('ai.refresh')}
        >
          {busy ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
        </button>
        {/* 关闭 */}
        <button
          onClick={closeDrawer}
          className="flex h-7 w-7 items-center justify-center rounded-btn text-fg-muted transition-all duration-150 hover:bg-bg-muted hover:text-fg-primary active:scale-95"
          title={t('common.close')}
          aria-label={t('common.close')}
        >
          <X size={14} />
        </button>
      </div>

      {/* 提示条 */}
      {notice && (
        <div className="flex items-center gap-2 border-b border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-caption text-emerald-400">
          <span className="flex-1">{notice}</span>
          <button onClick={() => setNotice(null)} className="text-emerald-400/70 hover:text-emerald-400" title={t('common.close')} aria-label={t('common.close')}>
            <X size={10} />
          </button>
        </div>
      )}
      {error && (
        <div className="flex items-center gap-2 border-b border-red-500/20 bg-red-500/10 px-3 py-2 text-caption text-red-400">
          <span className="flex-1">{error}</span>
          <button onClick={() => setError(null)} className="text-red-400/70 hover:text-red-400" title={t('common.close')} aria-label={t('common.close')}>
            <X size={10} />
          </button>
        </div>
      )}

      {/* 内容区 */}
      <div className="flex-1 overflow-y-auto">
        {view === 'create' && (
          <CreateForm
            busy={busy}
            onCancel={goList}
            onSubmit={async (payload) => {
              const ok = await run(async () => {
                // 本地图片在创建后落盘（此时才拿到 id），再回写 avatar 字段
                const { avatarImageDataUrl, ...regInput } = payload
                const res = await window.lunareclipse.aiRegister(regInput)
                if (!res?.ok) throw new Error(res?.error ?? t('ai.createFail'))
                if (res.existing) {
                  setNotice(t('ai.existing', { name: payload.name }))
                } else {
                  if (payload.avatarImageDataUrl && res.record) {
                    const img = await window.lunareclipse.aiSaveAvatarImage(res.record.id, payload.avatarImageDataUrl)
                    if (img?.ok && img.ref) {
                      await window.lunareclipse.aiUpdate(res.record.id, { avatar: img.ref })
                    }
                  }
                  setNotice(t('ai.created', { name: payload.name }))
                }
              })
              if (ok) goList()
            }}
          />
        )}

        {view === 'edit' && selected && (
          <EditForm
            ai={selected}
            busy={busy}
            onCancel={goList}
            onSubmit={async (name, description, avatar) => {
              await run(async () => {
                const res = await window.lunareclipse.aiUpdate(selected.id, { name, description, avatar })
                if (!res?.ok) throw new Error(res?.error ?? t('ai.updateFail'))
                setNotice(t('ai.updated', { name }))
              })
              goList()
            }}
          />
        )}

        {view === 'prompt' && selected && (
          <PromptEditor
            ai={selected}
            busy={busy}
            onBack={goList}
            onNotify={setNotice}
          />
        )}

        {view === 'list' && (
          <div className="px-2 py-2">
            {/* AI 代理全局开关（好友/群聊/公告板 AI 自动应答的总闸） */}
            <div className="mb-2 flex items-center gap-2 rounded-btn border border-border-subtle bg-bg-base px-3 py-2">
              <Bot size={13} className="shrink-0 text-accent" />
              <div className="min-w-0 flex-1">
                <div className="text-caption font-medium text-fg-primary">{t('ai.proxyGlobal')}</div>
                <div className="mt-0.5 text-micro text-fg-muted">{t('ai.proxyGlobalDesc')}</div>
              </div>
              <button
                onClick={() => void toggleProxy()}
                disabled={proxyBusy || proxyOn === null}
                role="switch"
                aria-checked={proxyOn === true}
                aria-label={t('ai.proxyGlobal')}
                title={proxyOn ? t('ai.proxyOn') : t('ai.proxyOff')}
                className={`relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-40 ${
                  proxyOn ? 'bg-accent' : 'bg-bg-muted'
                }`}
              >
                {proxyBusy || proxyOn === null ? (
                  <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
                    <Loader2 size={10} className="animate-spin text-fg-muted" />
                  </span>
                ) : (
                  <span
                    className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all ${
                      proxyOn ? 'left-[18px]' : 'left-0.5'
                    }`}
                  />
                )}
              </button>
            </div>

            {/* 新建入口 */}
            <button
              onClick={() => {
                setError(null)
                setNotice(null)
                setView('create')
              }}
              className="mb-2 flex w-full items-center justify-center gap-1.5 rounded-btn border border-dashed border-border-subtle px-3 py-2 text-caption text-fg-muted transition-colors hover:border-accent/40 hover:bg-accent/5 hover:text-accent"
            >
              <Plus size={13} />
              {t('ai.createNew')}
            </button>

            {/* 系统 AI（只读展示 + 提示词定制） */}
            <div className="mb-3">
              <div className="mb-1.5 flex items-center gap-1 px-1 text-[10px] uppercase tracking-wider text-fg-muted">
                <span className="rounded-full bg-accent/10 px-2 py-0.5 text-accent">{t('ai.system')}</span>
                <span className="text-fg-muted/70">· {systemAis.length}</span>
              </div>
              {systemAis.length > 0 ? (
                systemAis.map((ai) => (
                  <AiListItem
                    key={ai.id}
                    ai={ai}
                    onPrompt={() => {
                      setSelected(ai)
                      setView('prompt')
                    }}
                  />
                ))
              ) : (
                <div className="px-3 py-2 text-[10px] text-fg-muted/60">{t('ai.empty')}</div>
              )}
            </div>

            {/* 自定义 AI（可管理） */}
            <div className="mb-3">
              <div className="mb-1.5 flex items-center gap-1 px-1 text-[10px] uppercase tracking-wider text-fg-muted">
                <span className="rounded-full bg-bg-muted px-2 py-0.5 text-fg-secondary">{t('ai.custom')}</span>
                <span className="text-fg-muted/70">· {customAis.length}</span>
              </div>
              {customAis.length > 0 ? (
                customAis.map((ai) => (
                  <AiListItem
                    key={ai.id}
                    ai={ai}
                    onEdit={() => {
                      setSelected(ai)
                      setView('edit')
                    }}
                    onPrompt={() => {
                      setSelected(ai)
                      setView('prompt')
                    }}
                    onToggle={async () => {
                      await run(async () => {
                        const res = ai.deactivated
                          ? await window.lunareclipse.aiReactivate(ai.id)
                          : await window.lunareclipse.aiDeactivate(ai.id)
                        if (!res?.ok) throw new Error(res?.error ?? t('ai.toggleFail'))
                        setNotice(ai.deactivated ? t('ai.reactivated', { name: ai.name }) : t('ai.deactivated', { name: ai.name }))
                      })
                    }}
                    onRemove={() => {
                      setError(null)
                      setNotice(null)
                      setRemoveTarget(ai)
                    }}
                  />
                ))
              ) : (
                <div className="px-3 py-2 text-[10px] text-fg-muted/60">{t('ai.customEmpty')}</div>
              )}
            </div>
          </div>
        )}

</div>

        {/* 删除确认弹层：级联清除该 AI 全部工作域，展示范围清单与清除统计 */}
        {removeTarget && (
          <div
            className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 backdrop-blur-[2px]"
            onMouseDown={(e) => {
              if (e.target === e.currentTarget && !removing) setRemoveTarget(null)
            }}
          >
            <div
              role="dialog"
              aria-modal="true"
              aria-label={t('ai.confirmDelete', { name: removeTarget.name })}
              className="w-[400px] max-w-[92vw] overflow-hidden rounded-card border border-red-500/20 bg-bg-elevated shadow-2xl"
            >
              {/* 标题行 */}
              <div className="flex items-start gap-2 px-4 py-3">
                <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-red-500/10 text-red-400">
                  <AlertTriangle size={14} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-caption font-medium text-fg-primary">{t('ai.confirmDelete', { name: removeTarget.name })}</div>
                  <div className="mt-0.5 text-micro text-fg-muted">
                    #{removeTarget.id} · {removeTarget.agent}
                  </div>
                </div>
                <button
                  onClick={() => !removing && setRemoveTarget(null)}
                  disabled={removing}
                  className="flex h-6 w-6 items-center justify-center rounded-btn text-fg-muted transition-colors hover:bg-bg-muted hover:text-fg-primary disabled:opacity-30"
                  title={t('common.close')}
                  aria-label={t('common.close')}
                >
                  <X size={13} />
                </button>
              </div>

              {/* 说明 */}
              <div className="px-4 pb-3 text-caption leading-relaxed text-fg-secondary">
                {t('ai.deleteScopeDesc')}
              </div>

              {/* 级联清除范围清单 */}
              <div className="grid grid-cols-2 gap-1.5 px-4 pb-3">
                {REMOVE_SCOPES.map(({ icon: Icon, key }) => (
                  <div key={key} className="flex items-center gap-1.5 rounded-btn bg-red-500/[0.06] px-2 py-1.5 text-caption text-fg-secondary">
                    <Icon size={12} className="shrink-0 text-red-400/80" />
                    <span className="truncate">{t(`ai.${key}`)}</span>
                  </div>
                ))}
              </div>

              {/* 不可恢复警告 */}
              <div className="flex items-center gap-1.5 px-4 pb-4 text-micro font-medium text-red-400">
                <AlertTriangle size={12} className="shrink-0" />
                {t('ai.deleteIrreversible')}
              </div>

              {/* 操作区 */}
              <div className="flex items-center gap-2 border-t border-border-subtle px-4 py-3">
                <button
                  onClick={() => setRemoveTarget(null)}
                  disabled={removing}
                  className="flex h-7 flex-1 items-center justify-center rounded-btn border border-border-subtle px-3 text-caption text-fg-muted transition-colors hover:bg-bg-muted hover:text-fg-primary disabled:opacity-40"
                >
                  {t('ai.cancel')}
                </button>
                <button
                  onClick={() => void confirmRemove()}
                  disabled={removing}
                  className="flex h-7 flex-1 items-center justify-center gap-1.5 rounded-btn bg-red-500 px-3 text-caption font-medium text-white transition-colors hover:bg-red-600 disabled:opacity-40"
                >
                  {removing ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
                  {removing ? t('ai.deleting') : t('ai.deleteConfirmBtn')}
                </button>
              </div>

              </div>
          </div>
        )}
    </div>
  )
}

/** 删除弹层中的级联清除范围清单（对应 ai-workspace-purge 清理的每类工作域） */
const REMOVE_SCOPES = [
  { icon: Brain, key: 'scopeMemory' },
  { icon: Database, key: 'scopeRaw' },
  { icon: Fingerprint, key: 'scopeNng' },
  { icon: Sparkles, key: 'scopeIdentity' },
  { icon: MessageSquare, key: 'scopeSessions' },
  { icon: Archive, key: 'scopeAvatarPrompt' },
  { icon: Users, key: 'scopeSocial' },
  { icon: Wrench, key: 'scopeTools' }
] as const

/** 列表行：avatar + 名称 + 描述 + 操作 */
function AiListItem({
  ai,
  onEdit,
  onPrompt,
  onToggle,
  onRemove
}: {
  ai: AiRecord
  onEdit?: () => void
  onPrompt?: () => void
  onToggle?: () => void
  onRemove?: () => void
}) {
  const t = useT()
  const isSystem = ai.kind === 'system'
  return (
    <div className={`group mb-1 flex items-start gap-2 rounded-btn px-3 py-2 transition-all duration-150 hover:bg-bg-muted/70 ${ai.deactivated ? 'opacity-50' : ''}`}>
      <AiAvatar
        avatar={ai.avatar}
        fallback={aiAvatarFallback(ai.id)}
        className="mt-0.5 h-6 w-6 text-sm"
        title={ai.name}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className={`truncate text-body ${ai.deactivated ? 'text-fg-muted' : 'text-fg-primary'}`}>{ai.name}</span>
          {ai.deactivated && (
            <span className="shrink-0 rounded-full bg-fg-muted/15 px-1.5 py-0.5 text-[10px] text-fg-muted">{t('ai.statusDeactivated')}</span>
          )}
          {!ai.deactivated && (
            <span className="shrink-0 rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-[10px] text-emerald-400">{t('ai.statusActive')}</span>
          )}
        </div>
        {ai.description && (
          <div className="mt-0.5 line-clamp-2 text-caption text-fg-secondary">{ai.description}</div>
        )}
        <div className="mt-1 flex flex-wrap items-center gap-1 text-micro text-fg-muted">
          <span className="rounded bg-bg-muted px-1 py-px font-mono">#{ai.id}</span>
          <span className="rounded bg-bg-muted px-1 py-px font-mono">{ai.agent}</span>
          {ai.parentAiId != null && <span>· {t('ai.fromAi', { id: ai.parentAiId })}</span>}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {/* 提示词 */}
        <button
          onClick={onPrompt}
          aria-label={t('ai.prompt')}
          className="flex h-6 w-6 items-center justify-center rounded text-fg-muted transition-colors hover:bg-bg-muted hover:text-accent"
          title={t('ai.prompt')}
        >
          <FileText size={12} />
        </button>
        {!isSystem && onEdit && (
          <button
            onClick={onEdit}
            aria-label={t('ai.edit')}
            className="flex h-6 w-6 items-center justify-center rounded text-fg-muted transition-colors hover:bg-bg-muted hover:text-accent"
            title={t('ai.edit')}
          >
            <Pencil size={12} />
          </button>
        )}
        {!isSystem && onToggle && (
          <button
            onClick={onToggle}
            aria-label={ai.deactivated ? t('ai.reactivate') : t('ai.deactivate')}
            className={`flex h-6 w-6 items-center justify-center rounded transition-colors hover:bg-bg-muted ${ai.deactivated ? 'text-accent hover:text-accent' : 'text-fg-muted hover:text-red-400'}`}
            title={ai.deactivated ? t('ai.reactivate') : t('ai.deactivate')}
          >
            {ai.deactivated ? <RotateCcw size={12} /> : <Power size={12} />}
          </button>
        )}
        {!isSystem && onRemove && (
          <button
            onClick={onRemove}
            aria-label={t('ai.delete')}
            className="flex h-6 w-6 items-center justify-center rounded text-fg-muted transition-colors hover:bg-red-500/10 hover:text-red-400"
            title={t('ai.delete')}
          >
            <Trash2 size={12} />
          </button>
        )}
      </div>
    </div>
  )
}

/** 创建表单 */
function CreateForm({
  busy,
  onCancel,
  onSubmit
}: {
  busy: boolean
  onCancel: () => void
  onSubmit: (payload: { name: string; description?: string; avatar?: string; avatarImageDataUrl?: string; systemPrompt?: string }) => void
}) {
  const t = useT()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [avatar, setAvatar] = useState<string | undefined>(undefined)
  const [systemPrompt, setSystemPrompt] = useState('')
  const [localErr, setLocalErr] = useState<string | null>(null)

  const submit = () => {
    const trimmed = name.trim()
    if (trimmed.length < 1 || trimmed.length > 16) {
      setLocalErr(t('ai.nameInvalid'))
      return
    }
    setLocalErr(null)
    // 本地图片（data: 前缀）尚未落盘：拆分交付，由面板层在创建成功后调 ai:saveAvatarImage 落盘再回写
    const isImageData = avatar?.startsWith('data:')
    onSubmit({
      name: trimmed,
      description: description.trim() || undefined,
      avatar: isImageData ? undefined : avatar,
      avatarImageDataUrl: isImageData ? avatar : undefined,
      systemPrompt: systemPrompt.trim() || undefined
    })
  }

  return (
    <div className="px-3 py-3">
      <div className="mb-3 space-y-2">
        <div>
          <div className="mb-1 text-caption text-fg-secondary">{t('ai.name')} *</div>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
            placeholder={t('ai.namePlaceholder')}
            maxLength={16}
            className="w-full rounded-btn border border-border-subtle bg-bg-base px-2.5 py-1.5 text-caption text-fg-primary outline-none focus:border-accent"
          />
        </div>
        <div>
          <div className="mb-1 text-caption text-fg-secondary">{t('ai.description')}</div>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={t('ai.descriptionPlaceholder')}
            maxLength={200}
            rows={2}
            className="w-full resize-none rounded-btn border border-border-subtle bg-bg-base px-2.5 py-1.5 text-caption text-fg-primary outline-none focus:border-accent"
          />
        </div>
        <div>
          <div className="mb-1 text-caption text-fg-secondary">{t('ai.avatar')}</div>
          <AvatarPicker avatar={avatar} onChange={setAvatar} label="🤖" />
        </div>
        <div>
          <div className="mb-1 text-caption text-fg-secondary">{t('ai.promptCreate')}</div>
          <textarea
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
            placeholder={t('ai.promptCreatePlaceholder')}
            maxLength={50000}
            rows={5}
            className="w-full resize-none rounded-btn border border-border-subtle bg-bg-base px-2.5 py-1.5 font-mono text-caption text-fg-primary outline-none focus:border-accent"
          />
        </div>
      </div>
      {localErr && <div className="mb-2 text-caption text-red-400">{localErr}</div>}
      <div className="flex items-center gap-2">
        <button
          onClick={submit}
          disabled={busy}
          className="flex h-7 flex-1 items-center justify-center gap-1 rounded-btn bg-accent px-3 text-caption font-medium text-accent-fg transition-colors hover:bg-accent/90 disabled:opacity-40"
        >
          {busy ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
          {t('ai.save')}
        </button>
        <button
          onClick={onCancel}
          disabled={busy}
          className="flex h-7 items-center rounded-btn border border-border-subtle px-3 text-caption text-fg-muted transition-colors hover:bg-bg-muted hover:text-fg-primary"
        >
          {t('ai.cancel')}
        </button>
      </div>
    </div>
  )
}

/** 编辑表单 */
function EditForm({
  ai,
  busy,
  onCancel,
  onSubmit
}: {
  ai: AiRecord
  busy: boolean
  onCancel: () => void
  onSubmit: (name: string, description: string | undefined, avatar: string | undefined) => void
}) {
  const t = useT()
  const [name, setName] = useState(ai.name)
  const [description, setDescription] = useState(ai.description ?? '')
  const [avatar, setAvatar] = useState<string | undefined>(ai.avatar)
  const [localErr, setLocalErr] = useState<string | null>(null)

  const submit = () => {
    const trimmed = name.trim()
    if (trimmed.length < 1 || trimmed.length > 16) {
      setLocalErr(t('ai.nameInvalid'))
      return
    }
    setLocalErr(null)
    onSubmit(trimmed, description.trim() || undefined, avatar?.trim() ? avatar : undefined)
  }

  return (
    <div className="px-3 py-3">
      <div className="mb-3 space-y-2">
        <div>
          <div className="mb-1 text-caption text-fg-secondary">{t('ai.name')} *</div>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
            maxLength={16}
            className="w-full rounded-btn border border-border-subtle bg-bg-base px-2.5 py-1.5 text-caption text-fg-primary outline-none focus:border-accent"
          />
        </div>
        <div>
          <div className="mb-1 text-caption text-fg-secondary">{t('ai.description')}</div>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={200}
            rows={3}
            className="w-full resize-none rounded-btn border border-border-subtle bg-bg-base px-2.5 py-1.5 text-caption text-fg-primary outline-none focus:border-accent"
          />
        </div>
        <div>
          <div className="mb-1 text-caption text-fg-secondary">{t('ai.avatar')}</div>
          <AvatarPicker
            avatar={avatar}
            onChange={setAvatar}
            label="🤖"
            saveImage={async (dataUrl) => {
              const r = await window.lunareclipse.aiSaveAvatarImage(ai.id, dataUrl)
              return r?.ok ? (r.ref ?? null) : null
            }}
          />
        </div>
      </div>
      {localErr && <div className="mb-2 text-caption text-red-400">{localErr}</div>}
      <div className="flex items-center gap-2">
        <button
          onClick={submit}
          disabled={busy}
          className="flex h-7 flex-1 items-center justify-center gap-1 rounded-btn bg-accent px-3 text-caption font-medium text-accent-fg transition-colors hover:bg-accent/90 disabled:opacity-40"
        >
          {busy ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
          {t('ai.save')}
        </button>
        <button
          onClick={onCancel}
          disabled={busy}
          className="flex h-7 items-center rounded-btn border border-border-subtle px-3 text-caption text-fg-muted transition-colors hover:bg-bg-muted hover:text-fg-primary"
        >
          {t('ai.cancel')}
        </button>
      </div>
    </div>
  )
}

/** 文件粒度提示词编辑器：内置模板为基底，副本目录（frontend/shared）同名替换/独有追加。
 * 左侧按层列出参与合并的文件（内置=只读基底，副本=可编辑覆盖）；
 * 选中内置文件可「建立副本」后编辑；副本可保存/删除（恢复内置）；新建文件走 frontend/shared 层追加。 */
function PromptEditor({
  ai,
  busy,
  onBack,
  onNotify
}: {
  ai: AiRecord
  busy: boolean
  onBack: () => void
  onNotify: (msg: string) => void
}) {
  const t = useT()
  type PromptLayer = 'frontend' | 'shared'
  type PromptFileEntry = { name: string; source: 'builtin' | 'override' }
  type SelEntry = { layer: PromptLayer; name: string; source: 'builtin' | 'override' }

  const [layers, setLayers] = useState<{ frontend: PromptFileEntry[]; shared: PromptFileEntry[] }>({
    frontend: [],
    shared: []
  })
  const [loading, setLoading] = useState(true)
  const [sel, setSel] = useState<SelEntry | null>(null)
  const [builtin, setBuiltin] = useState<string | null>(null)
  const [content, setContent] = useState('')
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [busyLocal, setBusyLocal] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const refresh = async () => {
    const res = await window.lunareclipse.aiListPromptFiles(ai.id)
    if (res?.ok && res.layers) {
      setLayers({ frontend: res.layers.frontend, shared: res.layers.shared })
    }
  }

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    window.lunareclipse
      .aiListPromptFiles(ai.id)
      .then((res) => {
        if (cancelled || !res?.ok || !res.layers) return
        setLayers({ frontend: res.layers.frontend, shared: res.layers.shared })
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [ai.id])

  /** 打开文件：读副本内容（无副本走内置基底），编辑区展示当前生效文本 */
  const open = async (layer: PromptLayer, name: string, source: 'builtin' | 'override') => {
    setErr(null)
    setCreating(false)
    setSel({ layer, name, source })
    setContent('')
    setBuiltin(null)
    const res = await window.lunareclipse.aiReadPromptFile(ai.id, layer, name)
    if (!res?.ok) {
      setErr(res?.error ?? '读取文件失败')
      return
    }
    setBuiltin(res.builtin ?? null)
    setContent(res.content ?? res.builtin ?? '')
  }

  /** 保存当前文件副本；内容为空 = 删除副本恢复内置（后端同语义） */
  const save = async () => {
    if (!sel || busyLocal) return
    setBusyLocal(true)
    setErr(null)
    try {
      const res = await window.lunareclipse.aiSavePromptFile(ai.id, sel.layer, sel.name, content)
      if (!res?.ok) throw new Error(res?.error ?? t('ai.promptSaveFail'))
      if (content.trim()) onNotify(t('ai.promptFileSaved', { name: sel.name }))
      else onNotify(t('ai.promptRestored', { name: sel.name }))
      await refresh()
      // 空内容 = 副本删除 → 重新按内置打开
      await open(sel.layer, sel.name, content.trim() ? 'override' : 'builtin')
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusyLocal(false)
    }
  }

  /** 以内置为基底建立副本，进入可编辑状态 */
  const createCopy = async () => {
    if (!sel || busyLocal) return
    setBusyLocal(true)
    setErr(null)
    try {
      const res = await window.lunareclipse.aiSavePromptFile(ai.id, sel.layer, sel.name, builtin ?? '')
      if (!res?.ok) throw new Error(res?.error ?? t('ai.promptSaveFail'))
      onNotify(t('ai.promptCopyDone', { name: sel.name }))
      await refresh()
      await open(sel.layer, sel.name, 'override')
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusyLocal(false)
    }
  }

  /** 删除副本恢复内置（重新打开显示内置基底） */
  const removeCopy = async () => {
    if (!sel || busyLocal) return
    setBusyLocal(true)
    setErr(null)
    try {
      const res = await window.lunareclipse.aiClearPromptFile(ai.id, sel.layer, sel.name)
      if (!res?.ok) throw new Error(res?.error ?? t('ai.promptSaveFail'))
      onNotify(t('ai.promptRestored', { name: sel.name }))
      await refresh()
      await open(sel.layer, sel.name, 'builtin')
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusyLocal(false)
    }
  }

  /** 新建副本文件：校验文件名 → 写入内容落盘 → 打开编辑 */
  const createFile = async () => {
    const name = newName.trim()
    if (!name || busyLocal) return
    if (!/^[^\\/]+\.(md|txt)$/i.test(name)) {
      setErr(t('ai.promptNameHint'))
      return
    }
    setBusyLocal(true)
    setErr(null)
    try {
      const res = await window.lunareclipse.aiSavePromptFile(ai.id, 'frontend', name, content)
      if (!res?.ok) throw new Error(res?.error ?? t('ai.promptSaveFail'))
      onNotify(t('ai.promptFileSaved', { name }))
      setNewName('')
      setCreating(false)
      await refresh()
      await open('frontend', name, 'override')
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusyLocal(false)
    }
  }

  const layerList: Array<{ key: PromptLayer; label: string }> = [
    { key: 'frontend', label: t('ai.promptLayerFrontend') },
    { key: 'shared', label: t('ai.promptLayerShared') }
  ]

  return (
    <div className="flex h-full flex-col px-3 py-3">
      <div className="mb-2 text-caption text-fg-secondary">{t('ai.promptHint')}</div>
      {loading ? (
        <div className="flex flex-1 items-center justify-center py-10 text-fg-muted">
          <Loader2 size={16} className="animate-spin" />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 gap-2">
          {/* 左侧文件清单（frontend/shared 两层） */}
          <div className="flex w-44 shrink-0 flex-col overflow-y-auto rounded-btn border border-border-subtle">
            {layerList.map(({ key, label }) => (
              <div key={key} className="flex flex-col">
                <div className="sticky top-0 z-10 flex items-center justify-between bg-bg-surface px-2 py-1 text-[10px] uppercase tracking-wider text-fg-muted">
                  <span className="flex items-center gap-1">
                    <FileText size={9} />
                    {label}
                  </span>
                  <button
                    onClick={() => {
                      setErr(null)
                      setCreating(true)
                      setSel(null)
                      setNewName('')
                      setContent('')
                    }}
                    className="rounded p-0.5 text-fg-muted transition-colors hover:bg-bg-muted hover:text-fg-primary"
                    title={t('ai.promptNew')}
                    aria-label={t('ai.promptNew')}
                  >
                    <Plus size={10} />
                  </button>
                </div>
                {layers[key].map((f) => {
                  const active = !creating && sel?.layer === key && sel?.name === f.name
                  return (
                    <button
                      key={f.name}
                      onClick={() => void open(key, f.name, f.source)}
                      className={`flex items-center gap-1.5 px-2 py-1.5 text-left text-caption transition-colors ${
                        active ? 'bg-accent/10 text-accent' : 'text-fg-muted hover:bg-bg-muted hover:text-fg-primary'
                      }`}
                    >
                      <span className="min-w-0 flex-1 truncate" title={f.name}>
                        {f.name}
                      </span>
                      <span
                        className={`shrink-0 rounded px-1 py-px text-[9px] ${
                          f.source === 'override' ? 'bg-amber-500/15 text-amber-400' : 'bg-bg-muted text-fg-muted'
                        }`}
                      >
                        {f.source === 'override' ? t('ai.promptOverrideBadge') : t('ai.promptBuiltinBadge')}
                      </span>
                    </button>
                  )
                })}
              </div>
            ))}
          </div>

          {/* 右侧编辑区 */}
          <div className="flex min-w-0 flex-1 flex-col">
            {err && <div className="mb-2 text-caption text-red-400">{err}</div>}
            {creating ? (
              <div className="flex flex-1 flex-col">
                <input
                  autoFocus
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder={t('ai.promptNewName')}
                  onKeyDown={(e) => e.key === 'Enter' && void createFile()}
                  className="mb-2 w-full rounded-btn border border-border-subtle bg-bg-base px-2.5 py-1.5 text-caption text-fg-primary outline-none focus:border-accent"
                />
                <textarea
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                  placeholder={t('ai.promptPlaceholder')}
                  className="min-h-[200px] flex-1 resize-none rounded-btn border border-border-subtle bg-bg-base px-2.5 py-2 text-caption leading-relaxed text-fg-primary outline-none focus:border-accent"
                />
                <div className="mt-2 flex items-center gap-2">
                  <button
                    onClick={() => void createFile()}
                    disabled={busyLocal || busy}
                    className="flex h-7 flex-1 items-center justify-center gap-1 rounded-btn bg-accent px-3 text-caption font-medium text-accent-fg transition-colors hover:bg-accent/90 disabled:opacity-40"
                  >
                    {busyLocal ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
                    {t('ai.promptNewCreate')}
                  </button>
                  <button
                    onClick={() => {
                      setCreating(false)
                      setErr(null)
                    }}
                    className="flex h-7 items-center rounded-btn border border-border-subtle px-3 text-caption text-fg-muted transition-colors hover:bg-bg-muted hover:text-fg-primary"
                  >
                    {t('ai.cancel')}
                  </button>
                </div>
              </div>
            ) : sel ? (
              <>
                <div className="mb-1.5 flex items-center gap-1.5">
                  <span className="min-w-0 flex-1 truncate text-caption font-medium text-fg-primary" title={sel.name}>
                    {sel.name}
                  </span>
                  <span
                    className={`shrink-0 rounded px-1 py-px text-[9px] ${
                      sel.source === 'override' ? 'bg-amber-500/15 text-amber-400' : 'bg-bg-muted text-fg-muted'
                    }`}
                  >
                    {sel.source === 'override' ? t('ai.promptOverrideBadge') : t('ai.promptBuiltinBadge')}
                  </span>
                </div>
                <textarea
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                  readOnly={sel.source === 'builtin'}
                  placeholder={t('ai.promptPlaceholder')}
                  className="min-h-[200px] flex-1 resize-none rounded-btn border border-border-subtle bg-bg-base px-2.5 py-2 text-caption leading-relaxed text-fg-primary outline-none focus:border-accent disabled:opacity-60"
                />
                <div className="mt-1 text-micro text-fg-muted">
                  {sel.source === 'builtin' ? t('ai.promptBuiltinReadonly') : t('ai.promptEmptyRemoves')}
                </div>
                <div className="mt-2 flex items-center gap-2">
                  {sel.source === 'builtin' ? (
                    <>
                      <button
                        onClick={() => void createCopy()}
                        disabled={busyLocal || busy}
                        className="flex h-7 flex-1 items-center justify-center gap-1 rounded-btn bg-accent px-3 text-caption font-medium text-accent-fg transition-colors hover:bg-accent/90 disabled:opacity-40"
                      >
                        {busyLocal ? <Loader2 size={12} className="animate-spin" /> : <Pencil size={12} />}
                        {t('ai.promptCreateCopy')}
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        onClick={() => void save()}
                        disabled={busyLocal || busy}
                        className="flex h-7 flex-1 items-center justify-center gap-1 rounded-btn bg-accent px-3 text-caption font-medium text-accent-fg transition-colors hover:bg-accent/90 disabled:opacity-40"
                      >
                        {busyLocal ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
                        {t('ai.promptSave')}
                      </button>
                      <button
                        onClick={() => void removeCopy()}
                        disabled={busyLocal || busy}
                        className="flex h-7 items-center gap-1 rounded-btn border border-border-subtle px-3 text-caption text-fg-muted transition-colors hover:bg-bg-muted hover:text-fg-primary"
                        title={t('ai.promptRestore')}
                      >
                        <Trash2 size={11} />
                        {t('ai.promptRestore')}
                      </button>
                    </>
                  )}
                  <button
                    onClick={onBack}
                    disabled={busyLocal || busy}
                    className="flex h-7 items-center rounded-btn border border-border-subtle px-3 text-caption text-fg-muted transition-colors hover:bg-bg-muted hover:text-fg-primary"
                  >
                    {t('ai.back')}
                  </button>
                </div>
              </>
            ) : (
              <div className="flex flex-1 items-center justify-center text-caption text-fg-muted">{t('ai.promptNoFile')}</div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}