/**
 * ROOM 设备管理区（B-B2）回归。
 *
 * 两层：
 * 1. **IPC 入参解析** `parseDeviceCall`（纯函数）：形状非法即拒（不猜）；
 * 2. **渲染探针**：`DeviceZone` SSR 输出含扫描入口 + 空态 + 权限说明（`useEffect` 不执行 → 停在空态）。
 */
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, it, expect } from 'vitest'
import { parseDeviceCall } from '../electron/main/room/device-ipc'
import { DeviceZone } from '../src/components/Room/DeviceZone'

describe('parseDeviceCall：IPC 入参形状', () => {
  it('合法入参 → 取出 deviceId/actionId/params', () => {
    const r = parseDeviceCall({ deviceId: 'reg:lamp', actionId: 'power:on', params: { level: 3 } })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.req.deviceId).toBe('reg:lamp')
      expect(r.req.actionId).toBe('power:on')
      expect(r.req.params).toEqual({ level: 3 })
    }
  })

  it('缺字段 / 空串 / 非对象 → 拒', () => {
    expect(parseDeviceCall({}).ok).toBe(false)
    expect(parseDeviceCall({ deviceId: 'x' }).ok).toBe(false)
    expect(parseDeviceCall({ deviceId: '  ', actionId: 'a' }).ok).toBe(false)
    expect(parseDeviceCall(null).ok).toBe(false)
    expect(parseDeviceCall({ deviceId: 1, actionId: 'a' }).ok).toBe(false)
  })

  it('params 非对象 → 归零为空对象（不把非法值透传下去）', () => {
    const r = parseDeviceCall({ deviceId: 'd', actionId: 'a', params: 'nope' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.req.params).toEqual({})
  })
})

describe('DeviceZone 渲染探针', () => {
  const html = renderToStaticMarkup(<DeviceZone />)

  it('有扫描入口与空态（SSR 下 useEffect 不执行）', () => {
    expect(html).toContain('扫描设备')
    expect(html).toContain('未发现设备')
  })

  it('说明权限边界（控制动作要授权、发现只读）', () => {
    expect(html).toContain('控制动作')
    expect(html).toContain('只读')
  })
})
