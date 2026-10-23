import { describe, it, expect, beforeEach } from 'vitest'
import { HookManager } from '../electron/main/hooks/hook-manager'
import { installIdleSuppression, installFactCheckReminder, installClosingReflection, installFailureCircuitBreaker } from '../electron/main/kernel/governance'
import { createRegistrar, kernelRegistry } from '../electron/main/kernel'

function setup(which: Array<'idle' | 'fact' | 'closing' | 'breaker'> = ['idle', 'fact', 'closing', 'breaker']): HookManager {
  kernelRegistry.disposeBySource({ kind: 'builtin' })
  const { reg } = createRegistrar(kernelRegistry, { kind: 'builtin' })
  if (which.includes('idle')) installIdleSuppression(reg)
  if (which.includes('fact')) installFactCheckReminder(reg)
  if (which.includes('closing')) installClosingReflection(reg)
  if (which.includes('breaker')) installFailureCircuitBreaker(reg)
  const hm = new HookManager()
  hm.loadHooks([])
  return hm
}

async function preLlm(hm: HookManager, opts: { userPrompt?: string; idleRounds?: number; recentFailures?: number; governance?: unknown }) {
  return hm.run('PreLLMCall', {
    event: 'PreLLMCall',
    userPrompt: opts.userPrompt ?? '',
    idleRounds: opts.idleRounds ?? 0,
    recentFailures: opts.recentFailures ?? 0,
    governance: opts.governance,
    cwd: process.cwd()
  } as never)
}

beforeEach(() => {
  kernelRegistry.disposeBySource({ kind: 'builtin' })
})

describe('机制 A：空转抑制', () => {
  it('连续空转 ≥2 轮注入终止指令', async () => {
    const hm = setup()
    const r = await preLlm(hm, { idleRounds: 2 })
    expect(r.injectedContext).toContain('TASK_COMPLETE')
    expect(r.injectedContext).toContain('空转')
  })

  it('空转 <2 轮不注入', async () => {
    const hm = setup()
    const r = await preLlm(hm, { idleRounds: 1 })
    expect(r.injectedContext).toBeUndefined()
    const r0 = await preLlm(hm, { idleRounds: 0 })
    expect(r0.injectedContext).toBeUndefined()
  })

  it('governance.idleSuppression=false 时关闭', async () => {
    const hm = setup()
    const r = await preLlm(hm, { idleRounds: 5, governance: { idleSuppression: false } })
    expect(r.injectedContext).toBeUndefined()
  })
})

describe('机制 B：查证提醒', () => {
  it('疑问句（是什么）注入查证提醒', async () => {
    const hm = setup()
    const r = await preLlm(hm, { userPrompt: '记忆工作流是什么？' })
    expect(r.injectedContext).toContain('查证')
    expect(r.injectedContext).toContain('read_md')
  })

  it('疑问句（为什么/怎么）也触发', async () => {
    const hm = setup()
    const r = await preLlm(hm, { userPrompt: '为什么这个会这样？' })
    expect(r.injectedContext).toContain('查证')
    const r2 = await preLlm(hm, { userPrompt: '这个怎么做的？' })
    expect(r2.injectedContext).toContain('查证')
  })

  it('非疑问句不注入', async () => {
    const hm = setup()
    const r = await preLlm(hm, { userPrompt: '帮我写个文件' })
    expect(r.injectedContext).toBeUndefined()
  })

  it('系统激活消息不触发', async () => {
    const hm = setup()
    const r = await preLlm(hm, { userPrompt: '【系统注入：本条为系统激活消息】…TASK_COMPLETE…' })
    expect(r.injectedContext).toBeUndefined()
  })

  it('governance.factCheckReminder=false 时关闭', async () => {
    const hm = setup()
    const r = await preLlm(hm, { userPrompt: '这是什么？', governance: { factCheckReminder: false } })
    expect(r.injectedContext).toBeUndefined()
  })
})

describe('机制 C：收尾反思', () => {
  it('含 [TASK_COMPLETE] 注入反思段（含自主改进授权）', async () => {
    const hm = setup()
    const r = await preLlm(hm, { userPrompt: '【激活】全部完成则输出 [TASK_COMPLETE]' })
    expect(r.injectedContext).toContain('复盘')
    expect(r.injectedContext).toContain('TASK_COMPLETE')
    expect(r.injectedContext).toContain('授权')
  })

  it('不含 TASK_COMPLETE 不注入', async () => {
    const hm = setup(['closing'])
    const r = await preLlm(hm, { userPrompt: '今天天气怎么样' })
    expect(r.injectedContext).toBeUndefined()
  })

  it('governance.closingReflection=false 时关闭', async () => {
    const hm = setup()
    const r = await preLlm(hm, { userPrompt: '输出 [TASK_COMPLETE]', governance: { closingReflection: false } })
    expect(r.injectedContext).toBeUndefined()
  })
})

describe('机制 D：失败循环止损', () => {
  it('连续失败 ≥3 轮注入止损指令', async () => {
    const hm = setup(['breaker'])
    const r = await preLlm(hm, { recentFailures: 3 })
    expect(r.injectedContext).toContain('撞墙')
    expect(r.injectedContext).toContain('重试最多 1 次')
    expect(r.injectedContext).toContain('如实报告')
  })

  it('失败 <3 轮不注入', async () => {
    const hm = setup(['breaker'])
    expect((await preLlm(hm, { recentFailures: 2 })).injectedContext).toBeUndefined()
    expect((await preLlm(hm, { recentFailures: 0 })).injectedContext).toBeUndefined()
  })

  it('governance.failureCircuitBreaker=false 时关闭', async () => {
    const hm = setup(['breaker'])
    const r = await preLlm(hm, { recentFailures: 5, governance: { failureCircuitBreaker: false } })
    expect(r.injectedContext).toBeUndefined()
  })
})

describe('三机制互不干扰', () => {
  it('同一轮可同时触发空转抑制 + 收尾反思（注入拼接）', async () => {
    const hm = setup()
    const r = await preLlm(hm, { userPrompt: '【激活】输出 [TASK_COMPLETE]', idleRounds: 3 })
    expect(r.injectedContext).toContain('TASK_COMPLETE')
    expect(r.injectedContext).toContain('复盘')
  })
})
