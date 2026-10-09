/**
 * restart-pending.ts —— 重启后自动续接（持久化标记）

 * 背景：AI 自我重启会终止主进程，内存里的持续激活续接状态随之丢失。
 * 重启后需要"自己激活自己"完成验证/续接，必须靠磁盘标记：

 * restartApp 前 writeRestartPending() 落盘标记（同步写，保证重启前写入完成）
 * 主进程启动后 consumeRestartPending() 读取并删除标记
 * 存在标记 → pushExternalEvent 注入激活事件 → AI 醒来执行续接任务

* 标记文件：{activationDir}/pending-restart.json
 * 内容：{ reason, createdAt }

 * 本文件同时承载系统生命周期信息（lifecycle.json：启动/关闭时间与原因），
 * 以提示词末尾静默注入的方式呈现，不触发激活事件打扰用户。
 */
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'fs'
import { join } from 'path'

export interface RestartPending {
  reason: string
  createdAt: number
}

export function pendingRestartPath(activationDir: string): string {
  return join(activationDir, 'pending-restart.json')
}

/**
 * 写入重启待办标记（同步写，必须在重启动作前完成落盘）
 * @param activationDir 激活目录（{dataDir}/.activation）
 * @param reason 重启原因/待续接任务描述（重启后注入给 AI 的内容）
 */
export function writeRestartPending(activationDir: string, reason: string): string {
  const path = pendingRestartPath(activationDir)
  const payload: RestartPending = { reason, createdAt: Date.now() }
  writeFileSync(path, JSON.stringify(payload, null, 2), 'utf-8')
  return path
}

/**
 * 消费重启待办标记：读取原因并删除标记文件
 * @returns 存在标记返回 reason，否则 null
 */
export function consumeRestartPending(activationDir: string): string | null {
  const path = pendingRestartPath(activationDir)
  if (!existsSync(path)) return null
  try {
    const payload = JSON.parse(readFileSync(path, 'utf-8')) as RestartPending
    return payload.reason ?? null
  } catch {
    // 标记文件损坏：返回 null（视为无标记），残留文件在 finally 中清理
    return null
  } finally {
    try {
      unlinkSync(path)
    } catch {
      // 删除失败不阻塞启动，下次启动会再次读到（幂等）
    }
  }
}

// ============================================================
// 系统生命周期（lifecycle.json）：AI 感知自身开/关时间
// ------------------------------------------------------------
// 背景（设计动机）：重启感知从「激活事件」降级为「提示词末尾静默信息」。
// 之前的 startup-marker 是消费后注入激活事件——每次重启都触发一次激活流程，打扰用户。
// 改为持久化 lifecycle.json：启动时写 startedAt/mode，关闭时写 lastShutdownAt/reason，
// buildInjectedMessages 末尾直接读取并拼成 system 消息——AI 每次醒来在提示词最后面
// 自然看到「上次何时关闭、本次何时启动」，不触发任何激活事件。
// ============================================================

export interface LifecycleInfo {
  /** 本次主进程启动时间戳 */
  startedAt: number
  /** 运行模式：dev（开发）/ packaged（打包） */
  mode: 'dev' | 'packaged'
  /** 上次关闭时间戳（首次运行 / 异常强杀时为 undefined） */
  lastShutdownAt?: number
  /** 上次关闭原因：ai-restart（AI 自我重启）/ user-quit（用户关闭）/ 缺失（异常退出） */
  lastShutdownReason?: 'ai-restart' | 'user-quit'
}

export function lifecyclePath(activationDir: string): string {
  return join(activationDir, 'lifecycle.json')
}

/** 读取生命周期信息（无文件 / 损坏返回 null，不抛错） */
export function readLifecycle(activationDir: string): LifecycleInfo | null {
  const path = lifecyclePath(activationDir)
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as LifecycleInfo
  } catch {
    return null
  }
}

/** 记录启动（同步写，whenReady 早期调用）：覆盖 startedAt/mode，保留上次关闭信息 */
export function recordStartup(activationDir: string, mode: 'dev' | 'packaged'): string {
  const path = lifecyclePath(activationDir)
  const prev = readLifecycle(activationDir)
  const payload: LifecycleInfo = {
    startedAt: Date.now(),
    mode,
    // 继承上次关闭信息（启动时若存在说明上次非正常退出——正常退出会在关闭时写入）
    ...(prev?.lastShutdownAt !== undefined ? { lastShutdownAt: prev.lastShutdownAt } : {}),
    ...(prev?.lastShutdownReason !== undefined ? { lastShutdownReason: prev.lastShutdownReason } : {})
  }
  writeFileSync(path, JSON.stringify(payload, null, 2), 'utf-8')
  return path
}

/** 记录关闭（同步写，before-quit 调用）：写入 lastShutdownAt + reason */
export function recordShutdown(
  activationDir: string,
  reason: 'ai-restart' | 'user-quit'
): string | null {
  const path = lifecyclePath(activationDir)
  const prev = readLifecycle(activationDir)
  const payload: LifecycleInfo = {
    startedAt: prev?.startedAt ?? Date.now(),
    mode: prev?.mode ?? 'dev',
    lastShutdownAt: Date.now(),
    lastShutdownReason: reason
  }
  writeFileSync(path, JSON.stringify(payload, null, 2), 'utf-8')
  return path
}

/** 构建生命周期注入文本（提示词末尾静默信息）；无信息返回 null */
export function buildLifecycleInjection(activationDir: string): string | null {
  const info = readLifecycle(activationDir)
  if (!info) return null
  const startTime = new Date(info.startedAt).toLocaleString('zh-CN')
  const modeText = info.mode === 'dev' ? '开发模式' : '打包模式'
  const lines = [`## 系统生命周期`, `- 本次启动：${startTime}（${modeText}）`]
  if (info.lastShutdownAt !== undefined) {
    const shutdownTime = new Date(info.lastShutdownAt).toLocaleString('zh-CN')
    const reasonText =
      info.lastShutdownReason === 'ai-restart'
        ? 'AI 自我重启'
        : info.lastShutdownReason === 'user-quit'
          ? '用户关闭'
          : '异常退出'
    lines.push(`- 上次关闭：${shutdownTime}（${reasonText}）`)
  } else {
    lines.push(`- 上次关闭：无记录（首次运行或异常强杀）`)
  }
  return lines.join('\n')
}
