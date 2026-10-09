/**
 * 一次性迁移脚本：skills / skills_domains / config 作用域裸数字分层 → U/AI 字面前缀分层
 *
 * 背景：getScopedPath 曾返回 {root}/{domain}/{uid}/{aiId}（裸数字分层），
 * 与 memory（U{uid}/AI{aiId}）、NNG/cache（AI{aiId}/U{uid}）的 U/AI 字面前缀
 * 约定不一致，属历史欠账。本次改造把三个域统一收拢到 paths.ts 的
 * scopedDomainPath() 唯一真源 {root}/{domain}/U{uid}/AI{aiId}/，
 * 磁盘既有数据需要搬到新位置，否则升级后旧技能/配置不可见。
 *
 * 迁移规则（幂等，可重复执行）：
 * 1. 目标 {root}/{domain}/U{uid}/AI{aiId} 已存在 → 跳过（不覆盖新数据，防冲突）
 * 2. 源 {root}/{domain}/{uid}/{aiId} 不存在 → 跳过
 * 3. 源存在且目标不存在 → 整目录 rename 到目标
 * 4. 顶层 {root}/{domain}/{entry}（非纯数字、非 U 前缀）属更早的未分层残留，
 *    不在本脚本范围（运行时 loader.migrateLegacyScopedData 登录后处理）
 *
 * 路径注入（禁止硬编码）：根 data 目录来自环境变量 ABYSSAC_DEV_ROOT
 *   （dataDir 指向的目录，即 app/data；其下 abyssac_data 为 dataRoot）。
 * 默认值仅用于开发环境兜底（app/data），生产/分发必须显式注入。
 *
 * 运行：node scripts/migrate-scoped-domains-uid-aiid.mjs [--dry-run]
 *   --dry-run 仅报告待迁移项，不落盘。
 */
import { existsSync, readdirSync, renameSync, mkdirSync, statSync, rmSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const appRoot = join(dirname(fileURLToPath(import.meta.url)), '..') // app/

// 根路径注入：dataDir 绝对路径（其下 abyssac_data 即 dataRoot，与 paths.ts buildDataPaths 一致）
const dataDir = process.env.ABYSSAC_DEV_ROOT || join(appRoot, 'data')
const root = join(dataDir, 'abyssac_data')
const DRY_RUN = process.argv.includes('--dry-run')

const DOMAINS = ['skills', 'skills_domains', 'config']

function isNumericScopeDir(name) {
  return /^\d+$/.test(name)
}

/** 单个 uid 目录下的裸数字 aiId 子目录全部迁到 U{uid}/AI{aiId} */
function migrateUidDomain(domainRoot, uidEntry) {
  const uidDir = join(domainRoot, uidEntry)
  let aiEntries
  try {
    aiEntries = readdirSync(uidDir).filter((n) => /^\d+$/.test(n))
  } catch {
    return 0
  }
  let moved = 0
  for (const aiEntry of aiEntries) {
    const from = join(uidDir, aiEntry)
    let st
    try {
      st = statSync(from)
    } catch {
      continue
    }
    if (!st.isDirectory()) continue
    const to = join(domainRoot, `U${uidEntry}`, `AI${aiEntry}`)
    if (existsSync(to)) {
      console.log(`[skip] 目标已存在（不覆盖）: ${to}  <-  ${from}`)
      continue
    }
    if (DRY_RUN) {
      console.log(`[dry-run] 待迁移: ${from} -> ${to}`)
      moved++
      continue
    }
    try {
      mkdirSync(dirname(to), { recursive: true })
      renameSync(from, to)
      console.log(`[migrated] ${from} -> ${to}`)
      moved++
    } catch (err) {
      console.error(`[failed] ${from} -> ${to}:`, err.message)
    }
  }
  // 迁移后旧 uid 壳目录若已空则删除（rename 留下的空壳，留着无意义只占位置）
  if (!DRY_RUN && moved > 0) {
    try {
      if (readdirSync(uidDir).length === 0) rmSync(uidDir, { recursive: true, force: true })
    } catch {
      // 删除空壳失败可容忍（不影响迁移结果，仅残留空目录）
    }
  }
  return moved
}

console.log(`[scope] dataRoot=${root}${DRY_RUN ? '（DRY-RUN，不落盘）' : ''}`)

if (!existsSync(root)) {
  console.warn(`[scope] dataRoot 不存在：${root}。请通过环境变量 ABYSSAC_DEV_ROOT 注入 dataDir。`)
  process.exit(1)
}

let total = 0
for (const domain of DOMAINS) {
  const domainRoot = join(root, domain)
  if (!existsSync(domainRoot)) continue
  const uidEntries = readdirSync(domainRoot).filter(isNumericScopeDir)
  for (const uidEntry of uidEntries) {
    total += migrateUidDomain(domainRoot, uidEntry)
  }
}

console.log(`[scope] 完成：${DRY_RUN ? '待迁移' : '已迁移'} ${total} 个作用域目录（domains=${DOMAINS.join(',')}）`)