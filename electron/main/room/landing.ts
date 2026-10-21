/**
 * @category ROOM
 * @summary 房间落点（AI 主动声明「下一轮接哪条线」）的形状定义与解析（**纯函数**）
 *
 * 为什么拆出来：`runtime.ts` 已到 800 行硬红线（CODE-RULES §3.1），而落点解析是无状态纯函数。
 * 拆出后 `runtime.ts` 再导出，消费方（test / bootstrap）零改动。
 *
 * 边界：本文件只做**形状**校验；语义校验（可写尾端 / 父是否存在）在应用点 `applyLanding`
 * （复用 `session_select` 的规则），本层不碰业务判断。
 *
 * 不删理由：删掉即落点解析回到运行时宿主里，既不可单测也会继续把宿主撑大。
 */

/** AI 主动声明的落点（作用于**当前主树**，由 `contextMode` 决定是哪棵） */
export interface RoomLanding {
  action: 'continue' | 'create'
  /** continue 必填（目标节点）；create 可选（从哪个可写尾端分叉） */
  internalId?: string
  title?: string
  summary?: string
  /** create：true = 新话题（虚线，空白承接不复制父内容）；缺省 = 从可写尾端实线继承 */
  newTopic?: boolean
}

/**
 * 落点形状校验（**纯函数**）：只认 `action === 'continue' | 'create'`，其余字段按需取。
 * 形状非法 → null（调用方丢弃并留痕，不抛——与 `contextMode` 同处置）。
 */
export function parseLanding(raw: unknown): RoomLanding | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as { action?: unknown; internalId?: unknown; title?: unknown; summary?: unknown; newTopic?: unknown }
  if (o.action !== 'continue' && o.action !== 'create') return null
  return {
    action: o.action,
    ...(typeof o.internalId === 'string' && o.internalId ? { internalId: o.internalId } : {}),
    ...(typeof o.title === 'string' && o.title.trim() ? { title: o.title.trim() } : {}),
    ...(typeof o.summary === 'string' && o.summary.trim() ? { summary: o.summary.trim() } : {}),
    ...(o.newTopic === true ? { newTopic: true } : {})
  }
}
