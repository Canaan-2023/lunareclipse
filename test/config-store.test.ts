import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { ConfigStore } from '../electron/main/api/config-store'
import { DEFAULT_CONFIG } from '@shared/types'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

describe('ConfigStore', () => {
  let tmpDir: string
  let configPath: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'config-test-'))
    configPath = join(tmpDir, 'config.json')
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('构造时加载默认配置（文件不存在）', () => {
    const store = new ConfigStore(configPath)
    const config = store.get()
    expect(config.llm).toBeDefined()
    expect(config.dmnLlm).toBeDefined()
    expect(config.theme).toBe(DEFAULT_CONFIG.theme)
  })

  it('save 持久化配置到文件', () => {
    const store = new ConfigStore(configPath)
    const config = store.get()
    config.theme = 'parchment'
    store.save(config)
    // 重新加载验证
    const store2 = new ConfigStore(configPath)
    expect(store2.get().theme).toBe('parchment')
  })

  it('subscribe 在配置变化时收到回调', () => {
    const store = new ConfigStore(configPath)
    const cb = vi.fn()
    store.subscribe(cb)
    const newConfig = { ...store.get(), theme: 'frost-glass' as const }
    store.save(newConfig)
    expect(cb).toHaveBeenCalledTimes(1)
    expect(cb.mock.calls[0][0].theme).toBe('frost-glass')
    expect(cb.mock.calls[0][1].theme).toBe(DEFAULT_CONFIG.theme)
  })

  it('subscribe 返回的取消函数能停止接收回调', () => {
    const store = new ConfigStore(configPath)
    const cb = vi.fn()
    const unsubscribe = store.subscribe(cb)
    unsubscribe()
    store.save({ ...store.get(), theme: 'frost-glass' as const })
    expect(cb).not.toHaveBeenCalled()
  })

  it('save 相同配置不触发订阅者回调', () => {
    const store = new ConfigStore(configPath)
    const cb = vi.fn()
    store.subscribe(cb)
    const config = store.get()
    store.save({ ...config }) // 浅拷贝，内容相同
    expect(cb).not.toHaveBeenCalled()
  })

  it('多个订阅者都能收到回调', () => {
    const store = new ConfigStore(configPath)
    const cb1 = vi.fn()
    const cb2 = vi.fn()
    store.subscribe(cb1)
    store.subscribe(cb2)
    store.save({ ...store.get(), theme: 'frost-glass' as const })
    expect(cb1).toHaveBeenCalledTimes(1)
    expect(cb2).toHaveBeenCalledTimes(1)
  })

  it('订阅者抛异常不影响其他订阅者和 save 流程', () => {
    const store = new ConfigStore(configPath)
    const badCb = vi.fn(() => { throw new Error('subscriber error') })
    const goodCb = vi.fn()
    store.subscribe(badCb)
    store.subscribe(goodCb)
    expect(() => store.save({ ...store.get(), theme: 'frost-glass' as const })).not.toThrow()
    expect(badCb).toHaveBeenCalledTimes(1)
    expect(goodCb).toHaveBeenCalledTimes(1)
  })

  it('老主题名加载时自动迁移到新主题', () => {
    // 模拟老配置文件：theme 为旧名 'eclipse-contrast'
    const oldConfig = { ...DEFAULT_CONFIG, theme: 'eclipse-contrast' as unknown as string }
    writeFileSync(configPath, JSON.stringify(oldConfig), 'utf-8')
    const store = new ConfigStore(configPath)
    expect(store.get().theme).toBe('night')
  })
})
