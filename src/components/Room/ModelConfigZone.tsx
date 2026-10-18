/**
 * 为什么存在：交接单 §8.5 要求 ROOM 的「模型配置管理区」（像素风：当前策略 + 切换历史 + 成本视图），
 * 且 §8.2⑤ 的成本上限被用户裁决改为「可查余额」。本组件是这块区域的实现。
 * 作用：AUTO 开关 / 最小驻留 / 钉死模型 / 模型池（id + 定位 + 启用）/ 切换审计 / 余额探测。
 * 不删理由：删掉即模型池只能手改 config.json，切换历史无从查看。
 *
 * 权限口径：本区是**用户**路径（AI 不得改模型池/上限/钉死模型，§0 T1-11；AI 只能在池内选择）。
 */
import { useState, useEffect, useCallback } from 'react'
import { Cpu, RefreshCw, Wallet, Plus, Trash2 } from 'lucide-react'
import { useT } from '../../i18n/useT'

type Tier = 'fast' | 'strong' | 'reasoning'

interface PoolEntry {
  id: string
  tier: Tier
  enabled: boolean
}

interface SwitchEntry {
  ts: number
  round: number
  from: string
  to: string
  tier: string
  reason: string
}

const TIERS: Tier[] = ['fast', 'strong', 'reasoning']

export function ModelConfigZone() {
  const t = useT()
  const [enabled, setEnabled] = useState(false)
  const [minDwell, setMinDwell] = useState(2)
  const [pin, setPin] = useState('')
  const [pool, setPool] = useState<PoolEntry[]>([])
  const [available, setAvailable] = useState<string[]>([])
  const [draft, setDraft] = useState('')
  const [log, setLog] = useState<SwitchEntry[]>([])
  const [balance, setBalance] = useState<string>('')

  const load = useCallback(async () => {
    const api = window.lunareclipse
    if (!api?.modelRouterGetConfig) return
    const cfg = await api.modelRouterGetConfig()
    if (cfg?.ok) {
      const c = cfg.config as { enabled?: boolean; pinModel?: string; minDwellRounds?: number; pool?: PoolEntry[] }
      setEnabled(c.enabled === true)
      setPin(c.pinModel ?? '')
      setMinDwell(c.minDwellRounds ?? 2)
      setPool(Array.isArray(c.pool) ? c.pool : [])
    }
    const lg = await api.modelRouterGetSwitchLog()
    if (lg?.ok) setLog(lg.entries as SwitchEntry[])
    const raw = await api.getConfig?.()
    const models = (raw as { availableModels?: string[] } | null)?.availableModels
    if (Array.isArray(models)) setAvailable(models)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const save = useCallback(
    async (next: { enabled: boolean; pool: PoolEntry[]; pinModel?: string; minDwellRounds?: number }) => {
      await window.lunareclipse?.modelRouterSetConfig?.(next)
    },
    []
  )

  const patch = (p: Partial<{ enabled: boolean; minDwellRounds: number; pinModel: string; pool: PoolEntry[] }>) => {
    const next = {
      enabled: p.enabled ?? enabled,
      minDwellRounds: p.minDwellRounds ?? minDwell,
      pinModel: p.pinModel ?? pin,
      pool: p.pool ?? pool
    }
    setEnabled(next.enabled)
    setMinDwell(next.minDwellRounds)
    setPin(next.pinModel)
    setPool(next.pool)
    void save(next)
  }

  const addModel = (id: string) => {
    const v = id.trim()
    if (!v || pool.some((e) => e.id === v)) return
    patch({ pool: [...pool, { id: v, tier: 'fast', enabled: true }] })
  }

  const probe = async () => {
    const r = await window.lunareclipse?.modelRouterProbeBalance?.()
    if (!r) return
    if (r.known && r.balances?.length) {
      setBalance(r.balances.map((b) => `${b.total} ${b.currency}`).join(' · '))
    } else {
      setBalance(r.error ?? t('model.balanceUnknown'))
    }
  }

  return (
    <div className="h-full space-y-4 overflow-y-auto">
      {/* ===== 当前策略 ===== */}
      <section className="rounded-card border-2 border-border-subtle bg-bg-surface p-3">
        <div className="mb-2 flex items-center gap-2 font-mono text-caption tracking-wider text-fg-muted">
          <Cpu size={12} />
          {t('model.policy')}
        </div>
        <label className="flex items-center justify-between text-body text-fg-primary">
          <span>{t('model.auto')}</span>
          <input type="checkbox" checked={enabled} onChange={(e) => patch({ enabled: e.target.checked })} />
        </label>
        <label className="mt-2 flex items-center justify-between text-body text-fg-primary">
          <span>{t('model.minDwell')}</span>
          <input
            type="number"
            min={0}
            value={minDwell}
            onChange={(e) => patch({ minDwellRounds: Number(e.target.value) || 0 })}
            className="w-16 rounded-btn border-2 border-border-subtle bg-bg-base px-2 py-1 text-caption"
          />
        </label>
        <label className="mt-2 flex items-center justify-between text-body text-fg-primary">
          <span>{t('model.pin')}</span>
          <input
            value={pin}
            placeholder={t('model.pinPlaceholder')}
            onChange={(e) => patch({ pinModel: e.target.value })}
            className="w-48 rounded-btn border-2 border-border-subtle bg-bg-base px-2 py-1 font-mono text-[11px]"
          />
        </label>
      </section>

      {/* ===== 模型池 ===== */}
      <section className="rounded-card border-2 border-border-subtle bg-bg-surface p-3">
        <div className="mb-2 font-mono text-caption tracking-wider text-fg-muted">{t('model.pool')}</div>
        {pool.length === 0 && <div className="mb-2 text-[11px] text-fg-muted">{t('model.poolEmpty')}</div>}
        <div className="space-y-1">
          {pool.map((e, i) => (
            <div key={e.id} className="flex items-center gap-2 text-[11px]">
              <input
                type="checkbox"
                checked={e.enabled}
                onChange={(ev) => {
                  const next = [...pool]
                  next[i] = { ...e, enabled: ev.target.checked }
                  patch({ pool: next })
                }}
              />
              <span className="flex-1 truncate font-mono text-fg-secondary">{e.id}</span>
              <select
                value={e.tier}
                onChange={(ev) => {
                  const next = [...pool]
                  next[i] = { ...e, tier: ev.target.value as Tier }
                  patch({ pool: next })
                }}
                className="rounded-btn border-2 border-border-subtle bg-bg-base px-1 py-0.5 text-[11px]"
              >
                {TIERS.map((tr) => (
                  <option key={tr} value={tr}>
                    {t(`model.tier.${tr}`)}
                  </option>
                ))}
              </select>
              <button
                onClick={() => patch({ pool: pool.filter((x) => x.id !== e.id) })}
                className="text-fg-muted hover:text-red-400"
                title={t('model.remove')}
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))}
        </div>
        <div className="mt-2 flex items-center gap-2">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={t('model.addPlaceholder')}
            list="room-model-available"
            className="flex-1 rounded-btn border-2 border-border-subtle bg-bg-base px-2 py-1 font-mono text-[11px]"
          />
          <datalist id="room-model-available">
            {available.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
          <button
            onClick={() => {
              addModel(draft)
              setDraft('')
            }}
            className="rounded-btn border-2 border-border-subtle px-2 py-1 text-fg-muted active:scale-95"
            title={t('model.add')}
          >
            <Plus size={12} />
          </button>
        </div>
      </section>

      {/* ===== 成本视图（用户裁决：不加成本上限，改为可查余额）===== */}
      <section className="rounded-card border-2 border-border-subtle bg-bg-surface p-3">
        <div className="mb-2 flex items-center justify-between">
          <span className="font-mono text-caption tracking-wider text-fg-muted">{t('model.balance')}</span>
          <button onClick={() => void probe()} className="text-fg-muted hover:text-accent" title={t('model.probe')}>
            <Wallet size={12} />
          </button>
        </div>
        <div className="text-[11px] text-fg-secondary">{balance || t('model.balanceHint')}</div>
      </section>

      {/* ===== 切换审计 ===== */}
      <section className="rounded-card border-2 border-border-subtle bg-bg-surface p-3">
        <div className="mb-2 flex items-center justify-between">
          <span className="font-mono text-caption tracking-wider text-fg-muted">{t('model.switchLog')}</span>
          <button onClick={() => void load()} className="text-fg-muted hover:text-accent" title={t('lan.refresh')}>
            <RefreshCw size={12} />
          </button>
        </div>
        {log.length === 0 ? (
          <div className="text-[11px] text-fg-muted">{t('model.switchLogEmpty')}</div>
        ) : (
          <div className="space-y-1">
            {[...log].reverse().slice(0, 20).map((e, i) => (
              <div key={`${e.ts}-${i}`} className="text-[11px] text-fg-muted">
                <span className="font-mono text-fg-secondary">
                  #{e.round} {e.from} → {e.to}
                </span>{' '}
                <span className="text-accent">[{e.tier}]</span> {e.reason}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
