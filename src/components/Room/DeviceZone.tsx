/**
 * ROOM 设备管理区（ADR-29 裁决6）：真设备列表 + 动作调用。
 *
 * 为什么存在：B-B1 的「设备」区只是**复用局域网地图**（`LanMapSection`），不是设备列表。
 * 本组件接 `room:device-scan`（只读发现）与 `room:device-call`（控制类动作经用户授权，fail-closed）。
 *
 * 权限边界（两路，勿混）：
 * - 发现（`scan`）只枚举，不触碰控制面；
 * - **交互路径**（本组件）：控制类动作 → 主进程 `DefaultDeviceManager.call` → `requestPermission` 弹框，
 *   用户拒绝即不执行；
 * - **自主路径**（AI 自己调设备）**不走本组件**——走 `device_call` 工具 → 执行器 `t1.executor-high-risk`。
 *
 * 局域网地图仍在下方保留（ADR-29：`lan` 归设备管理区），故本组件只负责「设备」这一半。
 *
 * 不删理由：删掉即设备区退回局域网地图，诉求 9「新增设备管理区」落空。
 */
import { useCallback, useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { useT } from '../../i18n/useT'

interface DeviceAction {
  id: string
  name: string
  kind: 'info' | 'control'
  risk: string
}

interface DeviceCapability {
  id: string
  name: string
  actions: DeviceAction[]
}

interface DeviceSummary {
  id: string
  name: string
  source: string
  kind: string
  address?: string
  status?: string
  capabilities: DeviceCapability[]
}

export function DeviceZone() {
  const t = useT()
  const [devices, setDevices] = useState<DeviceSummary[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [last, setLast] = useState('')

  const scan = useCallback(async () => {
    setBusy(true)
    setError('')
    try {
      const r = await window.lunareclipse?.roomDeviceScan?.()
      if (r?.ok) setDevices((r.devices ?? []) as DeviceSummary[])
      else setError(r?.error ?? t('room.device.scanFailed'))
    } finally {
      setBusy(false)
    }
  }, [t])

  useEffect(() => {
    void scan()
  }, [scan])

  const call = async (deviceId: string, actionId: string): Promise<void> => {
    setError('')
    setLast('')
    const r = await window.lunareclipse?.roomDeviceCall?.({ deviceId, actionId })
    if (r?.ok) setLast(`${deviceId} · ${actionId} → ${t('room.device.callOk')}`)
    else setError(r?.error ?? t('room.device.callFailed'))
  }

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto">
      <div className="room-panel flex items-center justify-between p-3">
        <div className="font-mono text-caption tracking-wider text-fg-muted">{t('room.zone.device')}</div>
        <button
          type="button"
          onClick={() => void scan()}
          disabled={busy}
          className="room-press flex items-center gap-1.5 px-2.5 py-1 text-caption text-fg-secondary disabled:opacity-40"
        >
          <RefreshCw size={12} />
          {t('room.device.scan')}
        </button>
      </div>

      {(error || last) && (
        <div className={`px-1 text-micro ${error ? 'text-danger' : 'text-success'}`}>{error || last}</div>
      )}

      {devices.length === 0 ? (
        <div className="text-micro text-fg-muted">{t('room.device.empty')}</div>
      ) : (
        devices.map((d) => (
          <div key={d.id} className="room-panel space-y-2 p-3">
            <div className="flex items-center gap-2 text-caption">
              <span className="font-mono text-accent">{d.name}</span>
              <span className="text-fg-muted">{d.kind}</span>
              {d.address && <span className="truncate font-mono text-micro text-fg-muted">{d.address}</span>}
              {d.status && <span className="text-micro text-fg-muted">{d.status}</span>}
            </div>
            {d.capabilities.map((cap) => (
              <div key={cap.id} className="space-y-1">
                <div className="text-micro text-fg-muted">{cap.name}</div>
                <div className="flex flex-wrap gap-1">
                  {cap.actions.map((a) => (
                    <button
                      key={a.id}
                      type="button"
                      onClick={() => void call(d.id, a.id)}
                      className="room-press px-2 py-1 text-micro text-fg-secondary"
                      title={`${a.id}${a.kind === 'control' ? ` · ${t('room.device.controlHint')}` : ''}`}
                    >
                      {a.name}
                      {a.kind === 'control' && <span className="ml-1 text-fg-muted">*</span>}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ))
      )}
      <div className="px-1 text-micro text-fg-muted">{t('room.device.hint')}</div>
    </div>
  )
}
