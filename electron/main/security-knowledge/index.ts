/**
 * index.ts — 安全知识库挂载状态与轻量检索入口
 * 为什么存在：sources.ts 定义了官方源清单，本模块回答「挂载了没有、能用什么」——
 *  - getKnowledgeStatus()：逐源返回本地目录是否存在、文件规模（挂载状态，无假数据）
 *  - searchLocalSource()：对已挂载目录做文件名级关键词检索（零依赖、轻量；
 *    不做全文索引——那需要完整 RAG 管线，超出本项目边界）
 * 未挂载目录明确返回 not-mounted，不编造检索结果；检索层只读，不修改任何源文件。
 */
import { existsSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { getKnowledgeRoot, SECURITY_KNOWLEDGE_SOURCES, type SecurityKnowledgeSource } from './sources'

export interface KnowledgeSourceStatus {
  id: string
  name: string
  kind: SecurityKnowledgeSource['kind']
  repo: string
  mounted: boolean
  /** 本地目录绝对路径（未挂载时也是目标路径，供克隆落点提示） */
  localPath: string
  /** 已挂载时的粗略规模（文件数），未挂载为 0 */
  fileCount: number
}

export interface SearchHit {
  sourceId: string
  file: string
}

const SCANABLE_EXT = /\.(md|markdown|yaml|yml)$/i
const MAX_FILES_PER_SOURCE = 2000
const MAX_DEPTH = 6

/** 统计目录内可检索文件数（排除 .git 与 node_modules，限制深度防递归爆炸） */
function countScanableFiles(dir: string, depth: number): number {
  if (depth > MAX_DEPTH) return 0
  let count = 0
  for (const name of readdirSync(dir)) {
    if (name === '.git' || name === 'node_modules') continue
    const p = join(dir, name)
    let st
    try {
      st = statSync(p)
    } catch {
      continue
    }
    if (st.isDirectory()) {
      count += countScanableFiles(p, depth + 1)
    } else if (SCANABLE_EXT.test(name) && count < MAX_FILES_PER_SOURCE) {
      count += 1
    }
  }
  return count
}

/** 逐源返回挂载状态（mounted 依据本地目录真实存在与否，不做假设） */
export function getKnowledgeStatus(): KnowledgeSourceStatus[] {
  const root = getKnowledgeRoot()
  return SECURITY_KNOWLEDGE_SOURCES.map((s) => {
    const localPath = join(root, s.localDir)
    const mounted = existsSync(localPath)
    let fileCount = 0
    if (mounted) {
      try {
        fileCount = countScanableFiles(localPath, 0)
      } catch {
        fileCount = 0
      }
    }
    return { id: s.id, name: s.name, kind: s.kind, repo: s.repo, mounted, localPath, fileCount }
  })
}

/** 全部源是否已挂载（快捷判断；任一未挂载返回 false） */
export function isAllKnowledgeMounted(): boolean {
  return getKnowledgeStatus().every((s) => s.mounted && s.fileCount > 0)
}

/**
 * 对单个源做文件名级关键词检索。
 * 已挂载 → 返回命中文件（路径相对 localDir，前 MAX_FILES 条）；未挂载 → 空数组（调用方
 * 应结合 getKnowledgeStatus 给出 not-mounted 提示，不要误读为「无结果」）。
 */
export function searchLocalSource(sourceId: string, keyword: string, limit = 20): SearchHit[] {
  const source = SECURITY_KNOWLEDGE_SOURCES.find((s) => s.id === sourceId)
  if (!source) return []
  const root = join(getKnowledgeRoot(), source.localDir)
  if (!existsSync(root) || !keyword.trim()) return []
  const kw = keyword.toLowerCase()
  const hits: SearchHit[] = []
  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_DEPTH || hits.length >= limit) return
    for (const name of readdirSync(dir)) {
      if (name === '.git' || name === 'node_modules') continue
      const p = join(dir, name)
      let st
      try {
        st = statSync(p)
      } catch {
        continue
      }
      if (st.isDirectory()) {
        walk(p, depth + 1)
      } else if (SCANABLE_EXT.test(name)) {
        const rel = p.slice(root.length).replace(/^[\\/]/, '')
        // 对相对路径（含目录名）做关键词匹配——HackTricks 等源的主题大量表达在目录名上
        if (rel.toLowerCase().includes(kw)) {
          hits.push({ sourceId, file: rel })
          if (hits.length >= limit) return
        }
      }
    }
  }
  walk(root, 0)
  return hits
}

/** 统一入口：不限源的全局文件名检索（按源分组返回） */
export function searchAllSources(keyword: string, limitPerSource = 20): Record<string, SearchHit[]> {
  const out: Record<string, SearchHit[]> = {}
  for (const s of SECURITY_KNOWLEDGE_SOURCES) {
    const hits = searchLocalSource(s.id, keyword, limitPerSource)
    if (hits.length > 0) out[s.id] = hits
  }
  return out
}