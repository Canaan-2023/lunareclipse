/**
 * 用户工作域级联清理（注销询问 / 账号管理「清理工作域」共用，按 uid 清空该账号全部 AI 工作域）。
 *
 * 为什么存在——账号注销或治理时需「清空某账号在本机的全部数据」：记忆/会话/技能/配置/
 * NNG/cache/ABYSS 等每账号独占域，以及主系统侧为分系统账号归集的会话与日备份。
 * 它与 purgeAiWorkspace 互补：
 * - purgeAiWorkspace(aiId)：删一个 AI 的全部用户作用域（一个 AI 跨所有 uid）；
 * - purgeUserWorkspace(uid)：删一个 uid 的全部 AI 作用域（一个 uid 跨所有 AI）。
 *
 * 清理范围（全部以 abyssac_data 为 root，按该 uid 独占路径定位）：
 * - 记忆工作域：{root}/memory/U{uid}（整目录，覆盖全部 AI 子域）
 * - NNG 认知图谱：{root}/NNG/AI{aiId}/U{uid}（AIID 在前，遍历各 AI 删该 uid 子树）
 * - cache 缓存：{root}/cache/AI{aiId}/U{uid}（同上）
 * - 会话：{root}/sessions/U{uid}（含旧裸数字 {uid} 残留；AI 层在其下）
 * - 技能/技能域/配置：{root}/{skills,skills_domains,config}/U{uid}（含旧裸数字残留）
 * - 自我认知：{root}/ABYSS/U{uid}（USER.md + AI{aiId}/AI.md 一并清，属该 uid 工作域）
 * - 用户头像：{root}/avatars/user/{uid}（若存在）
 * - 分系统归集会话：{root}/sessions_satellite/{instanceId}/U{uid}（主系统侧，遍历 instanceId）
 * - 日备份：{root}/backup/U{uid}（备份中心按 {uid}/{date} 归档，uid 级清）
 * - AI 社交私聊：{root}/federation/ai-chats/ai_{uid}_*_*.json（首段 uid 命中即删）
 * - SKILL 市场安装记录：{root}/skill-market/manifest.json 中该 uid 全部作用域（U{uid}/…）记录
 *
 * 边界（不清理）：
 * - 账号本体（users.json / ai-registry.json / instance.json）——只清工作域数据，不动账号
 * - 同步水位（master_seq/*.json）——基础设施，删后断线重连无法续传
 * - 全局共享域（plugins / plugins_domains / cron / task_details / frontend / dmn2 /
 * mission / patch / system-catalog / thinking-log / workflows）——跨账号基础设施或全局配置
 * - 已删除的 AI 注册表项对应孤儿目录：不在此轮范围（purgeAiWorkspace 负责 AI 维度）
 *
 * 安全：删除前对每个目标做「resolve 后仍在 root 下 + 位于白名单域 + uid 段为整数」三重校验；
 * 幂等：路径不存在静默跳过；单个失败记日志不中断其余项。
 */
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join, resolve, sep } from 'path'
import { getMarketRoot } from '../skills/market'

/** 清理结果：实际删除的目录与文件（绝对路径） */
export interface UserWorkspacePurgeResult {
  removedDirs: string[]
  removedFiles: string[]
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/**
 * 级联清空某 uid 在本机的全部 AI 工作域内容（幂等、防越界）。
 * errorMode：对受影响路径删除失败时如何处理——默认 throw 中断（数据治理失败必须暴露），
 * 单个未知 AI 目录读取失败仅记日志继续。
 */
export function purgeUserWorkspace(root: string, uid: number): UserWorkspacePurgeResult {
  if (!Number.isInteger(uid) || uid <= 0) {
    throw new Error(`purgeUserWorkspace: uid 必须为正整数 (got ${uid})`)
  }
  const removedDirs: string[] = []
  const removedFiles: string[] = []

  const uidTag = `U${uid}`

  /** 校验删除目标：resolve 后位于 root 之下（防路径穿越）；相对段首段为白名单域；
   * 目录类目标末段必须为 U{uid} 或旧裸数字 {uid}；文件类目标文件名须命中 ai_{uid}_*_*.json 模式 */
  const assertSafe = (target: string, rootDomain: string, isFile = false): void => {
    const abs = resolve(target)
    const absRoot = resolve(root)
    if (absRoot === abs || !abs.startsWith(absRoot + sep)) {
      throw new Error(`purgeUserWorkspace: 拒绝越界删除 ${abs}`)
    }
    const rel = abs.slice(absRoot.length + 1)
    if (!rel.startsWith(rootDomain + sep)) {
      throw new Error(`purgeUserWorkspace: 拒绝删除越界路径 ${rel}（不在 ${rootDomain}/ 域内）`)
    }
    const last = rel.split(sep).pop() ?? ''
    const isUidDir = last === uidTag || last === String(uid)
    const isUidChatFile = new RegExp(`^ai_${uid}_\\d+_\\d+\\.json$`).test(last)
    if (isFile ? !isUidChatFile : !isUidDir) {
      throw new Error(`purgeUserWorkspace: 拒绝删除越界路径 ${rel}（末段不在 U{uid} 白名单内）`)
    }
  }

  const rmDir = (target: string, rootDomain: string): void => {
    if (!existsSync(target)) return
    assertSafe(target, rootDomain)
    rmSync(target, { recursive: true, force: true })
    removedDirs.push(target)
  }
  const rmFile = (target: string, rootDomain: string): void => {
    if (!existsSync(target)) return
    assertSafe(target, rootDomain, true)
    rmSync(target, { force: true })
    removedFiles.push(target)
  }
  // 以下各域全部以 abyssac_data 根为基准拼接
  const base = { root }

  // 1) 记忆工作域：memory/U{uid}（整目录，覆盖全部 AI 子域 + 计数器 + raw_memory + calendar/diary）
  rmDir(join(base.root, 'memory', uidTag), 'memory')
  // 旧裸数字残留 memory/{uid}（历史分层，迁移前写入）
  rmDir(join(base.root, 'memory', String(uid)), 'memory')

  // 2) NNG 认知图谱：NNG/AI{aiId}/U{uid}（AIID 在前，遍历各 AI 删该 uid 子树）
  const nngRoot = join(base.root, 'NNG')
  for (const aiName of safeReaddir(nngRoot)) {
    if (!/^AI\d+$/.test(aiName)) continue
    rmDir(join(nngRoot, aiName, uidTag), 'NNG')
    rmDir(join(nngRoot, aiName, String(uid)), 'NNG')
  }

  // 3) cache：cache/AI{aiId}/U{uid}（同上）
  const cacheRoot = join(base.root, 'cache')
  for (const aiName of safeReaddir(cacheRoot)) {
    if (!/^AI\d+$/.test(aiName)) continue
    rmDir(join(cacheRoot, aiName, uidTag), 'cache')
    rmDir(join(cacheRoot, aiName, String(uid)), 'cache')
  }

  // 4) 会话：sessions/U{uid} + 旧裸数字 sessions/{uid}
  rmDir(join(base.root, 'sessions', uidTag), 'sessions')
  rmDir(join(base.root, 'sessions', String(uid)), 'sessions')

  // 5) 技能/技能域/配置：{skills,skills_domains,config}/U{uid}（含旧裸数字残留）
  for (const domain of ['skills', 'skills_domains', 'config']) {
    rmDir(join(base.root, domain, uidTag), domain)
    rmDir(join(base.root, domain, String(uid)), domain)
  }

  // 6) 自我认知：ABYSS/U{uid}（USER.md 用户级 + AI{aiId}/AI.md）
  rmDir(join(base.root, 'ABYSS', uidTag), 'ABYSS')
  rmDir(join(base.root, 'ABYSS', String(uid)), 'ABYSS')

  // 7) 用户头像：avatars/user/{uid}
  rmDir(join(base.root, 'avatars', 'user', uidTag), 'avatars')

  // 8) 分系统归集会话：sessions_satellite/{instanceId}/U{uid}（主系统侧）
  const satSessionsRoot = join(base.root, 'sessions_satellite')
  for (const instanceId of safeReaddir(satSessionsRoot)) {
    rmDir(join(satSessionsRoot, instanceId, uidTag), 'sessions_satellite')
  }

  // 9) 日备份：backup/U{uid}（备份中心按 {uid}/{date} 归档）
  rmDir(join(base.root, 'backup', uidTag), 'backup')

  // 10) AI 社交私聊：federation/ai-chats/ai_{uid}_{avA}_{avB}.json（首段 uid 命中即删）
  const aiChatsDir = join(base.root, 'federation', 'ai-chats')
  for (const file of safeReaddir(aiChatsDir)) {
    if (new RegExp(`^ai_${uid}_\\d+_\\d+\\.json$`).test(file)) {
      rmFile(join(aiChatsDir, file), 'federation')
    }
  }

  // 11) SKILL 市场安装记录：manifest 中该 uid 全部作用域（U{uid}/AI{aiId}）记录清空
  purgeMarketScopeRecords(root, uid, removedFiles)

  return { removedDirs, removedFiles }
}

/**
 * 清空 skill-market manifest 中属于该 uid 的安装记录（作用域键 U{uid}/AI{aiId} 全部移除）。
 * 为什么存在——磁盘 skills/U{uid} 已删，若 manifest 仍留有该 uid 作用域记录，
 * 「已安装」称号虽以磁盘为真源（isInstalledOnDisk）不会误显，但残留记录会让
 * 该 uid 重新登录后 syncAll 试图更新不存在的技能，且数据治理要「零残留」。
 * 文件缺失/损坏时静默跳过（市场可自愈重建），不阻断整体清理。
 */
function purgeMarketScopeRecords(root: string, uid: number, removedFiles: string[]): void {
  const manifestPath = join(getMarketRoot(root), 'manifest.json')
  if (!existsSync(manifestPath)) return
  let manifest: { installed?: Record<string, unknown>; sources?: unknown[] }
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as typeof manifest
  } catch (err) {
    console.error(`[user-workspace-purge] SKILL 市场 manifest 解析失败，跳过记录清理:`, err)
    return
  }
  if (!manifest || typeof manifest !== 'object' || !manifest.installed || typeof manifest.installed !== 'object') return
  const prefix = `U${uid}/`
  const retained: Record<string, unknown> = {}
  let removed = 0
  for (const [scopeKey, records] of Object.entries(manifest.installed)) {
    if (scopeKey.startsWith(prefix)) {
      removed += 1
    } else {
      retained[scopeKey] = records
    }
  }
  if (removed === 0) return
  manifest.installed = retained
  try {
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8')
    removedFiles.push(manifestPath)
  } catch (err) {
    console.error(`[user-workspace-purge] SKILL 市场 manifest 记录清理写回失败:`, err)
  }
}