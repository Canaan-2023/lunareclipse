/**
 * @category 安全
 * @summary 权限层审计落点：JSONL 追加写 + 尾部读取
 *
 * 为什么存在：交接单 §0 要求「全量审计」——T0 拒绝、T1 未授予拒绝、T1 越界拒绝、以及每次放行
 * 都必须可回溯。裁决层只负责产出 AuditEntry，落点独立成模块，使裁决保持纯逻辑可测。
 *
 * 什么作用：提供文件 sink（JSONL 追加）、内存 sink（测试用）与尾部读取（UI 审计视图用）。
 *
 * 不删理由：删掉即审计退回「只 console.log」，而 console 不落盘、不可回溯、分发包里也读不到。
 *
 * 写策略：`appendFileSync` 追加单行 JSON（追加型、非读改写覆盖，不适用 CODE-RULES §3.8 的
 * 原子写收敛规则——该规则针对「写临时文件再 rename 覆盖记录型文件」的形态）。
 * 写入失败一律吞掉：审计是旁路，绝不能因为它写不进去而改变裁决结果或阻断动作。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs'
import { dirname, join } from 'path'
import type { AuditEntry, AuditSink } from '@shared/types/permission'
import { getAppAnchor } from '../../utils/app-root'

/**
 * 默认审计文件路径：`<锚点>/data/security/audit.jsonl`。
 * 为什么是单源函数：权限层的两个装配点（`bootstrap/assembly-ipc.ts` 的 `security:listAudit` 读取、
 * 路由栈 `routing/routing-stack.ts` 的审计落点）必须指向同一文件，各写一份必然漂移。
 * `data/` 不进包（CODE-RULES §3.4），锚点派生保证随程序整体搬迁。
 */
export function defaultAuditFilePath(): string {
  return join(getAppAnchor(), 'data', 'security', 'audit.jsonl')
}

/** 文件 sink：把每条审计以一行 JSON 追加到 filePath（目录不存在则先建）。 */
export function createFileAuditSink(filePath: string): AuditSink {
  return (entry: AuditEntry): void => {
    try {
      mkdirSync(dirname(filePath), { recursive: true })
      appendFileSync(filePath, `${JSON.stringify(entry)}\n`, 'utf-8')
    } catch {
      /* 审计写入失败不影响裁决（见文件头「写策略」） */
    }
  }
}

/** 内存 sink：测试用。`entries` 为实时数组（按写入顺序）。 */
export function createMemoryAuditSink(): { sink: AuditSink; entries: AuditEntry[] } {
  const entries: AuditEntry[] = []
  return {
    sink: (entry) => {
      entries.push(entry)
    },
    entries
  }
}

/**
 * 读取审计尾部 limit 条（最近的在最后）。
 * 文件不存在返回空数组；损坏行跳过（审计文件被外部截断/写入中断时不整体失败）。
 */
export function readAuditTail(filePath: string, limit = 200): AuditEntry[] {
  if (!existsSync(filePath)) return []
  let raw: string
  try {
    raw = readFileSync(filePath, 'utf-8')
  } catch {
    return []
  }
  const lines = raw.split('\n').filter((l) => l.trim().length > 0)
  const tail = lines.slice(-Math.max(0, limit))
  const out: AuditEntry[] = []
  for (const line of tail) {
    try {
      out.push(JSON.parse(line) as AuditEntry)
    } catch {
      /* 跳过损坏行 */
    }
  }
  return out
}
