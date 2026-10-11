import { describe, it, expect, beforeEach } from 'vitest'
import { join } from 'path'
import { CronManageTool } from '../electron/main/tools/cron-manage'
import { HookListTool } from '../electron/main/tools/hook-list'
import { WebExtractTool } from '../electron/main/tools/web-extract'
import { CronScheduler } from '../electron/main/cron/scheduler'
import { HookManager } from '../electron/main/hooks/hook-manager'
import { kernelRegistry, createRegistrar } from '../electron/main/kernel'
import { TOOL_MAP, isToolForAgent } from '../shared/tools/registry'

const TEST_ROOT = join(process.cwd(), 'tmp', 'tool-gaps-test-root')

beforeEach(() => {
  kernelRegistry.disposeBySource({ kind: 'builtin' })
  kernelRegistry.disposeBySource({ kind: 'plugin', pluginName: 'gp-hook' })
})

describe('cron_manage 工具', () => {
  function makeScheduler(): CronScheduler {
    return new CronScheduler(
      TEST_ROOT,
      { pushExternalEvent: () => {} } as never,
      { setInterval: () => 0, clearInterval: () => {} } as never
    )
  }

  it('upsert 合法 schedule → list 可见 → toggle → delete', async () => {
    const scheduler = makeScheduler()
    const tool = new CronManageTool()
    const ctx = { getCronScheduler: () => scheduler } as never

    const up = await tool.execute({ action: 'upsert', id: 'test-review', schedule: 'every 6h', prompt: '复盘' }, ctx)
    expect(up.ok).toBe(true)

    const list = await tool.execute({ action: 'list' }, ctx) as { ok: boolean; data: { jobs: Array<{ id: string; schedule: string; enabled: boolean }> } }
    expect(list.ok).toBe(true)
    expect(list.data.jobs.some((j) => j.id === 'test-review' && j.schedule === 'every 6h' && j.enabled)).toBe(true)

    const tg = await tool.execute({ action: 'toggle', id: 'test-review', enabled: false }, ctx)
    expect(tg.ok).toBe(true)
    const list2 = await tool.execute({ action: 'list' }, ctx) as { ok: boolean; data: { jobs: Array<{ id: string; enabled: boolean }> } }
    expect(list2.data.jobs.find((j) => j.id === 'test-review')!.enabled).toBe(false)

    const del = await tool.execute({ action: 'delete', id: 'test-review' }, ctx)
    expect(del.ok).toBe(true)
    const list3 = await tool.execute({ action: 'list' }, ctx) as { ok: boolean; data: { jobs: Array<{ id: string }> } }
    expect(list3.data.jobs.some((j) => j.id === 'test-review')).toBe(false)
  })

  it('间隔型 every 6h / cron 5 段 / ISO 一次性都合法，非法表达式被拒', async () => {
    const scheduler = makeScheduler()
    const tool = new CronManageTool()
    const ctx = { getCronScheduler: () => scheduler } as never
    expect((await tool.execute({ action: 'upsert', id: 'a', schedule: 'every 6h', prompt: 'x' }, ctx)).ok).toBe(true)
    expect((await tool.execute({ action: 'upsert', id: 'b', schedule: '0 9 * * 1-5', prompt: 'x' }, ctx)).ok).toBe(true)
    expect((await tool.execute({ action: 'upsert', id: 'c', schedule: '2026-12-31T23:59:00+08:00', prompt: 'x' }, ctx)).ok).toBe(true)
    // 非法：不是间隔/cron/ISO
    expect((await tool.execute({ action: 'upsert', id: 'd', schedule: '每天 早上 六点', prompt: 'x' }, ctx)).ok).toBe(false)
    expect((await tool.execute({ action: 'upsert', id: 'e', schedule: '0 9 * *', prompt: 'x' }, ctx)).ok).toBe(false)
  })

  it('参数校验：缺 id/schedule/prompt/未知 action', async () => {
    const scheduler = makeScheduler()
    const tool = new CronManageTool()
    const ctx = { getCronScheduler: () => scheduler } as never
    expect((await tool.execute({ action: 'upsert', schedule: '0 0 * * *', prompt: 'x' }, ctx)).ok).toBe(false)
    expect((await tool.execute({ action: 'upsert', id: 'x', prompt: 'x' }, ctx)).ok).toBe(false)
    expect((await tool.execute({ action: 'upsert', id: 'x', schedule: '0 0 * * *' }, ctx)).ok).toBe(false)
    expect((await tool.execute({ action: 'nope' }, ctx)).ok).toBe(false)
  })

  it('无调度器报错', async () => {
    const tool = new CronManageTool()
    expect((await tool.execute({ action: 'list' }, undefined)).ok).toBe(false)
  })
})

describe('hook_list 工具（三源合并）', () => {
  it('config + kernel + plugin 三源都列出', async () => {
    // kernel + plugin hook
    const { reg } = createRegistrar(kernelRegistry, { kind: 'builtin' })
    reg.registerHook('PreToolUse', async () => ({ action: 'continue' }), { matcher: '.*' })
    kernelRegistry.register('hook', { kind: 'plugin', pluginName: 'gp-hook' }, {
      event: 'PreLLMCall', matcher: '.*', fn: async () => ({ action: 'continue' })
    })
    // config hook
    const hm = new HookManager()
    hm.loadHooks([{
      event: 'PreToolUse',
      matcher: 'Write',
      handler: { type: 'javascript', handler: 'return { action: "continue" }' }
    }])

    const tool = new HookListTool()
    const res = await tool.execute({}, { hookManager: hm } as never) as {
      ok: boolean
      data: { total: number; hooks: Array<{ event: string; source: string }> }
    }
    expect(res.ok).toBe(true)
    const sources = res.data.hooks.map((h) => h.source)
    expect(sources).toContain('config')
    expect(sources).toContain('kernel')
    expect(sources).toContain('plugin:gp-hook')
    // 至少 4 个：config 1 + kernel 4 治理(若装)…实际 kernel 只有刚注册的 1 个 + plugin 1 + config 1
    expect(res.data.total).toBeGreaterThanOrEqual(3)
  })
})

describe('web_extract 工具', () => {
  it('参数校验：缺 url / 非 http', async () => {
    const tool = new WebExtractTool()
    expect((await tool.execute({}, undefined)).ok).toBe(false)
    expect((await tool.execute({ url: 'file:///etc/passwd' }, undefined)).ok).toBe(false)
    expect((await tool.execute({ url: 'ftp://x.com' }, undefined)).ok).toBe(false)
  })

  it('SSRF 拦截内网地址', async () => {
    const tool = new WebExtractTool()
    const r = await tool.execute({ url: 'http://127.0.0.1:8080/secret' }, undefined)
    expect(r.ok).toBe(false)
    expect(r.error).toContain('SSRF')
    const r2 = await tool.execute({ url: 'http://192.168.1.1/admin' }, undefined)
    expect(r2.ok).toBe(false)
    expect(r2.error).toContain('SSRF')
  })
})

describe('新工具元数据（防漏注册回归）', () => {
  it('TOOL_MAP 有元数据且对 frontend 可见', () => {
    for (const id of ['cron_manage', 'hook_list', 'web_extract']) {
      const meta = TOOL_MAP[id]
      expect(meta).toBeDefined()
      expect(meta!.agents).toContain('frontend')
      expect(isToolForAgent(id, 'frontend')).toBe(true)
    }
  })
})
