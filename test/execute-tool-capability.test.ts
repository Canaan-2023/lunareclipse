import { describe, it, expect, afterAll } from 'vitest'
import { createToolRegistry, executeTool } from '../electron/main/tools/index'
import { clearDynamicToolMetas } from '../shared/tools/registry'

/**
 * executeTool × CapabilityGuard 集成（2026-08-18）
 * - 默认（无 policy enabled）：工具不被能力闸拦截
 * - config.capabilityPolicy.enabled + denyTools 列出该工具 → 返回"被能力策略拒绝"
 * - 其它工具不受影响
 */
describe('executeTool × CapabilityGuard 集成', () => {
  afterAll(() => clearDynamicToolMetas())

  it('默认放行；denyTools 精确拦截被禁工具', async () => {
    // 默认：无能力策略 → 不拦截（用 Read，其 execute 报"文件不存在"但 error 不含能力拒绝字样）
    const regDefault = createToolRegistry({ config: {} } as never, {} as never)
    const r0 = await executeTool(regDefault, 'Read', { file_path: '__nonexistent__' })
    const err0 = (r0 as { error?: string }).error ?? ''
    expect(err0).not.toContain('被能力策略拒绝') // 能力闸未拦截

    // 启用 denyTools 列出 Read → 拦截
    const regDeny = createToolRegistry(
      { config: { capabilityPolicy: { enabled: true, denyTools: ['Read'] } } } as never,
      {} as never
    )
    const r1 = await executeTool(regDeny, 'Read', { file_path: '__nonexistent__' })
    expect(r1.ok).toBe(false)
    const err1 = (r1 as { error?: string }).error ?? ''
    expect(err1).toContain('被能力策略拒绝')
    expect(err1).toContain('Read')

    // 其它工具不受影响：denyTools 只列 Read，tool_info 不被能力拒（且本身执行不同路径）
    const regDeny2 = createToolRegistry(
      { config: { capabilityPolicy: { enabled: true, denyTools: ['Read'] } } } as never,
      {} as never
    )
    const r2 = await executeTool(regDeny2, 'tool_info', {})
    const err2 = (r2 as { error?: string }).error ?? ''
    expect(err2).not.toContain('被能力策略拒绝')
  })
})
