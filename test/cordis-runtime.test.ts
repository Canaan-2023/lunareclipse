import { describe, it, expect } from 'vitest'
import { join } from 'path'
import { tmpdir } from 'os'
import { rmSync } from 'fs'
import { createRootContext, mountFeatureServices, CoeffectService, CapabilityService, KernelService } from '../electron/main/kernel/cordis-runtime'
import { coeffectRegistry } from '../electron/main/kernel/coeffect'
import { createRegistrar, kernelRegistry } from '../electron/main/kernel'
import { LLMClient } from '../electron/main/api/llm'
import { browserManager } from '../electron/main/tools/browser-manager'
import { LilithAdapter } from '../electron/main/services/lilith-adapter'
import { SubAgentManager } from '../electron/main/sub-agent'
import { CronScheduler } from '../electron/main/cron/scheduler'
import type { LLMConfig } from '@shared/types'
import type { Plugin } from '../electron/main/vendor/cordis/index.ts'

/**
 * 月蚀 Cordis 运行时验证（阶段 2，2026-08-25）

 * createRootContext() 建立的 ctx 服务容器：
 * - ctx.coeffect / ctx.capability / ctx.kernel 三个基础服务可用
 * - 与既有 LXK 单例（coeffectRegistry）共用同一注册表（插件 + 老机制双向可见）
 * - 插件可 inject 这些服务（真实插件用法）
 */

/** 真 fiber 化启动链：同步建根 + 异步装配功能服务（与 index.ts whenReady 一致） */
async function bootCtx() {
  const ctx = createRootContext()
  await mountFeatureServices(ctx)
  return ctx
}

describe('月蚀 Cordis 运行时：root Context 与基础服务', () => {
  it('createRootContext 注册三个基础服务', () => {
    const ctx = createRootContext()
    expect(ctx.coeffect).toBeInstanceOf(CoeffectService)
    expect(ctx.capability).toBeInstanceOf(CapabilityService)
    expect(ctx.kernel).toBeInstanceOf(KernelService)
  })

  it('ctx.coeffect 与既有 coeffectRegistry 单例连通（双向可见）', () => {
    const ctx = createRootContext()
    const source = { kind: 'plugin' as const, pluginName: 'cordis-test' }
    // 经 Cordis 服务提供 → 老 registry 可读
    ctx.coeffect.provide('svc/demo', { v: 1 }, source)
    expect(coeffectRegistry.get('svc/demo')).toEqual({ v: 1 })
    // 经老 registry 提供 → Cordis 服务可读
    coeffectRegistry.provide('svc/old', { v: 2 }, { kind: 'builtin' as const, builtinName: 'test' })
    expect(ctx.coeffect.get('svc/old')).toEqual({ v: 2 })
    expect(ctx.coeffect.has('svc/demo')).toBe(true)
    expect(ctx.coeffect.listKeys()).toContain('svc/demo')
  })

  it('ctx.capability 默认放行 + 策略可读', () => {
    const ctx = createRootContext()
    const decision = ctx.capability.check('run_command', undefined, undefined)
    expect(decision.allowed).toBe(true)
    const policy = ctx.capability.readPolicy({ capabilityPolicy: { enabled: true, denyTools: ['run_command'] } })
    expect(policy.enabled).toBe(true)
    expect(policy.denyTools).toContain('run_command')
    const denied = ctx.capability.check('run_command', undefined, { capabilityPolicy: { enabled: true, denyTools: ['run_command'] } })
    expect(denied.allowed).toBe(false)
  })

  it('ctx.kernel.status 返回注册表快照结构', () => {
    const ctx = createRootContext()
    const status = ctx.kernel.status()
    expect(status.counts).toHaveProperty('tool')
    expect(status.counts).toHaveProperty('hook')
    expect(status.counts).toHaveProperty('prompt')
    expect(Array.isArray(status.tools)).toBe(true)
    expect(Array.isArray(status.hooks)).toBe(true)
  })

  it('插件可以 inject 基础服务（真实插件形态）', async () => {
    const ctx = createRootContext()
    let saw: unknown
    const plugin: Plugin = {
      name: 'cordis-basic-inject',
      inject: ['coeffect', 'kernel'],
      apply(c) {
        saw = c.coeffect // 注入触达即证明服务就绪
      }
    }
    const fiber = ctx.plugin(plugin)
    await fiber
    expect(saw).toBeInstanceOf(CoeffectService)
  })
})

describe('月蚀 Cordis 运行时：核心服务（阶段 3a）', () => {
  it('ctx.sessions.init 挂载 SessionStore（与旧引用同一实例）', () => {
    const ctx = createRootContext()
    const dir = join(tmpdir(), `cordis-sessions-${Date.now()}`)
    const store = ctx.sessions.init(dir)
    expect(store.getDir()).toBe(dir)
    // 幂等：二次 init 返回同一实例
    expect(ctx.sessions.init(dir)).toBe(store)
    // 未 init 就访问 store 应报错（防绕过启动链）
    const ctx2 = createRootContext()
    expect(() => ctx2.sessions.store).toThrow()
    rmSync(dir, { recursive: true, force: true })
  })

  it('ctx.llm.create 工厂返回 LLMClient 实例', () => {
    const ctx = createRootContext()
    const client = ctx.llm.create({
      provider: 'opencode-go',
      baseURL: 'http://127.0.0.1:1',
      apiKey: 'test-key',
      model: 'test-model'
    } as LLMConfig)
    expect(client).toBeInstanceOf(LLMClient)
  })

  it('插件可 inject 核心服务（ctx.sessions/ctx.llm）', async () => {
    const ctx = createRootContext()
    ctx.sessions.init(join(tmpdir(), `cordis-sessions-${Date.now()}`))
    let ready = false
    const plugin: Plugin = {
      name: 'cordis-core-inject',
      inject: ['sessions', 'llm', 'tools'],
      apply(c) {
        ready = !!(c.sessions && c.llm && c.tools)
      }
    }
    await ctx.plugin(plugin)
    expect(ready).toBe(true)
  })

  it('ctx.config/ctx.users 未 init 时抛错，init 后可用', () => {
    const ctx = createRootContext()
    expect(() => ctx.config.store).toThrow()
    expect(() => ctx.users.store).toThrow()
    const dir = join(tmpdir(), `cordis-cfg-${Date.now()}`)
    const cfgStore = ctx.config.init(join(dir, 'config.json'))
    expect(ctx.config.store).toBe(cfgStore)
    // users 延迟 init
    const userStore = ctx.users.init(join(dir, 'users.json'))
    expect(ctx.users.store).toBe(userStore)
    rmSync(dir, { recursive: true, force: true })
  })

  it('ctx.systemPrompt 未注册实现时报错，注册后委托', async () => {
    const ctx = createRootContext()
    await expect(ctx.systemPrompt.assemble([])).rejects.toThrow('未注册')
    ctx.systemPrompt.registerAssembler(async (messages) => [...messages, { id: 'x', role: 'system', content: 'ok', createdAt: 1 }])
    const out = await ctx.systemPrompt.assemble([], null, 's1')
    expect(out).toHaveLength(1)
    expect(out[0].content).toBe('ok')
  })

  it('ctx.governance.installAll 安装四件套（挂载即生效，返回 void）', async () => {
    const ctx = await bootCtx()
    const { reg, handles } = createRegistrar(kernelRegistry, { kind: 'builtin' })
    const before = kernelRegistry.getHandles('hook').length
    ctx.governance.installAll(reg)
    // 安装后 hook 注册表新增治理条目（挂载即生效）
    const after = kernelRegistry.getHandles('hook').length
    expect(after).toBeGreaterThan(before)
    expect(handles.length).toBeGreaterThanOrEqual(4)
  })

  it('ctx.skills 未 init 时抛错，init 后返回 SkillLoader 实例', async () => {
    const ctx = await bootCtx()
    expect(() => ctx.skills.loader).toThrow()
    const loader = ctx.skills.init(() => null, join(tmpdir(), `skills-${Date.now()}.json`))
    expect(ctx.skills.loader).toBe(loader)
  })

  it('ctx.mcp 未 init 时抛错，init 后返回 McpClientManager 实例', async () => {
    const ctx = await bootCtx()
    expect(() => ctx.mcp.manager).toThrow()
    const manager = ctx.mcp.init()
    expect(ctx.mcp.manager).toBe(manager)
    // 幂等：二次 init 返回同一实例
    expect(ctx.mcp.init()).toBe(manager)
  })

  it('ctx.browser 暴露浏览器管理器单例', async () => {
    const ctx = await bootCtx()
    expect(ctx.browser.manager).toBeDefined()
    expect(ctx.browser.manager).toBe(browserManager)
  })

  it('ctx.lilith.create 返回 LilithAdapter 实例（工厂，不启动）', async () => {
    const ctx = await bootCtx()
    const adapter = ctx.lilith.create({ port: 6186, dataRoot: tmpdir(), appDataDir: tmpdir() } as never)
    expect(adapter).toBeInstanceOf(LilithAdapter)
  })

  it('ctx.cron.create 返回 CronScheduler 实例（工厂，不启动）', async () => {
    const ctx = await bootCtx()
    const scheduler = ctx.cron.create(join(tmpdir(), `cron-${Date.now()}`), {} as never, {} as never)
    expect(scheduler).toBeInstanceOf(CronScheduler)
  })

  it('ctx.subagent.create 返回 SubAgentManager 实例（泛型工厂）', async () => {
    const ctx = await bootCtx()
    const manager = ctx.subagent.create(
      async () => ({ output: '', timedOut: false, turns: 0 }),
      [],
      {}
    )
    expect(manager).toBeInstanceOf(SubAgentManager)
  })

  it('ctx.workflow 未 init 时抛错（防绕过启动链）', async () => {
    const ctx = await bootCtx()
    expect(() => ctx.workflow.manager).toThrow()
  })

  it('ctx.monitor 未 init 时三个组件均抛错（防绕过启动链）', async () => {
    const ctx = await bootCtx()
    expect(() => ctx.monitor.supervisor).toThrow()
    expect(() => ctx.monitor.pathSync).toThrow()
    expect(() => ctx.monitor.healthCheck).toThrow()
  })

  it('ctx.memory 未 init 时 dataPaths 返回 null（保护），init 后返回传入的 paths', async () => {
    const ctx = await bootCtx()
    expect(ctx.memory.dataPaths).toBeNull()
    const fakePaths = { root: '/tmp/test-mem', high: '/tmp/test-mem/high', meta: '/tmp/test-mem/meta' } as never
    ctx.memory.init(fakePaths)
    expect(ctx.memory.dataPaths).toBe(fakePaths)
  })

  it('createRootContext 同步期功能服务不可读（真 fiber 化：异步装配前 undefined）', () => {
    const ctx = createRootContext()
    expect(ctx.get('memory')).toBeUndefined()
    expect(ctx.get('cron')).toBeUndefined()
    expect(ctx.get('skills')).toBeUndefined()
    // 基础/核心服务立即可用（同步阶段契约不变）
    expect(ctx.coeffect).toBeInstanceOf(CoeffectService)
    expect(ctx.featurePlugins).toBeDefined()
  })

  it('卸载功能服务后 ctx.get 返回 undefined（fiber 卸载自动撤销服务键）', async () => {
    const ctx = await bootCtx()
    expect(ctx.get('memory')).toBeTruthy()
    await ctx.featurePlugins.setEnabled('memory', false)
    await ctx.featurePlugins.unmount('memory')
    expect(ctx.get('memory')).toBeUndefined()
  })

  it('功能服务开关真实装卸：关闭后服务不可读，重开恢复', async () => {
    const ctx = await bootCtx()
    expect(ctx.get('cron')).toBeTruthy()
    await ctx.featurePlugins.setEnabled('cron', false)
    expect(ctx.get('cron')).toBeUndefined()
    await ctx.featurePlugins.setEnabled('cron', true)
    expect(ctx.get('cron')).toBeTruthy()
  })
})