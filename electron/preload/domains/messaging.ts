/**
 * 消息接入 preload 域（外部平台 → 月蚀大脑的配置读取/保存与运行状态）。
 * 为什么存在：飞书等外部平台适配器跑在主进程，凭证明文只落在主进程 config.json，
 * 渲染侧只能经桥读取（后端已脱敏为 `***`）、保存与手动重启，不直接接触密钥。
 * 不删理由：设置页「消息接入」面板的读写与状态灯轮询全靠这三个方法，
 * 去掉即该面板取不到配置、保存无效（不是可选能力，是面板唯一数据来源）。
 */
import { ipcRenderer } from 'electron'
import type { MessagingConfig, MessagingContact } from '@shared/types'

/** messaging:get 返回：脱敏配置（appSecret 已被后端替换为 `***`）+ 运行状态 */
export interface MessagingStatusSnapshot {
  running: boolean
  handledCount: number
  lastError: string
}

export interface MessagingGetResult {
  config: MessagingConfig
  status: MessagingStatusSnapshot
}

export interface MessagingSaveResult {
  ok: boolean
  messaging?: MessagingConfig
  error?: string
}

export interface MessagingRestartResult {
  ok: boolean
  error?: string
}

export const api = {
  /** 读取消息接入配置（脱敏）与运行状态（设置页打开时读一次 + 状态灯 5s 轮询） */
  messagingGet: () => ipcRenderer.invoke('messaging:get') as Promise<MessagingGetResult>,
  /**
   * 保存消息接入配置（部分字段更新，后端与现有配置合并后热生效，无需重启）。
   * feishu 传 `{appId}` 不传 appSecret 时后端保留旧密钥，避免只改 ID 时把密钥抹掉。
   */
  messagingSave: (opts?: {
    enabled?: boolean
    feishu?: { appId?: string; appSecret?: string }
    allowFrom?: string[]
    contacts?: MessagingContact[]
  }) => ipcRenderer.invoke('messaging:save', opts ?? {}) as Promise<MessagingSaveResult>,
  /** 手动重启外部平台长连接（改凭证后的保险动作；正常保存即热生效） */
  messagingRestart: () => ipcRenderer.invoke('messaging:restart') as Promise<MessagingRestartResult>
}
