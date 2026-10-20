/**
 * @category ROOM
 * @summary 感知策略持久化：每个房间一份（`<data>/room/sensor-policy/<roomSessionId>.json`）
 *
 * 为什么存在：AI 在计划里声明的感知策略（屏蔽哪个信号 / 间隔 / 阈值）是**它的配置**，
 * 不该在应用重启后悄悄回到系统默认——那等于「AI 配了也不算数」。
 *
 * 存储口径：
 * - **按房间隔离**：文件名用房间自持会话 id（`room-autonomous-U{uid}-AI{aiId}`），
 *   换 AI / 换用户天然各一份；
 * - **记录型 JSON 原子写**：复用 `renameFileWithRetry`（Windows EPERM 重试），与形象 / 工具区一致；
 * - **读取不校验语义**：本类只负责「读出来 / 写进去」，合法性由 `@shared/room/sensor-policy`
 *   在运行时入口校验（fail-closed：非法即回落默认策略）。
 *
 * 不删理由：删掉即 AI 的感知配置每次启动都丢失，用户看到的「它自己配的」只是假象。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import type { RoomSensorPolicy } from '@shared/room/sensor-policy'
import { renameFileWithRetry } from '../utils/atomic-write'

/** 房间会话 id 只允许安全字符；其它一律替换，避免路径穿越（防御性，正常 id 不会命中）。 */
function safeName(roomSessionId: string): string {
  return roomSessionId.replace(/[^A-Za-z0-9._-]/g, '_')
}

export class SensorPolicyStore {
  constructor(private readonly root: string) {}

  private filePath(roomSessionId: string): string {
    return join(this.root, `${safeName(roomSessionId)}.json`)
  }

  /** 读取原始 JSON；文件缺失 / 解析失败返回 undefined（调用方回落默认策略）。 */
  load(roomSessionId: string): unknown {
    const p = this.filePath(roomSessionId)
    if (!existsSync(p)) return undefined
    try {
      return JSON.parse(readFileSync(p, 'utf-8')) as unknown
    } catch {
      return undefined
    }
  }

  /** 写入（调用方已校验策略；本方法只负责原子落盘）。 */
  save(roomSessionId: string, policy: RoomSensorPolicy): void {
    const p = this.filePath(roomSessionId)
    mkdirSync(dirname(p), { recursive: true })
    const tmp = `${p}.tmp`
    writeFileSync(tmp, JSON.stringify(policy, null, 2), 'utf-8')
    renameFileWithRetry(tmp, p)
  }
}
