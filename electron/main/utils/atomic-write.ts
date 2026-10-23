/**
 * 原子写公共工具（Windows 文件锁容错）。
 *
 * 为什么存在：Electron 主进程多个 store 采用「写 .tmp → renameSync 到目标」的原子写，
 * Windows 下目标文件被杀软扫描或其它句柄短暂占用时 renameSync 偶发 EPERM
 * （chat-room-chat-store、internal-session-store 均实测复现过），单次调用直接抛错
 * 导致保存失败。本模块收敛「EPERM 重试 + 删除目标后重试」的容错策略，避免各调用点
 * 各自手写一份。
 *
 * 策略与语义：
 * - 先重试若干次（每次间隔 retryDelayMs，等短期占用释放）；
 * - EPERM 重试耗尽仍失败时，尝试删除目标文件再 rename（与 workflow/persister.ts
 *   的 Windows 兼容策略同源；目标文件被读取句柄占用时删除通常比覆盖重命名更易成功）；
 * - 仍失败则抛出最新错误，错误语义与直接调用 renameSync 一致；
 * - 非 EPERM 错误（ENOENT/ENOTDIR/EACCES 等）不重试，原样抛出，保留调用方既有处理。
 *
 * 默认值依据（2026-10 模拟实测，Windows + 独立线程句柄占用目标文件）：
 * - 占用 ≤250ms（retries=5 × retryDelayMs=50 的重试窗口）：6/6 次在窗口内成功，
 *   耗时 ≈ 占用时长 + 轮询粒度（≤50ms）；
 * - 占用 >250ms：5 次重试耗尽后进入删除目标 fallback，实测约 300ms 收敛成功，
 *   不随占用时长线性增长；占用方不允许删除时最终抛出（语义：持续占用不无限阻塞）。
 * - 因此 5×50ms 覆盖典型短暂占用（杀软扫描/句柄瞬时锁定），
 *   同时把同步路径最坏等待控制在亚秒级，避免保存链路长期卡死。
 */

import { renameSync, unlinkSync } from 'fs'

export interface RenameFileWithRetryOptions {
  /** EPERM（Windows 文件锁）最大重试次数，默认 5；依据见文件头注释的模拟实测 */
  retries?: number
  /** 每次重试间隔毫秒，默认 50；测试可传 0 避免真实等待 */
  retryDelayMs?: number
}

/** 同步等待（Node 无内置同步 sleep；仅在 EPERM 重试路径调用，至多 retries×delay 毫秒） */
function syncSleep(ms: number): void {
  if (ms <= 0) return
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function isEperm(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === 'EPERM'
}

/**
 * 带 Windows 文件锁容错的 rename：EPERM 重试 → 删除目标后重试 → 抛出。
 * 成功结果与 renameSync 完全一致（src 替换 dest），失败时错误语义不变。
 */
export function renameFileWithRetry(
  src: string,
  dest: string,
  opts: RenameFileWithRetryOptions = {}
): void {
  const { retries = 5, retryDelayMs = 50 } = opts

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      renameSync(src, dest)
      return
    } catch (err) {
      if (!isEperm(err)) throw err
      if (attempt < retries) {
        console.warn(
          `[atomic-write] rename EPERM（Windows 文件锁）重试 ${attempt + 1}/${retries}: ${src} -> ${dest}`
        )
        syncSleep(retryDelayMs)
        continue
      }
      // 重试耗尽：目标被占用时先删目标再 rename（与 workflow/persister.ts 同源策略）
      try {
        unlinkSync(dest)
      } catch {
        // 目标可能不存在或同样被占用，忽略后仍尝试 rename
      }
      try {
        renameSync(src, dest)
        return
      } catch (finalErr) {
        console.warn(
          `[atomic-write] rename 最终失败（删除目标后仍失败）: ${src} -> ${dest}`
        )
        throw finalErr
      }
    }
  }
}