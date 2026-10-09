/**
 * NNG 一级索引与缓存索引的读写：维护 root.json（一级节点清单）
 * 与 cache/index.json（缓存清单），集中 upsert/remove 条目，
 * 保证索引与磁盘结构一致，供外部扫描与 AI 检索快速定位。
 * 不删掉的理由：AI 检索先读索引（root.json/index.json）拿到节点路径再下钻，
 * 索引缺失会让 NNG/缓存成为"只能遍历目录"的黑箱；索引集中维护保证与磁盘一致。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { dirname } from 'path'
import { nowIso } from './memory'

export interface NngRootEntry {
  name: string
  path: string
  描述: string
  last_modified: string
}

export interface NngRootJson {
  version: string
  updated_at: string
  total_nodes: number
  nodes: NngRootEntry[]
}

export interface CacheIndexEntry {
  name: string
  path: string
  描述: string
  last_modified: string
}

export interface CacheIndexJson {
  version: string
  updated_at: string
  total_entries: number
  cache_list: CacheIndexEntry[]
}

const INDEX_VERSION = '1.0'

export function readNngRoot(rootJsonPath: string): NngRootJson {
  if (!existsSync(rootJsonPath)) {
    return { version: INDEX_VERSION, updated_at: nowIso(), total_nodes: 0, nodes: [] }
  }
  try {
    const raw = readFileSync(rootJsonPath, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<NngRootJson>
    return {
      version: parsed.version ?? INDEX_VERSION,
      updated_at: parsed.updated_at ?? nowIso(),
      total_nodes: parsed.total_nodes ?? 0,
      nodes: parsed.nodes ?? []
    }
  } catch {
    return { version: INDEX_VERSION, updated_at: nowIso(), total_nodes: 0, nodes: [] }
  }
}

export function writeNngRoot(rootJsonPath: string, data: NngRootJson): void {
  mkdirSync(dirname(rootJsonPath), { recursive: true })
  data.updated_at = nowIso()
  data.total_nodes = data.nodes.length
  writeFileSync(rootJsonPath, JSON.stringify(data, null, 2), 'utf-8')
}

export function readCacheIndex(indexJsonPath: string): CacheIndexJson {
  if (!existsSync(indexJsonPath)) {
    return { version: INDEX_VERSION, updated_at: nowIso(), total_entries: 0, cache_list: [] }
  }
  try {
    const raw = readFileSync(indexJsonPath, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<CacheIndexJson>
    return {
      version: parsed.version ?? INDEX_VERSION,
      updated_at: parsed.updated_at ?? nowIso(),
      total_entries: parsed.total_entries ?? 0,
      cache_list: parsed.cache_list ?? []
    }
  } catch {
    return { version: INDEX_VERSION, updated_at: nowIso(), total_entries: 0, cache_list: [] }
  }
}

export function writeCacheIndex(indexJsonPath: string, data: CacheIndexJson): void {
  mkdirSync(dirname(indexJsonPath), { recursive: true })
  data.updated_at = nowIso()
  data.total_entries = data.cache_list.length
  writeFileSync(indexJsonPath, JSON.stringify(data, null, 2), 'utf-8')
}

export function upsertNngRootEntry(
  rootJsonPath: string,
  entry: NngRootEntry
): void {
  const data = readNngRoot(rootJsonPath)
  const idx = data.nodes.findIndex((n) => n.name === entry.name)
  if (idx >= 0) {
    data.nodes[idx] = entry
  } else {
    data.nodes.push(entry)
  }
  writeNngRoot(rootJsonPath, data)
}

export function removeNngRootEntry(rootJsonPath: string, name: string): void {
  const data = readNngRoot(rootJsonPath)
  data.nodes = data.nodes.filter((n) => n.name !== name)
  writeNngRoot(rootJsonPath, data)
}

export function upsertCacheIndexEntry(
  indexJsonPath: string,
  entry: CacheIndexEntry
): void {
  const data = readCacheIndex(indexJsonPath)
  const idx = data.cache_list.findIndex((c) => c.name === entry.name)
  if (idx >= 0) {
    data.cache_list[idx] = entry
  } else {
    data.cache_list.push(entry)
  }
  writeCacheIndex(indexJsonPath, data)
}

export function removeCacheIndexEntry(indexJsonPath: string, name: string): void {
  const data = readCacheIndex(indexJsonPath)
  data.cache_list = data.cache_list.filter((c) => c.name !== name)
  writeCacheIndex(indexJsonPath, data)
}
