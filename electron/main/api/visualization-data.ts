/**
 * 可视化数据读取层：为前端 P0 可视化面板提供监控状态、错误日志、
 * 记忆列表与 NNG 树等数据，全部为纯读取、不修改任何文件，
 * 把数据装配从 IPC handler 中剥离，便于复用与测试。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import { join, dirname } from 'path'
import type { DataPaths } from '../models/paths'
import type { ErrorLogEntry } from '../monitor/error-log'
import type { WorkflowInstanceSummary, WorkflowNodeSummary, RawMemoryLatest, RawMemoryListItem, MemoryDirectoryNode } from '@shared/types'
import { parseRawMemoryContent, parseRawMemoryEntries } from '../services/raw-memory-next-batch'

/**
 * 可视化数据读取层
 * 为前端 P0 可视化提供监控状态等数据
 * 所有函数均为纯读取，不修改任何文件
 */

export interface MonitorState {
  启动时间: string
  统计: {
    create_events: number
    modify_events: number
    delete_events: number
    move_events: number
  }
}

export interface MemoryListItem {
  name: string
  path: string
  type: 'normal' | 'meta' | 'high'
  size: number
  mtime: string
}

export interface NngTreeNode {
  name: string
  path: string
  type: 'standard' | 'meta' | 'high'
  children: NngTreeNode[]
  jsonFile: string | null  // 该节点的 _nng.json 文件名（一级节点才有，二级节点路径在父文件夹内）
}

function readJson<T>(filePath: string): T | null {
  try {
    if (!existsSync(filePath)) return null
    const raw = readFileSync(filePath, 'utf-8')
    return JSON.parse(raw) as T
  } catch (err) {
    console.warn(`[visualization] 读取失败 ${filePath}:`, err)
    return null
  }
}

export function readMonitorState(paths: DataPaths): MonitorState | null {
  return readJson<MonitorState>(paths.fileMonitorState)
}

export function readErrorLogEntries(errorLogList: ErrorLogEntry[]): ErrorLogEntry[] {
  return [...errorLogList]
}

/** 列出 memory 目录下的记忆文件（递归遍历子目录，记忆文件在 normal/年/月/日/ 3 层深子目录） */
export function listMemories(paths: DataPaths): MemoryListItem[] {
  const result: MemoryListItem[] = []
  const types: Array<{ type: 'normal' | 'meta' | 'high'; dir: string }> = [
    { type: 'normal', dir: paths.memoryNormal },
    { type: 'meta', dir: paths.memoryMeta },
    { type: 'high', dir: paths.memoryHigh }
  ]
  for (const { type, dir } of types) {
    if (!existsSync(dir)) continue
    // 递归扫描目录下所有 .json 文件
    scanMemoryDir(dir, type, result)
  }
  // 按修改时间倒序（最新在前）
  result.sort((a, b) => b.mtime.localeCompare(a.mtime))
  return result
}

/** 递归扫描记忆目录 */
function scanMemoryDir(dir: string, type: 'normal' | 'meta' | 'high', result: MemoryListItem[]): void {
  let files: string[]
  try {
    files = readdirSync(dir)
  } catch {
    return
  }
  for (const f of files) {
    const fp = join(dir, f)
    try {
      const st = statSync(fp)
      if (st.isDirectory()) {
        // 递归子目录（记忆文件在 年/月/日/ 子目录中）
        scanMemoryDir(fp, type, result)
      } else if (st.isFile() && f.endsWith('.json')) {
        // 相对路径作为显示名（去掉 memory/normal/ 前缀）
        const displayName = fp.replace(/\\/g, '/').split(`memory/${type}/`)[1] || f
        result.push({
          name: displayName,
          path: fp,
          type,
          size: st.size,
          mtime: st.mtime.toISOString()
        })
      }
    } catch {
      // 跳过无法 stat 的文件
    }
  }
}

/** 从 NNG 文件名解析类型（meta_/high_ 前缀） */
function parseNngType(fileName: string): 'standard' | 'meta' | 'high' {
  // 文件名格式：{层级序号}{meta_|high_}{name}_nng.json
  const stripped = fileName.replace(/^\.?\/?/, '')
  if (/^\d*meta_/.test(stripped)) return 'meta'
  if (/^\d*high_/.test(stripped)) return 'high'
  return 'standard'
}

/** 从文件名提取节点 name（去掉序号前缀和 _nng.json 后缀） */
function parseNngName(fileName: string): string {
  return fileName
    .replace(/^\d+/, '')        // 去掉序号前缀
    .replace(/_nng\.json$/, '') // 去掉后缀
    .replace(/^(meta_|high_)/, '') // 去掉类型前缀（保留在 type 字段）
}

/**
 * 读取 NNG 树结构（递归遍历，最大深度 3 层）
 * 路径规则（重构，与 2_数据格式.md 2.2 节一致）：
* - 一级节点：NNG/AI{aiId}/U{uid}/root/{层级序号}{meta_|high_}{name}_nng.json
 * - 二级及以下：NNG/AI{aiId}/U{uid}/root/{父节点同名文件夹}/{层级序号}{name}_nng.json
 * - 类型从文件名前缀区分，不按子目录分
 */
export function readNngTree(paths: DataPaths): NngTreeNode[] {
  const rootDir = paths.nngLevel1Dir  // NNG/AI{aiId}/U{uid}/root/（一级节点目录）
  if (!existsSync(rootDir)) return []
  const result: NngTreeNode[] = []
  try {
    const entries = readdirSync(rootDir)
    for (const e of entries) {
      if (!e.endsWith('_nng.json')) continue  // 一级节点是 .json 文件，不是目录
      const fp = join(rootDir, e)
      try {
        const st = statSync(fp)
        if (st.isFile()) {
          const name = parseNngName(e)
          const type = parseNngType(e)
          // 同名文件夹：如 1auth_nng.json → 1auth/
          const folderName = e.replace(/_nng\.json$/, '')
          const folderPath = join(rootDir, folderName)
          result.push(readNngNode(folderPath, folderName, name, type, e, 1))
        }
      } catch {
        // 跳过
      }
    }
  } catch {
    // 跳过
  }
  return result
}

/** 递归读取单个 NNG 节点及其子节点（最大深度 3） */
function readNngNode(
  folderPath: string,
  folderName: string,
  name: string,
  type: 'standard' | 'meta' | 'high',
  jsonFile: string | null,
  depth: number
): NngTreeNode {
  const children: NngTreeNode[] = []
  // 最大深度 3，避免过深遍历开销
  if (depth < 3 && existsSync(folderPath)) {
    try {
      const entries = readdirSync(folderPath)
      for (const e of entries) {
        if (!e.endsWith('_nng.json')) continue
        const fp = join(folderPath, e)
        try {
          const st = statSync(fp)
          if (st.isFile()) {
            const childName = parseNngName(e)
            const childType = parseNngType(e)
            const childFolderName = e.replace(/_nng\.json$/, '')
            const childFolderPath = join(folderPath, childFolderName)
            children.push(
              readNngNode(childFolderPath, childFolderName, childName, childType, e, depth + 1)
            )
          }
        } catch {
          // 跳过
        }
      }
    } catch {
      // 跳过
    }
  }
  return {
    name,
    // path 指向该节点 json 文件完整路径（前端点击 openFilePreview 直接读文件内容）
    // 一级节点：NNG/AI{aiId}/U{uid}/root/{name}_nng.json；二级及以下：{父文件夹}/{name}_nng.json
    path: jsonFile ? join(dirname(folderPath), jsonFile) : folderPath,
    type,
    children,
    jsonFile
  }
}

/** 一次性读取所有可视化数据（减少前端轮询开销） */
export function readAllVisualizationData(
  paths: DataPaths,
  errorLogList: ErrorLogEntry[]
): {
  monitorState: MonitorState | null
  errorLogs: ErrorLogEntry[]
  memories: MemoryListItem[]
  nngTree: NngTreeNode[]
} {
  return {
    monitorState: readMonitorState(paths),
    errorLogs: readErrorLogEntries(errorLogList),
    memories: listMemories(paths),
    nngTree: readNngTree(paths)
  }
}

/** 截断长文本（保留前 N 字符，尾部加省略号） */
function truncate(text: string, maxLen: number): { text: string; truncated: boolean } {
  if (text.length <= maxLen) return { text, truncated: false }
  return { text: `${text.slice(0, maxLen)}…`, truncated: true }
}

/**
 * 读取最新一条 raw_memory 摘要（监控面板"最新 RAW"接口）。
 * 定位方式：读 raw_memory/序号.json 的 {当前日期, 当前序号} → 拼 {当前日期路径}/{序号}.md。
 * 内容截断：用户原话 200 字 / AI 回复 300 字，供面板展示；点击可打开完整文件。
 */
export function readLatestRawMemory(paths: DataPaths): RawMemoryLatest | null {
  // 1. 读计数器，定位最新文件
  let date = ''
  let seq = 0
  try {
    if (existsSync(paths.rawMemoryCounter)) {
      const counter = JSON.parse(readFileSync(paths.rawMemoryCounter, 'utf-8')) as {
        当前日期?: string
        当前序号?: number
      }
      date = String(counter.当前日期 ?? '')
      seq = Number(counter.当前序号 ?? 0)
    }
  } catch {
    // 计数器不可读则 fallback 扫描目录
  }

  if (!date || seq <= 0) {
    // fallback：扫 raw_memory 目录找序号最大的文件
    const files: Array<{ seq: number; date: string; path: string }> = []
    const scanDir = (dir: string, datePrefix: string) => {
      let entries: string[] = []
      try {
        entries = readdirSync(dir)
      } catch {
        return
      }
      for (const entry of entries) {
        const fullPath = join(dir, entry)
        try {
          const st = statSync(fullPath)
          if (st.isDirectory()) {
            scanDir(fullPath, datePrefix ? `${datePrefix}-${entry}` : entry)
          } else if (entry.endsWith('.md')) {
            // 兼容 序号.md 和 序号_关键词.md
            const seqNum = Number(entry.replace(/\.md$/, '').split('_')[0])
            if (Number.isFinite(seqNum)) {
              files.push({ seq: seqNum, date: datePrefix || 'unknown', path: fullPath })
            }
          }
        } catch {
          // skip
        }
      }
    }
    scanDir(paths.rawMemory, '')
    if (files.length === 0) return null
    files.sort((a, b) => b.seq - a.seq)
    const latest = files[0]
    date = latest.date
    seq = latest.seq
  }

  // 2. 拼路径：{date: YYYY-MM-DD} → raw_memory/YYYY/MM/DD/{seq}.md（兼容 序号_关键词.md）
  const datePath = date.split('-').join('/')
  const dayDir = join(paths.rawMemory, datePath)
  let filePath = join(dayDir, `${seq}.md`)
  let rawText = ''
  try {
    if (existsSync(filePath)) {
      rawText = readFileSync(filePath, 'utf-8')
    } else {
      // 兼容重命名后的 序号_关键词.md：在日期目录内按序号前缀查找
      const names = existsSync(dayDir) ? readdirSync(dayDir) : []
      const prefixed = names.find((n) => n.startsWith(`${seq}_`) && n.endsWith('.md'))
      if (prefixed) {
        filePath = join(dayDir, prefixed)
        rawText = readFileSync(filePath, 'utf-8')
      }
    }
  } catch {
    rawText = ''
  }
  if (!rawText) return null

  // MD 纯文本解析（标题/时间戳/## 用户/## AI 分节），无 JSON 转义
  const raw = parseRawMemoryContent(rawText)
  const user = truncate(raw.用户原话 ?? '', 200)
  const ai = truncate(raw.AI回复 ?? '', 300)
  return {
    seq,
    date,
    path: filePath.replace(/\\/g, '/'),
    timestamp: raw.时间戳 ?? '',
    userText: user.text,
    aiText: ai.text,
    size: statSync(filePath, { throwIfNoEntry: false })?.size ?? 0,
    truncated: user.truncated || ai.truncated
  }
}

/** 文档 2.1：读取记忆文件完整内容 */
export function readMemoryContent(path: string): Record<string, unknown> | null {
  try {
    if (!existsSync(path)) return null
    return JSON.parse(readFileSync(path, 'utf-8'))
  } catch {
    return null
  }
}

/** 文档 2.2：读取 NNG 文件完整内容 */
export function readNngContent(path: string): Record<string, unknown> | null {
  try {
    if (!existsSync(path)) return null
    return JSON.parse(readFileSync(path, 'utf-8'))
  } catch {
    return null
  }
}

/** 工作流实例文件 → 监控摘要（活跃 + 归档统一转换，只取展示字段） */
function toWorkflowInstanceSummary(raw: Record<string, unknown>): WorkflowInstanceSummary | null {
  try {
    const history = Array.isArray(raw.history) ? (raw.history as Array<Record<string, unknown>>) : []
    const nodes: WorkflowNodeSummary[] = history.map((h) => ({
      nodeId: String(h.nodeId ?? ''),
      nodeName: String(h.nodeName ?? h.nodeId ?? ''),
      status: (h.status as WorkflowNodeSummary['status']) ?? 'done',
      startedAt: Number(h.startedAt ?? 0),
      endedAt: h.endedAt != null ? Number(h.endedAt) : undefined
    }))
    return {
      id: String(raw.id ?? ''),
      templateId: String(raw.templateId ?? ''),
      templateName: raw.templateName != null ? String(raw.templateName) : undefined,
      status: (raw.status as WorkflowInstanceSummary['status']) ?? 'failed',
      currentNode: raw.currentNode != null ? String(raw.currentNode) : null,
      startedAt: Number(raw.startedAt ?? 0),
      completedAt: raw.completedAt != null ? Number(raw.completedAt) : undefined,
      error: raw.error != null ? String(raw.error) : undefined,
      nodes
    }
  } catch {
    return null
  }
}

/**
 * 读取工作流引擎实例进度摘要（监控面板"工作流进度"数据源，工作流迁移后真实进度）。
 * 纯磁盘读取：活跃实例（instances/*.json，status=running/paused）+ 最近归档（archive/*.json 按修改时间取 5 个）。
 */
export function readWorkflowInstanceSummaries(paths: DataPaths): WorkflowInstanceSummary[] {
  const result: WorkflowInstanceSummary[] = []
  const instancesDir = paths.workflowInstances
  const archiveDir = join(instancesDir, 'archive')

  const readDir = (dir: string, limit: number, activeOnly: boolean): void => {
    let files: string[]
    try {
      files = readdirSync(dir).filter((f) => f.endsWith('.json'))
    } catch {
      return
    }
    // 归档按修改时间倒序取最近 N 个；活跃目录直接全量
    const sorted = activeOnly
      ? files
      : files
          .map((f) => ({ f, m: statSync(join(dir, f), { throwIfNoEntry: false })?.mtimeMs ?? 0 }))
          .sort((a, b) => b.m - a.m)
          .slice(0, limit)
          .map((x) => x.f)
    for (const f of sorted) {
      try {
        const raw = JSON.parse(readFileSync(join(dir, f), 'utf-8')) as Record<string, unknown>
        // 活跃目录只收 running/paused；归档目录收全部（含 completed/failed/cancelled）
        const status = raw.status as string
        if (activeOnly && status !== 'running' && status !== 'paused') continue
        const summary = toWorkflowInstanceSummary(raw)
        if (summary) result.push(summary)
      } catch {
        // 跳过损坏文件
      }
    }
  }

  readDir(instancesDir, 0, true)   // 活跃：全部 running/paused
  readDir(archiveDir, 5, false)    // 归档：最近 5 个
  return result
}

// ===== RAW 记忆列表 + 记忆系统文件夹树（监控面板新增） =====

/**
 * RAW 记忆完整列表（监控面板 RAW 区）。
 * 扫 raw_memory 全部 .md 文件（排除计数器），解析对话对数，按日期+序号排序。
 */
export function getRawMemoryList(paths: DataPaths): RawMemoryListItem[] {
  const result: RawMemoryListItem[] = []
  const scanDir = (dir: string, datePrefix: string) => {
    let entries: string[] = []
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const entry of entries) {
      const fullPath = join(dir, entry)
      try {
        const st = statSync(fullPath)
        if (st.isDirectory()) {
          scanDir(fullPath, datePrefix ? `${datePrefix}-${entry}` : entry)
        } else if (entry.endsWith('.md')) {
          const seqNum = Number(entry.replace(/\.md$/, '').split('_')[0])
          if (!Number.isFinite(seqNum)) continue
          let entriesCount = 0
          let userText = ''
          try {
            const entriesParsed = parseRawMemoryEntries(readFileSync(fullPath, 'utf-8'))
            entriesCount = entriesParsed.length
            userText = entriesParsed[0]?.用户原话 ?? ''
          } catch {
            // 解析失败保留 0
          }
          result.push({
            path: fullPath.replace(/\\/g, '/'),
            date: datePrefix || 'unknown',
            seq: seqNum,
            size: st.size,
            entries: entriesCount,
            userText: userText.slice(0, 80)
          })
        }
      } catch {
        // 跳过
      }
    }
  }
  scanDir(paths.rawMemory, '')
  result.sort((a, b) => (a.date === b.date ? a.seq - b.seq : a.date < b.date ? -1 : 1))
  return result
}

/**
 * 记忆系统文件夹树（记忆专用视图，用户设计）：
 * 顶层只显示五个记忆分类（普通/元认知/高阶/RAW/NNG），不显示 workflows/
 * 等非记忆目录；全部 loaded:false，点开文件夹才扫该层（懒加载）。
 */
export function getMemoryDirectoryTree(paths: DataPaths): MemoryDirectoryNode[] {
  const sections: Array<{ name: string; path: string }> = [
    { name: '普通记忆（normal）', path: paths.memoryNormal },
    { name: '元认知记忆（meta）', path: paths.memoryMeta },
    { name: '高阶记忆（high）', path: paths.memoryHigh },
    { name: 'RAW 记忆', path: paths.rawMemory },
    { name: 'NNG 图（root）', path: paths.nngLevel1Dir }
  ]
  return sections.map((s) => ({
    name: s.name,
    path: s.path.replace(/\\/g, '/'),
    type: 'dir' as const,
    children: [],
    loaded: false,
    hasMore: existsSync(s.path)
  }))
}

/** 取某目录的直接子节点（懒加载用：目录展开时调用，只扫这一层）
 * 用户定稿：显示真实文件夹结构——不配对、不分组、不过滤空目录，
 * 纯按名称排序（NNG 的 `1xx/` 与 `1xx_nng.json` 同名相邻成列排开，和真实文件一致）。 */
export function getDirectoryChildren(absPath: string): MemoryDirectoryNode[] {
  const result: MemoryDirectoryNode[] = []
  let entries: string[] = []
  try {
    // 纯名称排序（不 dir 优先、不分组）——真实结构 + 同名相邻
    entries = readdirSync(absPath).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  } catch {
    return result
  }
  for (const entry of entries) {
    const fullPath = join(absPath, entry)
    try {
      const st = statSync(fullPath)
      if (st.isDirectory()) {
        result.push({
          name: entry,
          path: fullPath.replace(/\\/g, '/'),
          type: 'dir',
          children: [],
          loaded: false,
          hasMore: true
        })
      } else {
        result.push({ name: entry, path: fullPath.replace(/\\/g, '/'), type: 'file', size: st.size })
      }
    } catch {
      // 跳过损坏
    }
  }
  return result
}
