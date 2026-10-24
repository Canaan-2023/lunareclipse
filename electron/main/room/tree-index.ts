/**
 * @category ROOM
 * @summary 会话树索引的渲染（**纯函数**）：把自主 AI 工作所在会话的逆生树索引变成提示词段
 *
 * 为什么拆出来：`runtime.ts` 已到 800 行硬红线（CODE-RULES §3.1），而这段是**无状态纯格式化**，
 * 与「运行时怎么跑」无关。拆出后 `runtime.ts` 保留再导出，消费方（test / bootstrap）零改动。
 *
 * 口径（ADR-30 / 0.53.18）：只给索引（落点标记 / id / 标题 / 摘要 / 代际 / 可写与否），**不给正文**——
 * 正文由 AI 按需回翻。**只有一棵树**：自主模式不再自持房间树，它继承「开启自主的那个会话」的树。
 *
 * 不删理由：删掉即「AI 看到什么」的构造点回到运行时宿主里，既不可单测也会继续把宿主撑大。
 */

/** 一棵会话树的索引里的一条 */
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
  sessionId: string
  /** 该树当前的落点（承接指针）；无则 null */
  activeId: string | null
  sessions: TreeSessionLine[]
}

/** 树索引最多列几条（只给索引；正文由 AI 按 id 回翻——用户「不需要全部读取」） */
export const TREE_INDEX_MAX = 5

/**
 * 把会话树索引渲染成提示词段（**纯函数**，便于单测）。
 * 只给索引（落点标记 / id / 标题 / 摘要 / 代际 / 可写与否）——正文由 AI 自己回翻。
 * `null` = 还没绑定承载会话（自主模式没在会话里开启）：不注入任何索引段。
 */
export function buildTreeIndexBlock(tree: TreeIndex | null | undefined): string {
  if (!tree) return ''
  const lines = tree.sessions.slice(0, TREE_INDEX_MAX).map((s, i) => {
    const flags = [s.writableTail ? '可写' : '只读', s.gen != null ? `第${s.gen}代` : ''].filter(Boolean).join('/')
    const mark = s.id === tree.activeId ? '★当前落点 ' : ''
    return `  ${i + 1}. ${mark}${s.id} [${flags}] ${s.title}：${(s.summary || '（无摘要）').slice(0, 200)}`
  })
  const block = `· 会话树（当前会话的逆生树）\n${lines.length > 0 ? lines.join('\n') : '  （空——可用 landing 的 create 开第一条线）'}`
  return `\n【会话树】\n${block}`
}
