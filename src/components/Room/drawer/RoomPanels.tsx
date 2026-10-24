/**
 * 抽屉的三个**只读**面板：传感器 / 工具与设备 / 关于我。
 *
 * 为什么全做成只读：用户裁决「**零新 IPC**」——抽屉不许为了好看去挖新通道。三个面板分别复用
 * 既有能力：
 * - **传感器**：房间快照里的 `collectorView`（AI 决定看什么）+ `getConfig()` 里的用户层开关。
 * - **工具与设备**：`room:tool-zone-list`（AI 自造工具）+ `room:device-scan`（**按钮触发**，
 *   不自动扫——扫描是有代价的动作，不该在打开抽屉时就发生）。
 * - **关于我**：`room:avatar-get`（AI 自己的像素规格）+ 房间自持会话 id。
 *
 * 授权页不在这里：`GrantsPanel` 曾是本文件的**只读能力目录**（因为当时 `security:*` 渲染面
 * 整条不存在，读真实授予就得新挖通道）。用户 2026-10-19 补上了授予入口与告知义务，
 * 授权页因此换成**与设置页共用的 `Security/SecurityPanel`**（能授予、能撤回、带条款）——
 * 授予界面只允许有一份实现，本文件不再自带第二份。
 *
 * 不删理由：删掉即「AI 在房间里能看到什么、能碰什么、自己长什么样」没有一处集中可读的地方。
 */
import { useEffect, useState } from 'react'
import { useT } from '../../../i18n/useT'
import { reloadMascot, useMascot } from '../use-mascot'
import type { RoomRuntimeSnapshot } from '../room-status'
import { SENSOR_SIGNALS, SENSOR_SIGNAL_LABEL } from '@shared/room/sensor-policy'

/** 时间戳 → `HH:MM`（只依赖入参，不读当前时刻） */
function clock(ts: number): string {
  const d = new Date(ts)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 传感器：AI 决定看什么（采集视图）+ 感知器状态 + 用户层开关（采集器总开关与各段）。 */
export function SensorsPanel({
  state,
  aiId,
  onOpenGrants
}: {
  state: RoomRuntimeSnapshot
  aiId: number
  /** 「去授权」入口：授权页与设置页共用同一个 SecurityPanel，这里只负责把用户带过去 */
  onOpenGrants?: () => void
}) {
  const t = useT()
  const [switches, setSwitches] = useState<Record<string, boolean> | null>(null)
  const [granted, setGranted] = useState<boolean | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [resetting, setResetting] = useState(false)
  const [resetError, setResetError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        // `await` 对桥接方法缺失是安全的（直接 .then 会同步抛错）
        const raw = await window.lunareclipse?.getConfig?.()
        if (!alive) return
        const c = (raw as { collector?: Record<string, unknown> } | null)?.collector
        setSwitches(
          c
            ? {
                enabled: c.enabled === true,
                desktop: c.desktop === true,
                processes: c.processes === true,
                network: c.network === true
              }
            : null
        )
      } catch (err: unknown) {
        if (alive) setError(err instanceof Error ? err.message : String(err))
      }
    })()
    void (async () => {
      const r = await window.lunareclipse?.securityListCapabilities?.()
      if (!alive || !r?.ok) return
      setGranted((r.grants as Record<string, unknown> | undefined)?.['t1.collector'] != null)
    })()
    return () => {
      alive = false
    }
  }, [])

  const rows: Array<[string, boolean]> = switches
    ? [
        [t('collector.enable'), switches.enabled],
        [t('collector.desktop'), switches.desktop],
        [t('collector.processes'), switches.processes],
        [t('collector.network'), switches.network]
      ]
    : []

  /** 用户侧回收路径：把 AI 的感知策略复位为默认（不经过 AI） */
  const resetPolicy = async (): Promise<void> => {
    setResetting(true)
    setResetError(null)
    try {
      const r = await window.lunareclipse?.roomSensorPolicyReset?.(aiId)
      if (!r?.ok) setResetError(r?.error ?? t('room.sensor.resetFailed'))
    } catch (err) {
      setResetError(err instanceof Error ? err.message : String(err))
    } finally {
      setResetting(false)
    }
  }

  return (
    <div className="min-h-0 flex-1 space-y-3 overflow-y-auto">
      {/* 感知器（0.53.1）：空闲时它替 AI 睁着眼——让「等采集」不再等于「静默」 */}
      <section className="rounded-card border-2 border-border-subtle bg-bg-surface p-3">
        <div className="mb-2 flex items-center justify-between gap-2">
          <span className="font-mono text-[11px] tracking-wider text-fg-muted">{t('room.sensor.title')}</span>
          <span className={`text-[11px] ${state.sensing ? 'text-success' : 'text-fg-muted'}`}>
            {state.sensing ? t('room.sensor.on') : t('room.sensor.off')}
          </span>
        </div>
        <p className="text-[11px] leading-5 text-fg-muted">{t('room.sensor.hint')}</p>
        {/* AI 自己配置的感知策略（0.53.3）：屏蔽了什么 / 多久看一次 / 多大变化才算有事 */}
        {state.sensorPolicy && (
          <div className="mt-2 space-y-1 rounded-card border border-border-subtle/60 p-2 text-[11px]">
            <div className="flex items-center justify-between gap-2">
              <span className="text-fg-muted">{t('room.sensor.policy')}</span>
              <span className={state.sensorPolicy.enabled ? 'text-success' : 'text-fg-muted'}>
                {state.sensorPolicy.enabled ? t('room.sensor.policyOn') : t('room.sensor.policyOff')}
              </span>
            </div>
            <div className="text-fg-secondary">
              <span className="text-fg-muted">{t('room.sensor.muted')}：</span>
              {SENSOR_SIGNALS.filter((s) => state.sensorPolicy!.mute.includes(s)).length === 0 ? (
                <span className="text-fg-muted">{t('room.sensor.mutedNone')}</span>
              ) : (
                <span>
                  {SENSOR_SIGNALS.filter((s) => state.sensorPolicy!.mute.includes(s))
                    .map((s) => SENSOR_SIGNAL_LABEL[s])
                    .join('、')}
                </span>
              )}
            </div>
            <div className="text-fg-secondary">
              <span className="text-fg-muted">{t('room.sensor.interval')}：</span>
              {state.sensorPolicy.intervalMs != null
                ? `${Math.round(state.sensorPolicy.intervalMs / 1000)}s`
                : t('room.sensor.intervalDefault')}
            </div>
            <div className="text-fg-secondary">
              <span className="text-fg-muted">{t('room.sensor.threshold')}：</span>
              {state.sensorPolicy.thresholds?.cpuDeltaPct != null || state.sensorPolicy.thresholds?.freeMemDeltaGB != null ? (
                <span>
                  {state.sensorPolicy.thresholds?.cpuDeltaPct != null
                    ? `CPU ${state.sensorPolicy.thresholds.cpuDeltaPct}pp`
                    : ''}
                  {state.sensorPolicy.thresholds?.cpuDeltaPct != null && state.sensorPolicy.thresholds?.freeMemDeltaGB != null
                    ? ' · '
                    : ''}
                  {state.sensorPolicy.thresholds?.freeMemDeltaGB != null
                    ? `${t('room.sensor.memory')} ${state.sensorPolicy.thresholds.freeMemDeltaGB}GB`
                    : ''}
                </span>
              ) : (
                <span className="text-fg-muted">{t('room.sensor.thresholdDefault')}</span>
              )}
            </div>
            {/* 用户始终可回收：AI 关了感知也能在这里恢复默认，不必手删 JSON */}
            <button
              type="button"
              onClick={() => void resetPolicy()}
              disabled={resetting}
              className="room-press mt-1.5 px-2 py-0.5 text-micro text-fg-secondary disabled:opacity-40"
              title={t('room.sensor.resetHint')}
            >
              {resetting ? t('room.sensor.resetting') : t('room.sensor.reset')}
            </button>
            {resetError && <div className="text-micro text-danger">{resetError}</div>}
          </div>
        )}
        {!state.sensing && switches && (switches.enabled !== true || granted === false) && (
          <div className="mt-1.5 flex items-start justify-between gap-2">
            <p className="text-[11px] leading-5 text-warning">{t('room.sensor.blocked')}</p>
            {onOpenGrants && (
              <button
                type="button"
                onClick={onOpenGrants}
                className="room-press shrink-0 px-2 py-0.5 text-micro text-accent"
              >
                {t('room.drawer.tab.grants')} →
              </button>
            )}
          </div>
        )}
        <div className="mt-2 space-y-1 text-[11px]">
          <div className="text-fg-secondary">
            <span className="text-fg-muted">{t('room.sensor.lastWake')}：</span>
            {state.lastWake ? (
              <span>
                {t(`room.wake.${state.lastWake.source}`)} · {clock(state.lastWake.at)}
                {state.lastWake.detail ? ` · ${state.lastWake.detail}` : ''}
              </span>
            ) : (
              <span className="text-fg-muted">{t('room.sensor.never')}</span>
            )}
          </div>
          <div className="text-fg-secondary">
            <span className="text-fg-muted">{t('room.sensor.lastCollect')}：</span>
            {state.lastCollect ? (
              <span>
                {clock(state.lastCollect.at)} · {state.lastCollect.text}
              </span>
            ) : (
              <span className="text-fg-muted">{t('room.sensor.noCollect')}</span>
            )}
          </div>
        </div>
      </section>
      <section className="rounded-card border-2 border-border-subtle bg-bg-surface p-3">
        <div className="mb-2 font-mono text-[11px] tracking-wider text-fg-muted">{t('room.collector.view')}</div>
        {state.collectorView ? (
          <div className="text-[11px] text-fg-secondary">
            <span className="font-mono text-accent">{state.collectorView.name}</span>
            {` · ${state.collectorView.scopes.join('/')} · ${state.collectorView.fields.join('、')}`}
          </div>
        ) : (
          <div className="text-[11px] text-fg-muted">{t('room.collector.viewDefault')}</div>
        )}
      </section>
      <section className="rounded-card border-2 border-border-subtle bg-bg-surface p-3">
        <div className="mb-2 font-mono text-[11px] tracking-wider text-fg-muted">{t('room.drawer.sensors.userSwitches')}</div>
        {error ? (
          <div className="text-[11px] text-danger">{error}</div>
        ) : !switches ? (
          <div className="text-[11px] text-fg-muted">{t('room.drawer.loading')}</div>
        ) : (
          <ul className="space-y-1">
            {rows.map(([label, on]) => (
              <li key={label} className="flex items-center justify-between text-[11px]">
                <span className="text-fg-secondary">{label}</span>
                {/* 开关状态不只靠颜色：文字也写出来（无障碍） */}
                <span className={on ? 'text-success' : 'text-fg-muted'}>
                  {on ? t('room.drawer.sensors.on') : t('room.drawer.sensors.off')}
                </span>
              </li>
            ))}
          </ul>
        )}
        {/* 第二层（AI 侧授予）在「授权」页；这里只读，不另做一份授予界面 */}
        <p className="mt-2 text-[11px] leading-5 text-fg-muted">{t('collector.grant.twoLayer')}</p>
      </section>
    </div>
  )
}

/** 工具与设备：AI 自造工具（只读清单）+ 设备发现（**按钮触发**）。 */
export function ToolsDevicesPanel() {
  const t = useT()
  const [tools, setTools] = useState<Array<{ name: string; description?: string; enabled?: boolean }>>([])
  const [devices, setDevices] = useState<Array<{ id: string; name?: string; category?: string; address?: string }>>([])
  const [scanError, setScanError] = useState<string | null>(null)
  const [scanning, setScanning] = useState(false)

  useEffect(() => {
    let alive = true
    void (async () => {
      const r = await window.lunareclipse?.roomToolZoneList?.()
      if (alive && r?.ok) setTools((r.entries ?? []) as Array<{ name: string; description?: string; enabled?: boolean }>)
    })()
    return () => {
      alive = false
    }
  }, [])

  const scan = async (): Promise<void> => {
    setScanning(true)
    setScanError(null)
    try {
      const r = await window.lunareclipse?.roomDeviceScan?.()
      if (!r?.ok) setScanError(r?.error ?? t('room.device.scanFailed'))
      else setDevices((r.devices ?? []) as Array<{ id: string; name?: string; category?: string; address?: string }>)
    } finally {
      setScanning(false)
    }
  }

  return (
    <div className="min-h-0 flex-1 space-y-3 overflow-y-auto">
      <section className="rounded-card border-2 border-border-subtle bg-bg-surface p-3">
        <div className="mb-2 font-mono text-[11px] tracking-wider text-fg-muted">{t('room.drawer.tools.title')}</div>
        {tools.length === 0 ? (
          <div className="text-[11px] text-fg-muted">{t('room.drawer.tools.empty')}</div>
        ) : (
          <ul className="space-y-1">
            {tools.map((x) => (
              <li key={x.name} className="text-[11px]">
                <span className="font-mono text-accent">{x.name}</span>
                {x.enabled === false && <span className="ml-1.5 text-fg-muted">（{t('room.drawer.tools.disabled')}）</span>}
                {x.description && <div className="text-micro text-fg-muted">{x.description}</div>}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="rounded-card border-2 border-border-subtle bg-bg-surface p-3">
        <div className="mb-2 flex items-center justify-between">
          <span className="font-mono text-[11px] tracking-wider text-fg-muted">{t('room.drawer.tools.devices')}</span>
          <button
            type="button"
            onClick={() => void scan()}
            disabled={scanning}
            className="room-press px-2 py-0.5 text-micro text-fg-muted disabled:opacity-40"
          >
            {t('room.device.scan')}
          </button>
        </div>
        {scanError ? (
          <div className="text-[11px] text-danger">{scanError}</div>
        ) : devices.length === 0 ? (
          <div className="text-[11px] text-fg-muted">{t('room.device.empty')}</div>
        ) : (
          <ul className="space-y-1">
            {devices.map((d) => (
              <li key={d.id} className="text-[11px] text-fg-secondary">
                <span className="text-fg-primary">{d.name ?? d.id}</span>
                {d.category && <span className="ml-1.5 text-fg-muted">{d.category}</span>}
                {d.address && <span className="ml-1.5 font-mono text-micro text-fg-muted">{d.address}</span>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

/**
 * 关于我：AI 自己的像素规格（尺寸 / 色数 / 帧名）+ 房间身份 + **图片立绘的放图说明**。
 *
 * 为什么把「放图目录」与「需要的文件名」摆在这里（ADR-34）：换成 AI 生成立绘之后，
 * 用户最需要知道的两件事就是「图放哪」与「叫什么名字」——**这两件事不该靠猜、也不该去翻文档**。
 * 文件名清单直接取自**当前加载的规格**（AI 重画过就是它重画后的帧名），不是写死的第二份清单。
 */
export function AboutPanel({
  aiId,
  aiName,
  hostSessionId
}: {
  aiId: number
  aiName: string
  /** 承载会话（0.53.18）：自主模式正在继承的那个会话 */
  hostSessionId?: string
}) {
  const t = useT()
  const mascot = useMascot(aiId)
  const [spec, setSpec] = useState<{
    room: { w: number; h: number; palette: string[] }
    avatar: { w: number; h: number; palette: string[]; frames: Record<string, unknown> }
    avatarPos: { x: number; y: number }
  } | null>(null)
  const [failed, setFailed] = useState(false)
  const [processing, setProcessing] = useState(false)
  const [proc, setProc] = useState<{
    processed: Array<{ file: string; frame: string; w: number; h: number; alreadyTransparent: boolean; removed: number }>
  } | null>(null)
  const [procError, setProcError] = useState<string | null>(null)

  /** 后处理：raw/ → 去背/裁切/统一画布 → mascot/，然后重新读取让画面立刻更新 */
  const processRaw = async (): Promise<void> => {
    setProcessing(true)
    setProcError(null)
    try {
      const r = await window.lunareclipse?.roomMascotProcess?.(aiId)
      if (!r?.ok) setProcError(r?.error ?? t('room.drawer.about.mascotProcessFailed'))
      else {
        setProc({ processed: r.processed })
        await reloadMascot(aiId)
      }
    } catch (err) {
      setProcError(err instanceof Error ? err.message : String(err))
    } finally {
      setProcessing(false)
    }
  }


  useEffect(() => {
    let alive = true
    void (async () => {
      const r = await window.lunareclipse?.roomAvatarGet?.(aiId)
      if (!alive) return
      if (r?.ok && r.spec) setSpec(r.spec as typeof spec)
      else setFailed(true)
    })()
    return () => {
      alive = false
    }
  }, [aiId])

  const frameNames = spec ? Object.keys(spec.avatar.frames) : []
  const covered = frameNames.filter((n) => mascot.frames[n] !== undefined)

  const rows: Array<[string, string]> = [
    [t('room.drawer.about.ai'), aiName],
    ...(hostSessionId ? ([[t('room.drawer.about.session'), hostSessionId]] as Array<[string, string]>) : []),
    ...(spec
      ? ([
          [t('room.drawer.about.roomSize'), `${spec.room.w}×${spec.room.h}`],
          [t('room.drawer.about.avatarSize'), `${spec.avatar.w}×${spec.avatar.h}`],
          [t('room.drawer.about.colors'), `${spec.avatar.palette.length}`],
          [t('room.drawer.about.avatarPos'), `${spec.avatarPos.x}, ${spec.avatarPos.y}`],
          [t('room.drawer.about.mascotCount'), `${covered.length} / ${frameNames.length}`]
        ] as Array<[string, string]>)
      : [])
  ]

  return (
    <div className="min-h-0 flex-1 space-y-3 overflow-y-auto">
      <section className="rounded-card border-2 border-border-subtle bg-bg-surface p-3">
        <div className="mb-2 font-mono text-[11px] tracking-wider text-fg-muted">{t('room.drawer.about.title')}</div>
        {failed && <div className="mb-2 text-[11px] text-fg-muted">{t('room.drawer.about.noAvatar')}</div>}
        <ul className="space-y-1">
          {rows.map(([label, value]) => (
            <li key={label} className="flex items-baseline justify-between gap-2 text-[11px]">
              <span className="shrink-0 text-fg-muted">{label}</span>
              <span className="min-w-0 truncate text-right font-mono text-fg-secondary" title={value}>
                {value}
              </span>
            </li>
          ))}
        </ul>
      </section>

      {/* ===== 图片立绘（ADR-34）：放图目录 + 需要的文件名 + 重新读取 + 后处理 ===== */}
      <section className="rounded-card border-2 border-border-subtle bg-bg-surface p-3">
        <div className="mb-2 flex items-center justify-between gap-2">
          <span className="font-mono text-[11px] tracking-wider text-fg-muted">{t('room.drawer.about.mascot')}</span>
          <span className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={() => void processRaw()}
              disabled={processing}
              className="room-press px-2 py-0.5 text-micro text-fg-secondary disabled:opacity-40"
              title={t('room.drawer.about.mascotProcessHint')}
            >
              {processing ? t('room.drawer.about.mascotProcessing') : t('room.drawer.about.mascotProcess')}
            </button>
            <button
              type="button"
              onClick={() => void reloadMascot(aiId)}
              className="room-press px-2 py-0.5 text-micro text-fg-muted"
            >
              {t('room.drawer.about.mascotReload')}
            </button>
          </span>
        </div>
        <div className="mb-2 break-all font-mono text-micro text-fg-secondary" title={mascot.dir ?? ''}>
          {mascot.dir ?? t('room.drawer.about.mascotNoDir')}
        </div>
        {mascot.error && <div className="mb-2 text-micro text-danger">{mascot.error}</div>}
        <p className="text-[11px] leading-5 text-fg-muted">{t('room.drawer.about.mascotHint')}</p>
        <p className="mt-1 text-[11px] leading-5 text-fg-muted">{t('room.drawer.about.mascotScopeHint')}</p>
        <p className="mt-1 text-[11px] leading-5 text-fg-muted">{t('room.drawer.about.mascotRawHint')}</p>
        {procError && <div className="mt-2 text-micro text-danger">{procError}</div>}
        {proc && (
          <div className="mt-2 space-y-0.5">
            <div className="text-micro text-success">
              {t('room.drawer.about.mascotProcessed').replace('{n}', String(proc.processed.length))}
            </div>
            {proc.processed.map((p) => (
              <div key={p.file} className="text-micro text-fg-muted">
                <span className="font-mono">{p.file}</span>
                {' → '}
                <span className="font-mono text-fg-secondary">{p.frame}.png</span>
                {!p.alreadyTransparent && ` · ${t('room.drawer.about.mascotCutout').replace('{pct}', String(Math.round((p.removed / (p.w * p.h)) * 100)))}`}
              </div>
            ))}
          </div>
        )}
        {frameNames.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {frameNames.map((n) => (
              <span
                key={n}
                className={`font-mono text-micro ${mascot.frames[n] ? 'text-success' : 'text-fg-muted'}`}
                title={mascot.frames[n] ? t('room.drawer.about.mascotHas') : t('room.drawer.about.mascotMiss')}
              >
                {n}.png
              </span>
            ))}
          </div>
        )}
        {mascot.skipped.length > 0 && (
          <div className="mt-2 space-y-0.5">
            <div className="text-micro text-warning">{t('room.drawer.about.mascotSkipped')}</div>
            {mascot.skipped.map((s) => (
              <div key={s.file} className="text-micro text-fg-muted">
                <span className="font-mono">{s.file}</span>：{s.reason}
              </div>
            ))}
          </div>
        )}
        {mascot.loaded && covered.length === 0 && (
          <div className="mt-2 text-micro text-fg-muted">{t('room.drawer.about.mascotEmpty')}</div>
        )}
      </section>

      <p className="text-[11px] leading-5 text-fg-muted">{t('room.drawer.about.hint')}</p>
    </div>
  )
}
