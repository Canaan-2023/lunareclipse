/**
 * 权限层 preload 域：能力目录 / 告知义务确认 / T1 授予 / 撤回 / 审计读取。
 *
 * 为什么存在：`security:*` 的**主进程**侧自 ADR-11 起就在（`ipc/handlers/security.ts`），
 * 但 preload 面与渲染面一直缺席——用户界面里没有任何地方能授予权限，于是「T1 默认关」
 * 事实上等于「T1 永远关」（用户 2026-10-19 指出：「前端 UI 没有权限授予的入口，也就是说
 * 当前无法授予任何权限」）。本域把那条已经存在的用户专属通道接到渲染侧。
 *
 * 边界（与主进程一致，勿放宽）：这些方法**不注册为工具**、不进 `config:set` 白名单，
 * 只有渲染进程（用户）能调；AI 在房间/无头链路里可达的工具面不含任何一项。
 */
import { ipcRenderer } from 'electron'

export const api = {
  /** 能力目录 + 当前授予 + 告知义务确认态（设置页权限面板与房间授权页的数据源） */
  securityListCapabilities: () =>
    ipcRenderer.invoke('security:listCapabilities') as Promise<{
      ok: boolean
      capabilities: unknown[]
      grants: Record<string, unknown>
      acknowledged: boolean
      /** 确认时刻（epoch ms）；未确认或条款升版后为 null */
      acknowledgedAt: number | null
      noticeVersion: number
    }>,
  /** 记录「已阅读并理解，授予造成的损失自担」——**授予的前置条件**（未确认时授予会被拒） */
  securityAcknowledge: () =>
    ipcRenderer.invoke('security:acknowledge') as Promise<{
      ok: boolean
      acknowledged?: boolean
      noticeVersion?: number
      error?: string
    }>,
  /** 授予一项 T1 能力（scoped 能力必须带范围，否则主进程拒绝） */
  securityGrant: (payload: { key: string; scope?: unknown; expiresAt?: number; note?: string }) =>
    ipcRenderer.invoke('security:grant', payload) as Promise<{
      ok: boolean
      grants?: Record<string, unknown>
      error?: string
    }>,
  /** 撤回一项授予（**永不设门**：收回权限的方向永远畅通） */
  securityRevoke: (key: string) =>
    ipcRenderer.invoke('security:revoke', key) as Promise<{
      ok: boolean
      grants?: Record<string, unknown>
      error?: string
    }>,
  /** 审计尾部（最近在后）：裁决 + 授予/撤回都落同一个 JSONL */
  securityListAudit: (limit?: number) =>
    ipcRenderer.invoke('security:listAudit', limit) as Promise<{ ok: boolean; entries: unknown[] }>
}
