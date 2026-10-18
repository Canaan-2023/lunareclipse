/**
 * service-refs（进程级引用容器）契约测试。
 *
 * 为什么存在：ADR-02 第 3 步把 13 个进程级引用的释放收敛到 `releaseServiceRefs()`，但该释放链
 * 此前**无直测**——唯一验证是 `api-server.test.ts`「关闭与清理」的 1 个用例（只断言 closeApiServer
 * 后 HTTP 拒连）。13 项是否逐项被释放、哪几项按设计**不置空**、释放相对顺序是否与拆分前一致，
 * 此前只能靠人读代码（复审轮列为测试缺口 P0）。
 *
 * 覆盖：
 * 1. 逐项释放：注入可观测 stub → 断言各自释放方法被调用一次、引用被置空
 * 2. 按设计不置空：`messagingService` / `apiTokenSecret` 完全不变；`server` / `wss` 被 close 但不置空
 * 3. 释放相对顺序：先解绑订阅与监听、再关连接与端口（用调用序数组逐位断言）；
 *    Cordis 事件桥 detach 在 `unwatchHooks` 之前（挂载逆序卸载）
 * 4. 单点释放失败不阻断其余：`asyncDelegation.dispose` 抛错时仍置空、不向外抛、后续步骤照常
 * 5. 只读 getter 的未初始化 / 已释放语义
 *
 * 本模块仅 `import type` 依赖（零运行时），故本测试无需 mock electron。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  serviceRefs,
  releaseServiceRefs,
  getApiToken,
  getMessagingService,
  getHeadlessChatRunner,
  getGeoEnvText,
  SYSTEM_INJECTED_SESSION_ID
} from '../electron/main/api/service-refs'

/** 释放调用顺序记录：用于断言各引用的相对释放次序（顺序即释放语义） */
let calls: string[] = []

/** 向容器注入 13 个可观测 stub；返回「按设计不置空」两项的引用快照 */
function injectStubs(): { messaging: unknown; token: string } {
  calls = []
  serviceRefs.server = { close: () => calls.push('server.close') } as never
  serviceRefs.wss = {
    clients: new Set([{ close: () => calls.push('wss.client.close') }]),
    close: () => calls.push('wss.close')
  } as never
  serviceRefs.unsubscribeConfig = () => calls.push('unsubscribeConfig')
  serviceRefs.skillLoaderRef = { stopWatching: () => calls.push('skillLoader.stopWatching') } as never
  serviceRefs.hookManagerRef = {
    hookManager: {} as never,
    unwatchHooks: () => calls.push('hookManager.unwatchHooks'),
    detachEventBridge: () => calls.push('hookManager.detachEventBridge')
  }
  serviceRefs.cronSchedulerRef = { stop: () => calls.push('cronScheduler.stop') } as never
  serviceRefs.asyncDelegationRef = { dispose: () => calls.push('asyncDelegation.dispose') } as never
  serviceRefs.missionStoreRef = {} as never
  serviceRefs.streamSessionRef = { dispose: () => calls.push('streamSession.dispose') } as never
  serviceRefs.headlessChatRunnerRef = async () => 'reply'
  serviceRefs.geoEnvTextRef = () => 'env-text'
  serviceRefs.apiTokenSecret = 'token-abc'
  serviceRefs.messagingService = { stop: () => calls.push('messaging.stop') } as never
  return { messaging: serviceRefs.messagingService, token: serviceRefs.apiTokenSecret }
}

/** 容器复位（避免用例间互相污染：serviceRefs 是模块级单例） */
function resetAll(): void {
  serviceRefs.server = null
  serviceRefs.wss = null
  serviceRefs.unsubscribeConfig = null
  serviceRefs.skillLoaderRef = null
  serviceRefs.hookManagerRef = null
  serviceRefs.cronSchedulerRef = null
  serviceRefs.messagingService = null
  serviceRefs.apiTokenSecret = ''
  serviceRefs.asyncDelegationRef = null
  serviceRefs.missionStoreRef = null
  serviceRefs.streamSessionRef = null
  serviceRefs.headlessChatRunnerRef = null
  serviceRefs.geoEnvTextRef = null
}

describe('releaseServiceRefs：13 个进程级引用的释放链', () => {
  let preserved: { messaging: unknown; token: string }

  beforeEach(() => {
    resetAll()
    preserved = injectStubs()
  })

  afterEach(() => {
    resetAll()
  })

  it('逐项调用释放方法，且 9 项引用被置空', () => {
    releaseServiceRefs()

    expect(calls).toContain('unsubscribeConfig')
    expect(calls).toContain('skillLoader.stopWatching')
    expect(calls).toContain('hookManager.detachEventBridge')
    expect(calls).toContain('hookManager.unwatchHooks')
    expect(calls).toContain('cronScheduler.stop')
    expect(calls).toContain('asyncDelegation.dispose')
    expect(calls).toContain('streamSession.dispose')
    expect(calls).toContain('wss.client.close')
    expect(calls).toContain('wss.close')
    expect(calls).toContain('server.close')

    expect(serviceRefs.unsubscribeConfig).toBeNull()
    expect(serviceRefs.skillLoaderRef).toBeNull()
    expect(serviceRefs.hookManagerRef).toBeNull()
    expect(serviceRefs.cronSchedulerRef).toBeNull()
    expect(serviceRefs.asyncDelegationRef).toBeNull()
    expect(serviceRefs.missionStoreRef).toBeNull()
    expect(serviceRefs.streamSessionRef).toBeNull()
    expect(serviceRefs.headlessChatRunnerRef).toBeNull()
    expect(serviceRefs.geoEnvTextRef).toBeNull()
  })

  it('按设计不置空：messagingService / apiTokenSecret 保持不变，server / wss 被 close 但不置空', () => {
    releaseServiceRefs()

    // 外部平台接入与令牌由进程退出回收（拆分前语义，不得被「统一释放」误加）
    expect(serviceRefs.messagingService).toBe(preserved.messaging)
    expect(serviceRefs.apiTokenSecret).toBe(preserved.token)
    expect(calls).not.toContain('messaging.stop')

    // 连接与端口：close 但不置空（拆分前语义）
    expect(serviceRefs.server).not.toBeNull()
    expect(serviceRefs.wss).not.toBeNull()
  })

  it('释放相对顺序与拆分前一致：先解绑订阅/监听/调度，再关连接与端口', () => {
    releaseServiceRefs()

    expect(calls).toEqual([
      'unsubscribeConfig',
      'skillLoader.stopWatching',
      'hookManager.detachEventBridge',
      'hookManager.unwatchHooks',
      'cronScheduler.stop',
      'asyncDelegation.dispose',
      'streamSession.dispose',
      'wss.client.close',
      'wss.close',
      'server.close'
    ])
  })

  it('未挂 Cordis 事件桥时（detachEventBridge 缺省）仍安全释放', () => {
    serviceRefs.hookManagerRef = {
      hookManager: {} as never,
      unwatchHooks: () => calls.push('hookManager.unwatchHooks')
    }

    expect(() => releaseServiceRefs()).not.toThrow()
    expect(calls).toContain('hookManager.unwatchHooks')
    expect(serviceRefs.hookManagerRef).toBeNull()
  })

  it('单点释放失败不阻断其余：asyncDelegation.dispose 抛错仍置空、不向外抛、后续照常', () => {
    serviceRefs.asyncDelegationRef = {
      dispose: () => {
        calls.push('asyncDelegation.dispose')
        throw new Error('dispose boom')
      }
    } as never

    expect(() => releaseServiceRefs()).not.toThrow()

    expect(calls).toContain('asyncDelegation.dispose')
    expect(serviceRefs.asyncDelegationRef).toBeNull()
    // 抛错点之后的步骤仍执行
    expect(calls).toContain('streamSession.dispose')
    expect(calls).toContain('server.close')
  })

  it('容器为空时安全返回（退出路径可能在从未启动 API server 的情况下触发）', () => {
    resetAll()
    expect(() => releaseServiceRefs()).not.toThrow()
    expect(calls).toEqual([])
  })
})

describe('service-refs 只读 getter 的未初始化 / 已释放语义', () => {
  beforeEach(() => resetAll())
  afterEach(() => resetAll())

  it('未初始化：无头对话运行器与地理注入文本返回空语义', () => {
    expect(getHeadlessChatRunner()).toBeNull()
    expect(getGeoEnvText()).toBe('')
    expect(getApiToken()).toBe('')
    expect(getMessagingService()).toBeNull()
  })

  it('已初始化：getter 读到同一实例 / 现算值', () => {
    const messaging = { stop: () => undefined } as never
    const runner = async () => 'reply'
    serviceRefs.messagingService = messaging
    serviceRefs.headlessChatRunnerRef = runner
    serviceRefs.geoEnvTextRef = () => 'env-text'
    serviceRefs.apiTokenSecret = 'token-abc'

    expect(getMessagingService()).toBe(messaging)
    expect(getHeadlessChatRunner()).toBe(runner)
    expect(getGeoEnvText()).toBe('env-text')
    expect(getApiToken()).toBe('token-abc')
  })

  it('释放后：运行器与地理注入文本归空，令牌与服务实例保持不变', () => {
    const messaging = { stop: () => undefined } as never
    serviceRefs.messagingService = messaging
    serviceRefs.headlessChatRunnerRef = async () => 'reply'
    serviceRefs.geoEnvTextRef = () => 'env-text'
    serviceRefs.apiTokenSecret = 'token-abc'

    releaseServiceRefs()

    expect(getHeadlessChatRunner()).toBeNull()
    expect(getGeoEnvText()).toBe('')
    expect(getApiToken()).toBe('token-abc')
    expect(getMessagingService()).toBe(messaging)
  })

  it('系统注入会话 ID 为固定常量（跨版本稳定，调用方按常量比对）', () => {
    expect(SYSTEM_INJECTED_SESSION_ID).toBe('system_injected_events')
  })
})
