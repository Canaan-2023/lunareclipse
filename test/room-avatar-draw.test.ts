/**
 * ROOM「AI 决定像素点」（P3）回归。
 *
 * 用户裁决：「AI 可操作性 = 就是 **AI 决定像素点怎么摆放**」。落点 = AI 计划输出带 `avatar` 字段 →
 * runtime 调注入的 `applyAvatar`（门控 + 校验 + 落盘在组合根）→ 成功则 `avatarRev +1`（渲染侧据此重取）。
 *
 * 覆盖：
 * 1. 计划带 `avatar` → `applyAvatar` 恰好调用一次、`avatarRev` +1、事件流留痕；
 * 2. 应用失败（校验/门控拒）→ `avatarRev` 不变、事件流带原因，**不打崩循环**；
 * 3. 计划不带 `avatar` → 不调用；
 * 4. 未接线 `applyAvatar` → 不抛，事件记「未接线」；
 * 5. `t2.room-avatar` 登记为 T2（默认开、不可授予）——分级真源在 `shared/security/tiers.ts`。
 */
import { describe, it, expect } from 'vitest'
import { createRoomRuntime, type RoomRuntimeDeps } from '../electron/main/room/runtime'
import { isGrantable, resolveCapability } from '@shared/security/tiers'

const OK_EXECUTOR: RoomRuntimeDeps['executor'] = {
  execute: async () => ({
    ok: true,
    decision: { allowed: true, tier: 'T2', code: 'allowed', reason: 'ok', auditId: 'a' }
  })
}

function makeRt(reply: string, applyAvatar?: RoomRuntimeDeps['applyAvatar']) {
  const calls: unknown[] = []
  const rt = createRoomRuntime({
    collect: async () => ({ ok: true, text: '平台 win32 · CPU 5%' }),
    plan: async () => reply,
    executor: OK_EXECUTOR,
    allowedTools: () => ['read'],
    ...(applyAvatar
      ? {
          applyAvatar: (raw: unknown) => {
            calls.push(raw)
            return applyAvatar(raw)
          }
        }
      : {})
  })
  return { rt, calls }
}

const withAvatar = JSON.stringify({ note: '换个样子', decisions: [], avatar: { version: 1, marker: 'x' } })

describe('AI 重画像素形象（P3）', () => {
  it('计划带 avatar → 应用一次、avatarRev +1、事件留痕', async () => {
    const { rt, calls } = makeRt(withAvatar, () => ({ ok: true }))
    await rt.tick()
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual({ version: 1, marker: 'x' })
    expect(rt.getState().avatarRev).toBe(1)
    expect(rt.getState().events.some((e) => e.detail?.includes('已重画像素形象'))).toBe(true)
  })

  it('应用失败 → avatarRev 不变、事件带原因（不打崩循环）', async () => {
    const { rt } = makeRt(withAvatar, () => ({ ok: false, error: '形象必须完整落在房间内' }))
    const result = await rt.tick()
    expect(rt.getState().avatarRev).toBe(0)
    expect(rt.getState().events.some((e) => e.detail?.includes('像素形象未更新'))).toBe(true)
    expect(rt.getState().events.some((e) => e.detail?.includes('形象必须完整落在房间内'))).toBe(true)
    // 循环本身没崩：本轮照常返回结果
    expect(result.phase).toBe('idle')
  })

  it('计划不带 avatar → 不调用、avatarRev 保持 0', async () => {
    const { rt, calls } = makeRt('{"decisions":[]}', () => ({ ok: true }))
    await rt.tick()
    expect(calls).toHaveLength(0)
    expect(rt.getState().avatarRev).toBe(0)
  })

  it('未接线 applyAvatar → 不抛，事件记「未接线」', async () => {
    const { rt } = makeRt(withAvatar)
    await rt.tick()
    expect(rt.getState().avatarRev).toBe(0)
    expect(rt.getState().events.some((e) => e.detail?.includes('未接线'))).toBe(true)
  })
})

describe('t2.room-avatar 分级', () => {
  it('登记为 T2：默认开、不可授予', () => {
    const cap = resolveCapability('t2.room-avatar')
    expect(cap?.tier).toBe('T2')
    expect(isGrantable('t2.room-avatar')).toBe(false)
  })
})
