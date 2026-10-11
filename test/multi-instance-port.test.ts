// P5 多开解锁：API 端口隔离回归测试
// 模拟 default 实例（不传 preferredPort）与具名实例（preferredPort=0 → 动态端口）并行监听，
// 验证两者互不冲突——这是双实例并行运行时各自独立的关键链路。
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { startApiServer, closeApiServer } from '../electron/main/api/server'
import { ConfigStore } from '../electron/main/api/config-store'
import { SessionStore } from '../electron/main/api/session-store'
import { UserStore } from '../electron/main/models/user-store'
import { ActivationManager } from '../electron/main/api/activation-manager'
import { buildDataPaths } from '../electron/main/models/paths'
import { setPathContext } from '../electron/main/models/path-context'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('multi-instance: 双实例 API 端口隔离', () => {
  afterEach(async () => {
    closeApiServer()
    await sleep(500)
  })

  it('default（不传 preferredPort）与具名实例（preferredPort=0）同时监听互不冲突', async () => {
    const rootA = mkdtempSync(join(tmpdir(), 'inst-default-'))
    const rootB = mkdtempSync(join(tmpdir(), 'inst-named-'))
    // 系统强制登录后才可解析分层路径（uid=null 已禁止兜底，见 path-context.ts）
    setPathContext(rootA, () => 1, () => 1)

    const makeServer = (root: string, preferredPort: number | undefined) => {
      mkdirSync(join(root, 'sandbox'), { recursive: true })
      const cfgPath = join(root, 'config.json')
      writeFileSync(
        cfgPath,
        JSON.stringify({
          llm: { provider: 'openai', apiKey: 'test-key', model: 'gpt-test', temperature: 0.7, maxTokens: 2048 },
          aiMode: 'coding',
          continuousActivation: false
        }),
        'utf-8'
      )
      const configStore = new ConfigStore(cfgPath)
      const sessionStore = new SessionStore(join(root, 'sessions'))
      const userStore = new UserStore(join(root, 'users.json'))
      userStore.register('测试用户', 'test-pass')
      userStore.login('测试用户', 'test-pass')
      const activationManager = new ActivationManager(join(root, 'activation'))
      // 参数顺序（2026-10 起）：…, masterRouter, getMasterRouter, preferredPort——preferredPort 前必须有两个 undefined 占位，
      // 否则 0 会被错位解析成 getMasterRouter（0 为 falsy 无碍，但真正的 preferredPort 变 undefined → 双实例都抢固定 62002）。
      return startApiServer(
        configStore, sessionStore, userStore, activationManager, {},
        buildDataPaths(root), undefined, undefined, undefined, undefined, undefined, undefined,
        preferredPort
      )
    }

    // default 实例：固定端口（62002 或外部占用时回退动态）
    const portDefault = await makeServer(rootA, undefined)
    try {
      // 具名实例：index.ts 处 IS_CUSTOM_INSTANCE ? 0 : undefined
      const portNamed = await makeServer(rootB, 0)
      try {
        expect(portDefault).toBeGreaterThan(0)
        expect(portNamed).toBeGreaterThan(0)
        // 核心断言：两实例端口互不冲突，可并行监听
        expect(portNamed).not.toBe(portDefault)
      } finally {
        closeApiServer()
        await sleep(500)
      }
    } finally {
      closeApiServer()
      await sleep(500)
      for (const r of [rootA, rootB]) {
        try {
          rmSync(r, { recursive: true, force: true })
        } catch {
          /* ignore */
        }
      }
    }
  })
})