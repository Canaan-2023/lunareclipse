/**
 * @category 记忆
 * @summary 数据层：记忆/NNG/缓存/用户与 AI 注册表/配置

 * 记忆数据模型与对象构造的唯一来源：系统把对话沉淀为记忆文件，
 * 各模块需要统一的对象结构与路径规范（正斜杠 normalizePath），
 * 避免各处各写一份导致路径写法不一致、去重/关联/回写静默失效。
 * 本文件提供 Memory 类型、记忆文件命名与路径构造、buildMemoryObject，
 * 并导出全局统一的时间戳工具 nowIso。
 * 不删掉的理由：记忆对象承载"RAW来源"反向回溯字段与"关联NNG"正向索引字段，
 * 是 NNG/缓存 → 记忆 → RAW 检索链的数据契约；对象结构漂移会无声破坏整条链路。
 */
import { join } from 'path'
import { normalizePath, type MemoryType } from './paths'

export interface MemoryUser {
  UID: number
  用户名: string
}

export interface MemoryContent {
  用户原话?: string | string[]
  AI回复?: string
  精炼内容?: string
}

export interface Memory {
  自身路径: string
  用户?: MemoryUser
  /** AI 身份（说话人：月蚀/莉莉丝，从 RAW 对话对标题 `## AI（名字）` 解析） */
  AI身份?: string
  关联NNG: string[]
  关联文件?: string[]
  RAW来源?: string | string[]
  时间戳: string
  内容: MemoryContent
  备注: string
}

export interface CreateMemoryParams {
  type: MemoryType
  用户原话?: string | string[]
  AI回复?: string
  精炼内容?: string
  RAW来源?: string | string[]
  描述: string
  备注: string
  关联文件?: string[]
  user?: MemoryUser
  /** AI 身份（说话人：月蚀/莉莉丝，从 RAW 标题解析） */
  AI身份?: string
}

export function buildMemoryFileName(seq: number, desc: string): string {
  const safeDesc = desc.replace(/[\\/:*?"<>|]/g, '_')
  return `${seq}_${safeDesc}.json`
}

export function buildMemoryPath(
  memoryTypeDir: string,
  date: Date,
  seq: number,
  desc: string
): string {
  const yyyy = String(date.getFullYear())
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  const fileName = buildMemoryFileName(seq, desc)
  return join(memoryTypeDir, yyyy, mm, dd, fileName).replace(/\\/g, '/')
}

export function nowIso(date: Date = new Date()): string {
  const tzOffset = -date.getTimezoneOffset()
  const sign = tzOffset >= 0 ? '+' : '-'
  const absOffset = Math.abs(tzOffset)
  const hh = String(Math.floor(absOffset / 60)).padStart(2, '0')
  const mm = String(absOffset % 60).padStart(2, '0')
  const tzStr = `${sign}${hh}:${mm}`
  return (
    `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}` +
    `T${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}${tzStr}`
  )
}

/**
 * 构造记忆对象。所有路径字段统一经 normalizePath 规范化（正斜杠，同 buildNngObject）——
 * 记忆对象的唯一构造点，与 NNG 侧同一规范，也与 memory-sync 的 expectedSelf 对齐（避免回写抖动）。
 */
export function buildMemoryObject(params: CreateMemoryParams, absPath: string, timestamp: string): Memory {
  const mem: Memory = {
    自身路径: normalizePath(absPath),
    时间戳: timestamp,
    内容: {},
    关联NNG: [],
    备注: params.备注
  }
  if (params.用户原话 !== undefined) {
    mem.内容.用户原话 = params.用户原话
  }
  if (params.AI回复 !== undefined) {
    mem.内容.AI回复 = params.AI回复
  }
  if (params.精炼内容 !== undefined) {
    mem.内容.精炼内容 = params.精炼内容
  }
  if (params.RAW来源 !== undefined) {
    mem.RAW来源 = typeof params.RAW来源 === 'string'
      ? normalizePath(params.RAW来源)
      : params.RAW来源.map(normalizePath)
  }
  if (params.type === 'normal' && params.user) {
    mem.用户 = params.user
  }
  if (params.AI身份) {
    mem.AI身份 = params.AI身份
  }
  if (params.关联文件 && params.关联文件.length > 0) {
    mem.关联文件 = params.关联文件.map(normalizePath)
  }
  return mem
}
