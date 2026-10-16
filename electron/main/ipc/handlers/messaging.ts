/**
 * 消息接入 IPC：如流等消息服务配置的读取/保存与运行状态查询，
 * appSecret 脱敏返回（前端只显示已配置/未配置），保存后热生效无需重启。
 */
import type { IpcMainInvokeEvent } from 'electron'
import type { ConfigStore } from '../../api/config-store'
import type { UserStore } from '../../models/user-store'
import { getMessagingService } from '../../api/server'
import type { MessagingContact } from '@shared/types'
import { DEFAULT_CONFIG } from '@shared/types'
import { createAuthGuard } from './safe-handle'

export function registerMessagingHandlers(
  ipc: typeof import('electron').ipcMain,
  configStore: ConfigStore,
  getUserStore?: () => UserStore | null
): void {
  const authCheck = getUserStore ? createAuthGuard(getUserStore) : null
  // 获取配置 + 运行状态（appSecret 脱敏返回，前端只显示「已配置/未配置」）
  ipc.handle('messaging:get', () => {
    const cfg = configStore.get().messaging ?? DEFAULT_CONFIG.messaging!
    const svc = getMessagingService()
    const safeCfg = {
      ...cfg,
      feishu: cfg.feishu
        ? { appId: cfg.feishu.appId, appSecret: cfg.feishu.appSecret ? '***' : '' }
        : undefined
    }
    return {
      config: safeCfg,
      status: svc ? svc.status() : { running: false, handledCount: 0, lastError: '' }
    }
  })

  // 保存配置（部分字段更新，后端合并；保存后热生效，无需重启）
  ipc.handle(
    'messaging:save',
    async (
      _e: IpcMainInvokeEvent,
      opts: {
        enabled?: boolean
        feishu?: { appId?: string; appSecret?: string }
        allowFrom?: string[]
        contacts?: MessagingContact[]
      } = {}
    ) => {
      if (authCheck && !authCheck()) {
        return { ok: false, error: '请先登录' }
      }
      try {
        const cfg = configStore.get()
        const current = cfg.messaging ?? DEFAULT_CONFIG.messaging!
        const next = {
          ...cfg,
          messaging: {
            enabled: opts.enabled ?? current.enabled,
            // 飞书凭证：部分字段合并（避免只传 appId 时丢 appSecret）
            feishu:
              opts.feishu !== undefined
                ? {
                    appId: opts.feishu.appId ?? current.feishu?.appId ?? '',
                    appSecret: opts.feishu.appSecret ?? current.feishu?.appSecret ?? ''
                  }
                : current.feishu,
            allowFrom: opts.allowFrom ?? current.allowFrom ?? [],
            contacts: opts.contacts ?? current.contacts ?? []
          }
        }
        configStore.save(next)
        // 热生效：server.ts 已订阅 configStore，sync() 会自动启停/重启飞书长连接
        // 返回脱敏配置（与 messaging:get 一致，不暴露明文 appSecret）
        const safeMessaging = {
          ...next.messaging,
          feishu: next.messaging.feishu
            ? { appId: next.messaging.feishu.appId, appSecret: next.messaging.feishu.appSecret ? '***' : '' }
            : undefined
        }
        return { ok: true, messaging: safeMessaging }
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    }
  )

  // 手动重启飞书长连接（改凭证后保险；正常情况保存即热生效）
  ipc.handle('messaging:restart', () => {
    if (authCheck && !authCheck()) {
      return { ok: false, error: '请先登录' }
    }
    try {
      getMessagingService()?.sync()
      return { ok: true }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })
}
