/**
 * 内部会话「摆放结构」描述（逆生树三边语义的单源实现）。
 * 为什么存在：逆生树有三条独立坐标——继承轴（parentId/gen，向下，实线）、时间延续
 * （timeBranchId/isTimeFork/timeSourceId，v0.27 起同样向下，不再横向引出，实线）、
 * 新话题边（isNewTopic，AI 判定话题需新开的新会话，虚线，v0.28 起与继承区分）。
 * 同一套「代际 + 时间线 + 新话题」口径被三处消费：buildSessionContext 的锚点注入、
 * session-router 的候选清单渲染、session_select 工具的清单展示。此前三处各自书写
 * 会把语义写漂移（历史上同一口径出现过三次重复实现），现收敛为单一纯函数，
 * 三处调用格式逐字节一致。
 * 纯函数：不依赖 store 实例，跨会话查找（时间线上游回溯/同级分叉）由调用方
 * 以回调注入，便于 router（无 store）与 Layer/工具（有 store）各自按需提供。
 */
import type { InternalSession, InternalSessionSummary } from '@shared/types'

/** 摆放描述所需的会话公共字段（覆盖 Session 全量与 Summary 两者的交集） */
export interface PlacementView {
  id: string
  parentId?: string
  gen?: number
  /** ★ 新话题边标记：true = AI 判定话题需要新开的新会话（逆生树虚线，不复制父内容）；缺省 = 继承/延续（实线） */
  isNewTopic?: boolean
  isTimeFork?: boolean
  timeSourceId?: string
  timeBranchId?: string
}

/** 摆放描述所需的跨会话查找能力（由调用方注入：router 传候选集，store 方传真实存储） */
export interface PlacementLookup {
  /** 按 id 读取会话（时间线上游逐级回溯用）；不存在返回 null */
  get: (id: string) => PlacementView | null
  /** 同级时间分叉候选集（isTimeFork 时用于寻找同源兄弟）；缺省不渲染同级信息 */
  listSiblings?: () => Array<{ id: string; timeSourceId?: string }>
}

export interface PlacementDescription {
  /** 继承轴（向下）单行：第 N 代 / 根会话，含可回翻提示 */
  genLine: string
  /** 时间延续整段（含【时间线】前缀；同向下延伸）；无时间信息时为 null */
  timeLineBlock: string | null
}

/**
 * 描述单个内部会话在逆生树中的摆放位置。
 * genLine 语义：继承是压缩上下文——老会话冻结后 gen 不再 +1，最新叶子恒为链上
 * gen 最大者，AI 据此识别应承接哪个会话（新增时取最大 gen+1）。
 * isNewTopic 语义（v0.28 起 AI 判定话题新开的新会话，虚线）：空白承接当前输入、
 * 【不复制】父会话内容（与继承/时间延续的实线语义对立）；AI 据此识别它是
 * 「另一件事」而非同一话题的压缩/延续承接。
 * timeLineBlock 语义（v0.24 逆生树时间连线）：
 * - 上游：沿 timeSourceId 逐级回溯到源头（副本 → 源 → 源的源…），每级都可回翻；
 * - 分叉：isTimeFork 说明本会话是系统自动复制产生的时间延续；
 * - 锁定：timeBranchId 说明本会话已向时间下级延续、只读，后续承接应进时间尾端；
 * - 同级：与本次分叉同源（timeSourceId 相同）的其他副本 = 时间兄弟。
 */
export function describePlacement(view: PlacementView, lookup: PlacementLookup): PlacementDescription {
  const genLine = view.isNewTopic
    ? `代际：第 ${view.gen ?? 1} 代（挂接自 ${view.parentId}，AI 判定新话题新开【虚线】、空白承接当前输入、不复制父会话内容；可回翻其会话文件）`
    : `代际：第 ${view.gen ?? 1} 代（${view.parentId ? `继承自 ${view.parentId}，可回翻其会话文件获取原始上下文` : '根会话，无父会话'}）`

  const parts: string[] = []
  if (view.timeSourceId) {
    // 沿 timeSourceId 向上回溯完整时间线（有限环防御：visited 集合）
    const lineage: string[] = []
    const visited = new Set<string>()
    let curId: string | undefined = view.timeSourceId
    while (curId && !visited.has(curId)) {
      visited.add(curId)
      const s = lookup.get(curId)
      if (!s) break
      lineage.unshift(s.id)
      curId = s.timeSourceId
    }
    parts.push(
      `本会话是时间分叉副本，复制自 ${view.timeSourceId}（时间线：${[...lineage, view.id].join(' → ')}，可沿此链逐级回翻原始会话文件）`
    )
  }
  if (view.timeBranchId) {
    parts.push(
      `本会话已向时间下级 ${view.timeBranchId} 延续并被锁定（只读）；后续承接应进入时间尾端，不要在本会话直接续写`
    )
  }
  if (view.isTimeFork && view.timeSourceId) {
    const sibs = (lookup.listSiblings?.() ?? [])
      .filter((x) => x.timeSourceId === view.timeSourceId && x.id !== view.id)
      .map((x) => x.id)
    if (sibs.length > 0) parts.push(`同级时间分叉：${sibs.join(', ')}（与本会话同源，注意区分话题分支）`)
  }

  return {
    genLine,
    timeLineBlock: parts.length > 0 ? `【时间线】${parts.join('；')}` : null
  }
}

/** 类型护栏：PlacementView 兼容 InternalSession 与 InternalSessionSummary（防字段演进后静默缺失） */
export type PlacementViewFromSession = InternalSession | InternalSessionSummary