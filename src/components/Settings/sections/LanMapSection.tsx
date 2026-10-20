/**
 * 为什么存在：交接单 §6⑤ 与 B2 要求「局域网节点管理 UI：启停 + 链接可视化 + 路径与被拒原因」。
 * 局域网默认关闭（0.52.9 安全整改），用户需要一个可见入口来决定是否暴露监听面，并看清
 * 「谁连着谁、数据按哪条路径走、在哪一跳被拒」。
 * 作用：局域网管理区——开关 + 拓扑地图（环形布局 SVG）+ 节点表 + 路径记录（含被拒原因）。
 * 不删理由：删掉即 LAN 只有配置项、没有管理面；AI 侧 `lan_control` 与用户侧开关共用同一配置。
 */
import { useState, useEffect, useCallback } from 'react'
import { Network, RefreshCw, Power } from 'lucide-react'
import { useT } from '../../../i18n/useT'

interface NodeView {
  uid: number
  role: 'master' | 'satellite'
  online: boolean
  lastSeen: number | null
  latencyMs: number | null
  forwardWilling: boolean
}

interface TraceView {
  pathId: string
  from: number
  to: number
  path: number[]
  perHopStatus: Array<{ uid: number; state: string }>
  failureReason?: string
  rejectedBy?: number
  createdAt: number
}

const MAP = 280
const R = 104

export function LanMapSection() {
  const t = useT()
  const [status, setStatus] = useState({ enabled: false, running: false, role: 'standalone', nodeCount: 0 })
  const [nodes, setNodes] = useState<NodeView[]>([])
  const [links, setLinks] = useState<Array<{ from: number; to: number }>>([])
  const [traces, setTraces] = useState<TraceView[]>([])
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    const api = window.lunareclipse
    if (!api?.lanGetStatus) return
    const s = await api.lanGetStatus()
    if (s?.ok) setStatus({ enabled: s.enabled, running: s.running, role: s.role, nodeCount: s.nodeCount })
    const topo = await api.lanGetTopology()
    if (topo?.ok) {
      setNodes(topo.nodes)
      setLinks(topo.links)
    }
    const tr = await api.lanGetTraces()
    if (tr?.ok) setTraces(tr.traces as TraceView[])
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const toggle = async () => {
    const api = window.lunareclipse
    if (!api?.lanSetEnabled) return
    setBusy(true)
    await api.lanSetEnabled(!status.enabled)
    // 起停由主进程配置订阅异步落地，稍后回读
    setTimeout(() => {
      void refresh()
      setBusy(false)
    }, 500)
  }

  const pos = (uid: number) => {
    const i = nodes.findIndex((n) => n.uid === uid)
    const n = Math.max(1, nodes.length)
    const a = (2 * Math.PI * i) / n - Math.PI / 2
    return { x: MAP / 2 + R * Math.cos(a), y: MAP / 2 + R * Math.sin(a) }
  }

  const badge = (n: NodeView) =>
    n.online ? (n.forwardWilling ? 'text-emerald-400' : 'text-amber-400') : 'text-fg-muted'

  return (
    <div className="space-y-5">
      {/* ===== 开关与状态 ===== */}
      <section>
        <div className="mb-3 flex items-center gap-2 text-caption uppercase tracking-wider text-fg-muted">
          <Network size={12} />
          {t('lan.title')}
        </div>
        <div className="flex items-center justify-between rounded-card border border-border-subtle bg-bg-elevated px-3 py-3">
          <div className="space-y-1">
            <div className="text-body text-fg-primary">
              {status.enabled ? t('lan.enabled') : t('lan.disabled')}
            </div>
            <div className="text-[11px] text-fg-muted">
              {t('lan.role')}: {status.role} · {t('lan.nodes')}: {status.nodeCount}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => void refresh()}
              className="rounded-btn border border-border-subtle px-3 py-2 text-caption text-fg-secondary transition-all duration-150 active:scale-95 hover:border-accent/50"
              title={t('lan.refresh')}
            >
              <RefreshCw size={12} />
            </button>
            <button
              onClick={() => void toggle()}
              disabled={busy}
              className={`flex items-center gap-2 rounded-btn px-3 py-2 text-caption transition-all duration-150 active:scale-95 disabled:opacity-40 ${
                status.enabled ? 'bg-bg-muted text-fg-secondary' : 'bg-accent text-accent-fg'
              }`}
            >
              <Power size={12} />
              {status.enabled ? t('lan.toggleOff') : t('lan.toggleOn')}
            </button>
          </div>
        </div>
        <p className="mt-2 text-[11px] text-fg-muted">{t('lan.hint')}</p>
      </section>

      {/* ===== 拓扑地图 ===== */}
      <section>
        <div className="mb-3 text-caption uppercase tracking-wider text-fg-muted">{t('lan.map')}</div>
        {nodes.length === 0 ? (
          <div className="rounded-card border border-border-subtle bg-bg-elevated px-3 py-6 text-center text-caption text-fg-muted">
            {t('lan.noNodes')}
          </div>
        ) : (
          <div className="rounded-card border border-border-subtle bg-bg-elevated p-2">
            <svg viewBox={`0 0 ${MAP} ${MAP}`} className="w-full" style={{ maxHeight: 300 }}>
              {links.map((l, i) => {
                const a = pos(l.from)
                const b = pos(l.to)
                return (
                  <line
                    key={`${l.from}-${l.to}-${i}`}
                    x1={a.x}
                    y1={a.y}
                    x2={b.x}
                    y2={b.y}
                    stroke="currentColor"
                    className="text-border"
                    strokeWidth={1}
                  />
                )
              })}
              {nodes.map((n) => {
                const p = pos(n.uid)
                return (
                  <g key={n.uid}>
                    <circle cx={p.x} cy={p.y} r={16} fill="currentColor" className={badge(n)} opacity={0.15} />
                    <circle cx={p.x} cy={p.y} r={16} fill="none" stroke="currentColor" className={badge(n)} strokeWidth={1.5} />
                    <text x={p.x} y={p.y + 4} textAnchor="middle" fontSize={11} fill="currentColor" className="text-fg-primary">
                      {n.uid}
                    </text>
                  </g>
                )
              })}
            </svg>
            <div className="mt-2 space-y-1">
              {nodes.map((n) => (
                <div key={n.uid} className="flex items-center justify-between text-[11px] text-fg-muted">
                  <span>
                    <span className={badge(n)}>●</span> uid {n.uid} · {n.role}
                    {n.latencyMs != null ? ` · ${n.latencyMs}ms` : ''}
                  </span>
                  <span>{n.forwardWilling ? t('lan.willing') : t('lan.notWilling')}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </section>

      {/* ===== 路径记录 ===== */}
      <section>
        <div className="mb-3 text-caption uppercase tracking-wider text-fg-muted">{t('lan.traces')}</div>
        {traces.length === 0 ? (
          <div className="rounded-card border border-border-subtle bg-bg-elevated px-3 py-4 text-center text-caption text-fg-muted">
            {t('lan.noTraces')}
          </div>
        ) : (
          <div className="space-y-2">
            {[...traces].reverse().slice(0, 20).map((tr) => (
              <div key={tr.pathId} className="rounded-card border border-border-subtle bg-bg-elevated px-3 py-2">
                <div className="flex items-center justify-between text-caption text-fg-secondary">
                  <span>
                    {tr.from} → {tr.to}
                  </span>
                  <span className="text-[11px] text-fg-muted">{tr.path.join(' → ')}</span>
                </div>
                <div className="mt-1 flex flex-wrap gap-2 text-[11px] text-fg-muted">
                  {tr.perHopStatus.map((h) => (
                    <span key={h.uid} className={h.state === 'rejected' || h.state === 'failed' ? 'text-red-400' : ''}>
                      {h.uid}:{h.state}
                    </span>
                  ))}
                </div>
                {tr.failureReason && (
                  <div className="mt-1 text-[11px] text-red-400">
                    {tr.rejectedBy != null ? `${t('lan.rejectedBy')} ${tr.rejectedBy}：` : ''}
                    {tr.failureReason}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
