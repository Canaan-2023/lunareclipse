/**
 * 为什么存在：删除自定义 AI 后其工作区（记忆/会话/缓存）若不清理会留下孤儿目录，污染盘点与后续行为。
 * 作用：按 AI 标签扫描各数据域，删除匹配的目录与文件，返回移除清单供 UI 反馈。
 */

import { existsSync, readdirSync, rmSync } from 'fs'
import { join } from 'path'
import type { BaseDataPaths } from '../models/paths'

/**
 * AI 工作域级联清除（删除 AI 时调用，保证「一个 AI 一个域、无数据残留其他域」）。

 * 清理范围（全部以 abyssac_data 为 root，均按 {uid, aiId} 定位到该 AI 独占路径）：
 * - 记忆/RAW/日历/日记：{root}/memory/U{uid}/AI{aiId}（枚举所有 U{uid} 删除 AI{aiId} 子域）
 * - NNG 认知图谱：{root}/NNG/AI{aiId}（AIID 在前，整目录删即覆盖所有用户）
 * - cache 缓存（含注入）：{root}/cache/AI{aiId}（同上）
 * - 自我认知：{root}/ABYSS/U{uid}/AI{aiId}（只删 AI{aiId} 子目录，保留用户级 USER.md）
 * - 会话分目录：{root}/sessions/U{uid}/AI{aiId}（旧裸数字 {uid}/{aiId} 残留一并清；实际运行
 * 会话由 SessionStore.deleteByAiId 按 meta.aiId/确定性 sessionId 判定，此处兜底删目录）
 * - 提示词副本：{root}/frontend/ai-prompts/AI{aiId}（幂等，AiManager.remove 也会删）
 * - 头像：{root}/avatars/ai/{aiId}
 * - 配置/技能域：{root}/{config,skills,skills_domains}/U{uid}/AI{aiId}（旧裸数字 {uid}/{aiId} 分层一并清）
 * - AI 社交私聊：{root}/federation/ai-chats/ai_{uid}_{avA}_{avB}.json（avA/avB 命中即删）

 * 边界（不清理）：
 * - 聊天室/公示板/好友私聊等公共线路（lan-* 会话语义、federation/chat-rooms、
 * federation/news、federation/chats）——公共内容不因单个 AI 删除而清除
 * - 用户级文件（ABYSS/U{uid}/USER.md）、全局基础设施（plugins、cron、ai-registry.json）
 */
export interface AiWorkspacePurgeResult {
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
 * 级联清除某 AI 的全部工作域内容，返回实际删除的目录与文件路径。
 * 幂等：路径不存在时静默跳过；单个路径删除失败不影响其余项（记日志继续）。
 */
export function purgeAiWorkspace(base: BaseDataPaths, aiId: number): AiWorkspacePurgeResult {
  const removedDirs: string[] = []
  const removedFiles: string[] = []
  const aiTag = `AI${aiId}`
  const rmDir = (dir: string): void => {
    if (!existsSync(dir)) return
    try {
      rmSync(dir, { recursive: true, force: true })
      removedDirs.push(dir)
    } catch (err) {
      console.error(`[ai-workspace-purge] 删除目录失败 ${dir}:`, err)
    }
  }
  const rmFile = (file: string): void => {
    if (!existsSync(file)) return
    try {
      rmSync(file, { force: true })
      removedFiles.push(file)
    } catch (err) {
      console.error(`[ai-workspace-purge] 删除文件失败 ${file}:`, err)
    }
  }

  // 1) 记忆工作域：memory/U{uid}/AI{aiId}（覆盖所有 uid）
  const memoryRoot = join(base.root, 'memory')
  if (existsSync(memoryRoot)) {
    for (const uidEntry of safeReaddir(memoryRoot)) {
      if (/^U\d+$/.test(uidEntry)) rmDir(join(memoryRoot, uidEntry, aiTag))
    }
  }

  // 2) NNG 认知图谱：NNG/AI{aiId}（AIID 在前，整目录删）
  rmDir(join(base.root, 'NNG', aiTag))

  // 3) cache（含 cacheInjection）：cache/AI{aiId}
  rmDir(join(base.root, 'cache', aiTag))

  // 4) 自我认知：ABYSS/U{uid}/AI{aiId}（保留 U{uid}/USER.md）
  const abyssRoot = join(base.root, 'ABYSS')
  if (existsSync(abyssRoot)) {
    for (const uidEntry of safeReaddir(abyssRoot)) {
      if (/^U\d+$/.test(uidEntry)) rmDir(join(abyssRoot, uidEntry, aiTag))
    }
  }

  // 5) 会话分目录：sessions/U{uid}/AI{aiId}（旧裸数字 {uid}/{aiId} 残留一并清；运行中会话由
  // SessionStore.deleteByAiId 按 meta.aiId 处理）
  const sessionsRoot = join(base.root, 'sessions')
  if (existsSync(sessionsRoot)) {
    for (const uidEntry of safeReaddir(sessionsRoot)) {
      if (/^U\d+$/.test(uidEntry)) rmDir(join(sessionsRoot, uidEntry, aiTag))
      if (/^\d+$/.test(uidEntry)) rmDir(join(sessionsRoot, uidEntry, String(aiId)))
    }
  }

  // 6) 提示词副本：frontend/ai-prompts/AI{aiId}（幂等）
  rmDir(join(base.frontend, 'ai-prompts', aiTag))

  // 7) 头像：avatars/ai/{aiId}
  rmDir(join(base.root, 'avatars', 'ai', String(aiId)))

  // 8) 配置/技能域：{config,skills,skills_domains}/U{uid}/AI{aiId}
  // （同时兼容旧裸数字 {uid}/{aiId} 分层残留——旧版本写死 {root}/{domain}/{uid}/{aiId}，
  // 已统一为 U/AI 前缀，未迁移的旧目录在此一并清除，保证删除 AI 后零残留）
  for (const domain of ['config', 'skills', 'skills_domains']) {
    const root = join(base.root, domain)
    if (!existsSync(root)) continue
    for (const uidEntry of safeReaddir(root)) {
      if (/^U\d+$/.test(uidEntry)) rmDir(join(root, uidEntry, aiTag))
      if (/^\d+$/.test(uidEntry)) rmDir(join(root, uidEntry, String(aiId)))
    }
  }

  // 9) AI 社交私聊：federation/ai-chats/ai_{uid}_{avA}_{avB}.json（任一参与方命中即删）
  const aiChatsDir = join(base.root, 'federation', 'ai-chats')
  if (existsSync(aiChatsDir)) {
    for (const file of safeReaddir(aiChatsDir)) {
      const m = /^ai_(\d+)_(\d+)_(\d+)\.json$/.exec(file)
      if (!m) continue
      const avA = Number(m[2])
      const avB = Number(m[3])
      if (avA === aiId || avB === aiId) rmFile(join(aiChatsDir, file))
    }
  }

  return { removedDirs, removedFiles }
}