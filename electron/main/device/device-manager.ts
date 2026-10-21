/**
 * 设备管理器（ 设备接入基底核心）
 *
 * 为什么存在：把「设备注册 + 能力接口 + 调用路由 + 授权」收敛为单一入口，供
 * device_scan / device_register / device_call 三个工具共用；注册设备持久化到
 * {dataDir}/device-registry.json，重启后保留（AI 接入的外部设备不会随进程消失）。
 *
 * 调用语义：
 * - info 动作：只读探测/查询，直接放行（不打扰用户）。
 * - control 动作：任何控制操作都必须先经 requestPermission 授权（fail-closed：
 * ctx 无 requestPermission 或用户拒绝/超时 → 拒绝执行）。这延续了 run_command /
 * system_setting / clipboard 的高风险工具护栏约定——「AI 控制外部设备」属于
 * 系统级操作，默认不可静默执行。
 *
 * 能力实现：
 * - self / lan / bluetooth 由 discovery 模块按只读能力声明（info 类）。
 * - registered 设备由 AI 声明能力，其动作按 transport 执行：
 * http：向 baseUrl 发请求（GET 参数 / POST JSON）；
 * ws：向 wsUrl 发送 JSON 消息（尚未实现连接管理，返回"接口就绪"占位——真实
 * WebSocket 设备接入需要连接生命周期管理， 基底先声明接口形态）。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import type { ToolContext } from '../tools/base-tool'
import { getRuntimeProfile } from '../performance/runtime-profile'
import type {
  AbyssDevice,
  DeviceAction,
  DeviceCallParamsShape,
  DeviceManager,
  DeviceRegisterSpec
} from './types'
import { discoverSelf, discoverLanDevices, discoverBluetoothDevices } from './discovery'

/** 注册设备持久化文件名 */
const REGISTRY_FILE = 'device-registry.json'

/** 运行时状态：注册设备 id → 设备（启动时从磁盘加载） */
let registeredDevices = new Map<string, AbyssDevice>()

export class DefaultDeviceManager implements DeviceManager {
  /** 注册表落盘目录（index.ts 装配时注入 dataDir） */
  private dataDir: string | null = null

  /** 装配：注入数据目录并加载已注册设备（幂等） */
  init(dataDir: string): void {
    if (this.dataDir === dataDir && registeredDevices.size > 0) return
    this.dataDir = dataDir
    this.loadRegistered()
  }

  /** 全量发现：本机 + 局域网 + 蓝牙 + 已注册设备 */
  async scan(): Promise<AbyssDevice[]> {
    const [self, lan, bt] = await Promise.all([
      Promise.resolve(discoverSelf()),
      discoverLanDevices(),
      discoverBluetoothDevices()
    ])
    return [...registeredDevices.values(), self, ...lan, ...bt]
  }

  getDevice(deviceId: string): AbyssDevice | null {
    return registeredDevices.get(deviceId) ?? null
  }

  async register(spec: DeviceRegisterSpec): Promise<AbyssDevice> {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(spec.id)) {
      throw new Error('设备 id 仅允许字母/数字/-/_（1-64 字符），如 bedroom-lamp')
    }
    if (registeredDevices.has(`reg:${spec.id}`)) {
      throw new Error(`设备已存在: ${spec.id}（可用 device_register 覆盖？暂不支持覆盖，先注销再注册）`)
    }
    if (!spec.capabilities || spec.capabilities.length === 0) {
      throw new Error('设备至少声明一个能力接口（capabilities 不能为空）')
    }
    if (spec.transport === 'http' && !spec.baseUrl) {
      throw new Error('transport=http 时 baseUrl 必填')
    }
    if (spec.transport === 'ws' && !spec.wsUrl) {
      throw new Error('transport=ws 时 wsUrl 必填')
    }
    const device: AbyssDevice = {
      id: `reg:${spec.id}`,
      name: spec.name,
      source: 'registered',
      kind: spec.kind,
      address: spec.transport === 'http' ? spec.baseUrl : spec.wsUrl,
      transport: spec.transport,
      status: '已注册',
      discoveredAt: Date.now(),
      capabilities: spec.capabilities
    }
    registeredDevices.set(device.id, device)
    this.persist()
    return device
  }

  unregister(deviceId: string): { ok: boolean; data?: unknown; error?: string } {
    if (!registeredDevices.has(deviceId)) {
      return { ok: false, error: `设备未注册: ${deviceId}` }
    }
    registeredDevices.delete(deviceId)
    this.persist()
    return { ok: true, data: { unregistered: deviceId } }
  }

  async call(req: DeviceCallParamsShape, ctx?: ToolContext): Promise<{ ok: boolean; data?: unknown; error?: string }> {
    // 查找设备：registered 注册表优先；self 为内置设备（支持 system:info 实时状态）
    let device = registeredDevices.get(req.deviceId) ?? null
    let isBuiltinInfo = false
    if (!device && req.deviceId === 'self') {
      device = discoverSelf()
      isBuiltinInfo = true
    }
    if (!device) {
      return { ok: false, error: `设备不存在或不可调用: ${req.deviceId}（device_call 仅支持 self 与 registered 设备；lan/bluetooth 设备是只读发现结果，需先 device_register 声明为可调用设备）` }
    }

    // 找动作
    let action: DeviceAction | null = null
    for (const cap of device.capabilities) {
      const found = cap.actions.find((a) => a.id === req.actionId)
      if (found) {
        action = found
        break
      }
    }
    if (!action) {
      return {
        ok: false,
        error: `动作不存在: ${req.actionId}（设备 ${device.id} 支持的动作: ${device.capabilities
          .flatMap((c) => c.actions.map((a) => a.id))
          .join(', ') || '无'}）`
      }
    }

    // 参数校验（按 action.params 声明）
    const params = req.params ?? {}
    for (const p of action.params ?? []) {
      if (p.required && (params[p.name] === undefined || params[p.name] === null)) {
        return { ok: false, error: `缺参: ${p.name}（${p.description}）` }
      }
    }

    // self 内置设备：仅支持只读 info 动作（实时状态），控制类动作拒绝
    if (isBuiltinInfo) {
      if (action.kind !== 'info' || action.id !== 'system:info') {
        return { ok: false, error: `self 设备仅支持只读动作 system:info（请求 ${action.id} 被拒绝）` }
      }
      return { ok: true, data: buildSelfInfo() }
    }

    // 控制类动作授权（fail-closed）
    if (action.kind === 'control') {
      if (!ctx?.requestPermission) {
        return { ok: false, error: `控制动作 ${action.id} 需要用户授权，但当前上下文未提供 requestPermission` }
      }
      const resp = await ctx.requestPermission({
        type: 'device',
        description: `AI 请求控制设备「${device.name}」：${action.name}`,
        content: `设备: ${device.id}（${device.kind} @ ${device.address ?? '无地址'}）\n动作: ${action.id}\n参数: ${JSON.stringify(params)}`,
        risk: action.risk
      })
      if (!resp.allowed) {
        return { ok: false, error: `用户拒绝控制设备「${device.name}」: ${resp.reason ?? '无原因'}` }
      }
    }

    // 执行动作（registered 设备按 transport 执行）
    try {
      return await executeRegisteredAction(device, action, params)
    } catch (err) {
      return { ok: false, error: `调用设备动作失败: ${(err as Error).message}` }
    }
  }

  /** 从磁盘加载已注册设备 */
  private loadRegistered(): void {
    if (!this.dataDir) return
    const file = join(this.dataDir, REGISTRY_FILE)
    if (!existsSync(file)) {
      // 空数据目录 = 空注册表：显式清空，避免 init 换目录后残留旧内存态
      registeredDevices = new Map()
      return
    }
    try {
      const raw = JSON.parse(readFileSync(file, 'utf-8')) as AbyssDevice[]
      if (Array.isArray(raw)) {
        registeredDevices = new Map(
          raw.filter((d) => d && typeof d.id === 'string' && d.id.startsWith('reg:')).map((d) => [d.id, d])
        )
      }
    } catch (err) {
      console.warn('[device] 注册表加载失败（忽略，按空注册表启动）:', (err as Error).message)
      registeredDevices = new Map()
    }
  }

  /** 持久化注册设备 */
  private persist(): void {
    if (!this.dataDir) return
    try {
      const dir = this.dataDir
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, REGISTRY_FILE), JSON.stringify([...registeredDevices.values()], null, 2), 'utf-8')
    } catch (err) {
      console.error('[device] 注册表持久化失败:', (err as Error).message)
    }
  }
}

/** 执行 registered 设备的动作：http 走 REST，ws 走占位声明（连接管理待扩展） */
async function executeRegisteredAction(
  device: AbyssDevice,
  action: DeviceAction,
  params: Record<string, unknown>
): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  const transport = device.transport
  if (transport === 'http') {
    const baseUrl = device.address
    if (!baseUrl) return { ok: false, error: 'HTTP 设备缺少 baseUrl' }
    // 动作 id 即路径段（如 climate:set → POST /climate/set），参数作为 JSON body
    const url = `${baseUrl.replace(/\/$/, '')}/${action.id.replace(':', '/')}`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 8000)
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
        signal: controller.signal
      })
      const text = await resp.text()
      let body: unknown = text
      try { body = JSON.parse(text) } catch { /* 非 JSON 返回原文 */ }
      return { ok: resp.ok, data: { status: resp.status, body } }
    } catch (err) {
      return {
        ok: false,
        error: `HTTP 调用失败: ${(err as Error).message}（${url}）`
      }
    } finally {
      clearTimeout(timer)
    }
  }

  if (transport === 'ws') {
    const wsUrl = device.address
    return {
      ok: false,
      error:
        `WebSocket 设备（${wsUrl ?? '无地址'}）的消息发送需要连接生命周期管理（T3 基底预留接口形态，` +
        `尚未实现常驻 WS 连接；建议将设备能力声明为 http transport，或用 ws 设备做只读 capability 声明）。`
    }
  }

  return { ok: false, error: `未知 transport（${String(transport)}）` }
}

/** self 设备 system:info 动作的实时状态载荷（复用 runtime-profile） */
function buildSelfInfo(): { platform: string; cpuModel: string; logicalCores: number; physicalCores: number | null; totalMemGB: number; freeMemGB: number; cpuUsagePct: number; sampledAt: number } {
  const profile = getRuntimeProfile()
  const hw = profile.hardware
  return {
    platform: hw.platform,
    cpuModel: hw.cpuModel,
    logicalCores: hw.logicalCores,
    physicalCores: hw.physicalCores,
    totalMemGB: Math.round((hw.totalMemBytes / (1024 ** 3)) * 10) / 10,
    freeMemGB: Math.round((profile.freeMemBytes / (1024 ** 3)) * 10) / 10,
    cpuUsagePct: Math.round(profile.cpuUsagePct * 10) / 10,
    sampledAt: profile.sampledAt
  }
}

/** 全局单例：工具与装配点共用 */
export const deviceManager = new DefaultDeviceManager()