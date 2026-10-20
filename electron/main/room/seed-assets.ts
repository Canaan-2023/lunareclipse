/**
 * @category ROOM
 * @summary 首次启动把**随包素材**（Live2D 模型 + Cubism Core + 分区背景）写入用户数据目录
 *
 * 为什么存在（用户 2026-10-20 明确要求）：分发版要「开箱就看到猫和背景」，而不是让用户
 * 自己往 `<data>/room/` 里拷文件。素材放在 `resources/room-seed/`（electron-builder
 * extraResources），首次启动按「目标不存在才复制」的规则落到 `<data>/room/`。
 *
 * 边界：
 * - **只增不改**：已存在的文件一律跳过，用户改过的外观/背景不会被覆盖；
 * - 只在**打包态**执行（dev 下 skip，避免把仓库里的素材复制进开发数据目录）；
 * - 失败不阻断启动：单个文件复制失败只跳过，整体异常由调用方记日志。
 *
 * 不删理由：删掉即分发版回到「代码房间 + 2D 回落」，与用户要求相反。
 */
import { app } from 'electron'
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'fs'
import { dirname, join } from 'path'
import type { BaseDataPaths } from '../models/paths'

/** 资源目录名（electron-builder `extraResources.to = 'room-seed'`） */
export const ROOM_SEED_DIR = 'room-seed'

/**
 * 递归复制「目标不存在的文件」，返回复制数量。
 * 为什么不是整目录 cp：素材与用户数据同域，整目录覆盖会抹掉用户的 appearance/背景。
 */
export function copyTreeMissing(src: string, dst: string): number {
  let copied = 0
  let entries: string[]
  try {
    entries = readdirSync(src)
  } catch {
    return 0
  }
  for (const name of entries) {
    const from = join(src, name)
    const to = join(dst, name)
    let st: ReturnType<typeof statSync>
    try {
      st = statSync(from)
    } catch {
      continue
    }
    if (st.isDirectory()) {
      copied += copyTreeMissing(from, to)
      continue
    }
    if (existsSync(to)) continue
    try {
      mkdirSync(dirname(to), { recursive: true })
      copyFileSync(from, to)
      copied += 1
    } catch {
      // 单个文件失败（占用/权限）不阻断其余素材
    }
  }
  return copied
}

/**
 * 打包态首次启动写入随包素材；返回复制数量，非打包态 / 无素材目录返回 null。
 */
export function seedRoomAssets(paths: BaseDataPaths): number | null {
  if (!app?.isPackaged) return null
  const src = join(process.resourcesPath, ROOM_SEED_DIR)
  if (!existsSync(src)) return null
  return copyTreeMissing(src, join(paths.root, 'room'))
}
