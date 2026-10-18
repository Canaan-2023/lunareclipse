import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { mkdirSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { PluginLoader } from '../electron/main/plugins/loader'
import { setPathContext } from '../electron/main/models/path-context'
import { PluginManageTool } from '../electron/main/tools/plugin-manage'
import { TOOL_MAP, isToolForAgent } from '../shared/tools/registry'

const TEST_ROOT = join(process.cwd(), 'tmp', 'plugin-manage-test-root')

beforeEach(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true })
  mkdirSync(TEST_ROOT, { recursive: true })
})

afterAll(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true })
})

function makeCtx(): { getPluginLoader: () => PluginLoader | null; requestPermission: () => Promise<{ allowed: boolean }> } {
  setPathContext(TEST_ROOT, () => null)
  const loader = new PluginLoader()
  return {
    getPluginLoader: () => loader,
    requestPermission: async () => ({ allowed: true })
  }
}

describe('插件管理工具全链路', () => {
  it('install → list → uninstall', async () => {
    const ctx = makeCtx() as never
    const tool = new PluginManageTool()

    // install
    const r = await tool.execute({ action: 'install', name: 'my-guard', description: '测试插件' }, ctx)
    expect(r.ok).toBe(true)
    const dir = join(TEST_ROOT, 'plugins', 'my-guard')
    expect(existsSync(join(dir, 'plugin.json'))).toBe(true)
    expect(existsSync(join(dir, 'tools.js'))).toBe(true)

    // list 能看到
    const l = await tool.execute({ action: 'list' }, ctx) as { ok: boolean; data: { plugins: Array<{ dirName: string; enabled: boolean }> } }
    expect(l.ok).toBe(true)
    expect(l.data.plugins.some((p) => p.dirName === 'my-guard' && p.enabled)).toBe(true)

    // 同名再装报错
    const dup = await tool.execute({ action: 'install', name: 'my-guard' }, ctx)
    expect(dup.ok).toBe(false)

    // uninstall（先 setEnabled(false) 回滚，再删目录）
    const u = await tool.execute({ action: 'uninstall', name: 'my-guard' }, ctx)
    expect(u.ok).toBe(true)
    expect(existsSync(dir)).toBe(false)

    // 不存在报错
    const u2 = await tool.execute({ action: 'uninstall', name: 'my-guard' }, ctx)
    expect(u2.ok).toBe(false)
  })

  it('参数校验：缺 name / 非法名', async () => {
    const ctx = makeCtx() as never
    const tool = new PluginManageTool()
    expect((await tool.execute({ action: 'install' }, ctx)).ok).toBe(false)
    expect((await tool.execute({ action: 'install', name: '' }, ctx)).ok).toBe(false)
    expect((await tool.execute({ action: 'uninstall' }, ctx)).ok).toBe(false)
  })

  it('无 loader 上下文报错', async () => {
    const tool = new PluginManageTool()
    const r = await tool.execute({ action: 'list' }, undefined)
    expect(r.ok).toBe(false)
  })
})

describe('插件管理工具元数据（防漏注册回归）', () => {
  it('TOOL_MAP 有元数据且对 frontend 可见', () => {
    const meta = TOOL_MAP['plugin_manage']
    expect(meta).toBeDefined()
    expect(meta!.agents).toContain('frontend')
    expect(isToolForAgent('plugin_manage', 'frontend')).toBe(true)
  })
})
