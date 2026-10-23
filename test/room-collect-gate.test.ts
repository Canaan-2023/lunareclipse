/**
 * ROOM 自主采集闸门回归（P0-1）：`evaluateRoomCollectGate` + `buildRoomCollectInput`。
 *
 * 为什么存在：自主循环**每轮自动**采集（进程名 / 网卡速率 / 磁盘 / GPU），若只判用户层
 * `config.collector.enabled`，就等于「打开开关即把采集权授予 AI」——与 ADR-11 的三层分级、
 * ADR-16 §3.2「两层缺一不可」直接相悖（2026-10-18 工程保障团队评审 P0-1 实测确认）。
 * 本文件把「未授予 `t1.collector` 时不得采集」锁成机械守卫。
 *
 * 覆盖：开关未开 / 开关开但未授予 / 已授予 三态；并断言**未授予时不发生采集**（返回无 text）。
 * 不测「已授予」的完整采集：那会起 PowerShell/tasklist 子进程，属机器特异路径（CODE-RULES §二 R-T4）。
 */
import { describe, it, expect } from 'vitest'
import type { CollectorConfig } from '../shared/types/collector'
import type { SecurityGrants } from '../shared/types/permission'
import { evaluateRoomCollectGate, buildRoomCollectInput } from '../electron/main/bootstrap/room-runtime'

const ENABLED: CollectorConfig = { enabled: true, desktop: false }
const DISABLED: CollectorConfig = { enabled: false, desktop: false }
const EMPTY: SecurityGrants = { grants: {} }
const GRANTED: SecurityGrants = {
  grants: { 't1.collector': { key: 't1.collector', grantedAt: 1_700_000_000_000 } }
}

describe('ROOM 自主采集闸门（用户层开关 + AI 层授予，缺一不可）', () => {
  it('用户层开关未开（缺省 / false）→ 拒，原因指向开关', () => {
    const a = evaluateRoomCollectGate(undefined, GRANTED)
    expect(a.ok).toBe(false)
    if (!a.ok) expect(a.error).toContain('采集器未开启')

    const b = evaluateRoomCollectGate(DISABLED, GRANTED)
    expect(b.ok).toBe(false)
    if (!b.ok) expect(b.error).toContain('采集器未开启')
  })

  it('开关已开但未授予 t1.collector → 拒 + 授予提示（不因开关而放行）', () => {
    const g = evaluateRoomCollectGate(ENABLED, EMPTY)
    expect(g.ok).toBe(false)
    if (!g.ok) {
      expect(g.error).toContain('自主采集被拒')
      expect(g.error).toContain('t1.collector')
      expect(g.error).toContain('授予方式')
    }
  })

  it('开关已开且已授予 → 放行', () => {
    expect(evaluateRoomCollectGate(ENABLED, GRANTED).ok).toBe(true)
  })

  it('未授予时 buildRoomCollectInput 直接返回、**不采集**（无 text）', async () => {
    const r = await buildRoomCollectInput(ENABLED, EMPTY)
    expect(r.ok).toBe(false)
    expect(r.text).toBeUndefined()
    expect(String(r.error)).toContain('t1.collector')
  })

  it('用户层开关未开时优先报开关（先于权限裁决，且不采集）', async () => {
    const r = await buildRoomCollectInput(DISABLED, GRANTED)
    expect(r.ok).toBe(false)
    expect(r.text).toBeUndefined()
    expect(String(r.error)).toContain('采集器未开启')
  })
})
