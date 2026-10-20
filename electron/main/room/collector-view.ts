/**
 * @category ROOM
 * @summary 声明式采集视图：**AI 决定采集什么**（诉求 10）——scope × 字段白名单，不是任意代码
 *
 * 为什么存在：用户裁决「采集什么由 AI 自己决定（含 AI 自定义返回数据）」。此前采集范围是
 * **用户侧布尔开关**（`collector.desktop/processes/network`）+ 写死的字段列表，AI 无从选择。
 *
 * 形态选择（与 `./tool-zone.ts` 同范式，勿改成任意代码/脚本）：AI 声明
 * `{name, scopes, fields, schedule}`，其中 `scopes`/`fields` 必须落在本文件的**白名单**内。
 * 理由：AI 生成任意采集代码需要沙箱 + 逃逸防护；而「在既有字段里挑」已覆盖「决定看什么」的真实需求，
 * 且**每次采集仍过 `evaluatePolicy(t1.collector)`**（唯一检查点不变）。
 *
 * ⚠️ `schedule` 的语义（易误用）：它是 AI 的**自述留痕**，运行时**不得消费**——
 * 采集器是感官不是定时器（见 `./loop.ts` 头注释），激活只由事件/待机到期驱动。
 *
 * 不删理由：删掉即「AI 决定采集什么」退回用户布尔开关，诉求 10 落空。
 */
export const COLLECTOR_SCOPES = ['env', 'system'] as const
export type CollectorScope = (typeof COLLECTOR_SCOPES)[number]

/** 字段真源：每个 scope 下可采集的字段（AI 只能在此白名单内选）。 */
export const COLLECTOR_FIELDS: Record<CollectorScope, readonly string[]> = {
  env: ['platform', 'cpu', 'memory', 'cores', 'disks', 'gpus'],
  system: ['processes', 'network']
}

export interface CollectorView {
  name: string
  scopes: CollectorScope[]
  fields: string[]
  /** AI 自述「多久看一次」——**运行时不得消费**（仅留痕，见文件头） */
  schedule?: string
}

const MAX_NAME = 40
const MAX_FIELDS = 16
const MAX_SCHEDULE = 60

/** 默认视图 = 全部 scope 的全部字段（AI 未声明时的行为与改造前一致）。 */
export function defaultCollectorView(): CollectorView {
  return {
    name: '默认感官',
    scopes: [...COLLECTOR_SCOPES],
    fields: [...COLLECTOR_FIELDS.env, ...COLLECTOR_FIELDS.system]
  }
}

/** 校验并规范化一份采集视图（纯函数）：越界 scope / 白名单外字段一律拒。 */
export function validateCollectorView(
  raw: unknown
): { ok: true; view: CollectorView } | { ok: false; error: string } {
  const r = (raw ?? {}) as { name?: unknown; scopes?: unknown; fields?: unknown; schedule?: unknown }
  const name = typeof r.name === 'string' ? r.name.trim() : ''
  if (!name || name.length > MAX_NAME) return { ok: false, error: `视图名需为 1~${MAX_NAME} 字符` }

  if (!Array.isArray(r.scopes) || r.scopes.length === 0) return { ok: false, error: '至少需要一个 scope' }
  const scopes: CollectorScope[] = []
  for (const s of r.scopes) {
    if (typeof s !== 'string' || !(COLLECTOR_SCOPES as readonly string[]).includes(s)) {
      return { ok: false, error: `未知 scope「${String(s)}」：可选 ${COLLECTOR_SCOPES.join(' / ')}` }
    }
    const sc = s as CollectorScope
    if (!scopes.includes(sc)) scopes.push(sc)
  }

  if (!Array.isArray(r.fields) || r.fields.length === 0) return { ok: false, error: '至少需要一个字段' }
  if (r.fields.length > MAX_FIELDS) return { ok: false, error: `字段数不得超过 ${MAX_FIELDS}` }
  const allowed = new Set(scopes.flatMap((s) => COLLECTOR_FIELDS[s]))
  const fields: string[] = []
  for (const f of r.fields) {
    if (typeof f !== 'string' || !allowed.has(f)) {
      return { ok: false, error: `字段「${String(f)}」不在所选 scope 的白名单内` }
    }
    if (!fields.includes(f)) fields.push(f)
  }

  const sched = typeof r.schedule === 'string' && r.schedule.trim() ? r.schedule.trim().slice(0, MAX_SCHEDULE) : undefined
  return { ok: true, view: { name, scopes, fields, ...(sched ? { schedule: sched } : {}) } }
}

/** 该字段是否被视图选中（供采集实现判定）。 */
export function viewIncludes(view: CollectorView, field: string): boolean {
  return view.fields.includes(field)
}

export { MAX_NAME as COLLECTOR_VIEW_MAX_NAME, MAX_FIELDS as COLLECTOR_VIEW_MAX_FIELDS }
