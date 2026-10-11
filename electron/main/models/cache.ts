/**
 * 缓存（Cache）数据模型与构造：把记忆精简为 AI 直接可用的缓存条目
 * （只拎核心内容字段，保留路径供回查），并提供缓存命名/路径/截断/上限判定。
 * 是 memory-sync 与 cache-sync 共用的对象约定，保持两侧结构一致。
 * 不删掉的理由：缓存是 NNG 的精简镜像（同构含记忆路径），AI 直接读缓存免全文检索；
 * 容量上限与截断规则必须集中定义，否则缓存会涨到不可检索。
 */
import { join, basename } from 'path'
import { existsSync, readFileSync } from 'fs'
import type { NngArchiveRecord } from './nng'
import type { Memory, MemoryUser } from './memory'

/**
 * Cache.关联记忆 元素：从完整 Memory 对象中只拎出 AI 工具直接需要的内容字段。
 * 其他元数据（关联NNG/RAW来源/时间戳/自身路径）AI 需要时去 NNG 或记忆文件找。
 * 记忆路径 保留：孤立审查要用，AI 也需要路径去 NNG 查描述。
 * normal 记忆拎 用户原话/AI回复（精炼后），high/meta 记忆拎 精炼内容。
 * 增加 AI身份 + 用户 字段（同步器从记忆读取，AI 可区分说话人）
 */
export interface CacheMemoryEntry {
  记忆路径: string
  用户原话?: string | string[]
  AI回复?: string
  精炼内容?: string
  关联文件?: string[]
  备注: string
  /** AI 身份（说话人：月蚀/莉莉丝，从记忆读取） */
  AI身份?: string
  /** 用户身份（UID+用户名，从记忆读取） */
  用户?: MemoryUser
}

/**
 * 读取记忆文件，返回完整 Memory 对象。
 * 失败返回 null，不抛异常。
 */
export function readMemory(memoryPath: string): Memory | null {
  if (!existsSync(memoryPath)) return null
  try {
    return JSON.parse(readFileSync(memoryPath, 'utf-8')) as Memory
  } catch {
    return null
  }
}

/**
 * 从完整 Memory 对象构造 cache.关联记忆 元素（只拎出核心内容字段）。
 * 描述 字段不进 cache（AI 需要时去 NNG 查）。
 * normal 记忆拎 用户原话/AI回复（精炼后）+ 身份字段（用户是谁 / AI 是谁，从记忆读取）；
 * high/meta 记忆只拎 精炼内容（路径 + 内容即可，不需要身份——不是对话，是分析产物）。
 */
export function buildCacheMemoryEntry(mem: Memory): CacheMemoryEntry {
  const entry: CacheMemoryEntry = {
    记忆路径: mem.自身路径,
    备注: mem.备注 ?? ''
  }
  if (mem.内容.精炼内容 !== undefined) {
    // high/meta：只要路径 + 内容
    entry.精炼内容 = mem.内容.精炼内容
  } else {
    // normal：内容 + 身份字段（从记忆读取）
    entry.用户原话 = mem.内容.用户原话 ?? ''
    entry.AI回复 = mem.内容.AI回复 ?? ''
    if (mem.AI身份) {
      entry.AI身份 = mem.AI身份
    }
    if (mem.用户) {
      entry.用户 = mem.用户
    }
  }
  if (mem.关联文件 && mem.关联文件.length > 0) {
    entry.关联文件 = mem.关联文件
  }
  return entry
}

export interface Cache {
  自身路径: string
  描述: string
  关联记忆: CacheMemoryEntry[]
  上级缓存: string[]
  下级缓存: string[]
  归档记录: NngArchiveRecord[]
}

export const CACHE_CHAR_LIMIT = 20000
export const CACHE_TRUNCATE_LIMIT = 500
export const CACHE_TRUNCATE_NOTE = '(截断，全文请去记忆原文查看)'

export function getCacheNameFromNngPath(nngPath: string): string {
  const fileName = basename(nngPath)
  // 兼容两种输入：NNG 路径（1ai_self_nng.json）或 cache 路径（1ai_self_cache.json）
  // 修复：buildCacheSiblingFolder 曾收到 cachePath 导致后缀替换失败、把文件路径建成了目录（EISDIR 刷屏）
  return fileName.replace(/_nng\.json$/, '').replace(/_cache\.json$/, '')
}

export function buildCacheFileName(cacheName: string): string {
  return `${cacheName}_cache.json`
}

export function buildCachePath(targetFolder: string, nngPath: string): string {
  const cacheName = getCacheNameFromNngPath(nngPath)
  const fileName = buildCacheFileName(cacheName)
  return join(targetFolder, fileName).replace(/\\/g, '/')
}

export function buildCacheSiblingFolder(targetFolder: string, nngPath: string): string {
  const cacheName = getCacheNameFromNngPath(nngPath)
  return join(targetFolder, cacheName).replace(/\\/g, '/')
}

export function buildEmptyCache(absPath: string, description: string): Cache {
  return {
    自身路径: absPath,
    描述: description,
    关联记忆: [],
    上级缓存: [],
    下级缓存: [],
    归档记录: []
  }
}

export function truncateContent(text: string): string {
  const limit = CACHE_TRUNCATE_LIMIT - CACHE_TRUNCATE_NOTE.length
  if (text.length <= CACHE_TRUNCATE_LIMIT) {
    return text
  }
  return text.slice(0, limit) + CACHE_TRUNCATE_NOTE
}

export function measureCacheCharLength(cache: Cache): number {
  return JSON.stringify(cache).length
}

export function shouldTruncate(cache: Cache): boolean {
  return measureCacheCharLength(cache) > CACHE_CHAR_LIMIT
}
