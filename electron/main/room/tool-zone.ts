/**
 * @category ROOM
 * @summary 工具区：AI 自造工具的登记与执行（**声明式**，不是任意代码）
 *
 * 为什么存在：交接单 §7 的工具区是「AI 自己做工具的地方，给执行器用的」，且 §0 T1-8
 * 把「工具区产物启用」列为显式授予能力。这是最后一个仍是占位的 ROOM 分区。
 *
 * 不删理由：删掉即「AI 自造工具」没有承载面，`t1.tool-zone-enable` 也就没有作用对象。
 *
 * **形态选择（重要）**：AI 自造工具做成**声明式组合**——`名称 + 描述 + 步骤序列（引用既有工具）`，
 * **不是任意代码**。理由：执行 AI 写的任意代码需要沙箱 + 一整套逃逸防护，而「把既有工具按顺序组合」
 * 已覆盖「自造工具」的真实需求，且**每一步仍各自过 `evaluatePolicy`**（执行器门控），风险可控。
 * 若后续确需代码型工具，应单独立 ADR 评估沙箱面。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { renameFileWithRetry } from '../utils/atomic-write'
import type { ExecutorDecision, ExecutorResult } from './executor'

/** 组合步骤：调用某个既有工具（参数为模板字面量，不含占位替换——保持简单可预测）。 */
export interface ToolZoneStep {
  tool: string
  params: Record<string, unknown>
}

export interface ToolZoneEntry {
  id: string
  name: string
  description: string
  steps: ToolZoneStep[]
  /** 是否启用（未启用 = 执行器侧 fromToolZone 的动作会被拒） */
  enabled: boolean
  createdAt: number
}

export interface ToolZoneFile {
  updatedAt: string
  entries: ToolZoneEntry[]
}

const MAX_STEPS = 8
const MAX_ENTRIES = 50

/** 校验并规范化一条工具区条目（纯函数）。`allowedTools` = 当前可调用的工具名集合。 */
export function validateEntry(
  raw: unknown,
  allowedTools: readonly string[],
  now: number
): { ok: true; entry: ToolZoneEntry } | { ok: false; error: string } {
  const r = (raw ?? {}) as {
    id?: unknown
    name?: unknown
    description?: unknown
    steps?: unknown
    enabled?: unknown
  }
  const name = typeof r.name === 'string' ? r.name.trim() : ''
  if (!name) return { ok: false, error: '缺少工具名称' }
  if (!Array.isArray(r.steps) || r.steps.length === 0) return { ok: false, error: '至少需要一个步骤' }
  if (r.steps.length > MAX_STEPS) return { ok: false, error: `步骤数不得超过 ${MAX_STEPS}` }

  const allowed = new Set(allowedTools)
  const steps: ToolZoneStep[] = []
  for (const s of r.steps) {
    const st = (s ?? {}) as { tool?: unknown; params?: unknown }
    const tool = typeof st.tool === 'string' ? st.tool.trim() : ''
    if (!tool) return { ok: false, error: '步骤缺少 tool' }
    if (!allowed.has(tool)) return { ok: false, error: `步骤工具「${tool}」不在可用工具集合内` }
    steps.push({
      tool,
      params: (st.params && typeof st.params === 'object' ? st.params : {}) as Record<string, unknown>
    })
  }

  const id = typeof r.id === 'string' && r.id.trim() ? r.id.trim() : `tz_${now}_${Math.abs(name.length * 31)}`
  return {
    ok: true,
    entry: {
      id,
      name,
      description: typeof r.description === 'string' ? r.description : '',
      steps,
      enabled: r.enabled === true,
      createdAt: now
    }
  }
}

/** 执行一条工具区工具：**逐步串行**，任一步失败即停（不继续跑后续步骤）。 */
export async function runZoneTool(
  entry: ToolZoneEntry,
  execute: (decision: ExecutorDecision) => Promise<ExecutorResult>
): Promise<{ ok: boolean; steps: Array<{ tool: string; ok: boolean; error?: string }> }> {
  const results: Array<{ tool: string; ok: boolean; error?: string }> = []
  for (const step of entry.steps) {
    const r = await execute({
      kind: 'tool',
      toolName: step.tool,
      params: step.params,
      description: `工具区「${entry.name}」步骤：${step.tool}`,
      fromToolZone: true
      // 不传 readOnly：只读性由工具注册表元数据判定（见 ./tool-risk，P0-2）——
      // 工具区产物本身不是注册表工具，故外层一律按高风险；内部步骤各自按自身元数据判定，
      // 结构上不给「包一层就免审」的捷径。
    })
    const failed = !r.ok
    results.push({
      tool: step.tool,
      ok: !failed,
      ...(failed ? { error: r.decision.reason || r.result?.error || '执行失败' } : {})
    })
    if (failed) return { ok: false, steps: results }
  }
  return { ok: true, steps: results }
}

/**
 * 判定一个动作名走哪条路。**注册表优先**——避免自造工具用同名遮蔽内置工具
 * （遮蔽会让「AI 自造一个叫 read 的工具」变成劫持内置读取）。
 */
export function routeToolName(
  name: string,
  registryTools: readonly string[],
  zoneEntries: readonly ToolZoneEntry[]
): { kind: 'registry' } | { kind: 'zone'; entry: ToolZoneEntry } | { kind: 'unknown' } {
  if (!name) return { kind: 'unknown' }
  if (registryTools.includes(name)) return { kind: 'registry' }
  const entry = zoneEntries.find((e) => e.enabled && e.name === name)
  return entry ? { kind: 'zone', entry } : { kind: 'unknown' }
}

/** 工具区持久化（记录型 JSON，走 §3.8 的原子写收敛）。 */
export class ToolZoneStore {
  constructor(private readonly dir: string) {}

  private filePath(): string {
    return join(this.dir, 'tool-zone.json')
  }

  load(): ToolZoneEntry[] {
    const p = this.filePath()
    if (!existsSync(p)) return []
    try {
      const parsed = JSON.parse(readFileSync(p, 'utf-8')) as ToolZoneFile
      return Array.isArray(parsed?.entries) ? parsed.entries : []
    } catch {
      return []
    }
  }

  save(entries: ToolZoneEntry[]): void {
    const p = this.filePath()
    mkdirSync(dirname(p), { recursive: true })
    const body: ToolZoneFile = { updatedAt: new Date().toISOString(), entries: entries.slice(0, MAX_ENTRIES) }
    const tmp = `${p}.tmp`
    writeFileSync(tmp, JSON.stringify(body, null, 2), 'utf-8')
    renameFileWithRetry(tmp, p)
  }
}

export { MAX_ENTRIES as TOOL_ZONE_MAX_ENTRIES, MAX_STEPS as TOOL_ZONE_MAX_STEPS }
