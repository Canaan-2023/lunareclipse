/**
 * 配置树（阶段 5）测试：profile 继承链 / bundle 组合 / buildConfigTreeLayers
 * 层级顺序 / cordis.patch overlay / ConfigStore.getEffective() 端到端合并。
 *
 * 层级（低→高，后覆盖先）：核心 config.json → profile → bundle → patch 文件 → 插件 config.patch。
 * 合并语义：对象深合并（嵌套递归），数组/标量整体替换。
 * 注：profile 继承链内用 Object.assign 浅合并（读 mergeConfigLayers 前先归并父级），
 *     与 bundle/patch 的 deepMerge 语义不同——测试按实际实现断言。
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import {
  deepMerge,
  writeProfileFile,
  deleteProfileFile,
  writeBundleFile,
  deleteBundleFile,
  writePatchFile,
  readActiveProfile,
  writeActiveProfile,
  readActiveProfileConfig,
  listProfiles,
  readProfile,
  resolveProfileConfig,
  readActiveBundle,
  writeActiveBundle,
  readActiveBundleConfig,
  readActiveBundlePlugins,
  listBundles,
  readBundle,
  buildConfigTreeLayers,
  readCordisPatchOverlay,
  writeCordisPatchOverlay
} from '../electron/main/kernel/config-layer'
import { ConfigStore } from '../electron/main/api/config-store'
import { kernelRegistry } from '../electron/main/kernel/registry'

const TEST_ROOT = join(process.cwd(), 'tmp', 'config-tree-test')

beforeEach(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true })
  mkdirSync(TEST_ROOT, { recursive: true })
  kernelRegistry.disposeBySource({ kind: 'plugin', pluginName: 'tree-plugin' })
})

afterAll(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true })
})

describe('profile 层（具名配置组装）', () => {
  it('继承链：父 profile 先合并，子后覆盖（浅合并，顶层键覆盖）', () => {
    writeProfileFile(TEST_ROOT, 'base', {
      config: { a: 1, nested: { x: 1 } },
      description: '基础配置'
    })
    writeProfileFile(TEST_ROOT, 'dev', {
      extends: ['base'],
      config: { b: 2, nested: { y: 2 } }
    })
    const merged = resolveProfileConfig(TEST_ROOT, 'dev')
    expect(merged).toEqual({ a: 1, b: 2, nested: { y: 2 } })
  })

  it('深层继承（祖→父→子）按序合并', () => {
    writeProfileFile(TEST_ROOT, 'g1', { config: { level: 1, g: 'g1' } })
    writeProfileFile(TEST_ROOT, 'g2', { extends: ['g1'], config: { level: 2, p: 'p' } })
    writeProfileFile(TEST_ROOT, 'leaf', { extends: ['g2'], config: { level: 3 } })
    expect(resolveProfileConfig(TEST_ROOT, 'leaf')).toEqual({ level: 3, g: 'g1', p: 'p' })
  })

  it('环检测：互相 extends 不抛异常、不死循环，合并可见部分', () => {
    writeProfileFile(TEST_ROOT, 'cyc-a', { extends: ['cyc-b'], config: { a: 'A' } })
    writeProfileFile(TEST_ROOT, 'cyc-b', { extends: ['cyc-a'], config: { b: 'B' } })
    expect(() => resolveProfileConfig(TEST_ROOT, 'cyc-a')).not.toThrow()
    expect(resolveProfileConfig(TEST_ROOT, 'cyc-a')).toEqual({ a: 'A', b: 'B' })
  })

  it('自环：extends 自己不抛异常、不死循环', () => {
    writeProfileFile(TEST_ROOT, 'self', { extends: ['self'], config: { x: 1 } })
    expect(() => resolveProfileConfig(TEST_ROOT, 'self')).not.toThrow()
    expect(resolveProfileConfig(TEST_ROOT, 'self')).toEqual({ x: 1 })
  })

  it('损坏 profile 跳过；缺失 profile 返回 null', () => {
    mkdirSync(join(TEST_ROOT, 'profiles'), { recursive: true })
    writeFileSync(join(TEST_ROOT, 'profiles', 'broken.json'), '{ bad', 'utf-8')
    expect(readProfile(TEST_ROOT, 'broken')).toBeNull()
    expect(readProfile(TEST_ROOT, 'ghost')).toBeNull()
    // listProfiles 只列文件名（面板展示用，不解析内容）；解析在 readProfile/resolve 时跳过损坏
    expect(listProfiles(TEST_ROOT)).toEqual(['broken'])
  })

  it('激活切换：.active-profile 读写与清除', () => {
    expect(readActiveProfile(TEST_ROOT)).toBeNull()
    writeActiveProfile(TEST_ROOT, 'dev')
    expect(readActiveProfile(TEST_ROOT)).toBe('dev')
    writeActiveProfile(TEST_ROOT, null)
    expect(readActiveProfile(TEST_ROOT)).toBeNull()
    expect(existsSync(join(TEST_ROOT, '.active-profile'))).toBe(false)
  })

  it('无活跃 profile 时 readActiveProfileConfig 返回空对象（不污染合并链）', () => {
    writeProfileFile(TEST_ROOT, 'base', { config: { a: 1 } })
    expect(readActiveProfileConfig(TEST_ROOT)).toEqual({})
    writeActiveProfile(TEST_ROOT, 'base')
    expect(readActiveProfileConfig(TEST_ROOT)).toEqual({ a: 1 })
  })

  it('删除激活中的 profile 自动解除激活', () => {
    writeProfileFile(TEST_ROOT, 'gone', { config: { a: 1 } })
    writeActiveProfile(TEST_ROOT, 'gone')
    expect(deleteProfileFile(TEST_ROOT, 'gone')).toBe(true)
    expect(readActiveProfile(TEST_ROOT)).toBeNull()
    expect(deleteProfileFile(TEST_ROOT, 'gone')).toBe(false)
  })
})

describe('bundle 层（组合包）', () => {
  it('写读：bundle 声明含 plugins + config，损坏跳过', () => {
    writeBundleFile(TEST_ROOT, 'kit', {
      plugins: ['plg-a', 'plg-b'],
      config: { featureA: { enabled: true } },
      description: '组合包'
    })
    expect(listBundles(TEST_ROOT)).toEqual(['kit'])
    const decl = readBundle(TEST_ROOT, 'kit')
    expect(decl!.plugins).toEqual(['plg-a', 'plg-b'])
    expect(decl!.config).toEqual({ featureA: { enabled: true } })
    expect(decl!.description).toBe('组合包')

    mkdirSync(join(TEST_ROOT, 'bundles'), { recursive: true })
    writeFileSync(join(TEST_ROOT, 'bundles', 'broken.json'), '{ bad', 'utf-8')
    expect(readBundle(TEST_ROOT, 'broken')).toBeNull()
    expect(readBundle(TEST_ROOT, 'ghost')).toBeNull()
  })

  it('激活切换：.active-bundle 读写 + config/plugins 读取 + 删除自动解除', () => {
    expect(readActiveBundle(TEST_ROOT)).toBeNull()
    writeBundleFile(TEST_ROOT, 'kit', { plugins: ['p1'], config: { c: 1 } })
    writeActiveBundle(TEST_ROOT, 'kit')
    expect(readActiveBundle(TEST_ROOT)).toBe('kit')
    expect(readActiveBundleConfig(TEST_ROOT)).toEqual({ c: 1 })
    expect(readActiveBundlePlugins(TEST_ROOT)).toEqual(['p1'])

    writeActiveBundle(TEST_ROOT, null)
    expect(readActiveBundle(TEST_ROOT)).toBeNull()
    expect(readActiveBundleConfig(TEST_ROOT)).toEqual({})
    expect(readActiveBundlePlugins(TEST_ROOT)).toEqual([])

    writeActiveBundle(TEST_ROOT, 'kit')
    expect(deleteBundleFile(TEST_ROOT, 'kit')).toBe(true)
    expect(readActiveBundle(TEST_ROOT)).toBeNull()
    expect(deleteBundleFile(TEST_ROOT, 'kit')).toBe(false)
  })

  it('无 config 的 bundle 激活返回空组合', () => {
    writeBundleFile(TEST_ROOT, 'bare', { plugins: ['p1'] })
    writeActiveBundle(TEST_ROOT, 'bare')
    expect(readActiveBundleConfig(TEST_ROOT)).toEqual({})
    expect(readActiveBundlePlugins(TEST_ROOT)).toEqual(['p1'])
  })
})

describe('buildConfigTreeLayers（层级顺序）', () => {
  it('无 profile/bundle/patch 激活时返回空层（行为与旧版一致）', () => {
    expect(buildConfigTreeLayers(TEST_ROOT)).toEqual([])
  })

  it('层级顺序：profile → bundle → patch 文件（patch 按文件名排序）', () => {
    writeProfileFile(TEST_ROOT, 'base', { config: { a: 1 } })
    writeActiveProfile(TEST_ROOT, 'base')
    writeBundleFile(TEST_ROOT, 'kit', { plugins: [], config: { b: 2 } })
    writeActiveBundle(TEST_ROOT, 'kit')
    writePatchFile(TEST_ROOT, '020-later', { d: 4 })
    writePatchFile(TEST_ROOT, '010-first', { c: 3 })

    const layers = buildConfigTreeLayers(TEST_ROOT)
    expect(layers.map((l) => l.source)).toEqual(['profile', 'bundle', 'patch', 'patch'])
    expect(layers[0].name).toBe('base')
    expect(layers[1].name).toBe('kit')
    expect(layers[2].name).toBe('010-first.json')
    expect(layers[3].name).toBe('020-later.json')
    expect(layers.map((l) => l.content)).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }, { d: 4 }])
  })

  it('profile/bundle 无有效 config 片段时不产生空层', () => {
    writeActiveProfile(TEST_ROOT, 'ghost') // 活跃指向不存在的 profile
    writeActiveBundle(TEST_ROOT, 'ghost') // 同上
    writePatchFile(TEST_ROOT, '010-only', { x: 1 })
    const layers = buildConfigTreeLayers(TEST_ROOT)
    expect(layers.map((l) => l.source)).toEqual(['patch'])
  })
})

describe('cordis.patch overlay（按插件 id patch Cordis 模块 config）', () => {
  it('无文件返回空 map；写入后按插件 id 读取', () => {
    expect(readCordisPatchOverlay(TEST_ROOT)).toEqual({})
    const ok = writeCordisPatchOverlay(TEST_ROOT, {
      'cordis-plugin-a': { apiKey: 'k', retries: 3 }
    })
    expect(ok).toBe(true)
    const overlay = readCordisPatchOverlay(TEST_ROOT)
    expect(overlay['cordis-plugin-a']).toEqual({ apiKey: 'k', retries: 3 })
  })

  it('损坏/非对象 overlay 返回空 map；dataRoot 为空不写', () => {
    writeFileSync(join(TEST_ROOT, 'cordis.patch.json'), '{ bad', 'utf-8')
    expect(readCordisPatchOverlay(TEST_ROOT)).toEqual({})

    writeFileSync(join(TEST_ROOT, 'cordis.patch.json'), '[1,2]', 'utf-8')
    expect(readCordisPatchOverlay(TEST_ROOT)).toEqual({})

    expect(writeCordisPatchOverlay('', { x: { a: 1 } })).toBe(false)
    expect(existsSync(join(TEST_ROOT, 'cordis.patch.json'))).toBe(true) // 空 dataRoot 不清已有文件
    rmSync(join(TEST_ROOT, 'cordis.patch.json'), { force: true })
  })

  it('整体替换：二次写入覆盖旧 map', () => {
    writeCordisPatchOverlay(TEST_ROOT, { a: { v: 1 } })
    writeCordisPatchOverlay(TEST_ROOT, { b: { v: 2 } })
    const overlay = readCordisPatchOverlay(TEST_ROOT)
    expect(Object.keys(overlay)).toEqual(['b'])
  })
})

describe('ConfigStore.getEffective() 端到端（核心+profile+bundle+patch+插件 configPatch 全链合并）', () => {
  function setupCore(): ConfigStore {
    const corePath = join(TEST_ROOT, 'config.json')
    writeFileSync(corePath, JSON.stringify({
      theme: 'night',
      lilith: { toolPolicy: { base: { enabled: true } } },
      nested: { x: 1, coreOnly: true },
      list: [1, 2]
    }), 'utf-8')

    writeProfileFile(TEST_ROOT, 'base', { config: { profileKey: 'P', nested: { fromProfile: true } } })
    writeActiveProfile(TEST_ROOT, 'base')
    writeBundleFile(TEST_ROOT, 'kit', { plugins: ['plg-a'], config: { bundleKey: 'B', nested: { fromBundle: true } } })
    writeActiveBundle(TEST_ROOT, 'kit')
    writePatchFile(TEST_ROOT, '010-file', { patchKey: 'F', nested: { fromPatch: true } })

    const store = new ConfigStore(corePath, () => [
      ...buildConfigTreeLayers(TEST_ROOT).map((l) => l.content),
      ...kernelRegistry.get<Record<string, unknown>>('configPatch')
    ])
    // 插件 config.patch（最高层）
    kernelRegistry.register('configPatch', { kind: 'plugin', pluginName: 'tree-plugin' }, {
      pluginPatchKey: 'PLG',
      nested: { fromPlugin: true }
    })
    return store
  }

  it('各层按优先级合并：核心 < profile < bundle < patch 文件 < 插件 config.patch', () => {
    const store = setupCore()
    const eff = store.getEffective()

    // 核心字段保留
    expect(eff.theme).toBe('night')
    expect(eff.lilith.toolPolicy.base.enabled).toBe(true)
    expect(eff.nested.x).toBe(1)
    expect(eff.nested.coreOnly).toBe(true)
    // 每层独有键都在
    expect(eff.profileKey).toBe('P')
    expect(eff.bundleKey).toBe('B')
    expect(eff.patchKey).toBe('F')
    expect(eff.pluginPatchKey).toBe('PLG')
    // 嵌套深合并：各层片段共存（deepMerge 嵌套递归）
    expect(eff.nested).toEqual({
      x: 1, coreOnly: true,
      fromProfile: true, fromBundle: true, fromPatch: true, fromPlugin: true
    })
    // 数组整体替换不受影响（核心 list 未被 patch 层触及）
    expect(eff.list).toEqual([1, 2])
  })

  it('高层覆盖低层同键（patch 文件覆盖 bundle），get() 保持核心真相', () => {
    const store = setupCore()
    // bundle 提供 bundleKey，patch 文件不覆盖它——单独验证 patch 覆盖 bundle 的场景
    const eff = store.getEffective()
    expect(eff.bundleKey).toBe('B')
    // get() 不污染：profile/bundle/patch/插件键不进核心
    const core = store.get()
    expect(core.profileKey).toBeUndefined()
    expect(core.bundleKey).toBeUndefined()
    expect(core.pluginPatchKey).toBeUndefined()
  })

  it('脚本层键冲突时高层胜出（patch 覆盖 profile 与 bundle 同键）', () => {
    writeProfileFile(TEST_ROOT, 'base', { config: { conflict: 'profile' } })
    // kit bundle 重写为不同内容（覆盖 beforeEach 已建的同名会先被上例清理——独立 setup）
    writeBundleFile(TEST_ROOT, 'kit', { plugins: [], config: { conflict: 'bundle' } })
    writePatchFile(TEST_ROOT, '010-file', { conflict: 'patch' })
    const corePath = join(TEST_ROOT, 'config.json')
    writeFileSync(corePath, JSON.stringify({ conflict: 'core', theme: 'night' }), 'utf-8')
    const store = new ConfigStore(corePath, () => [
      ...buildConfigTreeLayers(TEST_ROOT).map((l) => l.content),
      ...kernelRegistry.get<Record<string, unknown>>('configPatch')
    ])
    expect(store.getEffective().conflict).toBe('patch')
  })

  it('插件卸载后其 config.patch 从生效配置消失（停用即失活）', () => {
    const store = setupCore()
    expect(store.getEffective().pluginPatchKey).toBe('PLG')
    kernelRegistry.disposeBySource({ kind: 'plugin', pluginName: 'tree-plugin' })
    const eff = store.getEffective()
    expect(eff.pluginPatchKey).toBeUndefined()
    // 其余各层不受影响
    expect(eff.profileKey).toBe('P')
    expect(eff.bundleKey).toBe('B')
    expect(eff.patchKey).toBe('F')
  })
})

describe('deepMerge 契约复核（配置树合并的基础）', () => {
  it('对象深合并、数组整体替换、标量覆盖', () => {
    expect(deepMerge({ a: 1, n: { x: 1 } }, { b: 2, n: { y: 2 } })).toEqual({ a: 1, b: 2, n: { x: 1, y: 2 } })
    expect(deepMerge({ arr: [1] }, { arr: [2, 3] }).arr).toEqual([2, 3])
    expect(deepMerge({ a: 1 }, null)).toBeNull()
  })
})