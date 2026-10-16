/**
 * 为什么存在：记忆输入层需把每次对话逐条归档为 RAW 记忆，供后续精炼工作流消费，且按日分文件方便封口。
 * 作用：按 scope 解析目录、维护当日序号自增，追加写入 RAW（超过 20000 字符滚动新文件）。
 * 不删掉的理由：RAW 是矢志不删的原始对话证据层，日记线/NNG 线最终都要回溯到这里；
 * 追加式写入保证对话原文完整落地，无本文件则记忆系统失去输入源头。
 */

import { join } from 'path'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, appendFileSync } from 'fs'
import type { BaseDataPaths, DataPaths, MemoryScope } from '../models/paths'
import { resolveScopePaths } from '../models/paths'
import { nowIso } from '../models/memory'

interface RawMemoryCounter {
  当前日期: string  // YYYY-MM-DD
  当前序号: number  // 当日已分配的最大序号（下一条对话用 +1）
  更新时间: string  // ISO 8601
}

/**
 * RAW 记忆字符上限（按字符上限 + 会话截取，不再一对话对一文件）。
 * 20K 字符 ≈ 1.5-2 万 tokens，本地（qwen3.5:9b 32K）与 API（deepseek 128K）模型都能单次读完整 RAW + 指令。
 * 每个 RAW 大小基本一致：实时追加，加进下一条对话对会超限时才开新文件。
 */
export const RAW_MAX_CHARS = 20000

/**
 * RAW 文件名解析：兼容两种格式——纯序号（20.md）与带关键词（20_记忆已整理_重点回顾.md，
 * 由 rename-raw-memory 工具生成）。与 raw-memory-next-batch.ts 的 SEQ_REGEX 保持一致，
 * 否则 writer 扫描当日最新文件时会漏掉带关键词的文件（找不到"落盘目标"而回退开新文件）。
 */
const SEQ_REGEX = /^(\d+)(?:_[\u4e00-\u9fa5A-Za-z0-9_]+)?\.md$/

/**
 * 原始对话写入 raw_memory（系统自动写入，AI 不参与）

 * 路径规则：{root}/memory/{uid}/{aiId}/raw_memory/YYYY/MM/DD/{序号}.md
 * 每个 AI × 用户 独立统计序号（计数器在各自作用域的 raw_memory/序号.json）

 * 格式（一个 RAW 含多个对话对，追加式）：
 * # RAW 记忆 #N

 * - 时间戳：xxx ← 每个对话对自己的时间戳

 * ## 用户（名字）
 * 用户原话

 * ## AI（名字）
 * AI 回复

 * ## 引用文件（可选）
 * - path

 * 追加逻辑：当前 RAW（内存跟踪 + 当日最大序号兜底）现有大小 + 新对话对 ≤ RAW_MAX_CHARS → 追加；
 * 超限或跨日 → 开新文件（消耗新序号）。
 */
export class RawMemoryWriter {
  /** 当前打开的 RAW 文件路径（按作用域缓存：{uid}_{aiId} → path，跨用户切换不串文件） */
  private currentPaths: Map<string, string> = new Map()
  /** 当前字符上限（构造传入或 setRawMaxChars 热更新；默认 RAW_MAX_CHARS） */
  private maxChars: number

  /**
   * @param paths 全局路径集（resolveScopePaths 的基座）
   * @param getScope 每次 write 时解析当前作用域（用户登录态 + AI 编号动态取）
   * @param rawMaxChars 字符上限（可选）
   */
constructor(
    private paths: BaseDataPaths,
    private getScope: () => MemoryScope | null,
    rawMaxChars?: number
  ) {
    this.maxChars = rawMaxChars && rawMaxChars > 0 ? rawMaxChars : RAW_MAX_CHARS
  }

/** 作用域路径（每次解析，保证登录切换后写入新用户目录；无作用域时抛错而非强转兜底——BaseDataPaths 缺 rawMemory 等字段） */
private scoped(): DataPaths {
    const scope = this.getScope()
    if (!scope) {
      throw new Error('raw_memory 写入失败：无记忆作用域（未登录用户？），无法确定 memory/U{uid}/AI{aiId} 目标目录')
    }
    return resolveScopePaths(this.paths, scope)
  }

  /** 当前作用域 key（无登录态时用全局 key） */
  private scopeKey(): string {
    const scope = this.getScope()
    return scope ? `${scope.uid}_${scope.aiId}` : 'global'
  }

  /** 当前作用域的 currentPath（getter/setter 封装） */
  private get currentPath(): string | null {
    return this.currentPaths.get(this.scopeKey()) ?? null
  }
  private set currentPath(p: string | null) {
    if (p === null) {
      this.currentPaths.delete(this.scopeKey())
    } else {
      this.currentPaths.set(this.scopeKey(), p)
    }
  }

  /** 热更新字符上限（config.json 的 rawMaxChars 变化时调用） */
  setRawMaxChars(n: number): void {
    if (n > 0) this.maxChars = n
  }

  /**
   * 写入一条对话对（追加到当前 RAW，超限自动开新文件）
   * @param userMessage 用户原话
   * @param aiReply AI 回复
   * @param referencedFiles 引用文件路径数组（有就带，没有传空数组）
   * @param timestamp 对话时间（ISO 8601），用于决定归到哪一天
   * @param userLabel 用户实名（如 Player），有则写进 ## 用户 标题
   * @param aiLabel AI 实名（如 月蚀），有则写进 ## AI 标题
   * @param scopeOverride 显式作用域（莉莉丝链路传 {uid, aiId:2}；不传用构造 getScope）
   * @returns 写入的文件绝对路径
   */
write(
    userMessage: string,
    aiReply: string,
    referencedFiles: string[],
    timestamp: string,
    userLabel?: string,
    aiLabel?: string,
    scopeOverride?: MemoryScope,
    opts?: { label?: string; heading?: string }
  ): string {
    const scope = scopeOverride ?? this.getScope()
    if (!scope) {
      throw new Error('raw_memory 写入失败：无记忆作用域（未登录用户？），无法确定 memory/U{uid}/AI{aiId} 目标目录')
    }
    const paths = resolveScopePaths(this.paths, scope)
    const scopeKeyForPath = `${scope.uid}_${scope.aiId}`

    const date = new Date(timestamp)
    if (isNaN(date.getTime())) {
      throw new Error(`时间戳格式无效：${timestamp}`)
    }

    const yyyy = String(date.getFullYear())
    const mm = String(date.getMonth() + 1).padStart(2, '0')
    const dd = String(date.getDate()).padStart(2, '0')
    const dayKey = `${yyyy}-${mm}-${dd}`

    // 组装本对话对段落（纯文本 Markdown，零 JSON 转义）
    const userHeading = userLabel ? `## 用户（${userLabel}）` : '## 用户'
    const aiHeading = aiLabel ? `## AI（${aiLabel}）` : '## AI'
    const entryLines: string[] = [
      '',
      `- 时间戳：${timestamp}`,
      '',
      userHeading,
      '',
      userMessage,
      '',
      aiHeading,
      '',
      aiReply
    ]
    if (referencedFiles.length > 0) {
      entryLines.push('', '## 引用文件', '')
      for (const f of referencedFiles) {
        entryLines.push(`- ${f}`)
      }
    }
const entryText = entryLines.join('\n')

    // 确定追加目标：内存 currentPath → 当日最大序号文件（兜底）→ 新文件。
    // 章节 RAW（opts.label）：每章一个独立文件，不做追加合并（多章不挤进同一文件）。
    // 为什么：写作插件要求「每章一个 RAW」，labelled RAW 若走追加逻辑会把多章挤进同一文件，
    // 破坏「一章一条语义完整原文」的记忆工作流消费前提。
    const target = opts?.label ? null : this.resolveTarget(dayKey, yyyy, mm, dd, entryText.length, paths, scopeKeyForPath)
    if (!target) {
      // 开新文件（写作插件传 opts.label：`{序号}_{章节名}.md` 按章归档；普通对话对保持 `{序号}.md`）。
      // 为什么保留两种形态：对话对需要追加合流（同一会话的 RAW 连续），章节 RAW 需要一章一文件（记忆提炼按章封口）。
      const seq = this.allocateSeq(dayKey, paths)
      const dayDir = join(paths.rawMemory, yyyy, mm, dd)
      if (!existsSync(dayDir)) {
        mkdirSync(dayDir, { recursive: true })
      }
      const fileName = opts?.label ? `${seq}_${opts.label}.md` : `${seq}.md`
      const filePath = join(dayDir, fileName)
      const header = opts?.heading ?? `# RAW 记忆 #${seq}\n`
      writeFileSync(filePath, header + entryText, 'utf-8')
      this.currentPaths.set(scopeKeyForPath, filePath)
      return filePath
    }

    // 追加到现有 RAW
    appendFileSync(target, entryText, 'utf-8')
    return target
  }

  /** 文件字符数：读全文算字符数（非 statSync().size 字节数——UTF-8 中文 3 字节/字，
   * 字节数与字符数混合比较会低估容量 3 倍。RAW 文件小（≤20K 字符），直接读全文可接受）。 */
  private charCount(filePath: string): number {
    return readFileSync(filePath, 'utf-8').length
  }

  /** 查找追加目标：内存 currentPath 或当日最大序号文件。
   * 规则：存在且 现有大小 + 新对话对 ≤ RAW_MAX_CHARS → 返回该文件路径；否则 null（开新文件）。
   * 跨日：内存 currentPath 是前一天的 → 忽略，改扫当日。
   * 为什么存在：同一会话连续追加合流到同一 RAW（对话对语义连续），这是记忆工作流消费的最小粒度。 */
  private resolveTarget(
     dayKey: string,
     yyyy: string,
     mm: string,
     dd: string,
     entryLen: number,
     paths: DataPaths,
     scopeKey: string
   ): string | null {
     // 1. 内存 currentPath（当前作用域的）：先验证它属于当天（跨日则作废）
      const curPath = this.currentPaths.get(scopeKey) ?? null
      if (curPath) {
        const dayDir = join(paths.rawMemory, yyyy, mm, dd).replace(/\\/g, '/')
        const normalizedCur = curPath.replace(/\\/g, '/')
        if (normalizedCur.startsWith(dayDir + '/')) {
          if (existsSync(curPath)) {
           try {
             if (this.charCount(curPath) + entryLen <= this.maxChars) {
               return curPath
             }
           } catch (err) {
             console.error(`[raw-memory-writer] 校验 currentPath 失败（走兜底）: ${curPath}`, err)
           }
         }
       }
       this.currentPaths.delete(scopeKey)
     }
     // 2. 兜底：当日最大序号文件
     const dayDir = join(paths.rawMemory, yyyy, mm, dd)
     if (existsSync(dayDir)) {
       let latest: string | null = null
       let latestSeq = -1
try {
          for (const f of readdirSync(dayDir)) {
            const m = SEQ_REGEX.exec(f)
            if (m) {
              const seq = parseInt(m[1], 10)
              if (seq > latestSeq) {
                latestSeq = seq
                latest = join(dayDir, f)
              }
            }
          }
        } catch (err) {
         console.error(`[raw-memory-writer] 扫描当日 RAW 文件失败（走兜底开新文件）: ${dayDir}`, err)
       }
       if (latest) {
         try {
           if (this.charCount(latest) + entryLen <= this.maxChars) {
             this.currentPaths.set(scopeKey, latest)
             return latest
           }
         } catch (err) {
           console.error(`[raw-memory-writer] 校验当日最新 RAW 失败（走兜底开新文件）: ${latest}`, err)
         }
       }
     }
     return null
   }

  /**
   * 预测下一条对话对将写入的 RAW 编号（只读，不修改计数器）。
   * 追加式语义：现有 RAW 未超限 → 返回当前编号；超限/跨日 → 返回新文件编号。
   * 供上下文注入时告知 AI「本条回复将写入 RAW #N」，编号与写入时一致。
   */
  peekNextSeq(now: Date = new Date()): number {
    const paths = this.scoped()
    const yyyy = String(now.getFullYear())
    const mm = String(now.getMonth() + 1).padStart(2, '0')
    const dd = String(now.getDate()).padStart(2, '0')
    const dayKey = `${yyyy}-${mm}-${dd}`
    // 先看内存 currentPath（当日）→ 现有大小小于上限 → 返回其编号
    const seqFromPath = (p: string | null): number | null => {
      if (!p) return null
      const m = /(\d+)(?:_[\u4e00-\u9fa5A-Za-z0-9_]+)?\.md$/.exec(p.replace(/\\/g, '/'))
      return m ? parseInt(m[1], 10) : null
    }
    const curPath = this.currentPaths.get(this.scopeKey()) ?? null
    const dayDir = join(paths.rawMemory, yyyy, mm, dd).replace(/\\/g, '/')
    if (curPath && curPath.replace(/\\/g, '/').startsWith(dayDir + '/')) {
      if (existsSync(curPath)) {
        try {
          if (this.charCount(curPath) < this.maxChars) {
            const seq = seqFromPath(curPath)
            if (seq !== null) return seq
          }
        } catch (err) {
          console.error(`[raw-memory-writer] peekNextSeq 校验 currentPath 失败: ${curPath}`, err)
        }
      }
    }
    // 当日最大序号文件兜底（兼容带关键词文件名，用真实文件名而不是重拼 ${seq}.md，
    // 否则带关键词的最新文件会被 charCount 判为不存在，落盘目标丢失）
    if (existsSync(dayDir)) {
      let latest: string | null = null
      let latestSeq = -1
      try {
        for (const f of readdirSync(dayDir)) {
          const m = SEQ_REGEX.exec(f)
          if (m) {
            const seq = parseInt(m[1], 10)
            if (seq > latestSeq) {
              latestSeq = seq
              latest = join(dayDir, f)
            }
          }
        }
      } catch { /* 忽略 */ }
      if (latestSeq > 0 && latest) {
        try {
          if (this.charCount(latest) < this.maxChars) return latestSeq
        } catch (err) {
          console.error(`[raw-memory-writer] peekNextSeq 校验当日最新 RAW 失败: ${latest}`, err)
        }
      }
    }
    // 需要新文件：当日序号 + 1（跨日则 1）
    const counterPath = paths.rawMemoryCounter
    if (existsSync(counterPath)) {
      try {
        const counter = JSON.parse(readFileSync(counterPath, 'utf-8')) as RawMemoryCounter
        return counter.当前日期 === dayKey ? counter.当前序号 + 1 : 1
      } catch {
        return 1
      }
    }
    return 1
  }

  /**
   * 分配当日序号（每日重置）
   * 读 raw_memory/序号.json，判断日期是否变化：
   * - 同一天：序号 +1
   * - 新一天：序号重置为 1
   */
  private allocateSeq(dayKey: string, paths: DataPaths): number {
    const counterPath = paths.rawMemoryCounter
    let counter: RawMemoryCounter

    if (existsSync(counterPath)) {
      try {
        counter = JSON.parse(readFileSync(counterPath, 'utf-8'))
      } catch {
        counter = { 当前日期: dayKey, 当前序号: 0, 更新时间: nowIso() }
      }
    } else {
      counter = { 当前日期: dayKey, 当前序号: 0, 更新时间: nowIso() }
    }

    let seq: number
    if (counter.当前日期 === dayKey) {
      seq = counter.当前序号 + 1
    } else {
      // 新一天，序号重置
      seq = 1
    }

    const newCounter: RawMemoryCounter = {
      当前日期: dayKey,
      当前序号: seq,
      更新时间: nowIso()
    }

    // 确保目录存在
    const counterDir = paths.rawMemory
    if (!existsSync(counterDir)) {
      mkdirSync(counterDir, { recursive: true })
    }
    writeFileSync(counterPath, JSON.stringify(newCounter, null, 2), 'utf-8')

    return seq
  }
}
