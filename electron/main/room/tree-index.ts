/**
 * @category ROOM
 * @summary 会话树索引的渲染（**纯函数**）：把房间树 / 承载会话树的索引变成提示词段
 *
 * 为什么拆出来：`runtime.ts` 已到 800 行硬红线（CODE-RULES §3.1），而这段是**无状态纯格式化**，
 * 与「运行时怎么跑」无关。拆出后 `runtime.ts` 保留再导出，消费方（test / bootstrap）零改动。
 *
 * 口径（ADR-30）：只给索引（落点标记 / id / 标题 / 摘要 / 代际 / 可写与否），**不给正文**——
 * 正文由 AI 按需回翻。每棵树最多列 `TREE_INDEX_MAX` 条。
 *
 * 不删理由：删掉即「AI 看到什么」的构造点回到运行时宿主里，既不可单测也会继续把宿主撑大。
 */
/** 会话树：`room` = 房间自持树；`host` = 承载房间的那个会话的树（ADR-30） */
export type RoomTree = 'room' | 'host'

/** 一棵会话树的索引里的一条（两棵树共用同一形状） */
export interface TreeSessionLine {
  id: string
  title: string
  summary: string
  /** 第几代（继承轴；根为 1 / 缺省） */
  gen?: number
  /** 可写尾端（无时间下级、无继承子）——**只有它能被承接** */
  writableTail: boolean
  updatedAt: number
}

/** 一棵会话树的索引（只给索引不给正文——用户「不需要全部读取」） */
export interface TreeIndex {
  tree: RoomTree
  sessionId: string
  /** 该树当前的落点（承接指针）；无则 null */
  activeId: string | null
  sessions: TreeSessionLine[]
}

/** 树索引每棵最多列几条（只给索引；正文由 AI 按 id 回翻——用户「不需要全部读取」） */
export const TREE_INDEX_MAX = 5

const TREE_LABEL: Record<RoomTree, string> = {
  room: '房间树（你自己的主上下文）',
  host: '承载会话树（用户当前会话那条）'
}

/**
 * 把两棵树的索引渲染成提示词段（**纯函数**，便于单测）。
 * 只给索引（落点标记 / id / 标题 / 摘要 / 代际 / 可写与否）——正文由 AI 自己回翻。
 */
export function buildTreeIndexBlock(trees: readonly TreeIndex[]): string {
  const blocks: string[] = []
  for (const t of trees) {
    const lines = t.sessions.slice(0, TREE_INDEX_MAX).map((s, i) => {
      const flags = [s.writableTail ? '可写' : '只读', s.gen != null ? `第${s.gen}代` : ''].filter(Boolean).join('/')
      const mark = s.id === t.activeId ? '★当前落点 ' : ''
      return `  ${i + 1}. ${mark}${s.id} [${flags}] ${s.title}：${(s.summary || '（无摘要）').slice(0, 200)}`
    })
    blocks.push(
      `· ${TREE_LABEL[t.tree]}\n${lines.length > 0 ? lines.join('\n') : '  （空——可用 landing 的 create 开第一条线）'}`
    )
  }
  return blocks.length > 0 ? `\n【会话树】\n${blocks.join('\n')}` : ''
}
