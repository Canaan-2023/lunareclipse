/**
 * 设备接入基底（T3）——DefaultDeviceManager 契约测试
 *
 * 覆盖：register 校验与持久化、磁盘加载往返、call 路由（self 只读 /
 * registered HTTP 调用 / control 授权 fail-closed）、unregister。
 * 发现层（lan/bluetooth 的 PowerShell/端口探测）不在本测试内跑，
 * 以免把 CI 绑定到真实网络环境——只测管理器的纯逻辑层。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createServer, type Server } from 'http'
import type { AddressInfo } from 'net'
import { DefaultDeviceManager } from '../app/electron/main/device/device-manager'
import type { DeviceRegisterSpec, DeviceManager } from '../app/electron/main/device/types'
import type { ToolContext } from '../app/electron/main/tools/base-tool'

/** 注册一个 HTTP 测试设备（智能家居式） */
function lampSpec(baseUrl: string): DeviceRegisterSpec {
  return {
    id: 'test-lamp',
    name: '测试卧室灯',
    kind: '智能家居',
    transport: 'http',
    baseUrl,
    capabilities: [
      {
        id: 'light',
        name: '灯光控制',
        actions: [
          {
            id: 'light:info',
            name: '查询灯光状态',
            description: '返回灯光当前状态',
            kind: 'info',
            risk: 'low'
          },
          {
            id: 'light:set',
            name: '设置灯光',
            description: '设置灯光亮度/开关',
            kind: 'control',
            risk: 'medium',
            params: [
              { name: 'on', type: 'boolean', description: '是否开灯', required: true },
              { name: 'brightness', type: 'number', description: '亮度 0-100', required: false }
            ]
          }
        ]
      }
    ]
  }
}

describe('DefaultDeviceManager', () => {
  let dataDir: string
  let mgr: DeviceManager
  /** 本地 HTTP 桩服务：记录收到的请求，回 JSON */
  let server: Server
  let calls: Array<{ url: string; method: string; body: unknown }> = []
  let baseUrl: string

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'abyss-devman-'))
    mgr = new DefaultDeviceManager()
    mgr.init(dataDir)

    server = createServer((req, res) => {
      let raw = ''
      req.on('data', (c) => { raw += c })
      req.on('end', () => {
        let body: unknown = raw
        try { body = JSON.parse(raw) } catch { /* 保持原文 */ }
        calls.push({ url: req.url ?? '', method: req.method ?? '', body })
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ received: body }))
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve()))
    )
    rmSync(dataDir, { recursive: true, force: true })
  })

  beforeEach(() => {
    calls = []
  })

  it('register 校验：非法 id / 空能力 / 缺端点均拒绝', async () => {
    await expect(mgr.register({ ...lampSpec(baseUrl), id: '中文id' })).rejects.toThrow(/仅允许/)
    await expect(mgr.register({ ...lampSpec(baseUrl), id: 'a b' })).rejects.toThrow(/仅允许/)
    await expect(
      mgr.register({ ...lampSpec(baseUrl), capabilities: [] })
    ).rejects.toThrow(/至少声明一个能力/)
    await expect(
      mgr.register({
        id: 'no-url', name: 'x', kind: 'y', transport: 'http',
        capabilities: lampSpec(baseUrl).capabilities
      })
    ).rejects.toThrow(/baseUrl 必填/)
    await expect(
      mgr.register({
        id: 'no-ws', name: 'x', kind: 'y', transport: 'ws',
        capabilities: lampSpec(baseUrl).capabilities
      })
    ).rejects.toThrow(/wsUrl 必填/)
  })

  it('register 成功：返回 reg: 前缀 id，且持久化到磁盘', async () => {
    const dev = await mgr.register(lampSpec(baseUrl))
    expect(dev.id).toBe('reg:test-lamp')
    expect(dev.source).toBe('registered')
    expect(dev.transport).toBe('http')
    expect(dev.capabilities[0].actions.map((a) => a.id)).toEqual(['light:info', 'light:set'])

    // 磁盘往返：注册表文件存在且含该设备
    const file = join(dataDir, 'device-registry.json')
    expect(existsSync(file)).toBe(true)
    const onDisk = JSON.parse(readFileSync(file, 'utf-8')) as Array<{ id: string }>
    expect(onDisk.find((d) => d.id === 'reg:test-lamp')).toBeTruthy()

    // 重复注册拒绝
    await expect(mgr.register(lampSpec(baseUrl))).rejects.toThrow(/已存在/)
    // getDevice 可查
    expect(mgr.getDevice('reg:test-lamp')?.name).toBe('测试卧室灯')
  })

  it('磁盘加载往返：init 到有注册表的目录能恢复注册设备', async () => {
    // 故意 init 到空目录（清空内存态），再写一份注册表文件后回到原目录，
    // 验证「重启后从磁盘恢复」路径真实生效
    const emptyDir = mkdtempSync(join(tmpdir(), 'abyss-devman-empty-'))
    try {
      const m2 = new DefaultDeviceManager()
      m2.init(emptyDir)
      await expect(m2.getDevice('reg:test-lamp')).toBeNull()

      // 把带 test-lamp 的注册表复制概念：直接用原 manager 的持久化文件内容
      const file = join(dataDir, 'device-registry.json')
      writeFileSync(join(emptyDir, 'device-registry.json'), readFileSync(file, 'utf-8'))

      const m3 = new DefaultDeviceManager()
      m3.init(emptyDir)
      expect(m3.getDevice('reg:test-lamp')?.name).toBe('测试卧室灯')
    } finally {
      rmSync(emptyDir, { recursive: true, force: true })
    }
  })

  it('call self：system:info 只读直通，返回本机运行时参数', async () => {
    const res = await mgr.call({ deviceId: 'self', actionId: 'system:info' })
    expect(res.ok).toBe(true)
    const data = res.data as Record<string, unknown>
    expect(data.logicalCores).toBeGreaterThan(0)
    expect(typeof data.cpuModel).toBe('string')
    expect(data.totalMemGB).toBeGreaterThan(0)
  })

  it('call：设备不存在 / 动作不存在 / self 非只读动作均拒绝', async () => {
    const notFound = await mgr.call({ deviceId: 'reg:nope', actionId: 'x' })
    expect(notFound.ok).toBe(false)
    expect(notFound.error).toMatch(/不存在或不可调用/)

    const badAction = await mgr.call({ deviceId: 'reg:test-lamp', actionId: 'light:nope' })
    expect(badAction.ok).toBe(false)
    expect(badAction.error).toMatch(/动作不存在/)

    const selfControl = await mgr.call({ deviceId: 'self', actionId: 'light:set' })
    expect(selfControl.ok).toBe(false)
    // self 只暴露 system:info 一个动作，控制类动作连动作都找不到 → 拒绝
    expect(selfControl.error).toMatch(/动作不存在/)
  })

  it('call registered info 动作：无需授权，向 HTTP 端点发请求', async () => {
    const res = await mgr.call({ deviceId: 'reg:test-lamp', actionId: 'light:info' })
    expect(res.ok).toBe(true)
    // HTTP 桩应收到 POST /light/info
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('/light/info')
    expect(calls[0].method).toBe('POST')
  })

  it('call registered control 动作：缺参数先行拦截', async () => {
    const res = await mgr.call({ deviceId: 'reg:test-lamp', actionId: 'light:set' })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/缺参: on/)
  })

  it('call registered control 动作：无 requestPermission 时 fail-closed 拒绝', async () => {
    const res = await mgr.call(
      { deviceId: 'reg:test-lamp', actionId: 'light:set', params: { on: true } },
      undefined
    )
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/未提供 requestPermission/)
    expect(calls).toHaveLength(0) // 未到达真实端点
  })

  it('call registered control 动作：用户拒绝则拒绝执行', async () => {
    const ctx = {
      requestPermission: async () => ({ allowed: false, reason: '用户不想开灯' })
    } as unknown as ToolContext
    const res = await mgr.call(
      { deviceId: 'reg:test-lamp', actionId: 'light:set', params: { on: true } },
      ctx
    )
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/用户拒绝/)
    expect(calls).toHaveLength(0)
  })

  it('call registered control 动作：用户授权后执行，参数按 JSON body 送达', async () => {
    let permissionAsked: unknown = null
    const ctx = {
      requestPermission: async (req: unknown) => {
        permissionAsked = req
        return { allowed: true, scope: 'once' }
      }
    } as unknown as ToolContext
    const res = await mgr.call(
      { deviceId: 'reg:test-lamp', actionId: 'light:set', params: { on: true, brightness: 70 } },
      ctx
    )
    expect(res.ok).toBe(true)
    // 授权请求携带 device 类型与动作内容
    const asked = permissionAsked as { type: string; description: string }
    expect(asked.type).toBe('device')
    expect(asked.description).toMatch(/测试卧室灯/)
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('/light/set')
    expect(calls[0].body).toEqual({ on: true, brightness: 70 })
    // 桩服务回显
    expect((res.data as { body: { received: unknown } }).body.received).toEqual({ on: true, brightness: 70 })
  })

  it('unregister 注销注册设备并同步持久化', async () => {
    const dev = await mgr.register({ ...lampSpec(baseUrl), id: 'temp-dev' })
    expect(mgr.getDevice(dev.id)).toBeTruthy()
    const res = mgr.unregister(dev.id)
    expect(res.ok).toBe(true)
    expect(mgr.getDevice(dev.id)).toBeNull()
    // 磁盘同步移除
    const onDisk = JSON.parse(readFileSync(join(dataDir, 'device-registry.json'), 'utf-8')) as Array<{ id: string }>
    expect(onDisk.find((d) => d.id === 'reg:temp-dev')).toBeUndefined()
    // 注销未注册设备报错
    expect(mgr.unregister('reg:ghost').ok).toBe(false)
  })
})