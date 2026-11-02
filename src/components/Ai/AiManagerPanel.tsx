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

 * 拆分说明（保持行为不变，仅降低单文件体量与重渲染面）：
 * - 列表行 → AiListItem（memo，回调传行数据保持引用稳定）
 * - 创建表单 / 编辑表单 / 提示词编辑器 → AiCreateForm / AiEditForm / AiPromptEditor，
 *   各自表单态就近下放，主组件不再随表单输入整体重渲染
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Sparkles, X, Plus, ArrowLeft, Loader2, RefreshCw, Bot, AlertTriangle, Brain, Database, Fingerprint, MessageSquare, Users, Wrench, Archive, Trash2 } from 'lucide-react'
import { useAppStore } from '../../stores/appStore'
import { useT } from '../../i18n/useT'
import { DEFAULT_AI_ID } from '@shared/types'
import type { AiRecord } from '../../../electron/main/models/ai-registry'
import { Modal } from '../Modal'
import { AiCreateForm } from './AiCreateForm'
import { AiEditForm } from './AiEditForm'
import { AiListItem } from './AiListItem'
import { AiPromptEditor } from './AiPromptEditor'
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

  const systemAis = useMemo(() => ais.filter((a) => a.kind === 'system'), [ais])
  const customAis = useMemo(() => ais.filter((a) => a.kind !== 'system'), [ais])

  /** 统一执行器：busy/错误/通知集中处理，成功后刷新注册表 */
  const run = useCallback(
    async (fn: () => Promise<unknown>): Promise<boolean> => {
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
    },
    [loadAis]
  )

  const goList = useCallback(() => {
    setView('list')
    setSelected(null)
    setError(null)
    setNotice(null)
  }, [])

  // 列表行回调：接收行数据而非内联闭包——引用稳定，AiListItem 的 memo 才生效
  const openPrompt = useCallback((ai: AiRecord) => {
    setSelected(ai)
    setView('prompt')
  }, [])

  const openEdit = useCallback((ai: AiRecord) => {
    setSelected(ai)
    setView('edit')
  }, [])

  const requestRemove = useCallback((ai: AiRecord) => {
    setError(null)
    setNotice(null)
    setRemoveTarget(ai)
  }, [])

  const toggleAi = useCallback(
    async (ai: AiRecord) => {
      await run(async () => {
        const res = ai.deactivated
          ? await window.lunareclipse.aiReactivate(ai.id)
          : await window.lunareclipse.aiDeactivate(ai.id)
        if (!res?.ok) throw new Error(res?.error ?? t('ai.toggleFail'))
        setNotice(ai.deactivated ? t('ai.reactivated', { name: ai.name }) : t('ai.deactivated', { name: ai.name }))
      })
    },
    [run, t]
  )

  const selectCreate = useCallback(() => {
    setError(null)
    setNotice(null)
    setView('create')
  }, [])

  if (!open) return null

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
        <div className="flex items-center gap-2 border-b border-success/20 bg-success/10 px-3 py-2 text-caption text-success">
          <span className="flex-1">{notice}</span>
          <button onClick={() => setNotice(null)} className="text-success/70 hover:text-success" title={t('common.close')} aria-label={t('common.close')}>
            <X size={10} />
          </button>
        </div>
      )}
      {error && (
        <div className="flex items-center gap-2 border-b border-danger/20 bg-danger/10 px-3 py-2 text-caption text-danger">
          <span className="flex-1">{error}</span>
          <button onClick={() => setError(null)} className="text-danger/70 hover:text-danger" title={t('common.close')} aria-label={t('common.close')}>
            <X size={10} />
          </button>
        </div>
      )}

      {/* 内容区 */}
      <div className="flex-1 overflow-y-auto">
        {view === 'create' && (
          <AiCreateForm
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
          <AiEditForm
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
          <AiPromptEditor
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
              onClick={selectCreate}
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
                  <AiListItem key={ai.id} ai={ai} onPrompt={openPrompt} />
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
                    onEdit={openEdit}
                    onPrompt={openPrompt}
                    onToggle={toggleAi}
                    onRemove={requestRemove}
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
      <Modal
        open={!!removeTarget}
        onClose={() => setRemoveTarget(null)}
        closeDisabled={removing}
        label={removeTarget ? t('ai.confirmDelete', { name: removeTarget.name }) : undefined}
        backdropClassName="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 backdrop-blur-[2px]"
        cardClassName="w-[400px] max-w-[92vw] overflow-hidden rounded-card border border-danger/20 bg-bg-elevated shadow-2xl"
      >
            {/* 标题行 */}
            <div className="flex items-start gap-2 px-4 py-3">
              <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-danger/10 text-danger">
                <AlertTriangle size={14} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-caption font-medium text-fg-primary">{removeTarget ? t('ai.confirmDelete', { name: removeTarget.name }) : ''}</div>
                <div className="mt-0.5 text-micro text-fg-muted">
                  #{removeTarget?.id} · {removeTarget?.agent}
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
                <div key={key} className="flex items-center gap-1.5 rounded-btn bg-danger/[0.06] px-2 py-1.5 text-caption text-fg-secondary">
                  <Icon size={12} className="shrink-0 text-danger/80" />
                  <span className="truncate">{t(`ai.${key}`)}</span>
                </div>
              ))}
            </div>

            {/* 不可恢复警告 */}
            <div className="flex items-center gap-1.5 px-4 pb-4 text-micro font-medium text-danger">
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
                className="flex h-7 flex-1 items-center justify-center gap-1.5 rounded-btn bg-danger px-3 text-caption font-medium text-white transition-colors hover:bg-danger disabled:opacity-40"
              >
                {removing ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
                {removing ? t('ai.deleting') : t('ai.deleteConfirmBtn')}
              </button>
            </div>
      </Modal>
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
