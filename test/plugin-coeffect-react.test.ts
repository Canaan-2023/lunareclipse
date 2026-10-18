import { describe, it, expect } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { PluginLoader } from '../electron/main/plugins/loader'
import { setPathContext } from '../electron/main/models/path-context'
import { coeffectRegistry } from '../electron/main/kernel/coeffect'
import { clearDynamicToolMetas } from '../shared/tools/registry'

/**
 * 反应式 coeffect 重载链路测试（2026-08-18）
 * 依赖某服务（deps）的插件，在服务被外部 provide 时取消依赖警告；服务被移除时重新出现警告。
 * 这验证 onChanged → coDepends → reloadSome 的真实触发路径（notify）。
 */
describe('反应式 coeffect：依赖插件随服务提供/移除更新', () => {
  const ROOT = join(process.cwd(), 'tmp', 'plugin-react-adhoc')
  const PLUG = join(ROOT, 'plugins')

  function mkConsumer(): void {
    const d = join(PLUG, 'react-consumer')
    mkdirSync(d, { recursive: true })
    writeFileSync(join(d, 'plugin.json'), JSON.stringify({ name: 'react-consumer', version: '0.1.0', deps: ['dyn-svc'] }), 'utf-8')
    writeFileSync(join(d, 'tools.js'), `export default [{ name: 'react_consume', description: 'x', parameters: [], async execute() { return { ok: true, data: 'c' } } }]`, 'utf-8')
  }

  it('外部 provide 服务 → 依赖插件取消警告；dispose → 警告重现', async () => {
    clearDynamicToolMetas()
    rmSync(ROOT, { recursive: true, force: true })
    mkConsumer()

    setPathContext(ROOT, () => null)
    const loader = new PluginLoader()
    await loader.reload()
    const consumer = () => loader.list().find((p) => p.dirName === 'react-consumer')!

    // 轮询等待工具（避免固定 sleep 的时序 flaky——app 高负载下 reloadSome 可能更慢）
    const waitFor = async (cond: () => boolean, timeoutMs = 3000): Promise<boolean> => {
      const t0 = Date.now()
      while (Date.now() - t0 < timeoutMs) {
        if (cond()) return true
        await new Promise((r) => setTimeout(r, 50))
      }
      return cond()
    }

    // 初始：dyn-svc 未提供 → 依赖插件带警告
    expect(coeffectRegistry.has('dyn-svc')).toBe(false)
    expect(consumer().errors.some((e) => e.includes('dyn-svc'))).toBe(true)

    // 外部提供 dyn-svc → 触发 onChanged → coDepends 命中 react-consumer → 反应式重载移除警告
    const h = coeffectRegistry.provide('dyn-svc', { v: 1 }, { kind: 'builtin' })
    expect(await waitFor(() => !consumer().errors.some((e) => e.includes('dyn-svc')))).toBe(true)

    // dispose 服务 → 警告重现
    h.dispose()
    expect(await waitFor(() => coeffectRegistry.has('dyn-svc') === false && consumer().errors.some((e) => e.includes('dyn-svc')))).toBe(true)

    loader.destroy()
    clearDynamicToolMetas()
    rmSync(ROOT, { recursive: true, force: true })
  })

  it('E1: setEnabled 停用提供方 → 依赖插件重载并出现缺依赖警告；恢复 → 警告消失', async () => {
    clearDynamicToolMetas()
    rmSync(ROOT, { recursive: true, force: true })
    mkConsumer()
    // 提供方：provides dyn-svc 并在 register 中实际 provide
    const pdir = join(PLUG, 'react-provider')
    mkdirSync(pdir, { recursive: true })
    writeFileSync(
      join(pdir, 'plugin.json'),
      JSON.stringify({ name: 'react-provider', version: '0.1.0', provides: ['dyn-svc'] }),
      'utf-8'
    )
    writeFileSync(
      join(pdir, 'hooks.js'),
      `module.exports = { register(reg) { reg.provide('dyn-svc', { v: 1 }) } }`,
      'utf-8'
    )

    setPathContext(ROOT, () => null)
    const loader = new PluginLoader()
    await loader.reload()
    const consumer = () => loader.list().find((p) => p.dirName === 'react-consumer')!

    const waitFor = async (cond: () => boolean, timeoutMs = 3000): Promise<boolean> => {
      const t0 = Date.now()
      while (Date.now() - t0 < timeoutMs) {
        if (cond()) return true
        await new Promise((r) => setTimeout(r, 50))
      }
      return cond()
    }

    // 初始：provider 已 provide → consumer 无缺依赖警告
    expect(coeffectRegistry.has('dyn-svc')).toBe(true)
    expect(await waitFor(() => !consumer().errors.some((e) => e.includes('dyn-svc')))).toBe(true)

    // 停用 provider → 句柄 dispose → 反应式重载 consumer → 缺依赖警告重现
    await loader.setEnabled('react-provider', false)
    expect(
      await waitFor(() => coeffectRegistry.has('dyn-svc') === false && consumer().errors.some((e) => e.includes('dyn-svc')))
    ).toBe(true)

    // 恢复 provider → 重新 provide → consumer 重载 → 警告消失
    await loader.setEnabled('react-provider', true)
    expect(await waitFor(() => coeffectRegistry.has('dyn-svc') && !consumer().errors.some((e) => e.includes('dyn-svc')))).toBe(true)

    loader.destroy()
    clearDynamicToolMetas()
    rmSync(ROOT, { recursive: true, force: true })
  })
})
