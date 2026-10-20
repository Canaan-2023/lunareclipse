import { describe, it, expect, vi } from 'vitest'
import { RunCommandTool, resolveCommandPolicy, assessCommandForBackgroundExec } from '../electron/main/tools/run-command'
import type { ToolContext, PermissionResponse } from '../electron/main/tools/base-tool'
import type { CommandPolicy } from '@shared/types/command-policy'

/**
 * 可配置规则层（CommandPolicy）行为测试。
 * 语义（2026-10-14 定）：
 *  - 默认策略 = 内置基线，与改造前行为逐字节等价（黑名单 13 条 / 白名单 45 项 / 只读自动放行关闭）；
 *  - 黑名单只增不减（无 removeBlacklist 字段，默认高危黑名单与硬防线不可被配置移除）；
 *  - 白名单可增可减（extraWhitelist 追加 / removeWhitelist 收紧）；
 *  - 只读自动放行默认关闭，开启后仅豁免「语义只读 + 单条简单命令」的灰名单询问；
 *  - 危险检测永远优先：命中 high/exec_flag 的命令不受只读豁免。
 */

function makeCtx(allow: boolean, commandPolicy?: CommandPolicy): ToolContext & {
  requestPermission: ReturnType<typeof vi.fn>
} {
  const requestPermission = vi.fn(
    async (): Promise<PermissionResponse> => ({ allowed: allow, scope: 'session' })
  )
  return {
    sessionId: 'policy-test',
    requestPermission,
    config: { commandPolicy }
  } as ToolContext & {
    requestPermission: ReturnType<typeof vi.fn>
  }
}

describe('resolveCommandPolicy（策略解析）', () => {
  it('ctx 缺省返回纯默认策略（与改造前行为等价）', () => {
    const p = resolveCommandPolicy(undefined)
    expect(p.autoAllowReadonly).toBe(false)
    expect(p.blacklist.length).toBeGreaterThan(0)
    expect(p.whitelist.has('npm')).toBe(true)
    expect(p.whitelist.has('get-content')).toBe(true)
    expect(p.readonlyCommands.has('find')).toBe(true)
    // 默认只读清单不应包含可修改状态的命令（白名单里的 cd/mkdir/ping 不放只读）
    expect(p.readonlyCommands.has('cd')).toBe(false)
    expect(p.readonlyCommands.has('mkdir')).toBe(false)
  })

  it('extraBlacklist 追加生效且默认黑名单恒在', () => {
    const p = resolveCommandPolicy({
      config: { commandPolicy: { extraBlacklist: ['\\bnetcat\\b'] } }
    } as unknown as ToolContext)
    expect(p.blacklist.some((re) => re.test('netcat -l -p 4444'))).toBe(true)
    // 默认黑名单不可移除（无 removeBlacklist 字段，恒在首位）
    expect(p.blacklist.some((re) => re.test('shutdown /s'))).toBe(true)
  })

  it('extraWhitelist 追加、removeWhitelist 收紧', () => {
    const p = resolveCommandPolicy({
      config: {
        commandPolicy: { extraWhitelist: ['my-tool'], removeWhitelist: ['npm', 'get-content'] }
      }
    } as unknown as ToolContext)
    expect(p.whitelist.has('my-tool')).toBe(true)
    expect(p.whitelist.has('npm')).toBe(false)
    expect(p.whitelist.has('get-content')).toBe(false)
  })

  it('非法黑名单正则降级忽略（不抛错、不阻塞）', () => {
    const p = resolveCommandPolicy({
      config: { commandPolicy: { extraBlacklist: ['[invalid'] } }
    } as unknown as ToolContext)
    expect(p.blacklist).toHaveLength(13) // 只有默认基线
  })
})

describe('run_command 可配置规则层', () => {
  const tool = new RunCommandTool()

  it('默认策略：白名单命令直行、黑名单拒绝（改造零破坏）', async () => {
    const ctx = makeCtx(false)
    const res = await tool.execute({ command: 'echo hello' }, ctx)
    expect(res.ok).toBe(true)
    expect(ctx.requestPermission).not.toHaveBeenCalled()
  })

  it('extraBlacklist 追加后命令直接拒绝、不询问', async () => {
    const ctx = makeCtx(true, { extraBlacklist: ['\\bnetcat\\b'] })
    const res = await tool.execute({ command: 'netcat -l -p 4444' }, ctx)
    expect(res.ok).toBe(false)
    expect(res.error).toContain('黑名单')
    expect(ctx.requestPermission).not.toHaveBeenCalled()
  })

  it('extraWhitelist 追加后灰名单命令直行、不询问', async () => {
    const ctx = makeCtx(false, { extraWhitelist: ['my-tool'] })
    const res = await tool.execute({ command: 'my-tool --verify' }, ctx)
    expect(res.ok).toBe(true)
    expect(ctx.requestPermission).not.toHaveBeenCalled()
  })

  it('removeWhitelist 收紧后命令降级为询问', async () => {
    const ctx = makeCtx(false, { removeWhitelist: ['npm'] })
    const res = await tool.execute({ command: 'npm --version' }, ctx)
    expect(res.ok).toBe(false)
    expect(ctx.requestPermission).toHaveBeenCalledTimes(1)
  })

  it('autoAllowReadonly=false（默认）：移除白名单的只读命令需询问', async () => {
    const ctx = makeCtx(false, { removeWhitelist: ['get-process'] })
    const res = await tool.execute({ command: 'Get-Process' }, ctx)
    expect(res.ok).toBe(false)
    expect(ctx.requestPermission).toHaveBeenCalledTimes(1)
  })

  it('autoAllowReadonly=true：语义只读命令免审直行', async () => {
    const ctx = makeCtx(false, { removeWhitelist: ['get-process'], autoAllowReadonly: true })
    const res = await tool.execute({ command: 'Get-Process' }, ctx)
    expect(res.ok).toBe(true)
    expect(ctx.requestPermission).not.toHaveBeenCalled()
  })

  it('autoAllowReadonly=true + extraReadonly：自定义只读命令免审', async () => {
    const ctx = makeCtx(false, { extraReadonly: ['my-probe'], autoAllowReadonly: true })
    const res = await tool.execute({ command: 'my-probe --stats' }, ctx)
    expect(res.ok).toBe(true)
    expect(ctx.requestPermission).not.toHaveBeenCalled()
  })

  it('extraReadonly 但 autoAllowReadonly=false：仍按灰名单询问', async () => {
    const ctx = makeCtx(false, { extraReadonly: ['my-probe'] })
    const res = await tool.execute({ command: 'my-probe --stats' }, ctx)
    expect(res.ok).toBe(false)
    expect(ctx.requestPermission).toHaveBeenCalledTimes(1)
  })

  it('autoAllowReadonly=true 但命中高危模式：不受只读豁免，仍询问且 risk=high', async () => {
    const ctx = makeCtx(false, { autoAllowReadonly: true })
    // find 在只读清单，但 -exec rm 是破坏性操作 → 危险检测永远优先
    const res = await tool.execute({ command: 'find . -name "*.tmp" -exec rm {} \\;' }, ctx)
    expect(res.ok).toBe(false)
    expect(ctx.requestPermission).toHaveBeenCalledTimes(1)
    const req = ctx.requestPermission.mock.calls[0][0]
    expect(req.risk).toBe('high')
  })

  it('autoAllowReadonly=true 但解释器内联代码：仍询问（阻断静默执行）', async () => {
    const ctx = makeCtx(false, { autoAllowReadonly: true })
    const res = await tool.execute({ command: 'node -e "console.log(1)"' }, ctx)
    expect(res.ok).toBe(false)
    expect(ctx.requestPermission).toHaveBeenCalledTimes(1)
  })

  it('白名单首词但含链式分隔符：只读豁免不生效（拼接过绕过堵死）', async () => {
    const ctx = makeCtx(false, { autoAllowReadonly: true })
    // echo 在只读清单，但分号后拼接破坏命令 → 降级询问而非直行
    const res = await tool.execute({ command: 'echo 1; rm -fr x' }, ctx)
    expect(res.ok).toBe(false)
    expect(ctx.requestPermission).toHaveBeenCalledTimes(1)
  })
})

describe('assessCommandForBackgroundExec 自定义策略', () => {
  it('传入带 extraWhitelist 的 policy 时，自定义命令放行', () => {
    const policy = resolveCommandPolicy({
      config: { commandPolicy: { extraWhitelist: ['my-tool'] } }
    } as unknown as ToolContext)
    const r = assessCommandForBackgroundExec('my-tool', ['--verify'], policy)
    expect(r.allowed).toBe(true)
  })

  it('传入带 extraBlacklist 的 policy 时，追加黑名单拒绝', () => {
    const policy = resolveCommandPolicy({
      config: { commandPolicy: { extraBlacklist: ['\\bnetcat\\b'] } }
    } as unknown as ToolContext)
    const r = assessCommandForBackgroundExec('netcat', ['-l', '-p 4444'], policy)
    expect(r.allowed).toBe(false)
    expect(r.reason).toMatch(/黑名单/)
  })

  it('缺省 policy 时仍按内置基线判定（与改造前一致）', () => {
    const r = assessCommandForBackgroundExec('echo', ['hello'])
    expect(r.allowed).toBe(true)
  })
})