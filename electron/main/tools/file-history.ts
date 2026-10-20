/**
 * file-history.ts
 * 文件编辑历史（会话级审计）：为什么存在——write/edit/notebook-edit 落盘成功后只返回行数
 * 统计，不保留"本次会话改了哪些文件"的追溯记录；重型方案是编辑前做快照备份、支持回滚，
 * 本产品按轻量定位取舍：不改 write/edit 接口，只在落盘成功后记录一条 diff 摘要，
 * 供会话内审计与 UI 追溯。
 * 作用：会话级内存存储（sessionId → FileEditRecord[]），提供 record/get/clear。
 * 设计原则：
 * 1. fire-and-forget：调用方（工具 execute 成功落盘后）调用，记录失败绝不影响主流程；
 * 2. 内存态、会话级：随进程生命周期，不落盘、不跨会话——审计价值在"本次会话刚改了什么"；
 * 3. 只读快照返回：getFileHistory 返回副本，外部改不动内部状态；
 * 4. 上限淘汰：每会话最多保留 MAX_RECORDS_PER_SESSION 条，超出丢弃最旧记录。
 */
import { createHash } from 'crypto'

export interface FileEditRecord {
  /** 记录 id（全局单调递增，便于排序与 UI key） */
  id: number
  /** 会话标识（ctx.sessionId ?? 'global'） */
  sessionId: string
  /** 操作类型：Write（覆盖写）/ Edit（字符串替换）/ NotebookEdit（按单元格改 ipynb） */
  op: 'Write' | 'Edit' | 'NotebookEdit'
  /** 落盘文件的绝对路径 */
  filePath: string
  /** 写入字节数 */
  bytes: number
  /** 新增行数（与工具返回的 addedLines 同口径） */
  addedLines: number
  /** 删除行数（与工具返回的 removedLines 同口径） */
  removedLines: number
  /** 写后内容 sha256（16 进制小写） */
  sha256: string
  /** 记录时间（epoch ms） */
  timestamp: number
}

/** 每会话保留的记录上限：100 条足够会话内审计追溯，防止长会话内存无限增长 */
export const MAX_RECORDS_PER_SESSION = 100

const GLOBAL_SESSION = 'global'

const store = new Map<string, FileEditRecord[]>()
let nextId = 1

function keyOf(sessionId: string | null | undefined): string {
  return sessionId ?? GLOBAL_SESSION
}

export interface RecordFileEditInput {
  sessionId?: string | null
  op: FileEditRecord['op']
  filePath: string
  bytes: number
  addedLines: number
  removedLines: number
  sha256: string
}

/** 落盘成功后记录一条编辑审计（同步内存写入；调用方无需感知失败分支） */
export function recordFileEdit(input: RecordFileEditInput): FileEditRecord {
  const sessionId = keyOf(input.sessionId)
  const record: FileEditRecord = {
    id: nextId++,
    sessionId,
    op: input.op,
    filePath: input.filePath,
    bytes: input.bytes,
    addedLines: input.addedLines,
    removedLines: input.removedLines,
    sha256: input.sha256,
    timestamp: Date.now(),
  }
  const list = store.get(sessionId) ?? []
  list.push(record)
  if (list.length > MAX_RECORDS_PER_SESSION) {
    list.splice(0, list.length - MAX_RECORDS_PER_SESSION)
  }
  store.set(sessionId, list)
  return { ...record }
}

/** 查询某会话的编辑历史（只读快照，按记录顺序返回；不传 sessionId 查 global） */
export function getFileHistory(sessionId?: string | null): FileEditRecord[] {
  const list = store.get(keyOf(sessionId))
  return list ? list.map((r) => ({ ...r })) : []
}

/** 清空编辑历史：传 sessionId 只清该会话；不传清空全部（测试/会话切换用） */
export function clearFileHistory(sessionId?: string | null): void {
  if (sessionId === undefined || sessionId === null) {
    store.clear()
    return
  }
  store.delete(keyOf(sessionId))
}

/** 计算内容 sha256（16 进制小写）：审计摘要用，与写后验证（字节比较）不同用途 */
export function sha256Of(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}