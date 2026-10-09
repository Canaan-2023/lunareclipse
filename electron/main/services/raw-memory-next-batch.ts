/**
 * 为什么存在：记忆精炼每次只取一批封口 RAW，进度（最后处理日期/序号）必须落盘，崩溃后才能续跑不重不漏。
 * 作用：解析进度文件、读取当日 RAW 记忆，产出下一批待精炼条目与更新后的进度。
 * 不删掉的理由：记忆工作流按批次消费 RAW，无进度落盘会重复提炼或遗漏；批量读取保证
 * 单次 LLM 调用处理完一批对话对，是 RAW→记忆 流转的节流器。
 */

import { existsSync, readdirSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import type { DataPaths } from '../models/paths'
import { nowIso } from '../models/memory'

export interface MemoryWorkflowProgress {
  最后处理日期: string  // YYYY-MM-DD
  最后处理序号: number
  更新时间: string
}

export interface RawMemoryEntry {
  /** raw_memory 文件绝对路径 */
  path: string
  /** 文件完整内容（JSON 字符串） */
  content: string
  /** 当日序号 */
  seq: number
  /** 日期 YYYY-MM-DD */
  date: string
}

export interface RawMemoryBatchResult {
  /** 本批次 raw_memory 条目（已按规则分批） */
  batch: RawMemoryEntry[]
  /** 本批次最后一条 raw_memory 的位置（记忆工作流完成后系统更新进度文档用） */
  nextProgress: { 最后处理日期: string; 最后处理序号: number }
}

export interface RawMemoryContent {
  时间戳?: string
  用户原话?: string
  AI回复?: string
  引用文件?: string[]
}

/**
 * 解析 raw_memory Markdown 文件内容为结构化字段（兼容单对话对格式）。

 * 格式（由 raw-memory-writer 生成）：
 * # RAW 记忆 #40

 * - 时间戳：2026-01-01T00:00:00.000Z

 * ## 用户

 * 用户原话（纯文本，保留换行）

 * ## AI

 * AI 回复（纯文本，保留换行）

 * ## 引用文件（可选）

 * - d:\...\a.ts

 * RAW 是"多对话对追加式"（一个文件含多段 用户/AI），
 * 本函数返回第一个对话对（兼容旧调用方）；新调用方用 parseRawMemoryEntries 取全部。
 */
export function parseRawMemoryContent(content: string): RawMemoryContent {
  const entries = parseRawMemoryEntries(content)
  return entries[0] ?? {}
}

/**
 * 解析 raw_memory Markdown 为对话对数组（多对话对格式）。
 * 按 `## 用户` 标题切分：每个对话对含 时间戳/用户原话/AI回复/引用文件。
 */
export function parseRawMemoryEntries(content: string): RawMemoryContent[] {
  const entries: RawMemoryContent[] = []
  // 按 ## 用户 标题切分对话对（含实名变体：## 用户（用户名，UID=1））
  const userRe = /^## 用户[^\n]*\n?/gm
  const matches: { index: number; length: number }[] = []
  let m: RegExpExecArray | null
  while ((m = userRe.exec(content)) !== null) {
    matches.push({ index: m.index, length: m[0].length })
  }
  if (matches.length === 0) return entries

  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index
    const end = i + 1 < matches.length ? matches[i + 1].index : content.length
    const segment = content.slice(start, end)
    entries.push(parseSegment(segment))
  }
  return entries
}

/** 解析单个对话对段落（含段首的 时间戳 元数据行） */
function parseSegment(segment: string): RawMemoryContent {
  const result: RawMemoryContent = {}
  // 段内找时间戳行（- 时间戳：xxx）
  const ts = segment.match(/- 时间戳：(.+)$/m)
  if (ts) result.时间戳 = ts[1].trim()

  const userText = sectionAfter('## 用户', segment, ['## AI', '## 引用文件'])
  if (userText) result.用户原话 = userText
  const aiReply = sectionAfter('## AI', segment, ['## 引用文件'])
  if (aiReply) result.AI回复 = aiReply

  // 引用文件：## 引用文件 之后的 - 列表行
  const filesIdx = segment.indexOf('## 引用文件')
  if (filesIdx >= 0) {
    const filesBody = segment.slice(filesIdx + '## 引用文件'.length)
    const files = filesBody
      .split('\n')
      .map((s) => s.replace(/^-\s*/, '').trim())
      .filter((s) => s.length > 0)
    if (files.length > 0) result.引用文件 = files
  }
  return result
}

/**
 * 提取指定标题后的正文，到任一停止标题（或段尾）截断。
 * 不用 lookahead 正则：分隔符不存在时（段尾）整体匹配会失败，
 * 手动截断逻辑对"无分隔符"天然兼容。
 */
function sectionAfter(heading: string, segment: string, stopHeadings: string[]): string {
  const headMatch = new RegExp(`^${heading}[^\n]*\n?`, 'm').exec(segment)
  if (!headMatch || headMatch.index === undefined) return ''
  let body = segment.slice(headMatch.index + headMatch[0].length)
  for (const stop of stopHeadings) {
    const stopMatch = new RegExp(`^${stop}`, 'm').exec(body)
    if (stopMatch && stopMatch.index !== undefined) {
      body = body.slice(0, stopMatch.index)
      break
    }
  }
  return body.replace(/^\s*\n/, '').replace(/\s+$/, '').trim()
}

// 兼容两种格式：纯序号（20.md）和 序号_关键词（20_记忆已整理_重点回顾.md）
const SEQ_REGEX = /^(\d+)(?:_[\u4e00-\u9fa5A-Za-z0-9_]+)?\.md$/

/**
 * 从记忆工作流进度开始扫描 raw_memory，连续取 batchSize 条成一批

 * 不再按字符阈值分批——长对话本来就是完整语义单元，限制字符会让 AI 失去完整上下文。
 * 现在的规则：从进度游标开始连续取 N 条（默认 5），不分长短，不单独成批。

 * 跨天扫描：扫完一天的所有文件后，cursor 前进一天，直到今天
 * 没有更多 raw_memory → 返回空批次
 */
export function getNextRawMemoryBatch(paths: DataPaths, batchSize = 5): RawMemoryBatchResult {
  const progress = readRawMemoryProgress(paths.rawMemoryProgress)
  const rawMemoryRoot = paths.rawMemory

  // 确定扫描起点
  let startDate: Date
  let startSeq: number
  if (progress.最后处理日期 && progress.最后处理序号 > 0) {
    // 从上次处理位置的下一条开始
    startDate = parseDayKey(progress.最后处理日期)
    startSeq = progress.最后处理序号 + 1
  } else {
    // 首次运行，找最早的 raw_memory 日期
    const earliest = findEarliestRawMemoryDate(rawMemoryRoot)
    if (!earliest) {
      return {
        batch: [],
        nextProgress: { 最后处理日期: '', 最后处理序号: 0 }
      }
    }
    startDate = earliest
    startSeq = 1
  }

  const today = new Date()
  today.setHours(0, 0, 0, 0)

  const startDayKey = formatDayKey(startDate)
  const batch: RawMemoryEntry[] = []
  let batchDone = false

  const cursor = new Date(startDate.getTime())
  while (cursor <= today && !batchDone) {
    const dateKey = formatDayKey(cursor)
    const allEntries = listRawMemoryFiles(rawMemoryRoot, cursor)
    // 封口规则：今日最大序号 = 当前活跃写入的 RAW（未满且无后继，
    // 可能还在追加），不进工作流。等下一个 RAW 产生（或隔天必然开新文件）后它才"封口"可处理。
    const isToday = dateKey === formatDayKey(today)
    const todayMaxSeq = isToday ? Math.max(0, ...allEntries.map((e) => e.seq)) : -1
    const entries = allEntries
      .filter((e) => {
        if (isToday && e.seq === todayMaxSeq) return false
        // 只在起点日期过滤已处理序号；其他日期从 1 开始全部扫描
        if (dateKey === startDayKey) {
          return e.seq >= startSeq
        }
        return true
      })
      .sort((a, b) => a.seq - b.seq)

    for (const entry of entries) {
      batch.push(entry)
      if (batch.length >= batchSize) {
        batchDone = true
        break
      }
    }

    if (!batchDone) {
      cursor.setDate(cursor.getDate() + 1)
    }
  }

  if (batch.length === 0) {
    return {
      batch: [],
      nextProgress: { 最后处理日期: '', 最后处理序号: 0 }
    }
  }

  const lastEntry = batch[batch.length - 1]
  return {
    batch,
    nextProgress: {
      最后处理日期: lastEntry.date,
      最后处理序号: lastEntry.seq
    }
  }
}

/**
 * 记忆工作流处理完一个批次后更新进度文档
 */
export function updateRawMemoryProgress(
  paths: DataPaths,
  progress: { 最后处理日期: string; 最后处理序号: number }
): void {
  const record: MemoryWorkflowProgress = {
    最后处理日期: progress.最后处理日期,
    最后处理序号: progress.最后处理序号,
    更新时间: nowIso()
  }
  const dir = dirname(paths.rawMemoryProgress)
  mkdirSync(dir, { recursive: true }) // 防骨架缺失时进度文件写入 ENOENT（正常由骨架预建，此处幂等兜底）
  const tmp = join(dir, `.progress.${process.pid}.${Date.now()}.tmp`)
  writeFileSync(tmp, JSON.stringify(record, null, 2), 'utf-8')
  renameSync(tmp, paths.rawMemoryProgress)
}

function readRawMemoryProgress(path: string): MemoryWorkflowProgress {
  if (!existsSync(path)) {
    return { 最后处理日期: '', 最后处理序号: 0, 更新时间: '' }
  }
  const raw = readFileSync(path, 'utf-8')
  const obj = JSON.parse(raw) as Partial<MemoryWorkflowProgress>
  return {
    最后处理日期: obj.最后处理日期 ?? '',
    最后处理序号: obj.最后处理序号 ?? 0,
    更新时间: obj.更新时间 ?? ''
  }
}

function parseDayKey(dayKey: string): Date {
  const [y, m, d] = dayKey.split('-').map((s) => parseInt(s, 10))
  return new Date(y, m - 1, d)
}

function formatDayKey(date: Date): string {
  const yyyy = String(date.getFullYear())
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

function listRawMemoryFiles(rawMemoryRoot: string, date: Date): RawMemoryEntry[] {
  const yyyy = String(date.getFullYear())
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  const dayDir = join(rawMemoryRoot, yyyy, mm, dd).replace(/\\/g, '/')
  if (!existsSync(dayDir)) {
    return []
  }

  const names = readdirSync(dayDir)

  const dateKey = `${yyyy}-${mm}-${dd}`
  const result: RawMemoryEntry[] = []
  for (const name of names) {
    const match = name.match(SEQ_REGEX)
    if (!match) continue
    const seq = parseInt(match[1], 10)
    if (Number.isNaN(seq)) continue
    const filePath = join(dayDir, name).replace(/\\/g, '/')
    const content = readFileSync(filePath, 'utf-8')
    result.push({
      path: filePath,
      content,
      seq,
      date: dateKey
    })
  }
  return result
}

/**
 * 找最早的 raw_memory 日期（首次运行时使用）
 */
function findEarliestRawMemoryDate(rawMemoryRoot: string): Date | null {
  if (!existsSync(rawMemoryRoot)) return null
  const years = readdirSync(rawMemoryRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^\d{4}$/.test(e.name))
    .map((e) => e.name)
    .sort()
  for (const year of years) {
    const yearDir = join(rawMemoryRoot, year).replace(/\\/g, '/')
    const months = readdirSync(yearDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^\d{2}$/.test(e.name))
      .map((e) => e.name)
      .sort()
    for (const month of months) {
      const monthDir = join(yearDir, month).replace(/\\/g, '/')
      const days = readdirSync(monthDir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && /^\d{2}$/.test(e.name))
        .map((e) => e.name)
        .sort()
      if (days.length > 0) {
        const day = days[0]
        const date = new Date(parseInt(year, 10), parseInt(month, 10) - 1, parseInt(day, 10))
        if (!Number.isNaN(date.getTime())) {
          return date
        }
      }
    }
  }
  return null
}
