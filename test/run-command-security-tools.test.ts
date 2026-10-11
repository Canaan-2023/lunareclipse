import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'events'

/**
 * T5：安全探测工具（nmap/nuclei/hydra/ssh 等）接入 run_command 审批通道的行为测试。
 * 语义（与 T4 ApprovalManager 接线一致）：
 *  - 安全工具不在白名单 → 天然灰名单，必须经过审批（桌面询问 / 自动化通道策略裁决）
 *  - 审批文本显式提示「目标需已授权」，risk 标 medium（区别于普通 low 灰名单）
 *  - 自动化通道无裁决器 → fail-closed 拒绝，不静默放行
 *  - 命中 high 危险模式的安全工具命令 → 自动化通道同样拒绝（安全边界不放宽）
 */

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))
vi.mock('child_process', () => ({
  spawn: (...args: unknown[]) => spawnMock(...args)
}))

import { RunCommandTool, getSecurityToolLabel } from '../electron/main/tools/run-command'
import type { ToolContext, PermissionResponse } from '../electron/main/tools/base-tool'

/** 生成可触发 close 的子进程桩（mock spawn 返回值） */
function fakeChild(): EventEmitter & {
  stdout: EventEmitter
  stderr: EventEmitter
  pid: number
  kill: ReturnType<typeof vi.fn>
} {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter
    stderr: EventEmitter
    pid: number
    kill: ReturnType<typeof vi.fn>
  }
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.kill = vi.fn()
  child.pid = 1234
  return child
}

/** 让下一次 spawn 返回的桩在 execute 内部挂上监听后自动 close(0)，防止测试挂起 */
function mockSpawnAutoClose(): void {
  spawnMock.mockImplementation(() => {
    const child = fakeChild()
    setImmediate(() => child.emit('close', 0))
    return child
  })
}

function makeCtx(allow: boolean, scope: 'once' | 'session' = 'session'): ToolContext & {
  requestPermission: ReturnType<typeof vi.fn>
} {
  const requestPermission = vi.fn(
    async (): Promise<PermissionResponse> => ({ allowed: allow, scope })
  )
  return { sessionId: 'test-session', requestPermission } as ToolContext & {
    requestPermission: ReturnType<typeof vi.fn>
  }
}

describe('getSecurityToolLabel 分类', () => {
  it('识别主流安全探测工具', () => {
    expect(getSecurityToolLabel('nmap -Pn -sV 10.0.0.5')).toBe('端口/服务扫描')
    expect(getSecurityToolLabel('nuclei -u http://10.0.0.5 -t cves/')).toBe('漏洞模板扫描')
    expect(getSecurityToolLabel('hydra -l admin -P pass.txt ssh://10.0.0.5')).toBe('口令/凭据爆破')
    expect(getSecurityToolLabel('ssh root@10.0.0.5')).toBe('远程连接')
  })

  it('普通命令不误标', () => {
    expect(getSecurityToolLabel('echo hello')).toBeNull()
    expect(getSecurityToolLabel('dir C:\\Users')).toBeNull()
    expect(getSecurityToolLabel('npm run build')).toBeNull()
  })
})

describe('run_command 安全探测工具审批通道（T5）', () => {
  const tool = new RunCommandTool()

  beforeEach(() => {
    spawnMock.mockReset()
  })

  it('nmap 走灰名单询问：risk medium + 授权提示 + 会话级授权一次通过', async () => {
    const ctx = makeCtx(true, 'session') // 用户同意（session 范围）
    mockSpawnAutoClose()

    const res = await tool.execute({ command: 'nmap -Pn -sV 10.0.0.5' }, ctx)
    expect(ctx.requestPermission).toHaveBeenCalledTimes(1)
    const req = ctx.requestPermission.mock.calls[0][0]
    expect(req.risk).toBe('medium')
    expect(req.description).toContain('端口/服务扫描')
    expect(req.description).toContain('请确认目标已授权')

    // 用户同意后真正执行（spawn 被调用）
    expect(res.ok).toBe(true)
    expect(spawnMock).toHaveBeenCalledTimes(1)

    // 会话级授权缓存：同命令第二次不再询问（直接执行，不申请新权限）
    mockSpawnAutoClose()
    const res2 = await tool.execute({ command: 'nmap -Pn -sV 10.0.0.5' }, ctx)
    expect(ctx.requestPermission).toHaveBeenCalledTimes(1) // 仍是 1 次
    expect(res2.ok).toBe(true)
  })

  it('nuclei 审批文本带「漏洞模板扫描」提示', async () => {
    const ctx = makeCtx(false)
    const res = await tool.execute({ command: 'nuclei -u http://10.0.0.5 -t cves/' }, ctx)
    expect(res.ok).toBe(false)
    expect(ctx.requestPermission).toHaveBeenCalledTimes(1)
    const req = ctx.requestPermission.mock.calls[0][0]
    expect(req.description).toContain('漏洞模板扫描')
    expect(req.description).toContain('请确认目标已授权')
  })

  it('用户拒绝 → 命令不执行，spawn 不被调用', async () => {
    const ctx = makeCtx(false)
    const res = await tool.execute({ command: 'hydra -l admin -P pass.txt ssh://10.0.0.5' }, ctx)
    expect(res.ok).toBe(false)
    expect(res.error ?? '').toContain('用户拒绝')
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('ssh 远程连接也要审批（不在白名单）', async () => {
    const ctx = makeCtx(false)
    const res = await tool.execute({ command: 'ssh root@10.0.0.5' }, ctx)
    expect(res.ok).toBe(false)
    expect(ctx.requestPermission).toHaveBeenCalledTimes(1)
  })

  it('自动化通道 + 裁决器 approve → 放行并授予会话授权', async () => {
    const resolveByPolicy = vi.fn(() => ({ status: 'approved' as const, reason: '' }))
    const ctx = {
      sessionId: 'auto-session',
      getSubAgentApproval: () => ({ resolveByPolicy })
    } as unknown as ToolContext
    mockSpawnAutoClose()

    const res = await tool.execute({ command: 'nmap -p 22 10.0.0.5' }, ctx)
    expect(res.ok).toBe(true)
    expect(resolveByPolicy).toHaveBeenCalledTimes(1)
    // 裁决器能看到安全工具分类，避免把 nmap 当普通 low 命令
    const args = resolveByPolicy.mock.calls[0][3] as { securityTool?: string }
    expect(args.securityTool).toBe('端口/服务扫描')

    // 会话授权已写入：同命令第二次不再走裁决
    mockSpawnAutoClose()
    await tool.execute({ command: 'nmap -p 22 10.0.0.5' }, ctx)
    expect(resolveByPolicy).toHaveBeenCalledTimes(1)
  })

  it('自动化通道 + 裁决器 deny → 拒绝并透出策略原因', async () => {
    const resolveByPolicy = vi.fn(() => ({ status: 'denied' as const, reason: 'policy: no_scan_without_scope' }))
    const ctx = {
      sessionId: 'auto-session-2',
      getSubAgentApproval: () => ({ resolveByPolicy })
    } as unknown as ToolContext

    const res = await tool.execute({ command: 'nmap -sU 10.0.0.5' }, ctx)
    expect(res.ok).toBe(false)
    expect(res.error ?? '').toContain('未获授权')
    expect(res.error ?? '').toContain('no_scan_without_scope')
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('自动化通道无裁决器 → fail-closed 拒绝，不静默放行', async () => {
    const ctx = { sessionId: 'auto-session-3' } as unknown as ToolContext
    const res = await tool.execute({ command: 'nuclei -u http://10.0.0.5 -t cves/' }, ctx)
    expect(res.ok).toBe(false)
    expect(res.error ?? '').toContain('requestPermission 未初始化')
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('安全工具 + high 危险模式（管道执行远程内容）→ 自动化通道仍拒绝，安全边界不放宽', async () => {
    const resolveByPolicy = vi.fn(() => ({ status: 'approved' as const, reason: '' }))
    const ctx = {
      sessionId: 'auto-session-4',
      getSubAgentApproval: () => ({ resolveByPolicy })
    } as unknown as ToolContext

    // 即使带 nmap 首词 + 裁决器 approve，链式拼接的 Remove-Item 裸动词是 high 危险模式 → 强制执行前拒绝
    const res = await tool.execute({ command: 'nmap -p 1-65535 10.0.0.5 ; Remove-Item -Recurse -Force C:Windows' }, ctx)
    expect(res.ok).toBe(false)
    expect(res.error ?? '').toContain('危险模式，自动化通道拒绝执行')
    expect(resolveByPolicy).not.toHaveBeenCalled()
    expect(spawnMock).not.toHaveBeenCalled()
  })
})