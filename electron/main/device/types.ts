/**
 * 设备接入基底——类型契约
 *
 * 为什么存在：月蚀此前只能控制"自己"（文件/命令/浏览器），对「当前设备连接的外部
 * 设备」（蓝牙耳机 / 局域网主机 / 智能家居 / AI 注册的自定义设备）没有统一抽象。
 * 用户要求做一个基底：扫描当前设备连接的设备 → 发现并抽象其能力接口 → 让 AI
 * 可以接入、调用、控制。本文件定义这个基底的全部公开类型。
 *
 * 分层：
 * - AbyssDevice：设备统一形态（发现结果 / 注册结果 / 调用目标都是它）
 * - DeviceCapability：一台设备对外暴露的能力接口（动作 + 参数 + 风险）
 * - 调用通道：device_scan（发现）→ device_register（接入）→ device_call（调用）
 */
import type { ToolContext } from '../tools/base-tool'

/**
 * 设备来源：
 * - self：本机（月蚀运行所在的电脑，能力=系统的硬件/资源接口，复用 runtime-profile）
 * - lan：局域网主机（ARP 表 / 网卡扫描发现）
 * - bluetooth：蓝牙设备（Windows 已配对/已连接枚举）
 * - registered：AI 或用户显式注册的自定义设备（HTTP/WS 端点抽象，持久化）
 */
export type DeviceSource = 'self' | 'lan' | 'bluetooth' | 'registered'

/** 动作风险等级（决定 device_call 是否走 requestPermission 授权） */
export type DeviceActionRisk = 'low' | 'medium' | 'high'

/**
 * 设备能力接口：一步可调用的动作。
 * kind='info' 为只读查询（直接放行）；kind='control' 为控制类（默认需授权）。
 */
export interface DeviceAction {
  /** 动作 id（设备内唯一），如 'system:info' / 'power:on' */
  id: string
  /** 动作名（人读，如 "获取系统状态"） */
  name: string
  /** 动作描述（给 AI 看怎么调用、返回什么） */
  description: string
  /** 动作类型：info=只读信息 / control=控制操作 */
  kind: 'info' | 'control'
  /** 风险等级：control 动作按 risk 走授权（low 也要经权限确认——控制类默认不可静默执行） */
  risk: DeviceActionRisk
  /** 动作参数声明（device_call 的 params 字段按此校验） */
  params?: Array<{ name: string; type: 'string' | 'number' | 'boolean'; description: string; required?: boolean }>
}

/** 设备能力分组：一组相关动作（如 climate: { info, set }） */
export interface DeviceCapability {
  /** 能力 id，如 'system' / 'climate' / 'media' */
  id: string
  /** 能力名（人读） */
  name: string
  /** 该能力下可调用的动作 */
  actions: DeviceAction[]
}

/** 设备统一形态 */
export interface AbyssDevice {
  /** 设备 id（全局唯一：self / lan:192.0.2.3 / bt:MAC / reg:自定义名） */
  id: string
  /** 设备名（人读） */
  name: string
  source: DeviceSource
  /** 设备类别（人读），如 "本机" / "局域网主机" / "蓝牙耳机" / "自定义设备" */
  kind: string
  /** 可寻址信息：IP / MAC / 端点 URL 等（self 缺省） */
  address?: string
  /** 注册设备的端点协议（source=registered 时有值） */
  transport?: 'http' | 'ws'
  /** 设备状态（发现时的快照） */
  status?: string
  /** 能力接口列表 */
  capabilities: DeviceCapability[]
  /** 发现/注册时间（毫秒时间戳） */
  discoveredAt: number
}

/**
 * 自定义设备注册规格（device_register 入参）。
 * target 为 HTTP(S)/WS 端点；device_call 调用动作时按 action 的 transport 构造请求。
 */
export interface DeviceRegisterSpec {
  /** 设备 id（建议短英文，如 'bedroom-lamp'；与既有 id 冲突则报错） */
  id: string
  /** 设备名（人读，如 "卧室灯"） */
  name: string
  /** 设备类别（人读，如 "智能家居"） */
  kind: string
  /** 端点协议：http（REST 调用）/ ws（WebSocket 发送消息） */
  transport: 'http' | 'ws'
  /** http 端点地址（transport=http 必填，如 http://192.0.2.50:8080） */
  baseUrl?: string
  /** ws 端点地址（transport=ws 必填，如 ws://192.0.2.50:8080/ws） */
  wsUrl?: string
  /** 能力接口列表（AI 按该设备的真实能力声明） */
  capabilities: DeviceCapability[]
}

/** device_call 入参 */
export interface DeviceCallParamsShape {
  /** 目标设备 id（device_scan 返回的设备 id） */
  deviceId: string
  /** 动作 id（设备 capabilities[].actions[].id） */
  actionId: string
  /** 动作参数（按动作 params 声明） */
  params?: Record<string, unknown>
}

/** device_call 执行函数签名（设备能力的实现由各 transport 提供） */
export type DeviceActionExecutor = (
  action: DeviceAction,
  params: Record<string, unknown>,
  ctx?: ToolContext
) => Promise<{ ok: boolean; data?: unknown; error?: string }>

/** 设备管理器对外接口（device_scan / device_call / device_register 工具经此访问） */
export interface DeviceManager {
  /** 全量发现：本机 + 局域网 + 蓝牙 + 已注册设备，返回设备列表（含各自能力接口） */
  scan(): Promise<AbyssDevice[]>
  /** 查询单台设备（scan 或 register 过的） */
  getDevice(deviceId: string): AbyssDevice | null
  /** 注册自定义设备（持久化，重启后保留） */
  register(spec: DeviceRegisterSpec): Promise<AbyssDevice>
  /** 注销自定义设备 */
  unregister(deviceId: string): { ok: boolean; error?: string }
  /**
   * 调用设备能力接口：
   * info 动作直接执行；control 动作必须先经 requestPermission 授权（fail-closed）。
   */
  call(req: { deviceId: string; actionId: string; params?: Record<string, unknown> }, ctx?: ToolContext): Promise<{ ok: boolean; data?: unknown; error?: string }>
}