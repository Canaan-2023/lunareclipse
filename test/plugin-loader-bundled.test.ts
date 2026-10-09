import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { PluginLoader } from '../electron/main/plugins/loader'
import { setPathContext } from '../electron/main/models/path-context'
import { clearDynamicToolMetas } from '../shared/tools/registry'

/**
 * 内置（bundled）插件层测试：
 * - bundled 目录（源码 electron/main/plugins/bundled / 打包 resources/plugins/bundled）
 *   作为第三层纳入 PluginLoader，优先级最低
 * - 同名覆盖：domain > user > bundled
 * - bundled 只读：不可删除、可禁用
 */
const TEST_ROOT = join(process.cwd(), 'tmp', 'plugin-bundled-test-root')
const USER_PLUGINS = join(TEST_ROOT, 'plugins')
const DOMAIN_PLUGINS = join(TEST_ROOT, 'plugins_domains')
const BUNDLED_PLUGINS = join(TEST_ROOT, 'bundled')

function makeTuple(dir: string, name: string, tool: string, data: string): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'plugin.json'),
    JSON.stringify({ name, description: data, version: '0.1.0' }),
    'utf-8'
  )
  writeFileSync(
    join(dir, 'tools.js'),
    `export default [{ name: '${tool}', description: '${data}', parameters: [], async execute() { return { ok: true, data: '${data}' } } }]`,
    'utf-8'
  )
}

beforeEach(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true })
  mkdirSync(USER_PLUGINS, { recursive: true })
  setPathContext(TEST_ROOT, () => null)
})

afterAll(() => {
  clearDynamicToolMetas()
  rmSync(TEST_ROOT, { recursive: true, force: true })
})

describe('插件系统：bundled 内置层', () => {
  it('bundled-only 插件正常加载，source=bundled，工具可用', async () => {
    makeTuple(join(BUNDLED_PLUGINS, 'alpha'), 'alpha', 'alpha_tool', 'bundled-alpha')
    const loader = new PluginLoader(() => null, () => BUNDLED_PLUGINS)
    await loader.reload()
    const p = loader.list().find((x) => x.dirName === 'alpha')
    expect(p).toBeDefined()
    expect(p!.source).toBe('bundled')
    expect(p!.errors).toEqual([])
    expect(p!.tools.length).toBe(1)
    const res = await p!.tools[0].execute({}, undefined)
    expect(res.ok).toBe(true)
    expect(res.data).toBe('bundled-alpha')
    loader.destroy()
  })

  it('同名覆盖：user 覆盖 bundled，domain 覆盖 user', async () => {
    // bundled 版 coding
    makeTuple(join(BUNDLED_PLUGINS, 'coding'), 'coding', 'coding_tool', 'bundled-coding')
    // user 版 coding（覆盖 bundled）
    makeTuple(join(USER_PLUGINS, 'coding'), 'coding', 'coding_tool', 'user-coding')
    // 只存在于 user 的 shadow-only-user
    makeTuple(join(USER_PLUGINS, 'shadow-user'), 'shadow-user', 'shadow_tool', 'user-shadow')

    const loader = new PluginLoader(() => null, () => BUNDLED_PLUGINS)
    await loader.reload()
    const list = loader.list()
    // coding 同名：user 版胜出（dirPath 指向 user 目录），bundled 版被覆盖
    const coding = list.find((x) => x.dirName === 'coding')
    expect(coding).toBeDefined()
    expect(coding!.source).toBe('user')
    expect(coding!.dirPath).toBe(join(USER_PLUGINS, 'coding'))
    expect(coding!.manifest.description).toBe('user-coding')
    const res = await coding!.tools[0].execute({}, undefined)
    expect(res.data).toBe('user-coding')
    // bundled-only 插件仍加载
    const shadow = list.find((x) => x.dirName === 'shadow-user')
    expect(shadow).toBeDefined()
    expect(shadow!.source).toBe('user')
    loader.destroy()
  })

  it('同名覆盖三层：domain 具有最终优先级', async () => {
    makeTuple(join(BUNDLED_PLUGINS, 'dup'), 'dup', 'dup_tool', 'bundled-dup')
    makeTuple(join(USER_PLUGINS, 'dup'), 'dup', 'dup_tool', 'user-dup')
    mkdirSync(join(DOMAIN_PLUGINS, 'dup'), { recursive: true })
    writeFileSync(
      join(DOMAIN_PLUGINS, 'dup', 'plugin.json'),
      JSON.stringify({ name: 'dup', description: 'domain-dup', version: '0.1.0' }),
      'utf-8'
    )

    const loader = new PluginLoader(() => DOMAIN_PLUGINS, () => BUNDLED_PLUGINS)
    await loader.reload()
    const dup = loader.list().find((x) => x.dirName === 'dup')
    expect(dup).toBeDefined()
    expect(dup!.source).toBe('domain')
    expect(dup!.manifest.description).toBe('domain-dup')
    loader.destroy()
  })

  it('bundled 插件不可删除（返回错误，目录保留）', async () => {
    makeTuple(join(BUNDLED_PLUGINS, 'locked'), 'locked', 'locked_tool', 'bundled-locked')
    const loader = new PluginLoader(() => null, () => BUNDLED_PLUGINS)
    await loader.reload()
    const r = await loader.deletePlugin('locked')
    expect(r.ok).toBe(false)
    expect(r.error).toContain('不可删除')
    // 目录未被 rm，插件仍留在列表
    expect(loader.list().some((x) => x.dirName === 'locked')).toBe(true)
    loader.destroy()
  })

  it('bundled 插件可禁用/启用（bundled-only 独立状态）', async () => {
    makeTuple(join(BUNDLED_PLUGINS, 'tog'), 'tog', 'tog_tool', 'bundled-tog')
    const loader = new PluginLoader(() => null, () => BUNDLED_PLUGINS)
    await loader.reload()
    const p = loader.list().find((x) => x.dirName === 'tog')
    expect(p).toBeDefined()
    expect(p!.source).toBe('bundled')
    expect(p!.enabled).toBe(true)
    // 禁用 → reload 后不再加载（工具为空）
    await loader.setEnabled('tog', false)
    await loader.reload()
    const after = loader.list().find((x) => x.dirName === 'tog')
    expect(after).toBeDefined()
    expect(after!.enabled).toBe(false)
    expect(after!.tools.length).toBe(0)
    // 启用 → 恢复
    await loader.setEnabled('tog', true)
    await loader.reload()
    const on = loader.list().find((x) => x.dirName === 'tog')
    expect(on).toBeDefined()
    expect(on!.enabled).toBe(true)
    expect(on!.tools.length).toBe(1)
    loader.destroy()
  })

  it('user 同名禁用不遮蔽 bundled 独立状态（状态 key 按 source 隔离）', async () => {
    makeTuple(join(BUNDLED_PLUGINS, 'sep'), 'sep', 'sep_tool', 'bundled-sep')
    makeTuple(join(USER_PLUGINS, 'sep'), 'sep', 'sep_tool', 'user-sep')
    const loader = new PluginLoader(() => null, () => BUNDLED_PLUGINS)
    await loader.reload()
    // 当前生效的是 user 版（覆盖 bundled）
    const p = loader.list().find((x) => x.dirName === 'sep')
    expect(p!.source).toBe('user')
    // 禁用 user 版：名字由 user 承担 → 整体禁用（不回落 bundled）
    await loader.setEnabled('sep', false)
    await loader.reload()
    const after = loader.list().find((x) => x.dirName === 'sep')
    expect(after).toBeDefined()
    expect(after!.enabled).toBe(false)
    // 删除 user 目录 → bundled 版以 bundled 状态独立接管（默认启用）
    const fs = await import('fs')
    fs.rmSync(join(USER_PLUGINS, 'sep'), { recursive: true, force: true })
    await loader.reload()
    const back = loader.list().find((x) => x.dirName === 'sep')
    expect(back).toBeDefined()
    expect(back!.source).toBe('bundled')
    expect(back!.enabled).toBe(true)
    loader.destroy()
  })

  it('无 bundled 目录时行为不变（getter 返回 null）', async () => {
    makeTuple(join(USER_PLUGINS, 'plain'), 'plain', 'plain_tool', 'user-plain')
    const loader = new PluginLoader(() => null, () => null)
    await loader.reload()
    const list = loader.list()
    expect(list.length).toBe(1)
    expect(list[0].dirName).toBe('plain')
    expect(list[0].source).toBe('user')
    loader.destroy()
  })
})