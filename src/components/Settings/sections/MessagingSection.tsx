/**
 * 为什么存在：飞书等外部平台消息接入是独立子系统（独立 IPC 通道即时重启），
 * 不占全局"保存设置"，故独立成设置区展示独立配置流。
 * 作用：渲染消息接入配置区——启用/停用接入服务、凭据与白名单/联系人管理、
 * 运行状态（handledCount/lastError）轮询展示。
 */
import { useState, useEffect } from 'react'
import { Plus, Trash2, RefreshCw, Check } from 'lucide-react'
import type { AppConfig, MessagingConfig, MessagingContact } from '@shared/types'
import { StatusRow } from '../StatusRow'
import { useT } from '../../../i18n/useT'

interface MessagingStatusView {
  running: boolean
  handledCount: number
  lastError: string
}

/**
 * 消息接入配置：飞书等外部平台 → 月蚀大脑。
 * 独立 IPC 通道（messaging:get/save/restart），不占全局「保存设置」。
 */
export function MessagingSection({ config, onChange }: { config: AppConfig; onChange: (c: AppConfig) => void }) {
  const t = useT()
  const [enabled, setEnabled] = useState(config.messaging?.enabled ?? false)
  const [appId, setAppId] = useState(config.messaging?.feishu?.appId ?? '')
  const [appSecret, setAppSecret] = useState(config.messaging?.feishu?.appSecret ?? '')
  const [allowFrom, setAllowFrom] = useState((config.messaging?.allowFrom ?? []).join('\n'))
  const [contacts, setContacts] = useState<MessagingContact[]>(config.messaging?.contacts ?? [])
  const [status, setStatus] = useState<MessagingStatusView | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  // 新联系人表单
  const [newId, setNewId] = useState('')
  const [newName, setNewName] = useState('')
  const [newType, setNewType] = useState<'p2p' | 'group'>('p2p')
  const [newAgent, setNewAgent] = useState<'xi' | 'lilith'>('xi')

  /**
   * 同步回设置面板 local（关键：防止全局「保存设置」用打开时的旧快照覆盖 messaging）。
   * 莉莉丝 LilithConnectSection 的 syncLocal 同款——任何变更都必须同步，否则全局保存一按，磁盘新值被旧快照打回。
   */
  const syncLocal = (next?: Partial<MessagingConfig>) => {
    onChange({
      ...config,
      messaging: {
        enabled,
        feishu: { appId, appSecret },
        allowFrom: allowFrom.split('\n').map((s) => s.trim()).filter(Boolean),
        contacts,
        ...next
      }
    })
  }

  /** 配置字段只读一次（打开面板时）——避免 5 秒轮询覆盖用户正在输入的内容 */
  const loadConfig = async () => {
    const r = await window.lunareclipse?.messagingGet?.()
    if (!r) return
    setEnabled(r.config.enabled)
    setAppId(r.config.feishu?.appId ?? '')
    setAppSecret(r.config.feishu?.appSecret ?? '')
    setAllowFrom((r.config.allowFrom ?? []).join('\n'))
    setContacts(r.config.contacts ?? [])
    setStatus(r.status)
  }

  /** 状态灯轮询（只刷运行状态，不碰配置字段） */
  const refreshStatus = async () => {
    const r = await window.lunareclipse?.messagingGet?.()
    if (r) setStatus(r.status)
  }

  useEffect(() => {
    loadConfig()
    const t = setInterval(refreshStatus, 5000)
    return () => clearInterval(t)
  }, [])

  const handleSave = async () => {
    setSaving(true)
    setMsg(null)
    const r = await window.lunareclipse?.messagingSave?.({
      enabled,
      feishu: { appId, appSecret },
      allowFrom: allowFrom.split('\n').map((s) => s.trim()).filter(Boolean),
      contacts
    })
    setSaving(false)
    if (r?.ok) {
      setMsg('✅ ' + t('settings.msgSavedExtra', { extra: enabled && appId && appSecret ? t('settings.msgSaveExtraFeishu') : t('settings.msgSaveExtraHint') }))
      syncLocal()
      loadConfig()
    } else {
      setMsg('❌ ' + t('settings.msgSaveFail', { error: r?.error ?? t('settings.msgUnknownError') }))
    }
  }

  /** 联系人变更自动保存（添加/删除/改 agent 即时落盘 + 同步 local，防全局保存覆盖） */
  const persistContacts = async (next: MessagingContact[]) => {
    setContacts(next)
    syncLocal({ contacts: next })
    const r = await window.lunareclipse?.messagingSave?.({ contacts: next })
    if (!r?.ok) {
      setMsg('❌ ' + t('settings.msgContactSaveFail', { error: r?.error ?? t('settings.msgUnknownError') }))
    }
  }

  const addContact = () => {
    const id = newId.trim()
    const name = newName.trim()
    if (!id || !name) return
    void persistContacts([...contacts, { id, name, type: newType, agent: newAgent }])
    setNewId('')
    setNewName('')
  }

  const removeContact = (idx: number) => {
    void persistContacts(contacts.filter((_, i) => i !== idx))
  }

  const canRun = enabled && appId && appSecret

  return (
    <div className="space-y-5">
      {/* 状态区 */}
      <section>
        <div className="mb-3 text-caption uppercase tracking-wider text-fg-muted">{t('settings.msgConnStatus')}</div>
        <div className="space-y-1.5 rounded-btn border border-border-subtle bg-bg-base/40 px-3 py-2.5 text-caption">
          <StatusRow
            label={t('settings.msgFeishu')}
            ok={!!status?.running}
            okText={t('settings.msgConnected', { n: status?.handledCount ?? 0 })}
            badText={canRun ? t('settings.msgNotConnected') : t('settings.msgNotStarted')}
          />
          {status?.lastError && <div className="pt-1 text-[11px] text-red-400">{t('settings.msgLastError', { error: status.lastError })}</div>}
          <div className="pt-1 text-[11px] text-fg-muted leading-relaxed">
            {t('settings.msgRouteDesc')}
          </div>
        </div>
      </section>

      {/* 开关 */}
      <section>
        <label className="flex cursor-pointer items-center justify-between rounded-btn border border-border-subtle bg-bg-base/40 px-3 py-2.5">
          <div>
            <div className="text-caption text-fg-primary">{t('settings.msgEnableLabel')}</div>
            <div className="text-[11px] text-fg-muted">{t('settings.msgDisableDesc')}</div>
          </div>
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => {
              setEnabled(e.target.checked)
              syncLocal({ enabled: e.target.checked })
            }}
            className="h-4 w-4 accent-[var(--accent)]"
          />
        </label>
      </section>

      {/* 飞书凭证 */}
      <section>
        <div className="mb-3 text-caption uppercase tracking-wider text-fg-muted">{t('settings.msgCredentials')}</div>
        <div className="space-y-2.5">
          <input
            type="text"
            value={appId}
            onChange={(e) => {
              setAppId(e.target.value)
              syncLocal({ feishu: { appId: e.target.value, appSecret } })
            }}
            placeholder={t('settings.msgAppIdPh')}
            className="w-full rounded-btn border border-border bg-bg-elevated px-3 py-2 text-caption text-fg-primary placeholder:text-fg-muted focus:border-accent/50 focus:outline-none"
          />
          <input
            type="password"
            value={appSecret}
            onChange={(e) => {
              setAppSecret(e.target.value)
              syncLocal({ feishu: { appId, appSecret: e.target.value } })
            }}
            placeholder="App Secret"
            className="w-full rounded-btn border border-border bg-bg-elevated px-3 py-2 text-caption text-fg-primary placeholder:text-fg-muted focus:border-accent/50 focus:outline-none"
          />
          <div className="rounded-btn bg-bg-muted/50 px-3 py-2 text-[11px] text-fg-muted leading-relaxed">
            {t('settings.msgApplyHint')} {t('settings.msgLongConnHint')}
          </div>
        </div>
      </section>

      {/* 白名单 */}
      <section>
        <div className="mb-3 text-caption uppercase tracking-wider text-fg-muted">{t('settings.msgWhitelist')}</div>
        <div className="space-y-2">
          <textarea
            value={allowFrom}
            onChange={(e) => {
              setAllowFrom(e.target.value)
              syncLocal({ allowFrom: e.target.value.split('\n').map((s) => s.trim()).filter(Boolean) })
            }}
            placeholder={t('settings.msgWhitelistPh')}
            rows={3}
            className="w-full resize-none rounded-btn border border-border bg-bg-elevated px-3 py-2 text-caption text-fg-primary placeholder:text-fg-muted focus:border-accent/50 focus:outline-none"
          />
          <div className="rounded-btn bg-bg-muted/50 px-3 py-2 text-[11px] text-fg-muted leading-relaxed">
            {t('settings.msgWhitelistDesc')}
          </div>
        </div>
      </section>

      {/* 联系人映射 */}
      <section>
        <div className="mb-3 text-caption uppercase tracking-wider text-fg-muted">{t('settings.msgContactMap')}</div>
        <div className="space-y-2">
          <div className="rounded-btn bg-bg-muted/50 px-3 py-2 text-[11px] text-fg-muted leading-relaxed">
            {t('settings.msgMapDesc')}
          </div>
          {contacts.length > 0 && (
            <div className="space-y-1.5">
              {contacts.map((c, i) => (
                <div key={i} className="flex items-center gap-2 rounded-btn border border-border-subtle bg-bg-base/40 px-3 py-2">
                  <span className="min-w-0 flex-1 truncate text-caption text-fg-primary" title={c.id}>
                    {c.name}
                    <span className="ml-1.5 text-[10px] text-fg-muted">{c.type === 'group' ? t('settings.msgGroup') : t('settings.msgPrivate')} · {c.id}</span>
                  </span>
                  <select
                    value={c.agent}
                    onChange={(e) =>
                      void persistContacts(
                        contacts.map((x, j) => (j === i ? { ...x, agent: e.target.value as 'xi' | 'lilith' } : x))
                      )
                    }
                    className="rounded-btn border border-border bg-bg-elevated px-2 py-1 text-[11px] text-fg-primary focus:outline-none"
                  >
                    <option value="xi">{t('settings.msgAgentXi')}</option>
                    <option value="lilith">{t('settings.msgAgentLilith')}</option>
                  </select>
                  <button
                    onClick={() => removeContact(i)}
                    className="text-fg-muted transition-colors hover:text-red-400"
                    title={t('settings.msgDelete')}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
            </div>
          )}
          {/* 添加表单 */}
          <div className="flex flex-wrap items-center gap-2 rounded-btn border border-dashed border-border-subtle px-3 py-2">
            <input
              type="text"
              value={newId}
              onChange={(e) => setNewId(e.target.value)}
              placeholder="open_id / chat_id"
              className="min-w-0 flex-1 rounded-btn border border-border bg-bg-elevated px-2 py-1.5 text-[11px] text-fg-primary placeholder:text-fg-muted focus:border-accent/50 focus:outline-none"
            />
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder={t('settings.msgNamePh')}
              className="w-24 rounded-btn border border-border bg-bg-elevated px-2 py-1.5 text-[11px] text-fg-primary placeholder:text-fg-muted focus:border-accent/50 focus:outline-none"
            />
            <select
              value={newType}
              onChange={(e) => setNewType(e.target.value as 'p2p' | 'group')}
              className="rounded-btn border border-border bg-bg-elevated px-2 py-1.5 text-[11px] text-fg-primary focus:outline-none"
            >
              <option value="p2p">{t('settings.msgPrivate')}</option>
              <option value="group">{t('settings.msgGroup')}</option>
            </select>
            <select
              value={newAgent}
              onChange={(e) => setNewAgent(e.target.value as 'xi' | 'lilith')}
              className="rounded-btn border border-border bg-bg-elevated px-2 py-1.5 text-[11px] text-fg-primary focus:outline-none"
            >
              <option value="xi">{t('settings.msgAgentXi')}</option>
              <option value="lilith">{t('settings.msgAgentLilith')}</option>
            </select>
            <button
              onClick={addContact}
              disabled={!newId.trim() || !newName.trim()}
              className="flex h-7 items-center gap-1 rounded-btn bg-accent px-2.5 text-[11px] text-accent-fg transition-all duration-150 hover:bg-accent/80 active:scale-95 disabled:opacity-40"
            >
              <Plus size={12} />
              {t('settings.msgAddBtn')}
            </button>
          </div>
        </div>
      </section>

      {/* 保存 */}
      <section>
        <div className="flex items-center gap-2">
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex h-8 items-center gap-1.5 rounded-btn bg-accent px-4 text-caption text-accent-fg transition-all duration-150 hover:bg-accent/80 active:scale-95 disabled:opacity-40"
          >
            <Check size={12} />
            {saving ? t('settings.msgSaving') : t('settings.msgSaveBtn')}
          </button>
          <button
            onClick={async () => {
              const r = await window.lunareclipse?.messagingRestart?.()
              if (r?.ok) {
                setMsg('✅ ' + t('settings.msgReconnectOk'))
                refreshStatus()
              } else {
                setMsg('❌ ' + (r?.error ?? t('settings.msgReconnectFail')))
              }
            }}
            className="flex h-8 items-center gap-1.5 rounded-btn bg-bg-muted px-3 text-caption text-fg-secondary transition-all duration-150 hover:bg-accent/15 hover:text-accent active:scale-95"
          >
            <RefreshCw size={12} />
            {t('settings.msgReconnect')}
          </button>
        </div>
        {msg && <div className="pt-2 text-[11px] text-fg-secondary leading-relaxed">{msg}</div>}
      </section>
    </div>
  )
}

