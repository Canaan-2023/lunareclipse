/**
 * 一次性迁移脚本：sessions 作用域裸数字分层 → U/AI 字面前缀分层
 *
 * 背景：sessions 曾是唯一保留裸数字分层 {root}/sessions/{uid}/{aiId} 的作用域，
 * 与 memory（U{uid}/AI{aiId}）、NNG/cache（AI{aiId}/U{uid}）的前缀约定不一致，
 * 属历史欠账。本次改造把 sessions 收拢到 paths.ts resolveScopePaths 的
 * U/AI 字面前缀语义 {root}/sessions/U{uid}/AI{aiId}/，磁盘既有数据需要搬到
 * 新位置，否则升级后旧会话在 scoped 目录下不可见（SessionStore 只在 scoped
 * 目录读写）。
 *
 * 迁移规则（幂等，可重复执行）：
 * 1. 目标 {root}/sessions/U{uid}/AI{aiId} 已存在 → 跳过（不覆盖新数据，防冲突）
 * 2. 源 {root}/sessions/{uid}/{aiId} 不存在 → 跳过
 * 3. 源存在且目标不存在 → 整目录 rename 到目标（先补建 U{uid} 父骨架）
 * 4. rename 后清理遗留空父目录 {root}/sessions/{uid}（非空说明仍有其它 AI 残留，跳过）
 * 5. 顶层纯数字目录若无纯数字子目录（如 headless 会话/冻结状态直挂根）不迁移
 *
 * 路径注入（禁止硬编码）：根 data 目录来自环境变量 ABYSSAC_DEV_ROOT
 *   （dataDir 指向的目录，即 app/data；其下 abyssac_data 为 dataRoot）。
 * 默认值仅用于开发环境兜底（app/data），生产/分发必须显式注入。
 *
 * 运行时兜底：登录/注册/运行期建新 AI 均经 ensureUserScopeSkeleton（
 * electron/main/services/user-scope-skeleton.ts 的 migrateLegacySessions），
 * 本脚本仅用于升级前离线整库迁移。
 *
 * 运行：node scripts/migrate-sessions-scope-prefix.mjs [--dry-run]
 *   --dry-run 仅报告待迁移项，不落盘。
 */
import { existsSync, readdirSync, renameSync, mkdirSync, rmdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const appRoot = join(dirname(fileURLToPath(import.meta.url)), '..') // app/

// 根路径注入：dataDir 绝对路径（其下 abyssac_data 即 dataRoot，与 paths.ts buildDataPaths 一致）
const dataDir = process.env.ABYSSAC_DEV_ROOT || join(appRoot, 'data')
const root = join(dataDir, 'abyssac_data')
const DRY_RUN = process.argv.includes('--dry-run')

const sessionsDir = join(root, 'sessions')

function isNumeric(name) {
  return /^\d+$/.test(name)
}

function migrate() {
  if (!existsSync(sessionsDir)) {
    console.log(`[sessions-migrate] sessions 目录不存在，无迁移项: ${sessionsDir}`)
    return
  }
  const topEntries = readdirSync(sessionsDir, { withFileTypes: true })
  let moved = 0
  let skipped = 0
  for (const uidEntry of topEntries) {
    if (!uidEntry.isDirectory() || !isNumeric(uidEntry.name)) continue
    const uidDir = join(sessionsDir, uidEntry.name)
    const aiEntries = readdirSync(uidDir, { withFileTypes: true })
    for (const aiEntry of aiEntries) {
      if (!aiEntry.isDirectory() || !isNumeric(aiEntry.name)) continue
      const legacy = join(uidDir, aiEntry.name)
      const target = join(sessionsDir, `U${uidEntry.name}`, `AI${aiEntry.name}`)
      if (existsSync(target)) {
        skipped++
        continue // 目标已存在（新数据或已迁移），不覆盖
      }
      if (DRY_RUN) {
        console.log(`[sessions-migrate] [dry-run] 将迁移: ${legacy} → ${target}`)
        moved++
        continue
      }
      try {
        mkdirSync(dirname(target), { recursive: true })
        renameSync(legacy, target)
        moved++
        console.log(`[sessions-migrate] 已迁移: ${legacy} → ${target}`)
        try {
          rmdirSync(uidDir) // 清空遗留父目录（还有其它 AI 残留时抛错忽略）
        } catch {
          /* 父目录非空，保留 */
        }
      } catch (err) {
        console.error(`[sessions-migrate] 迁移失败 ${legacy} → ${target}:`, err.message)
      }
    }
  }
  console.log(
    `[sessions-migrate] ${DRY_RUN ? '（dry-run）待迁移' : '完成'} ${moved} 项${skipped ? `，跳过 ${skipped} 项（目标已存在）` : ''}`
  )
}

migrate()