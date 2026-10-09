/**
 * 为什么存在：AI 代理的自动回复/主动协作开关（聊天室/直聊粒度）需要按实例落盘、重启后保持，而非写进共享配置。
 * 作用：读写 ai-agent-config 配置文件，加载失败或缺失时回退默认配置（默认全关）。
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { dirname, join } from 'path'

/**
 * AI 代理配置：控制 AI 是否以用户身份在聊天室/私聊中自动回复，以及是否周期主动发起协作。
 * 每个聊天室可独立开关；私聊按好友独立开关（后续可扩展）。
 * 存储在 abyssac_data/ai-agent-config.json，与主配置隔离。
 */
export interface AiAgentConfig {
  /** 全局总开关（默认 false） */
  enabled: boolean
  /** 聊天室级别开关：gid → boolean（未设置时继承全局） */
  chatRooms: Record<string, boolean>
  /** 私聊（好友）级别开关：uid → boolean */
  directChats: Record<string, boolean>
  /** 主动发起开关：周期唤醒 AI 让它自行决定是否去各线路发言（默认 false） */
  proactive: boolean
  /** 主动发起间隔毫秒（默认 10 分钟；0 视为关闭） */
  proactiveIntervalMs: number
}

const DEFAULT_PROACTIVE_INTERVAL_MS = 600_000

const DEFAULT_CONFIG: AiAgentConfig = {
  enabled: false,
  chatRooms: {},
  directChats: {},
  proactive: false,
  proactiveIntervalMs: DEFAULT_PROACTIVE_INTERVAL_MS,
}

function loadOrDefault(path: string): AiAgentConfig {
  if (!existsSync(path)) return { ...DEFAULT_CONFIG }
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as Partial<AiAgentConfig>
    return {
      enabled: typeof raw.enabled === 'boolean' ? raw.enabled : DEFAULT_CONFIG.enabled,
      chatRooms: raw.chatRooms && typeof raw.chatRooms === 'object'
        ? raw.chatRooms
        : { ...DEFAULT_CONFIG.chatRooms },
      directChats: raw.directChats && typeof raw.directChats === 'object'
        ? raw.directChats
        : { ...DEFAULT_CONFIG.directChats },
      proactive: typeof raw.proactive === 'boolean' ? raw.proactive : DEFAULT_CONFIG.proactive,
      proactiveIntervalMs: typeof raw.proactiveIntervalMs === 'number' && raw.proactiveIntervalMs >= 0
        ? raw.proactiveIntervalMs
        : DEFAULT_CONFIG.proactiveIntervalMs,
    }
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

export class AiAgentConfigStore {
  private config: AiAgentConfig
  private filePath: string

  constructor(root: string) {
    this.filePath = join(root, 'ai-agent-config.json')
    this.config = loadOrDefault(this.filePath)
  }

  get(): AiAgentConfig {
    return this.config
  }

  /** 查询某聊天室 AI 代理是否启用（先查房间级，未设置回退全局） */
  isChatRoomEnabled(gid: string): boolean {
    return this.config.chatRooms[gid] ?? this.config.enabled
  }

  /** 查询私聊 AI 代理是否启用 */
  isDirectChatEnabled(chatId: string): boolean {
    return this.config.directChats[chatId] ?? this.config.enabled
  }

  /** 公示板：AI 是否自动参与公示板交流（跟随全局总开关，暂不做板块级独立开关） */
  isBoardEnabled(): boolean {
    return this.config.enabled
  }

  /** 是否启用「AI 主动发起协作」的周期唤醒 */
  isProactiveEnabled(): boolean {
    return this.config.proactive && this.config.proactiveIntervalMs > 0
  }

  /** 主动发起间隔毫秒 */
  getProactiveIntervalMs(): number {
    return this.config.proactiveIntervalMs
  }

  /** 设置全局总开关 */
  setEnabled(v: boolean): void {
    this.config.enabled = v
    this.save()
  }

  /** 设置主动发起开关 */
  setProactive(v: boolean): void {
    this.config.proactive = v
    this.save()
  }

  /** 设置主动发起间隔毫秒 */
  setProactiveInterval(ms: number): void {
    this.config.proactiveIntervalMs = ms
    this.save()
  }

  /** 设置某聊天室开关 */
  setChatRoom(gid: string, v: boolean): void {
    this.config.chatRooms[gid] = v
    this.save()
  }

  /** 设置某私聊开关 */
  setDirectChat(chatId: string, v: boolean): void {
    this.config.directChats[chatId] = v
    this.save()
  }

  private save(): void {
    mkdirSync(dirname(this.filePath), { recursive: true })
    writeFileSync(this.filePath, JSON.stringify(this.config, null, 2), 'utf-8')
  }
}
