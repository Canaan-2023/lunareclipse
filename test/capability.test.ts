import { describe, it, expect } from 'vitest'
import { checkCapability, readCapabilityPolicy } from '../electron/main/kernel/capability'

describe('CapabilityGuard 声明式能力拦截（2026-08-18，interception）', () => {
  const meta = (caps?: string[]) => ({ caps, riskLevel: 'medium' as const })

  it('默认（无 policy / enabled=false）全放行，不破坏 AI 全量写权限边界', () => {
    expect(checkCapability('Write', meta(['filesystem:write']), undefined)).toEqual({ allowed: true })
    expect(checkCapability('run_command', meta(['system:exec']), {})).toEqual({ allowed: true })
    expect(checkCapability('Write', meta(['filesystem:write']), { capabilityPolicy: { enabled: false } })).toEqual({ allowed: true })
  })

  it('denyTools：显式禁用工具被拦', () => {
    const policy = { enabled: true, denyTools: ['run_command'] }
    const r = checkCapability('run_command', meta(['system:exec']), undefined, policy)
    expect(r.allowed).toBe(false)
    expect(r.reason).toContain('run_command')
    // 未禁用的工具放行
    expect(checkCapability('Read', meta(), undefined, policy).allowed).toBe(true)
  })

  it('denyCaps：工具声明被禁能力则拦', () => {
    const policy = { enabled: true, denyCaps: ['network'] }
    expect(checkCapability('web_search', meta(['network']), undefined, policy).allowed).toBe(false)
    expect(checkCapability('Read', meta(['filesystem:read']), undefined, policy).allowed).toBe(true)
    // 未声明任何 cap 的工具不受 denyCaps 影响（保守放行）
    expect(checkCapability('todo_write', meta(), undefined, policy).allowed).toBe(true)
  })

  it('allowCaps：白名单模式，声明了不允许能力的工具被拦', () => {
    const policy = { enabled: true, allowCaps: ['filesystem:read'] }
    expect(checkCapability('Write', meta(['filesystem:write']), undefined, policy).allowed).toBe(false)
    expect(checkCapability('Read', meta(['filesystem:read']), undefined, policy).allowed).toBe(true)
    // 未声明任何 cap → 保守放行（不误伤）
    expect(checkCapability('todo_write', meta(), undefined, policy).allowed).toBe(true)
  })

  it('readCapabilityPolicy：宽松解析 config.capabilityPolicy', () => {
    expect(readCapabilityPolicy(undefined)).toEqual({})
    expect(readCapabilityPolicy({ capabilityPolicy: { enabled: true, denyTools: ['a'] } })).toEqual({
      enabled: true,
      denyTools: ['a'],
      denyCaps: undefined,
      allowCaps: undefined
    })
    expect(readCapabilityPolicy({ capabilityPolicy: 123 })).toEqual({}) // 非对象忽略
  })

  it('真实 registry 工具带 caps：denyCaps 能按能力清单位拦（数据↔机制联通）', async () => {
    const { getAllToolMetas } = await import('../shared/tools/registry')
    const metas = getAllToolMetas()
    const web = metas.find((m) => m.id === 'web_search')
    expect(web).toBeDefined()
    expect(web!.caps).toContain('network') // 已落实能力标签
    // denyCaps:['network'] → web_search 被拦
    const policy = { enabled: true, denyCaps: ['network'] }
    expect(checkCapability('web_search', { caps: web!.caps, riskLevel: web!.riskLevel }, undefined, policy).allowed).toBe(false)
    // run_command 声明 system:exec，不受 network 拦截
    const rc = metas.find((m) => m.id === 'run_command')
    expect(checkCapability('run_command', { caps: rc!.caps, riskLevel: rc!.riskLevel }, undefined, policy).allowed).toBe(true)
  })
})
