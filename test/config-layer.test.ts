import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { deepMerge, mergeConfigLayers, readPatchFiles, writePatchFile, deletePatchFile, listPatchFiles } from '../electron/main/kernel/config-layer'
import { ConfigStore } from '../electron/main/api/config-store'
import { ConfigPatchTool } from '../electron/main/tools/config-patch'
import { kernelRegistry } from '../electron/main/kernel/registry'

const TEST_ROOT = join(process.cwd(), 'tmp', 'config-layer-test')

beforeEach(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true })
  mkdirSync(TEST_ROOT, { recursive: true })
  kernelRegistry.disposeBySource({ kind: 'builtin' })
  kernelRegistry.disposeBySource({ kind: 'plugin', pluginName: 'cfg-plugin' })
})

afterAll(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true })
})

describe('deepMerge / mergeConfigLayers', () => {
  it('对象深合并，嵌套递归', () => {
    const base = { a: 1, nested: { x: 1, y: 2 }, arr: [1, 2] }
    const patch = { nested: { y: 3, z: 4 }, arr: [9] }
    const merged = deepMerge(base, patch)
    expect(merged).toEqual({ a: 1, nested: { x: 1, y: 3, z: 4 }, arr: [9] })
  })

  it('数组整体替换（不 merge 数组）', () => {
    const merged = deepMerge({ allowFrom: ['u1'] }, { allowFrom: ['u2', 'u3'] })
    expect(merged.allowFrom).toEqual(['u2', 'u3'])
  })

  it('标量替换，null/非对象 patch 整体替换', () => {
    expect(deepMerge({ a: 1 }, { a: 2 })).toEqual({ a: 2 })
    expect(deepMerge({ a: 1 }, null)).toBeNull()
  })

  it('多层 patch 顺序应用（后覆盖先）', () => {
    const core = { lilith: { toolPolicy: { a: { enabled: true }, b: { enabled: true } } } }
    const p1 = { lilith: { toolPolicy: { a: { enabled: false } } } }
    const p2 = { lilith: { toolPolicy: { b: { enabled: false } } } }
    const merged = mergeConfigLayers(core, [p1, p2]) as typeof core
    expect(merged.lilith.toolPolicy.a.enabled).toBe(false)
    expect(merged.lilith.toolPolicy.b.enabled).toBe(false)
  })
})

describe('patch 文件读写', () => {
  it('writePatchFile 写入 + 回读校验，文件名安全化', () => {
    const filePath = writePatchFile(TEST_ROOT, '010-toolpolicy', { frontendToolPolicy: { tools: {} } })
    expect(filePath).toContain('010-toolpolicy.json')
    const back = JSON.parse(readFileSync(filePath, 'utf-8'))
    expect(back.frontendToolPolicy.tools).toEqual({})
  })

  it('readPatchFiles 按文件名排序', () => {
    writePatchFile(TEST_ROOT, '020-b', { b: 1 })
    writePatchFile(TEST_ROOT, '010-a', { a: 1 })
    const patches = readPatchFiles(TEST_ROOT)
    expect(patches.map((p) => Object.keys(p)[0])).toEqual(['a', 'b'])
  })

  it('损坏 patch 文件跳过不报错', () => {
    mkdirSync(join(TEST_ROOT, 'patch'), { recursive: true })
    writeFileSync(join(TEST_ROOT, 'patch', 'bad.json'), '{ not valid json', 'utf-8')
    writePatchFile(TEST_ROOT, '010-good', { good: true })
    const patches = readPatchFiles(TEST_ROOT)
    expect(patches).toHaveLength(1)
    expect(patches[0].good).toBe(true)
  })

  it('deletePatchFile 删除，不存在返回 false', () => {
    writePatchFile(TEST_ROOT, '010-x', { x: 1 })
    expect(deletePatchFile(TEST_ROOT, '010-x')).toBe(true)
    expect(existsSync(join(TEST_ROOT, 'patch', '010-x.json'))).toBe(false)
    expect(deletePatchFile(TEST_ROOT, '010-x')).toBe(false)
  })

  it('listPatchFiles 返回名 + 内容', () => {
    writePatchFile(TEST_ROOT, '010-y', { y: 2 })
    const list = listPatchFiles(TEST_ROOT)
    expect(list[0].name).toBe('010-y.json')
    expect(list[0].content.y).toBe(2)
  })
})

describe('ConfigStore.getEffective（覆盖层合并）', () => {
  it('无 patchProvider 时返回核心配置', () => {
    const store = new ConfigStore(join(TEST_ROOT, 'config.json'))
    expect(store.getEffective()).toBe(store.get())
  })

  it('patchProvider 提供的覆盖合并进生效配置，get() 保持核心', () => {
    const corePath = join(TEST_ROOT, 'config.json')
    writeFileSync(corePath, JSON.stringify({ frontendToolPolicy: { tools: { a: { enabled: true } } } }), 'utf-8')
    const store = new ConfigStore(corePath, () => [
      { frontendToolPolicy: { tools: { a: { enabled: false }, b: { enabled: true } } } }
    ])
    const effective = store.getEffective()
    expect(effective.frontendToolPolicy.tools.a.enabled).toBe(false)
    expect(effective.frontendToolPolicy.tools.b.enabled).toBe(true)
    // get() 不被 patch 污染
    expect(store.get().frontendToolPolicy.tools.a.enabled).toBe(true)
    expect(store.get().frontendToolPolicy.tools.b).toBeUndefined()
  })

  it('插件 config.patch 经 registry 参与合并', () => {
    const corePath = join(TEST_ROOT, 'config.json')
    writeFileSync(corePath, JSON.stringify({ lilith: { toolPolicy: { x: { enabled: true } } } }), 'utf-8')
    // 模拟插件注册 configPatch
    kernelRegistry.register('configPatch', { kind: 'plugin', pluginName: 'cfg-plugin' }, {
      lilith: { toolPolicy: { x: { enabled: false } } }
    })
    const store = new ConfigStore(corePath, () => kernelRegistry.get('configPatch'))
    const effective = store.getEffective()
    expect(effective.lilith.toolPolicy.x.enabled).toBe(false)
    // 卸载插件后恢复
    kernelRegistry.disposeBySource({ kind: 'plugin', pluginName: 'cfg-plugin' })
    expect(store.getEffective().lilith.toolPolicy.x.enabled).toBe(true)
  })
})

describe('config_patch 工具', () => {
  it('write → list → delete 全链路（经工具执行）', async () => {
    const tool = new ConfigPatchTool()
    const ctx = { paths: { root: TEST_ROOT } } as never

    const writeRes = await tool.execute({ action: 'write', name: '010-mine', patch: { frontendToolPolicy: { tools: { web_search: { enabled: true } } } } }, ctx)
    expect(writeRes.ok).toBe(true)

    const listRes = await tool.execute({ action: 'list' }, ctx) as { ok: boolean; data: { patchFiles: Array<{ name: string }> } }
    expect(listRes.ok).toBe(true)
    expect(listRes.data.patchFiles.some((f) => f.name === '010-mine.json')).toBe(true)

    const delRes = await tool.execute({ action: 'delete', name: '010-mine' }, ctx)
    expect(delRes.ok).toBe(true)
    expect(existsSync(join(TEST_ROOT, 'patch', '010-mine.json'))).toBe(false)
  })

  it('非法参数被拒', async () => {
    const tool = new ConfigPatchTool()
    const ctx = { paths: { root: TEST_ROOT } } as never
    expect((await tool.execute({ action: 'write', name: 'x' }, ctx)).ok).toBe(false) // 缺 patch
    expect((await tool.execute({ action: 'write', patch: { a: 1 } }, ctx)).ok).toBe(false) // 缺 name
    expect((await tool.execute({ action: 'nope' }, ctx)).ok).toBe(false) // 未知 action
  })
})
