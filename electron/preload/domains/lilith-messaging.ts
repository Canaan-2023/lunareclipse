/**
 * 莉莉丝桌宠连接 + 消息接入 preload 域。
 * 为什么存在：莉莉丝需要主进程检测/拉起游戏进程并建立本地桥接，外部平台（飞书等）消息
 * 适配器也在主进程生命周期内运行，前端仅做设置与状态查看。
 * 作用：暴露 lilith:detect/save/launch/status 及 messaging:get/save 等连接与接入方法。
 */
import { ipcRenderer } from 'electron'
import type { MessagingConfig, MessagingContact } from '@shared/types'

export const api = {
  // ===== 莉莉丝桌宠连接（设置页检测/保存/启动/状态） =====
  /** 自动检测游戏本体（扫描常见路径，返回 Lilith.exe 所在目录 + MOD 状态） */
  lilithDetect: () =>
    ipcRenderer.invoke('lilith:detect') as Promise<{ found: boolean; dir: string; hasMod: boolean; path: string }>,
  /** 保存连接配置（gamePath + autoStart + 总开关 + 人设等，持久化到 config.lilith） */
  lilithSave: (opts: {
    gamePath?: string
    autoStart?: boolean
    enabled?: boolean
    persona?: string
    mode?: 'character' | 'agent'
    toolPolicy?: Record<string, unknown>
    useAdapter?: boolean
    apiPort?: number
  }) =>
    ipcRenderer.invoke('lilith:save', opts) as Promise<{ ok: boolean; gamePath?: string; autoStart?: boolean; error?: string }>,
  /** 启动莉莉丝桌宠（MOD 完整时拉起 Lilith.exe） */
  lilithLaunch: () =>
    ipcRenderer.invoke('lilith:launch') as Promise<{ ok: boolean; alreadyRunning?: boolean; error?: string }>,
  /** 连接状态（设置页状态灯：游戏本体/MOD/进程/companion） */
  lilithStatus: () =>
    ipcRenderer.invoke('lilith:status') as Promise<{
      gamePath: string
      gameExists: boolean
      modExists: boolean
      gameRunning: boolean
      gamePid?: number
      companionRunning: boolean
      companionPort?: number
      modValid: boolean
    }>,

  // ===== 消息接入（2026-08-09：飞书等外部平台 → 月蚀大脑，设置页「消息接入」Tab） =====
  /** 获取消息接入配置 + 运行状态 */
  messagingGet: () =>
    ipcRenderer.invoke('messaging:get') as Promise<{
      config: MessagingConfig
      status: { running: boolean; handledCount: number; lastError: string }
    }>,
  /** 保存消息接入配置（开关/飞书凭证/白名单/联系人映射），保存即热生效 */
  messagingSave: (opts: {
    enabled?: boolean
    feishu?: { appId?: string; appSecret?: string }
    allowFrom?: string[]
    contacts?: MessagingContact[]
  }) =>
    ipcRenderer.invoke('messaging:save', opts) as Promise<{
      ok: boolean
      messaging?: MessagingConfig
      error?: string
    }>,
  /** 手动重启飞书长连接 */
  messagingRestart: () =>
    ipcRenderer.invoke('messaging:restart') as Promise<{ ok: boolean; error?: string }>,
}