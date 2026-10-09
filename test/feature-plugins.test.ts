import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { createRootContext } from '../electron/main/kernel/cordis-runtime'
import { FEATURE_PLUGINS, FeaturePluginsService } from '../electron/main/kernel/feature-plugins'
import { setPathContext } from '../electron/main/models/path-context'

/**
 * 内核功能插件对象表测试（阶段 4 + P1-A G3 真 fiber 化）：
 * - createRootContext 注册 ctx.featurePlugins 服务
 * - 声明表含 10 项（memory/workflow/monitor/lilith/browser/subagent/mcp/skills/cron/governance）
 * - 默认全启用（行为零变化基线）
 * - setEnabled 持久化到 {dataRoot}/.feature-plugins.json，重建服务后状态保留
 * - setEnabled/mount/unmount 为异步真 fiber 装卸：挂载后服务可读、卸载后服务键撤销
 * - mountAll 先重读状态文件（dataRoot 就绪后调用）：关闭项不挂载
 * - 非法 id 拒绝、onChanged 广播、list 可 JSON 序列化（mounter 函数不进 IPC）
 */
const TEST_ROOT = join(process.cwd(), 'tmp', 'feature-plugins-test-root')

beforeEach(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true })
  mkdirSync(TEST_ROOT, { recursive: true })
  setPathContext(TEST_ROOT, () => null)
})

afterAll(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true })
})

describe('内核功能插件对象表（阶段 4）', () => {
  it('声明表覆盖 10 个功能模块且服务键齐全', () => {
    const ids = FEATURE_PLUGINS.map((m) => m.id)
    expect(ids).toEqual(
      expect.arrayContaining([
        'memory', 'workflow', 'monitor', 'lilith', 'browser',
        'subagent', 'mcp', 'skills', 'cron', 'governance'
      ])
    )
    expect(FEATURE_PLUGINS.length).toBe(10)
    for (const m of FEATURE_PLUGINS) {
      expect(m.name.length).toBeGreaterThan(0)
      expect(m.description.length).toBeGreaterThan(0)
      expect(m.version.length).toBeGreaterThan(0)
      expect(m.serviceKey.length).toBeGreaterThan(0)
      expect(typeof m.mounter).toBe('function')
    }
  })

  it('createRootContext 注册 ctx.featurePlugins 服务', () => {
    const ctx = createRootContext()
    expect(ctx.featurePlugins).toBeInstanceOf(FeaturePluginsService)
  })

  it('createRootContext 同步期功能服务未挂载（真 fiber 化：异步装配前不可读）', () => {
    const ctx = createRootContext()
    // 同步阶段只注册基础/核心 + featurePlugins；功能服务待 mountFeatureServices 挂载
    expect(ctx.get('memory')).toBeUndefined()
    expect(ctx.get('cron')).toBeUndefined()
    expect(ctx.featurePlugins).toBeInstanceOf(FeaturePluginsService)
  })

  it('默认全启用（行为零变化基线）', () => {
    const ctx = createRootContext()
    const list = ctx.featurePlugins.list()
    expect(list.length).toBe(10)
    for (const p of list) expect(p.enabled).toBe(true)
    expect(ctx.featurePlugins.isEnabled('memory')).toBe(true)
  })

  it('setEnabled(false) 后 list/isEnabled 反映关闭且持久化到状态文件', async () => {
    const ctx = createRootContext()
    const res = await ctx.featurePlugins.setEnabled('memory', false)
    expect(res.ok).toBe(true)
    expect(ctx.featurePlugins.isEnabled('memory')).toBe(false)
    expect(ctx.featurePlugins.list().find((p) => p.id === 'memory')?.enabled).toBe(false)

    const statePath = join(TEST_ROOT, '.feature-plugins.json')
    const raw = JSON.parse(readFileSync(statePath, 'utf-8')) as Record<string, unknown>
    expect(raw.memory).toBe(false)
    expect(raw.governance).toBeUndefined() // 未动的项不写冗余 false（缺省按启用）
  })

  it('重建服务后状态保留（读状态文件）', async () => {
    const ctx = createRootContext()
    await ctx.featurePlugins.setEnabled('cron', false)
    await ctx.featurePlugins.setEnabled('mcp', false)

    const ctx2 = createRootContext()
    expect(ctx2.featurePlugins.isEnabled('cron')).toBe(false)
    expect(ctx2.featurePlugins.isEnabled('mcp')).toBe(false)
    expect(ctx2.featurePlugins.isEnabled('skills')).toBe(true)
  })

  it('setEnabled 对未登记 id 拒绝', async () => {
    const ctx = createRootContext()
    const res = await ctx.featurePlugins.setEnabled('not-exist', false)
    expect(res.ok).toBe(false)
    expect(res.error).toContain('不存在')
    expect(ctx.featurePlugins.isEnabled('not-exist')).toBe(false)
  })

  it('onChanged 广播状态变更，退订后不再收到', async () => {
    const ctx = createRootContext()
    const seen: Array<{ id: string; enabled: boolean }> = []
    const unsub = ctx.featurePlugins.onChanged(() => {
      seen.push({ id: 'workflow', enabled: ctx.featurePlugins.isEnabled('workflow') })
    })
    await ctx.featurePlugins.setEnabled('workflow', false)
    expect(seen.length).toBe(1)
    expect(seen[0].enabled).toBe(false)
    // 幂等开关不广播
    await ctx.featurePlugins.setEnabled('workflow', false)
    expect(seen.length).toBe(1)
    unsub()
    await ctx.featurePlugins.setEnabled('workflow', true)
    expect(seen.length).toBe(1)
  })

  it('setEnabled 相同状态幂等返回 ok 且不写冗余', async () => {
    const ctx = createRootContext()
    const res = await ctx.featurePlugins.setEnabled('lilith', true)
    expect(res.ok).toBe(true)
    const statePath = join(TEST_ROOT, '.feature-plugins.json')
    // 未发生变更 → 不产生状态文件
    expect(existsSync(statePath)).toBe(false)
  })

  it('setEnabled(true) 挂载服务 fiber：ctx.get 可读到实现；setEnabled(false) 卸载后撤销', async () => {
    const ctx = createRootContext()
    // 初始未挂载
    expect(ctx.get('memory')).toBeUndefined()
    expect(ctx.featurePlugins.isMounted('memory')).toBe(false)

    // 开启 → 挂载（幂等：重复开启不重复装卸）
    const on = await ctx.featurePlugins.setEnabled('memory', true)
    expect(on.ok).toBe(true)
    expect(on.mounted).toBe(true)
    expect(ctx.featurePlugins.isMounted('memory')).toBe(true)
    expect(ctx.get('memory')).toBeTruthy()
    const again = await ctx.featurePlugins.setEnabled('memory', true)
    expect(again.ok).toBe(true)
    expect(ctx.featurePlugins.isMounted('memory')).toBe(true)

    // 关闭 → 卸载：服务键撤销
    const off = await ctx.featurePlugins.setEnabled('memory', false)
    expect(off.ok).toBe(true)
    expect(off.mounted).toBe(false)
    expect(ctx.featurePlugins.isMounted('memory')).toBe(false)
    expect(ctx.get('memory')).toBeUndefined()
  })

  it('mountAll 先重读状态文件：关闭项不挂载、开启项挂载', async () => {
    // 先在同步构造后关闭 memory（状态落盘）；再模拟 dataRoot 就绪后的启动链 mountAll
    const ctx = createRootContext()
    await ctx.featurePlugins.setEnabled('memory', false)
    expect(ctx.get('memory')).toBeUndefined()

    const results = await ctx.featurePlugins.mountAll()
    expect(results.length).toBe(10)
    const memoryResult = results.find((r) => r.id === 'memory')
    expect(memoryResult?.ok).toBe(true)
    expect(memoryResult?.mounted).toBe(false) // 关闭项不挂载
    expect(ctx.featurePlugins.isMounted('memory')).toBe(false)
    expect(ctx.get('memory')).toBeUndefined()
    // 开启项（默认启用）全部挂载
    expect(ctx.featurePlugins.isMounted('cron')).toBe(true)
    expect(ctx.featurePlugins.isMounted('skills')).toBe(true)
    expect(ctx.get('cron')).toBeTruthy()
    expect(ctx.get('skills')).toBeTruthy()
  })

  it('mountAll 幂等：重复调用不重复挂载', async () => {
    const ctx = createRootContext()
    const r1 = await ctx.featurePlugins.mountAll()
    const r2 = await ctx.featurePlugins.mountAll()
    expect(r1.every((r) => r.ok)).toBe(true)
    expect(r2.every((r) => r.ok)).toBe(true)
    // 重新 mount 幂等：返回既有 fiber，不再重复装
    const remount = await ctx.featurePlugins.mount('cron')
    expect(remount.ok).toBe(true)
    expect(ctx.featurePlugins.isMounted('cron')).toBe(true)
  })

  it('mount 对未登记 id 返回 error（fail-fast，不中断其余）', async () => {
    const ctx = createRootContext()
    const res = await ctx.featurePlugins.mount('not-exist' as never)
    expect(res.ok).toBe(false)
    expect(res.error).toContain('不存在')
    const unmountRes = await ctx.featurePlugins.unmount('not-exist' as never)
    expect(unmountRes.ok).toBe(true) // 未挂载幂等 ok
  })
})

describe('状态文件健壮性（NIT 修复）', () => {
  it('脏键/未知 id/非 boolean 被白名单过滤', () => {
    const statePath = join(TEST_ROOT, '.feature-plugins.json')
    writeFileSync(
      statePath,
      JSON.stringify({
        memory: false,
        'not-a-plugin': true,
        skills: 'yes',
        cron: 1,
        governance: false
      }),
      'utf-8'
    )
    const ctx = createRootContext()
    expect(ctx.featurePlugins.isEnabled('memory')).toBe(false)
    expect(ctx.featurePlugins.isEnabled('governance')).toBe(false)
    // 脏键/错类型不进入状态：按默认启用处理
    expect(ctx.featurePlugins.isEnabled('not-a-plugin')).toBe(false)
    expect(ctx.featurePlugins.isEnabled('skills')).toBe(true)
    expect(ctx.featurePlugins.isEnabled('cron')).toBe(true)
  })

  it('list() 可 JSON 序列化（mounter 函数不进 IPC）', async () => {
    const ctx = createRootContext()
    await ctx.featurePlugins.mountAll()
    const list = ctx.featurePlugins.list()
    // 不抛 DataCloneError / JSON.stringify 不带函数
    const text = JSON.stringify(list)
    expect(text).toContain('"id":"memory"')
    expect(text).toContain('"serviceKey":"governance"')
    expect(text).toContain('"mounted"')
    // mounter 是函数时 JSON.stringify 会直接丢弃函数字段（不抛错），但显式字段必须齐全
    for (const p of list) {
      expect(Object.keys(p).sort()).toEqual(
        ['description', 'enabled', 'id', 'mounted', 'name', 'serviceKey', 'version'].sort()
      )
    }
  })
})