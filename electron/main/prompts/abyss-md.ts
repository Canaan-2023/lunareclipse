/**
 * @category ABYSS 体系
 * @summary USER.md / AI.md 读取端（单一来源）。

 * 写入端见 tools/abyss-md.ts（update_user_preference / update_abyss_md）。
 * 读取端统一收敛在本模块：普通会话（segments 注入段 user_md / ai_md）与桌宠链路
 * （generateLilithReply）共用同一份定位逻辑与包装格式，避免各链路手写不同版本导致漂移。
 */
import { existsSync, readFileSync } from 'fs'
import { DEFAULT_AI_ID } from '@shared/types'
import { resolveScopePaths, type BaseDataPaths } from '../models/paths'

/**
 * 读取用户级个人资料卡 USER.md（ABYSS/U{uid}/USER.md，所有 AI 会话共享）。
 * 文件不存在或内容为空时返回 null（调用侧不注入该段）。
 */
export function readUserMdContent(dataPaths: BaseDataPaths, uid: number): string | null {
  const userMd = resolveScopePaths(dataPaths, { uid, aiId: DEFAULT_AI_ID }).userMd
  if (!userMd || !existsSync(userMd)) return null
  const text = readFileSync(userMd, 'utf-8').trim()
  if (!text) return null
  return `[用户个人资料卡（ABYSS/U${uid}/USER.md，用户可在个人中心编辑；经 update_user_preference 更新）]\n${text}`
}

/**
 * 读取 AI 级自我认知 AI.md（ABYSS/U{uid}/AI{aiId}/AI.md，按会话 aiId 定位）。
 * 文件不存在或内容为空时返回 null（调用侧不注入该段）。
 */
export function readAiMdContent(
  dataPaths: BaseDataPaths,
  uid: number,
  aiId: number
): string | null {
  const aiMd = resolveScopePaths(dataPaths, { uid, aiId }).aiMd
  if (!aiMd || !existsSync(aiMd)) return null
  const text = readFileSync(aiMd, 'utf-8').trim()
  if (!text) return null
  return `[你的自我认知（ABYSS/U${uid}/AI${aiId}/AI.md，经 update_abyss_md 更新）]\n${text}`
}