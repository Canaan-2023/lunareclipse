/**
 * ROOM 唤醒仲裁（`room/wake.ts`）回归：**主进程单 owner + 去抖**。
 *
 * 为什么测：用户裁决「AI 停止时由采集器返回值激活 AI」「待机静默期由事件唤醒」。
 * 若每个来源各自唤醒，用户到达 + 监控命中会重复激活，且去抖口径会散落各处。
 * 去抖口径（SRE 定）：**同源 5s / 跨源 60s**。
 */
import { describe, it, expect } from 'vitest'
import {
  clearWakeArbiters,
  createWakeArbiter,
  registerWakeArbiter,
  reportRoomWake,
  WAKE_DEBOUNCE,
  type WakeSource
} from '../electron/main/room/wake'

describe('createWakeArbiter：去抖', () => {
  it('首次上报即触发', () => {
    const fired: WakeSource[] = []
    const a = createWakeArbiter((s) => fired.push(s))
    expect(a.request('user-present', 1000)).toBe(true)
    expect(fired).toEqual(['user-present'])
  })

  it('同源 5s 内丢弃，5s 后放行', () => {
    const fired: WakeSource[] = []
    const a = createWakeArbiter((s) => fired.push(s))
    a.request('monitor', 10_000)
    expect(a.request('monitor', 10_000 + WAKE_DEBOUNCE.sameSourceMs - 1)).toBe(false)
    expect(a.request('monitor', 10_000 + WAKE_DEBOUNCE.sameSourceMs)).toBe(true)
    expect(fired).toHaveLength(2)
  })

  it('跨源 60s 内丢弃（任意来源触发后压制其它来源），60s 后放行', () => {
    const fired: WakeSource[] = []
    const a = createWakeArbiter((s) => fired.push(s))
    a.request('user-present', 0)
    // 同源 5s 已过，但跨源 60s 未到 → 仍丢弃
    expect(a.request('monitor', WAKE_DEBOUNCE.sameSourceMs + 1)).toBe(false)
    expect(a.request('monitor', WAKE_DEBOUNCE.crossSourceMs)).toBe(true)
    expect(fired).toEqual(['user-present', 'monitor'])
  })

  it('被丢弃时不触发回调', () => {
    let n = 0
    const a = createWakeArbiter(() => {
      n += 1
    })
    a.request('monitor', 0)
    a.request('monitor', 1)
    a.request('user-present', 2)
    expect(n).toBe(1)
  })

  it('0.53.1：collector 是合法唤醒源，且 detail 原样透传（事件流要能说清为什么醒）', () => {
    const got: Array<{ source: WakeSource; detail?: string }> = []
    const a = createWakeArbiter((source, detail) => {
      got.push({ source, ...(detail ? { detail } : {}) })
    })
    expect(a.request('collector', 0, 'CPU 10% → 80%')).toBe(true)
    expect(got).toEqual([{ source: 'collector', detail: 'CPU 10% → 80%' }])
  })

  it('user-action / collector 不被跨源 60s 压掉（条件触发只受 5s 同源限制）', () => {
    const a = createWakeArbiter(() => undefined)
    expect(a.request('monitor', 0)).toBe(true)
    // 刚有过监控事件；用户此时授权/开采集器，不能被 60s 跨源抑制吞掉
    expect(a.request('user-action', WAKE_DEBOUNCE.sameSourceMs + 1)).toBe(true)
    // 但双击仍受 5s 保护
    expect(a.request('user-action', WAKE_DEBOUNCE.sameSourceMs + 2)).toBe(false)

    const b = createWakeArbiter(() => undefined)
    expect(b.request('user-present', 0)).toBe(true)
    // 感知到变化同样不被跨源压制
    expect(b.request('collector', WAKE_DEBOUNCE.sameSourceMs + 1)).toBe(true)
  })
})

describe('reportRoomWake：单 owner 上报入口', () => {
  it('带 aiId 只报该房间；不带则广播', () => {
    clearWakeArbiters()
    const hits: string[] = []
    registerWakeArbiter(1, createWakeArbiter(() => hits.push('ai1')))
    registerWakeArbiter(2, createWakeArbiter(() => hits.push('ai2')))

    expect(reportRoomWake('user-present', 1, 0)).toBe(true)
    expect(hits).toEqual(['ai1'])

    // 广播：两个房间都收到（时间推远以越过跨源去抖）
    hits.length = 0
    expect(reportRoomWake('monitor', undefined, 100_000)).toBe(true)
    expect([...hits].sort()).toEqual(['ai1', 'ai2'])
    clearWakeArbiters()
  })

  it('未注册的房间 → 不触发（false），不抛', () => {
    clearWakeArbiters()
    expect(reportRoomWake('user-present', 99, 0)).toBe(false)
  })

  it('collector 广播也走同一入口（powerMonitor / 感知器上报）', () => {
    clearWakeArbiters()
    const hits: string[] = []
    registerWakeArbiter(7, createWakeArbiter((source, detail) => hits.push(`${source}:${detail ?? ''}`)))
    expect(reportRoomWake('collector', 7, 0, '解锁屏幕')).toBe(true)
    expect(hits).toEqual(['collector:解锁屏幕'])
    clearWakeArbiters()
  })
})
