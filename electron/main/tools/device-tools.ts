/**
 * 设备接入工具（ 设备接入基底）
 *
 * 为什么存在：用户要求「借由这个接口做基底——检查当前设备连接的设备、找到它们的
 * 接口、让 AI 可以接入、调用、甚至扫描当前蓝牙/网络环境链接的设备让 AI 控制」。
 * 这三个工具把 DeviceManager 暴露给 LLM：
 * - device_scan：扫描当前环境设备（本机 / 局域网 / 蓝牙 / 已注册），返回设备列表
 * 与它们的能力接口（AI 据此知道"有哪些设备、能调用什么动作"）。
 * - device_register：AI 接入一台外部设备（声明其能力接口与 HTTP/WS 端点），
 * 持久化到注册表——这是"接入通道"。
 * - device_call：调用设备的能力接口；控制类动作先经 requestPermission 授权。
 *
 * 为什么独立成文件：与既有工具并列（clipboard / run-command 等模式一致），
 * DeviceManager 作为模块级单例注入（deviceManager），工具无状态、可测试。
 */
import type { Tool, ToolResult, ToolContext } from './base-tool'
import { deviceManager } from '../device/device-manager'
import type { AbyssDevice, DeviceRegisterSpec } from '../device/types'

/** 把设备压缩成给 AI 看的摘要（避免长描述塞爆上下文，保留能力接口） */
function summarize(device: AbyssDevice): unknown {
  return {
    id: device.id,
    name: device.name,
    source: device.source,
    kind: device.kind,
    address: device.address,
    status: device.status,
    capabilities: device.capabilities.map((cap) => ({
      capability: cap.id,
      name: cap.name,
      actions: cap.actions.map((a) => ({
        action: a.id,
        name: a.name,
        kind: a.kind,
        risk: a.risk,
        params: a.params,
        description: a.description
      }))
    }))
  }
}

/** device_scan：扫描当前环境连接的设备 */
export interface DeviceScanParams {
  /** 设备来源过滤：self（本机）/ lan（局域网）/ bluetooth（蓝牙）/ registered（已注册）；缺省全扫 */
  source?: 'self' | 'lan' | 'bluetooth' | 'registered'
}

export class DeviceScanTool implements Tool<DeviceScanParams> {
  name = 'device_scan'
  description =
    '扫描当前环境连接的设备（本机 / 局域网主机 / 蓝牙设备 / AI 已注册的自定义设备），返回每台设备的能力接口清单（可调用的 action）。只读操作。设备 id 供 device_call 使用；对 lan/bluetooth 设备想控制时先用 device_register 声明其接口。'
  parameters = [
    { name: 'source', type: 'string' as const, description: '设备来源过滤：self / lan / bluetooth / registered；缺省全部扫描', required: false }
  ]

  async execute(params: DeviceScanParams, _ctx?: ToolContext): Promise<ToolResult> {
    try {
      const devices = await deviceManager.scan()
      const filtered = params.source ? devices.filter((d) => d.source === params.source) : devices
      return {
        ok: true,
        data: {
          count: filtered.length,
          devices: filtered.map(summarize),
          hint: 'control 类 action 需用户授权后才执行；lan/bluetooth 为只读发现结果，需 device_register 声明后可调用'
        }
      }
    } catch (err) {
      return { ok: false, error: `设备扫描失败: ${(err as Error).message}` }
    }
  }
}

/** device_register：AI 接入一台外部设备 */
export interface DeviceRegisterParams {
  /** 设备 id（短英文，如 bedroom-lamp） */
  id: string
  /** 设备名（人读） */
  name: string
  /** 设备类别（人读，如 智能家居 / 局域网服务） */
  kind: string
  /** 端点协议：http（REST 调用）/ ws（WebSocket 发送） */
  transport: 'http' | 'ws'
  /** http 端点地址（transport=http 必填，如 http://192.0.2.50:8080） */
  baseUrl?: string
  /** ws 端点地址（transport=ws 必填） */
  wsUrl?: string
  /** 能力接口：actionId 的「:」会映射为 URL 路径段（climate:set → POST /climate/set） */
  capabilities: Array<{
    id: string
    name: string
    actions: Array<{
      id: string
      name: string
      description: string
      kind: 'info' | 'control'
      risk: 'low' | 'medium' | 'high'
      params?: Array<{ name: string; type: 'string' | 'number' | 'boolean'; description: string; required?: boolean }>
    }>
  }>
}

export class DeviceRegisterTool implements Tool<DeviceRegisterParams> {
  name = 'device_register'
  description =
    '把一台外部设备接入 AI 可控制的设备清单：声明设备 id、端点（HTTP 或 WS）与能力接口（可调用的 action 清单）。当 device_scan 发现设备、或用户要求接入某台设备时使用。注册后 device_scan 会列出该设备、device_call 可以调用它；设备信息保存在本地，重启应用后仍然可调用。'
  parameters = [
    { name: 'id', type: 'string' as const, description: '设备 id（仅字母/数字/-/_，1-64 字符，如 bedroom-lamp）', required: true },
    { name: 'name', type: 'string' as const, description: '设备名（人读，如 "卧室灯"）', required: true },
    { name: 'kind', type: 'string' as const, description: '设备类别（如 智能家居 / 局域网服务 / 传感器）', required: true },
    { name: 'transport', type: 'string' as const, description: '端点协议：http（REST）或 ws（WebSocket）', required: true },
    { name: 'baseUrl', type: 'string' as const, description: 'HTTP 端点地址（transport=http 必填，如 http://192.0.2.50:8080）', required: false },
    { name: 'wsUrl', type: 'string' as const, description: 'WebSocket 端点地址（transport=ws 必填）', required: false },
    { name: 'capabilities', type: 'array' as const, description: '能力接口清单：每项 { id, name, actions[] }，action 为 { id, name, description, kind(info/control), risk(low/medium/high), params[] }', required: true }
  ]

  async execute(params: DeviceRegisterParams): Promise<ToolResult> {
    try {
      const spec: DeviceRegisterSpec = {
        id: params.id,
        name: params.name,
        kind: params.kind,
        transport: params.transport,
        baseUrl: params.baseUrl,
        wsUrl: params.wsUrl,
        capabilities: params.capabilities
      }
      const device = await deviceManager.register(spec)
      return { ok: true, data: { registered: summarize(device), hint: '已注册；device_call 可调用该设备（control 动作需授权）' } }
    } catch (err) {
      return { ok: false, error: `设备注册失败: ${(err as Error).message}` }
    }
  }
}

/** device_call：调用设备能力接口 */
export interface DeviceCallParams {
  /** 目标设备 id（device_scan 返回的 id，或 reg: 前缀注册 id） */
  deviceId: string
  /** 动作 id（设备 capabilities[].actions[].id） */
  actionId: string
  /** 动作参数（按动作 params 声明） */
  params?: Record<string, unknown>
}

export class DeviceCallTool implements Tool<DeviceCallParams> {
  name = 'device_call'
  description =
    '调用设备的能力接口（action）：info 动作直接执行（只读）；control 动作（控制类）会请求用户授权，用户确认后执行。用于 AI 控制接入的设备（HTTP 设备发 POST 请求、WS 设备发消息）。'
  parameters = [
    { name: 'deviceId', type: 'string' as const, description: '目标设备 id（device_scan 返回的设备 id）', required: true },
    { name: 'actionId', type: 'string' as const, description: '动作 id（设备能力接口中的 action id，如 system:info / climate:set）', required: true },
    { name: 'params', type: 'object' as const, description: '动作参数（按动作声明的 params 传入）', required: false }
  ]

  async execute(params: DeviceCallParams, ctx?: ToolContext): Promise<ToolResult> {
    if (!params.deviceId || !params.actionId) {
      return { ok: false, error: 'deviceId 与 actionId 必填' }
    }
    try {
      // 只读 info 动作也经过这里；control 动作在 manager 内请求授权
      return await deviceManager.call(
        { deviceId: params.deviceId, actionId: params.actionId, params: params.params },
        ctx
      )
    } catch (err) {
      return { ok: false, error: `设备调用失败: ${(err as Error).message}` }
    }
  }
}