import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ConfigStore } from '../electron/main/api/config-store'
import { kernelRegistry } from '../electron/main/kernel'
import { loadConfigPatchModule } from '../electron/main/plugins/module-config-patch'

/**
 * 插件 config.patch 回滚测试（2026-08-16，对齐 Cordis "时间可组合性"）：
 * 插件加载 config.patch.json → 生效配置合并；卸载/dispose → 配置完全还原（可逆效应）。
 * 链路：PluginLoader.loadOne → loadConfigPatchModule → kernelRegistry.register('configPatch')
 *      → configStore.getEffective() 实时合并 → handle.dispose() → unregister → 还原
 */
describe('插件 config.patch 回滚（时间可组合性）', () => {
  let base: string
  let configStore: ConfigStore

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'config-patch-test-'))
    configStore = new ConfigStore(join(base, 'config.json'))
    // 模拟 index.ts 的 patchProvider：内核注册表的 configPatch（实时读取）
    configStore.setPatchProvider(() => kernelRegistry.get<Record<string, unknown>>('configPatch'))
  })

  afterEach(() => {
    // 清理注册表残留（kernelRegistry 是跨测试单例）
    for (const h of kernelRegistry.get<{ id: string }>('configPatch')) {
      try { (h as { dispose?: () => void }).dispose?.() } catch { /* 忽略 */ }
    }
    rmSync(base, { recursive: true, force: true })
  })

  it('注册 configPatch → getEffective 合并；dispose → 完全还原', () => {
    // 前置：无 patch 时生效配置不含插件字段
    expect((configStore.getEffective() as Record<string, unknown>).foo).toBeUndefined()

    // 插件带 config.patch.json
    const pluginDir = join(base, 'test-plugin')
    mkdirSync(pluginDir, { recursive: true })
    writeFileSync(join(pluginDir, 'config.patch.json'), JSON.stringify({ foo: { bar: 123, nested: { deep: 'v' } } }), 'utf8')
    const errors: string[] = []
    const handles = loadConfigPatchModule(pluginDir, 'test-plugin', errors)
    expect(errors).toEqual([])
    expect(handles.length).toBe(1)

    // 合并生效
    const merged = configStore.getEffective() as Record<string, unknown>
    expect((merged.foo as Record<string, unknown>).bar).toBe(123)
    expect(((merged.foo as Record<string, unknown>).nested as Record<string, unknown>).deep).toBe('v')

    // dispose（= 插件卸载时 kernelHandles 批量调用）→ 完全还原
    handles[0].dispose()
    expect(handles[0].disposed).toBe(true)
    const after = configStore.getEffective() as Record<string, unknown>
    expect(after.foo).toBeUndefined()
    // 核心配置本身不受影响
    expect(configStore.get()).toBeDefined()
  })

  it('非法 config.patch.json（非对象）→ 报错不注册', () => {
    const pluginDir = join(base, 'bad-plugin')
    mkdirSync(pluginDir, { recursive: true })
    writeFileSync(join(pluginDir, 'config.patch.json'), '[1,2,3]', 'utf8')
    const errors: string[] = []
    const handles = loadConfigPatchModule(pluginDir, 'bad-plugin', errors)
    expect(handles.length).toBe(0)
    expect(errors.some((e) => e.includes('config.patch.json 必须是 JSON 对象'))).toBe(true)
  })

  it('无 config.patch.json → 跳过（不注册）', () => {
    const errors: string[] = []
    const handles = loadConfigPatchModule(join(base, 'no-patch'), 'no-patch', errors)
    expect(handles.length).toBe(0)
    expect(errors).toEqual([])
  })
})
