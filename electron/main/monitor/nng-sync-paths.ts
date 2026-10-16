/**
 * NngSync 路径解析纯函数（从 nng-sync.ts 拆出，L2 拆分）

 * 纯函数化：所有函数显式接收根路径参数，不依赖 NngSync 实例状态。
 * 用途：作用域 NNG 工作域解析（NNG/AI{aiId}/U{uid}）、一级节点目录、root.json 索引文件定位、
 * NNG 文件判定。作用域根解析复用 cache-sync-paths 的 scopeNngRootFor（同一定义）。
 */
import { normalizePath } from '../models/paths'
import { scopeNngRootFor } from './cache-sync-paths'

/** 作用域一级节点目录（工作域下的 root/，一级 _nng.json 直接放这里） */
export function scopeLevel1DirForNng(nngPath: string, nngRoot: string): string {
  return `${scopeNngRootFor(nngPath, nngRoot)}/root`
}

/** 作用域 NNG 索引文件（工作域下的 root.json；非分层路径回退全局 nngRootJson） */
export function scopeRootJsonForNng(nngPath: string, nngRoot: string, nngRootJson: string): string {
  const scopeRoot = scopeNngRootFor(nngPath, nngRoot)
  return scopeRoot === normalizePath(nngRoot) ? nngRootJson : `${scopeRoot}/root.json`
}

/** 是否 NNG 文件（_nng.json 结尾且在 NNG 根内） */
export function isNngFile(path: string, nngRoot: string): boolean {
  const p = normalizePath(path)
  if (!p.endsWith('_nng.json')) return false
  const root = normalizePath(nngRoot)
  if (!p.startsWith(root + '/')) return false
  return true
}