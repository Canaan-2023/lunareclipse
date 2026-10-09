/**
 * CacheSync 路径解析纯函数（从 cache-sync.ts 拆出，L2 拆分）

 * 为什么存在：NNG 与缓存是两块目录结构同构镜像的存储，任何换算错误都会让
 * 缓存找不到 NNG、记忆回溯路径断链；路径换算必须集中成纯函数才能被两侧复用与单测。
 * 作用：所有函数显式接收根路径参数，不依赖 CacheSync 实例状态。
 * 用途：作用域路径解析（NNG/AI{aiId}/U{uid} ↔ cache/AI{aiId}/U{uid}）、
 * NNG↔cache 文件路径互转、uid 提取、cache 文件判定。
 * 不删掉的理由：NNG 与缓存目录结构同构镜像，路径换算规则必须集中且可单测，
 * 分散实现会导致镜像关系错位（缓存找不到 NNG、回溯路径断链）。
 */
import { basename, dirname } from 'path'
import {
  buildCacheFileName,
  getCacheNameFromNngPath
} from '../models/cache'
import { normalizePath } from '../models/paths'

/** 从作用域路径提取 NNG 作用域根（NNG/AI{aiId}/U{uid}），非分层路径回退全局根 */
export function scopeNngRootFor(p: string, nngRoot: string): string {
  const norm = normalizePath(p)
  const m = norm.match(/^(.+\/NNG\/AI\d+\/U\d+)(?:\/|$)/)
  return m ? m[1] : normalizePath(nngRoot)
}

/** 从作用域路径提取 cache 作用域根（cache/AI{aiId}/U{uid}），非分层路径回退全局根 */
export function scopeCacheRootFor(p: string, cacheIndexRoot: string): string {
  const norm = normalizePath(p)
  const m = norm.match(/^(.+\/cache\/AI\d+\/U\d+)(?:\/|$)/)
  return m ? m[1] : normalizePath(cacheIndexRoot)
}

/** 作用域一级缓存目录（cache/AI{aiId}/U{uid}/index，一级 _cache.json 直接放这里） */
export function scopeCacheLevel1DirFor(p: string, cacheIndexRoot: string): string {
  return `${scopeCacheRootFor(p, cacheIndexRoot)}/index`
}

/** 作用域索引文件（cache/AI{aiId}/U{uid}/index.json），非分层路径回退构造传入的全局索引 */
export function scopeCacheIndexJsonFor(
  p: string,
  cacheIndexRoot: string,
  cacheIndexJson: string
): string {
  const scopeRoot = scopeCacheRootFor(p, cacheIndexRoot)
  return scopeRoot === normalizePath(cacheIndexRoot) ? cacheIndexJson : `${scopeRoot}/index.json`
}

/** 从作用域路径提取 uid：cache/NNG 为 AI{aiId}/U{uid} 中的 U{uid}，memory 为 U{uid}/AI{aiId} 中的 U{uid} */
export function uidOfScopePath(path: string): number | null {
  const p = normalizePath(path)
  const cacheNng = /(?:NNG|cache)\/AI\d+\/U(\d+)(?:\/|$)/.exec(p)
  if (cacheNng) return Number(cacheNng[1])
  const memory = /memory\/U(\d+)\/AI\d+(?:\/|$)/.exec(p)
  if (memory) return Number(memory[1])
  return null
}

/** 是否 cache 文件（_cache.json 结尾且在 cache 根内） */
export function isCacheFile(path: string, cacheIndexRoot: string): boolean {
  const p = normalizePath(path)
  if (!p.endsWith('_cache.json')) return false
  const root = normalizePath(cacheIndexRoot)
  if (!p.startsWith(root + '/')) return false
  return true
}

/**
 * NNG 路径 → cache 路径（与 cacheToNngPath 互逆）
 * NNG/AI{aiId}/U{uid}/root/{rel}/{name}_nng.json → cache/AI{aiId}/U{uid}/index/{rel}/{name}_cache.json
 */
export function nngToCachePath(
  nngPath: string,
  nngRoot: string,
  _cacheIndexRoot: string
): string | null {
  const scopeNng = scopeNngRootFor(nngPath, nngRoot)
  const level1 = `${scopeNng}/root`
  if (!nngPath.startsWith(level1 + '/')) return null
  const relative = nngPath.slice(level1.length + 1)
  const fileName = basename(relative)
  const cacheName = getCacheNameFromNngPath(fileName)
  const cacheFileName = buildCacheFileName(cacheName)
  const relDir = dirname(relative)
  const scopeCache = scopeNng.replace(/\/NNG(\/AI\d+\/U\d+)$/, '/cache$1')
  const cachePath =
    relDir === '.' ? `${scopeCache}/index/${cacheFileName}` : `${scopeCache}/index/${relDir}/${cacheFileName}`
  return cachePath.replace(/\\/g, '/')
}

/**
 * cache 路径 → NNG 路径（与 nngToCachePath 互逆）
 * cache/AI{aiId}/U{uid}/index/{rel}/{name}_cache.json → NNG/AI{aiId}/U{uid}/root/{rel}/{name}_nng.json
 */
export function cacheToNngPath(
  cachePath: string,
  _nngRoot: string,
  cacheIndexRoot: string
): string | null {
  const scopeCache = scopeCacheRootFor(cachePath, cacheIndexRoot)
  const level1 = `${scopeCache}/index`
  if (!cachePath.startsWith(level1 + '/')) return null
  const relative = cachePath.slice(level1.length + 1)
  const fileName = basename(relative)
  const nngFileName = fileName.replace(/_cache\.json$/, '_nng.json')
  const relDir = dirname(relative)
  const scopeNng = scopeCache.replace(/\/cache(\/AI\d+\/U\d+)$/, '/NNG$1')
  const nngPath =
    relDir === '.' ? `${scopeNng}/root/${nngFileName}` : `${scopeNng}/root/${relDir}/${nngFileName}`
  return nngPath.replace(/\\/g, '/')
}

/** 构建 cache 路径（从 NNG 路径反推，独立于实例；仅用于无实例场景的路径推导） */
export function buildCachePathFromNng(
  nngPath: string,
  nngRoot: string,
  cacheIndexRoot: string
): string {
  const np = normalizePath(nngPath)
  const nr = normalizePath(nngRoot)
  const cr = normalizePath(cacheIndexRoot)
  const rel = np.slice(nr.length + 1)
  const fileName = basename(rel)
  const cacheName = getCacheNameFromNngPath(fileName)
  const cacheFileName = buildCacheFileName(cacheName)
  const relDir = dirname(rel)
  const cachePath = relDir === '.' ? `${cr}/${cacheFileName}` : `${cr}/${relDir}/${cacheFileName}`
  return cachePath.replace(/\\/g, '/')
}