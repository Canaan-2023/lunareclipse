import { describe, it, expect, vi } from 'vitest'
import {
  RunCommandTool,
  resolveCommandPolicy,
  matchPolicyRule,
  assessCommandForBackgroundExec
} from '../electron/main/tools/run-command'
import type { ToolContext, PermissionResponse } from '../electron/main/tools/base-tool'
import type { CommandPolicy } from '@shared/types/command-policy'

/**
 * 管理规则层（policyRules）行为测试（M4）。
 * 语义（2026-10-15 定）：
 *  - 管理级 > userSettings > builtin 基线三级裁决；危险检测/黑名单硬防线永远优先于本层；
 *  - deny 直接拒绝；ask 强制询问（即使白名单/只读自动放行面内）；allow 放行灰名单；
 *  - 多规则同时命中按动作优先级裁决（deny > ask > allow，安全优先）；
 *  - 自动化通道（无 requestPermission）：ask fail-closed 拒绝；
 *  - 后台 HOOK 通道与 run_command 共用同一判定源（防规则漂移）。
 */

function makeCtx(allow: boolean, commandPolicy?: CommandPolicy): ToolContext & {
  requestPermission: ReturnType<typeof vi.fn>
} {
  const requestPermission = vi.fn(
    async (): Promise<PermissionResponse> => ({ allowed: allow, scope: 'session' })
  )
  return {
    sessionId: 'policy-rules-test',
    requestPermission,
    config: { commandPolicy }
  } as ToolContext & {
    requestPermission: ReturnType<typeof vi.fn>
  }
}

describe('matchPolicyRule（管理规则匹配）', () => {
  it('无规则返回 null', () => {
    const p = resolveCommandPolicy(undefined)
    expect(matchPolicyRule('echo hi', p)).toBeNull()
  })

  it('命令前缀匹配（大小写不敏感）', () => {
    const p = resolveCommandPolicy({
      config: {
        commandPolicy: {
          policyRules: [{ command: 'npm', action: 'deny', note: '禁用包管理写' }]
        }
      }
    } as unknown as ToolContext)
    expect(matchPolicyRule('NPM install lodash', p)?.action).toBe('deny')
    expect(matchPolicyRule('echo hi', p)).toBeNull()
  })

  it("'*' 匹配所有命令", () => {
    const p = resolveCommandPolicy({
      config: { commandPolicy: { policyRules: [{ command: '*', action: 'ask' }] } }
    } as unknown as ToolContext)
    expect(matchPolicyRule('echo hi', p)?.action).toBe('ask')
    expect(matchPolicyRule('Get-Process', p)?.action).toBe('ask')
  })

  it('argPattern 子串匹配（大小写不敏感）', () => {
    const p = resolveCommandPolicy({
      config: {
        commandPolicy: {
          policyRules: [{ command: 'npm', argPattern: 'install', action: 'deny' }]
        }
      }
    } as unknown as ToolContext)
    expect(matchPolicyRule('npm install lodash', p)?.action).toBe('deny')
    expect(matchPolicyRule('npm run build', p)).toBeNull()
  })

  it('多规则同命中取最严动作（deny > ask > allow）', () => {
    const p = resolveCommandPolicy({
      config: {
        commandPolicy: {
          policyRules: [
            { command: 'npm', action: 'allow' },
            { command: 'npm', argPattern: 'install', action: 'deny' },
            { command: 'npm', argPattern: 'install lodash', action: 'ask' }
          ]
        }
      }
    } as unknown as ToolContext)
    expect(matchPolicyRule('npm install lodash', p)?.action).toBe('deny')
    expect(matchPolicyRule('npm update', p)?.action).toBe('allow')
  })
})

describe('run_command × 管理规则层', () => {
  const tool = new RunCommandTool()

  it('deny：直接拒绝，即使命令在白名单', async () => {
    const ctx = makeCtx(true, {
      policyRules: [{ command: 'npm', action: 'deny', note: '禁用' }]
    })
    const res = await tool.execute({ command: 'npm --version' }, ctx)
    expect(res.ok).toBe(false)
    expect(res.error).toContain('管理拒绝规则')
    expect(ctx.requestPermission).not.toHaveBeenCalled()
  })

  it('deny：argPattern 命中才拒绝，未命中不受影响', async () => {
    const ctx = makeCtx(true, {
      policyRules: [{ command: 'npm', argPattern: 'install', action: 'deny' }]
    })
    expect((await tool.execute({ command: 'npm install lodash' }, ctx)).ok).toBe(false)
    // 这里只验证「argPattern 不命中 → 不被管理规则拦截并真实执行」。
    // 原先用 `npm run build` 会真的跑完整构建（本机约 10s，正好撞上 10s 全局超时，
    // 让这条断言变成随机失败）；换成只读的 `npm --version`，语义不变、耗时毫秒级。
    expect((await tool.execute({ command: 'npm --version' }, ctx)).ok).toBe(true)
  })

  it('ask：白名单命令也强制询问', async () => {
    const ctx = makeCtx(false, {
      policyRules: [{ command: 'echo', action: 'ask', note: '必须确认' }]
    })
    const res = await tool.execute({ command: 'echo hello' }, ctx)
    expect(res.ok).toBe(false)
    expect(ctx.requestPermission).toHaveBeenCalledTimes(1)
    // 描述中附带管理规则备注，提示用户这是管理策略要求的确认
    const req = ctx.requestPermission.mock.calls[0][0]
    expect(req.description).toContain('必须确认')
  })

  it('ask：只读自动放行面内也强制询问', async () => {
    const ctx = makeCtx(false, {
      autoAllowReadonly: true,
      policyRules: [{ command: 'Get-Process', action: 'ask' }]
    })
    const res = await tool.execute({ command: 'Get-Process' }, ctx)
    expect(res.ok).toBe(false)
    expect(ctx.requestPermission).toHaveBeenCalledTimes(1)
  })

  it('ask 用户批准后授权，同命令不再询问', async () => {
    const ctx = makeCtx(true, {
      policyRules: [{ command: 'echo', action: 'ask' }]
    })
    const r1 = await tool.execute({ command: 'echo hello' }, ctx)
    expect(r1.ok).toBe(true)
    const r2 = await tool.execute({ command: 'echo hello' }, ctx)
    expect(r2.ok).toBe(true)
    expect(ctx.requestPermission).toHaveBeenCalledTimes(1)
  })

  it('allow：灰名单命令放行，不询问', async () => {
    const ctx = makeCtx(false, {
      policyRules: [{ command: 'my-tool', action: 'allow', note: '管理员信任' }]
    })
    const res = await tool.execute({ command: 'my-tool --sync' }, ctx)
    expect(res.ok).toBe(true)
    expect(ctx.requestPermission).not.toHaveBeenCalled()
  })

  it('allow：不能绕过危险检测（高危模式仍拦截）', async () => {
    const ctx = makeCtx(false, {
      policyRules: [{ command: '*', action: 'allow' }]
    })
    const res = await tool.execute({ command: 'find . -name "*.tmp" -exec rm {} \\;' }, ctx)
    expect(res.ok).toBe(false)
    expect(ctx.requestPermission).toHaveBeenCalledTimes(1)
  })

  it('allow：不能绕过黑名单', async () => {
    const ctx = makeCtx(false, {
      policyRules: [{ command: '*', action: 'allow' }]
    })
    const res = await tool.execute({ command: 'shutdown /s' }, ctx)
    expect(res.ok).toBe(false)
    expect(res.error).toContain('黑名单')
  })

  it('sed -i 危险编辑直接拒绝（参数级解析接线）', async () => {
    const ctx = makeCtx(true)
    const res = await tool.execute({ command: "sed -i '3d' a.txt" }, ctx)
    expect(res.ok).toBe(false)
    expect(res.error).toContain('sed 原地编辑命中危险表达式')
  })

  it('sed 只读编辑不在白名单，需用户授权', async () => {
    // sed 不带 -i 是只读编辑，但 sed 不在白名单/只读清单 → 灰名单需询问；
    // makeCtx(false) 用户拒绝 → ok=false 且 requestPermission 被调用 1 次
    const ctx = makeCtx(false)
    const res = await tool.execute({ command: "sed 's/a/b/' a.txt" }, ctx)
    expect(res.ok).toBe(false)
    expect(ctx.requestPermission).toHaveBeenCalledTimes(1)
  })

  it('自动化通道（无 requestPermission）：ask fail-closed 拒绝', async () => {
    // getSubAgentApproval 未装配（undefined）→ 直接拒绝
    const ctx = {
      sessionId: 'auto-ask-fail-closed',
      config: { commandPolicy: { policyRules: [{ command: 'echo', action: 'ask' }] } }
    } as unknown as ToolContext
    const res = await tool.execute({ command: 'echo hello' }, ctx)
    expect(res.ok).toBe(false)
    expect(res.error).toContain('自动化通道不能代为确认')
  })

  it('只读豁免被参数级写意图拦截：autoAllowReadonly 不放过写重定向', async () => {
    const ctx = makeCtx(false, { autoAllowReadonly: true })
    // echo 在只读清单，但 > 写重定向 = 非只读 → 降级为询问而非直行
    const res = await tool.execute({ command: 'echo hi > config.txt' }, ctx)
    expect(res.ok).toBe(false)
    expect(ctx.requestPermission).toHaveBeenCalledTimes(1)
  })

  it('只读豁免对 git 写子命令不生效', async () => {
    const ctx = makeCtx(false, { autoAllowReadonly: true })
    const res = await tool.execute({ command: 'git push origin main' }, ctx)
    expect(res.ok).toBe(false)
    expect(ctx.requestPermission).toHaveBeenCalledTimes(1)
  })

  it('默认策略：白名单命令带写重定向需询问（堵 echo > 静默写文件通道）', async () => {
    const ctx = makeCtx(false)
    const res = await tool.execute({ command: 'echo hi > config.txt' }, ctx)
    expect(res.ok).toBe(false)
    expect(ctx.requestPermission).toHaveBeenCalledTimes(1)
  })
})

describe('assessCommandForBackgroundExec × 管理规则层', () => {
  it('deny：后台命令拒绝', () => {
    const policy = resolveCommandPolicy({
      config: { commandPolicy: { policyRules: [{ command: 'npm', action: 'deny' }] } }
    } as unknown as ToolContext)
    const r = assessCommandForBackgroundExec('npm', ['install'], policy)
    expect(r.allowed).toBe(false)
    expect(r.reason).toMatch(/管理拒绝规则/)
  })

  it('ask：后台无授权通道，fail-closed 拒绝', () => {
    const policy = resolveCommandPolicy({
      config: { commandPolicy: { policyRules: [{ command: 'echo', action: 'ask' }] } }
    } as unknown as ToolContext)
    const r = assessCommandForBackgroundExec('echo', ['hello'], policy)
    expect(r.allowed).toBe(false)
    expect(r.reason).toMatch(/管理询问规则/)
  })

  it('allow：灰名单命令后台放行（白名单检查放行）', () => {
    const policy = resolveCommandPolicy({
      config: { commandPolicy: { policyRules: [{ command: 'my-tool', action: 'allow' }] } }
    } as unknown as ToolContext)
    const r = assessCommandForBackgroundExec('my-tool', ['--sync'], policy)
    expect(r.allowed).toBe(true)
  })

  it('allow 不能绕过后台危险检测', () => {
    const policy = resolveCommandPolicy({
      config: { commandPolicy: { policyRules: [{ command: '*', action: 'allow' }] } }
    } as unknown as ToolContext)
    const r = assessCommandForBackgroundExec('bash', ['-c', 'rm -rf /x'], policy)
    expect(r.allowed).toBe(false)
  })

  it('sed 危险编辑：后台通道同样拒绝', () => {
    const policy = resolveCommandPolicy(undefined)
    const r = assessCommandForBackgroundExec("sed -i '3d' a.txt", [], policy)
    expect(r.allowed).toBe(false)
    expect(r.reason).toMatch(/sed 原地编辑危险表达式/)
  })

  it('重定向写意图：后台 HOOK 通道拒绝（与 run_command 主通道同一判定源）', () => {
    const policy = resolveCommandPolicy(undefined)
    const r = assessCommandForBackgroundExec('echo', ['hi', '>', 'config.txt'], policy)
    expect(r.allowed).toBe(false)
    expect(r.reason).toMatch(/写重定向/)
  })

  it('命令自带写标志：npm install 后台 HOOK 放行（白名单，与主通道基线直行一致）', () => {
    const policy = resolveCommandPolicy(undefined)
    const r = assessCommandForBackgroundExec('npm', ['install', 'lodash'], policy)
    expect(r.allowed).toBe(true)
  })
})