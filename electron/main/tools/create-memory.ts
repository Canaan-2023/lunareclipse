/**
 * 创建记忆工具：为什么存在——AI 需要把重要对话内容沉淀为持久记忆（memory/），
 * 供后续会话检索，且文件名序号必须全局唯一。
 * 作用：create_memory 经全局 counter 取序号，构建记忆对象并写入 memory 目录。
 * 不删掉的理由：记忆是 ABYSS 检索线的中间层（NNG/缓存 → 记忆 → RAW来源 → RAW），
 * 没有记忆文件，NNG 关联与 RAW 回溯就没有落点；本工具是记忆文件的唯一生产入口。
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs'
import { dirname } from 'path'
import type { Tool, ToolResult, ToolContext } from './base-tool'
import { consumeNextSeq } from '../models/counter'
import {
  buildMemoryObject,
  buildMemoryPath,
  nowIso,
  type CreateMemoryParams,
  type MemoryUser
} from '../models/memory'
import { getMemoryTypeDir, scopeFromRawPath, type MemoryType } from '../models/paths'
import { readAiRegistry } from '../models/ai-registry'

export interface CreateMemoryToolParams {
  type: MemoryType
  /** 用户原话（仅 normal 用）：执行层硬校验只接受 string，声明 string[] 会让调用方误传数组而报错 */
  用户原话?: string
  AI回复?: string
  精炼内容?: string
  RAW来源?: string | string[]
  描述: string
  备注: string
  关联文件?: string[]
  时间戳?: string
  /** AI 身份（说话人：月蚀/莉莉丝）。选填——不传则由工具从 RAW 路径作用域自动解析（AI 编号 → 名字） */
  AI身份?: string
  /** 用户身份 {UID, 用户名}。选填——不传则由工具从 RAW 路径作用域自动解析（UID → 查 users.json） */
  用户?: { UID: number; 用户名: string }
}

/**
 * 从 RAW 路径解析 RAW 序号（记忆 ID 跟 RAW 走）。
 * 路径格式：{root}/memory/U{uid}/AI{aiId}/raw_memory/{YYYY}/{MM}/{DD}/{序号}_{关键词}.md
 * 兼容旧格式 raw_memory/{YYYY}/{MM}/{DD}/{序号}_{关键词}.md（或 {序号}.md 未重命名）
 * 如 …/raw_memory/2026/08/09/3_能力扩展.md → 3
 */
export function rawSeqFromPath(rawPath: string): number | null {
  const m = rawPath.match(/raw_memory[\\/]+\d{4}[\\/]+\d{2}[\\/]+\d{2}[\\/]+(\d+)/)
  return m ? parseInt(m[1], 10) : null
}

/**
 * 从 RAW 路径作用域自动解析记忆归属身份（走编号）：
 * - user：scope.uid → users.json 查用户名 → {UID, 用户名}
 * - AI身份：scope.aiId → ai-registry.json 查名字（月蚀/莉莉丝，改名不影响编号归属）
 * RAW 路径格式 {root}/memory/U{uid}/AI{aiId}/raw_memory/...，作用域天然带身份，无需 AI 从标题识别。
 * 解析失败返回空对象（回退 ctx.user / 不填）。
 */
export function resolveIdentityFromRawPath(
  ctx: ToolContext,
  rawPath: string
): { user?: MemoryUser; aiIdentity?: string } {
  const result: { user?: MemoryUser; aiIdentity?: string } = {}
  if (!ctx.paths) return result
  const scope = scopeFromRawPath(rawPath, ctx.paths)
  if (!scope) return result
  try {
    const raw = readFileSync(ctx.paths.usersJson, 'utf-8')
    const parsed = JSON.parse(raw) as { users?: Array<{ UID: number; 用户名: string }> }
    const rec = parsed.users?.find((u) => u.UID === scope.uid)
    if (rec) result.user = { UID: rec.UID, 用户名: rec.用户名 }
  } catch {
    // users.json 读取失败 → user 留空（回退 ctx.user）
  }
  try {
    const registry = readAiRegistry(ctx.paths.aiRegistryJson)
    const ai = registry.ais.find((a) => a.id === scope.aiId)
    if (ai) result.aiIdentity = ai.name
  } catch {
    // ai-registry 读取失败 → AI身份 留空
  }
  return result
}

export class CreateMemoryTool implements Tool<CreateMemoryToolParams> {
  name = 'create_memory'
  description =
    '创建记忆文件（路径/序号/时间戳由工具自动生成，AI 不拼路径），返回 { path } 新记忆文件绝对路径。type 必填：normal=普通对话记忆 / meta=元认知桥接记忆 / high=张力冲突记忆。normal 填 用户原话（≤500字写原文，>500字精炼）+AI回复（AI 精炼结论≤800字）；high/meta 填 精炼内容（high=张力分析，meta=元认知推导逻辑）。RAW来源必填（normal=单条 raw_memory 路径；high/meta=多条路径数组）。描述=记忆描述，用于文件名（如 user_auth_flow）；备注=记忆的生成场景和原因。AI身份 通常不用填（工具从 RAW 路径作用域自动解析：AI 编号→名字）；关联文件/时间戳 选填。'
  parameters = [
    { name: 'type', type: 'string' as const, description: '记忆类型：normal / meta / high', required: true },
    { name: '用户原话', type: 'string' as const, description: '仅 normal 填：≤500 字写用户原文，>500 字精炼核心诉求', required: false },
    { name: 'AI回复', type: 'string' as const, description: '仅 normal 填：AI 精炼后的结论（≤800 字，不抄原回复）', required: false },
    { name: '精炼内容', type: 'string' as const, description: '仅 high/meta 填：自由表述（high=张力分析，meta=元认知推导逻辑）', required: false },
    { name: 'RAW来源', type: 'string' as const, description: '必填：normal 填 string 单条 raw_memory 路径；high/meta 填 string[] 多条 raw_memory 路径', required: true },
    { name: '描述', type: 'string' as const, description: '记忆描述，用于文件名（如 user_auth_flow）', required: true },
    { name: '备注', type: 'string' as const, description: '必填。写记忆的生成场景、生成原因、声明了什么内容（对该记忆的备注说明）', required: true },
    { name: '关联文件', type: 'array' as const, description: '关联的外部文件实际路径数组（选填）', required: false },
    { name: '时间戳', type: 'string' as const, description: 'ISO 8601 时间戳（选填）。记忆工作流处理 raw_memory 时传入 raw_memory 的时间戳，memory 归到对话发生日期；不传则用当前时间', required: false },
    { name: 'AI身份', type: 'string' as const, description: 'AI 身份（说话人：月蚀/莉莉丝）。通常不用填——工具从 RAW 路径作用域自动解析（AI 编号 → 名字）；仅特殊场景显式传', required: false },
    { name: '用户', type: 'object' as const, description: '用户身份 {UID, 用户名}。通常不用填——工具从 RAW 路径作用域自动解析（UID → 查 users.json）；仅特殊场景显式传', required: false }
  ]

  execute(params: CreateMemoryToolParams, ctx?: ToolContext): Promise<ToolResult> {
    if (!ctx?.paths) {
      return Promise.resolve({ ok: false, error: 'ToolContext.paths 未初始化' })
    }
    const validTypes: MemoryType[] = ['normal', 'meta', 'high']
    if (!validTypes.includes(params.type)) {
      return Promise.resolve({ ok: false, error: `type 必须是 ${validTypes.join(' / ')}` })
    }
    if (!params.描述 || params.描述.trim().length === 0) {
      return Promise.resolve({ ok: false, error: '描述 不能为空' })
    }
    if (params.type === 'normal' && !ctx.user && !params.用户) {
      return Promise.resolve({ ok: false, error: 'normal 类型记忆需要 用户 参数或 ToolContext.user' })
    }
    if (params.type === 'normal') {
      if (typeof params.用户原话 !== 'string' || params.用户原话.trim().length === 0) {
        return Promise.resolve({ ok: false, error: 'normal 类型的 用户原话 必须是 string（AI 精炼的用户诉求，不能为空）' })
      }
      if (typeof params.AI回复 !== 'string' || params.AI回复.trim().length === 0) {
        return Promise.resolve({ ok: false, error: 'normal 类型的 AI回复 必须是 string（AI 精炼的结论，不能为空）' })
      }
    } else {
      if (typeof params.精炼内容 !== 'string' || params.精炼内容.trim().length === 0) {
        return Promise.resolve({ ok: false, error: `${params.type} 类型的 精炼内容 必须是 string（自由表述，不能为空）` })
      }
    }
    // RAW来源 必填：normal 为 string，high/meta 为 string[]
    if (params.type === 'normal') {
      if (typeof params.RAW来源 !== 'string' || params.RAW来源.trim().length === 0) {
        return Promise.resolve({ ok: false, error: 'normal 类型的 RAW来源 必须是 string（单条 raw_memory 路径）' })
      }
    } else {
      if (!Array.isArray(params.RAW来源) || params.RAW来源.length === 0) {
        return Promise.resolve({ ok: false, error: `${params.type} 类型的 RAW来源 必须是 string[]（至少一条 raw_memory 路径）` })
      }
      for (const item of params.RAW来源) {
        if (typeof item !== 'string' || item.trim().length === 0) {
          return Promise.resolve({ ok: false, error: `${params.type} 类型的 RAW来源 数组每项必须是非空字符串路径` })
        }
      }
    }
    if (!params.备注 || params.备注.trim().length === 0) {
      return Promise.resolve({ ok: false, error: '备注 不能为空' })
    }

    const memoryTypeDir = getMemoryTypeDir(ctx.paths, params.type)
    const date = params.时间戳 ? new Date(params.时间戳) : new Date()
    if (isNaN(date.getTime())) {
      return Promise.resolve({ ok: false, error: '时间戳 格式无效，需 ISO 8601' })
    }
    // 序号跟随 RAW（记忆 ID 跟 RAW 走，可追溯、无需独立计数器）：
    // normal 用 RAW来源 单条路径的 RAW 序号；high/meta 用 RAW来源 数组第一条（主来源在前）。
    // 同一 RAW 生成多条记忆时共享同一序号前缀（如 3_系统_xxx / 3_用户_yyy），靠描述区分，文件名不冲突。
    // RAW 路径格式异常（解析不到序号）→ 回退独立计数器（兼容兜底）。
    const rawSources = typeof params.RAW来源 === 'string' ? [params.RAW来源] : params.RAW来源
    const rawSeq = rawSources.length > 0 ? rawSeqFromPath(rawSources[0]) : null
    const seq = rawSeq ?? consumeNextSeq(ctx.paths.memoryCounter)
    // buildMemoryPath 已产出正斜杠；路径字段规范化统一在 buildMemoryObject 完成
    const absPath = buildMemoryPath(memoryTypeDir, date, seq, params.描述)

    if (existsSync(absPath)) {
      return Promise.resolve({ ok: false, error: `记忆文件已存在: ${absPath}` })
    }

    // user/AI身份 优先用显式传参；未传则从 RAW 路径作用域自动解析（走编号）。
    // RAW 路径天然带 {uid}/{aiId}，代码查 users.json / ai-registry.json 写入，AI 不再手动从标题识别。
    const autoIdentity = rawSources.length > 0 ? resolveIdentityFromRawPath(ctx, rawSources[0]) : {}
    const resolvedUser = params.用户 ?? autoIdentity.user ?? ctx.user
    const resolvedAiIdentity = params.AI身份 ?? autoIdentity.aiIdentity

    const createParams: CreateMemoryParams = {
      type: params.type,
      用户原话: params.用户原话,
      AI回复: params.AI回复,
      精炼内容: params.精炼内容,
      RAW来源: params.RAW来源,
      描述: params.描述,
      备注: params.备注,
      关联文件: params.关联文件,
      user: resolvedUser,
      AI身份: resolvedAiIdentity
    }
    const memObj = buildMemoryObject(createParams, absPath, nowIso(date))

    try {
      mkdirSync(dirname(absPath), { recursive: true })
      writeFileSync(absPath, JSON.stringify(memObj, null, 2), 'utf-8')
      ctx.handleAccessed?.(absPath)
      return Promise.resolve({ ok: true, data: { path: absPath } })
    } catch (err) {
      return Promise.resolve({ ok: false, error: (err as Error).message })
    }
  }
}
