/**
 * 内部会话继承链组装（纯函数，无 React/副作用依赖）。
 * 为什么独立成模块：buildChains 是 v0.20 结构化视图（继承链森林）的数据基础，
 * 抽离后可在 node 环境的 vitest 中直接单测（组件文件引入 React 无法纯环境导入）。
 * 作用：以 parentId 为边、gen 为代序，把服务端回传的扁平会话列表重组为继承链森林。
 * 不删理由：谱系图展示的单一数据来源；叶子路由/路由续跑在服务端完成，
 * 这里只负责展示结构，不与路由逻辑重复。
 */
import type { InternalSessionSummary } from '@shared/types'

/** 一条继承链：nodes 按 gen 升序（根在 index 0，最新叶子在末位） */
export interface Chain {
  nodes: InternalSessionSummary[]
}

/**
 * 把扁平会话列表组装为继承链森林。
 * 为什么存在：服务端只按 updatedAt 降序回传扁平列表，父子的结构关系需要
 * 在 UI 侧重组才能以谱系图形式展示。
 * 作用：以 parentId 为边、gen 为代序，把根（无父/父不在列表内=断链兜底）开始的
 * 后代链提取出来，供 ChainColumn 纵向渲染。
 * 导出理由：纯函数，需经单元测试覆盖边界（多链排序/断链孤儿/单节点/分支链）。
 * 不删理由：继承链展示是 v0.20 结构化视图的数据基础；叶子路由/路由续跑在
 * 服务端完成，这里只负责展示结构，不与路由逻辑重复。
 */
export function buildChains(list: InternalSessionSummary[]): Chain[] {
  // 一次性建 id 索引：roots 判定与子节点归属都走 Map，避免 O(n²) 的 list.some 扫描
  const byId = new Map(list.map((s) => [s.id, s]))
  // 父 id → 直接子节点列表（先收集所有以某节点为父的节点）
  const childrenByParent = new Map<string, InternalSessionSummary[]>()
  for (const s of list) {
    if (!s.parentId) continue
    const arr = childrenByParent.get(s.parentId)
    if (arr) arr.push(s)
    else childrenByParent.set(s.parentId, [s])
  }
  // 根：没有父，或父不在当前列表内（父被删后的断链孤儿，兜底为根避免整链消失）；
  // 注意不能把"无子节点"当根——叶子没有子却仍是继承链末梢，根必须由父关系决定
  const roots = list.filter((s) => !s.parentId || !byId.has(s.parentId))
  // 按 gen 升序排后代，使链内顺序稳定（根在前、叶子在后）
  for (const arr of childrenByParent.values()) {
    arr.sort((a, b) => (a.gen ?? 1) - (b.gen ?? 1))
  }

  const chains: Chain[] = []
  for (const root of roots) {
    const nodes: InternalSessionSummary[] = [root]
    // 沿链向下收集：内部会话继承是线性链（每节点至多一子），但用队列兼容潜在分支
    const queue = [...(childrenByParent.get(root.id) ?? [])]
    while (queue.length > 0) {
      const node = queue.shift()!
      nodes.push(node)
      queue.push(...(childrenByParent.get(node.id) ?? []))
    }
    chains.push({ nodes })
  }
  // 链间排序：以最新叶子的 updatedAt 降序（最近活跃的链靠前，与旧列表语义一致）
  return chains.sort((a, b) => {
    const ta = a.nodes[a.nodes.length - 1].updatedAt
    const tb = b.nodes[b.nodes.length - 1].updatedAt
    return tb - ta
  })
}

/** 所有「被其他节点引用为父」的 id 集合 → 不在集合中的节点即为最新叶子（父子继承链末梢，UI 高亮用） */
export function collectParentIds(list: InternalSessionSummary[]): Set<string> {
  const byId = new Map(list.map((s) => [s.id, s]))
  return new Set(
    list
      .filter((s) => s.parentId && byId.has(s.parentId))
      .map((s) => s.parentId!)
  )
}

/**
 * 逆生树节点：一个内部会话在「继承 × 时间 × 新话题」三轴树中的位置。
 * 为什么存在：v0.24 起会话池并存两条边——parentId（继承）与 timeBranchId（时间延续），
 * v0.28 起按用户定稿新增第三条边 isNewTopic（AI 判定话题需要新开的新会话，虚线）。
 * 仅用扁平列表或线性链无法表达「同一会话同时被继承压缩、被时间分叉、又引出新话题」
 * 的多重身份，需要组装为带三类子节点的树。
 * 语义（线型见 RowEdgeType）：
 * - children：继承子（parentId 指向本会话），子是父被压缩后的单线延续（实线）；
 * - timeFork：时间分叉副本（timeBranchId 指向本会话），副本是同一上下文的时间延续（实线），
 *   原会话随后被锁定（不可再作为路由候选）；
 * - newBranches：新话题分支（isNewTopic=true 且 parentId 指向本会话），AI 判定这是
 *   「另一件事」不是延续，视觉上以虚线从父引出。
 */
export interface SessionTreeNode {
  session: InternalSessionSummary
  /** 继承子：parentId 指向本会话（排除时间分叉副本与 isNewTopic 新话题分支） */
  children: SessionTreeNode[]
  /** 时间分叉副本：timeBranchId 指向的下级（isTimeFork=true，可继续写入） */
  timeFork?: SessionTreeNode
  /** 新话题分支：isNewTopic=true 且 parentId 指向本会话（虚线连线） */
  newBranches: SessionTreeNode[]
}

/**
 * 把扁平会话列表组装为「继承树 + 时间分叉 + 新话题」三轴森林。
 * 为什么存在：逆生树可视化需要一棵完整的树——每个节点含继承子（向下延伸）、
 * 时间分叉（也向下延伸）与新话题分支（同样向下），三类边互相独立、可共存
 * （一个会话既能被压缩出子、也能被时间分叉出副本、还能引出新话题）。
 * 与 buildChains 的关系：buildChains 只表达继承链（v0.20 谱系图），时间分叉与
 * 新话题加入后平面链表无法容纳「继承子 + 时间副本 + 新话题」多身份，故新增本函数；
 * buildChains 保留用于组件外的旧消费方与既有测试。
 * 关键点1：时间分叉副本（某会话 timeBranchId 的目标）不计入继承 children——
 * 副本的 parentId 与原会话相同（timeFork 复制父），若按 parentId 归并会与原会话
 * 并列成为「兄弟」，丢失时间延续语义；必须挂在 timeFork 边上。
 * 关键点2：isNewTopic 会话同样带 parentId，但语义是「新开话题」而非「延续承接」，
 * 若与继承子混排会丢失新会话身份（虚线无从画起）；必须先按 isNewTopic 分流到
 * newBranches，余下计为继承 children。
 * 导出理由：纯函数，需经单元测试覆盖（三类边挂载/并存/孤儿兜底）。
 * 不删理由：v0.24 逆生树视图的单一数据来源；叶子/尾端判定在服务端完成，
 * 这里只负责展示结构，不与路由逻辑重复。
 */
export function buildSessionTree(list: InternalSessionSummary[]): SessionTreeNode[] {
  const byId = new Map(list.map((s) => [s.id, s]))
  // forkId → srcId：记录每条时间连线的「目标副本 → 源头」（timeBranchId 指向者）
  const forkSrc = new Map<string, string>()
  for (const s of list) {
    if (s.timeBranchId && byId.has(s.timeBranchId)) forkSrc.set(s.timeBranchId, s.id)
  }
  // 继承子收集（排除时间分叉副本与 isNewTopic 新话题分支）
  const childrenByParent = new Map<string, InternalSessionSummary[]>()
  // 新话题分支收集（parentId 指向且 isNewTopic=true；与继承子同用 parentId 但语义对立）
  const newByParent = new Map<string, InternalSessionSummary[]>()
  for (const s of list) {
    if (!s.parentId) continue
    if (forkSrc.has(s.id)) continue
    const bucket = s.isNewTopic ? newByParent : childrenByParent
    const arr = bucket.get(s.parentId)
    if (arr) arr.push(s)
    else bucket.set(s.parentId, [s])
  }
  for (const arr of childrenByParent.values()) {
    arr.sort((a, b) => (a.gen ?? 1) - (b.gen ?? 1))
  }
  for (const arr of newByParent.values()) {
    arr.sort((a, b) => (a.gen ?? 1) - (b.gen ?? 1))
  }

  // 递归建树：children = 继承子树；timeFork = timeBranchId 目标子树；newBranches = 新话题子树
  const cache = new Map<string, SessionTreeNode>()
  const build = (s: InternalSessionSummary): SessionTreeNode => {
    const cached = cache.get(s.id)
    if (cached) return cached
    const node: SessionTreeNode = { session: s, children: [], newBranches: [] }
    cache.set(s.id, node)
    node.children = (childrenByParent.get(s.id) ?? []).map(build)
    node.newBranches = (newByParent.get(s.id) ?? []).map(build)
    if (s.timeBranchId) {
      const target = byId.get(s.timeBranchId)
      if (target) node.timeFork = build(target)
    }
    return node
  }

  const roots = list.filter(
    (s) => (!s.parentId || !byId.has(s.parentId)) && !forkSrc.has(s.id)
  )
  // 排序：按子树内最新 updatedAt 降序（最近活跃的树靠前），保持与旧列表一致的语义
  const maxUpdated = (n: SessionTreeNode): number => {
    let m = n.session.updatedAt
    for (const c of n.children) m = Math.max(m, maxUpdated(c))
    for (const nb of n.newBranches) m = Math.max(m, maxUpdated(nb))
    if (n.timeFork) m = Math.max(m, maxUpdated(n.timeFork))
    return m
  }
  return roots.map(build).sort((a, b) => maxUpdated(b) - maxUpdated(a))
}

// ====== v0.28 逆生树放射形布局（根在上，分支逐层向两侧散开）======

/** 卡片设计宽度（px）。为什么存在：布局按节点宽计算水平槽位；
 *  必须与 InternalSessionsView 的 CARD_W 一致，否则层级会错位。
 *  不删理由：布局纯函数与渲染组件共用同一度量，改大改小必须两侧同步。 */
export const TREE_CARD_W = 320

/** 卡片设计高度（px）。为什么存在：层高 = 卡片高 + 层间距；
 *  卡片实际高度由内容决定（摘要 line-clamp-3 兜底），这里取「上界」估算值——
 *  最重组合（徽章折两行 + 摘要 3 行截断 + 元信息行）约 170px，取 176 保证
 *  任意内容量下相邻两层都不压叠；渲染层按本常量锚定卡片 top/连线端点。
 *  不删理由：放射形布局的纵向节距唯一度量。 */
export const TREE_CARD_H = 176

/** 同一层内相邻节点槽位之间的水平间距（px）。为什么存在：开枝散叶的核心是
 *  兄弟节点横向并排且互不重叠，间距即最小水平呼吸空间。
 *  不删理由：布局水平节距组成之一，渲染容器宽度据此核算。 */
export const TREE_SLOT_GAP = 24

/** 相邻两层之间的垂直间距（px）。为什么存在：层级向下生长时在卡片间留出
 *  纵向呼吸空间，连线（斜向分杈）也占用该间隙。
 *  不删理由：布局纵向节距组成之一，渲染层按层计算 y 坐标。 */
export const TREE_LAYER_GAP = 20

/**
 * 展平行的连接边类型：
 * - inherit：继承子（parentId 指向父；实线 = 同一延续，v0.28 由虚线反转为实线）
 * - time：时间分叉副本（timeBranchId 引用父；实线 = 同一延续）
 * - new：新话题分支（isNewTopic=true；虚线 = AI 判定新开话题，非延续）
 * - null：根节点（无连接边）
 */
export type RowEdgeType = 'inherit' | 'time' | 'new' | null

/** 布局结果中的单个节点（绝对坐标，相对所属树的画布左上角）。 */
export interface TreeLayoutNode {
  session: InternalSessionSummary
  /** 纵向层级：根 = 0，每深入一代 +1（同一层所有节点 y 相同） */
  depth: number
  /** 水平中心坐标（px，相对树画布左边界） */
  x: number
  /** 垂直中心坐标（px，相对树画布上边界） */
  y: number
  /** 本节点与父节点的连接边类型；根为 null */
  edgeType: RowEdgeType
  /** 是否树根（组件层用于根徽章；根节点不画连线） */
  isRoot: boolean
  /** 是否叶子（无可视子节点；供折叠按钮显示） */
  isLeaf: boolean
}

/** 布局结果中的连接边（斜向分杈连线：从父节点底部中心到子节点顶部中心）。 */
export interface TreeLayoutEdge {
  /** 父节点 id（连线起点） */
  fromId: string
  /** 子节点 id（连线终点） */
  toId: string
  edgeType: Exclude<RowEdgeType, null>
  /** 起点坐标（父节点底部中心，px） */
  x1: number
  y1: number
  /** 终点坐标（子节点顶部中心，px） */
  x2: number
  y2: number
}

/** 一株逆生树的放射形布局（独立画布，含全部节点与连线）。 */
export interface TreeLayout {
  nodes: TreeLayoutNode[]
  edges: TreeLayoutEdge[]
  /** 画布总宽（px；由最宽一层决定） */
  width: number
  /** 画布总高（px；由最深一层决定） */
  height: number
  /** 最大层级（根=0；供渲染层按层对齐） */
  maxDepth: number
}

/**
 * 计算单株树的放射形布局（根在上，分支逐层向下、随深度向两侧散开）。
 * 为什么存在：v0.28 按用户定稿把「一列纵队 + 左缩进」改为「开枝散叶」——
 * 根固定在顶部，后代逐层向下，兄弟节点水平并排，深度越深横向越宽。
 * 布局算法（留白居中法）：
 * - 后序遍历给每棵子树分配「槽位」：叶子占 1 槽，内部节点占全部子树槽位之和；
 * - 先序遍历按子树槽位左右排布，每个节点的 x = 其子树槽位的中心（父对齐子群中心），
 *   同层兄弟从同一深度依次向右摆放；y = depth * 层节距。
 * - 这样根位于整树槽位中心 → 树向两侧均匀散开，正是「放射形开枝散叶」。
 * 导出理由：纯函数，需经单元测试覆盖（单链/分杈/多层/多根/折叠后布局）。
 * 不删理由：逆生树视图的布局单一数据来源；渲染组件只消费坐标，不重复计算。
 */
export function buildTreeLayout(node: SessionTreeNode): TreeLayout {
  // 后序：subtreeSlots[nodeId] = 子树槽位数（叶子=1，内部=子槽位和）
  const subtreeSlots = new Map<string, number>()
  const countSlots = (n: SessionTreeNode): number => {
    const cached = subtreeSlots.get(n.session.id)
    if (cached !== undefined) return cached
    const kids = [...n.children, ...n.newBranches, ...(n.timeFork ? [n.timeFork] : [])]
    const total = kids.length === 0 ? 1 : kids.reduce((sum, k) => sum + countSlots(k), 0)
    subtreeSlots.set(n.session.id, total)
    return total
  }
  countSlots(node)

  // 先序：分配槽位起点，x = 子树中心，y 按层
  const nodes: TreeLayoutNode[] = []
  const edges: TreeLayoutEdge[] = []
  let maxDepth = 0

  const place = (n: SessionTreeNode, depth: number, slotStart: number, edgeType: RowEdgeType, isRoot: boolean): void => {
    const slots = subtreeSlots.get(n.session.id) ?? 1
    const x = (slotStart + slots / 2) * (TREE_CARD_W + TREE_SLOT_GAP)
    // y 是节点中心坐标，0 层基线 = TREE_CARD_H/2（卡片 top 恰好贴画布顶边，不产生负值溢出）
    const y = depth * (TREE_CARD_H + TREE_LAYER_GAP) + TREE_CARD_H / 2
    maxDepth = Math.max(maxDepth, depth)
    nodes.push({
      session: n.session,
      depth,
      x,
      y,
      edgeType,
      isRoot,
      isLeaf: n.children.length === 0 && n.newBranches.length === 0 && !n.timeFork
    })

    // 子节点依次占位：继承子 → 新话题分支 → 时间分叉（顺序稳定，测试可断言）
    let cursor = slotStart
    const kids: Array<readonly [SessionTreeNode, Exclude<RowEdgeType, null>]> = [
      ...n.children.map((c) => [c, 'inherit'] as const),
      ...n.newBranches.map((c) => [c, 'new'] as const),
      ...(n.timeFork ? [[n.timeFork, 'time'] as const] : [])
    ]
    for (const [kid, kind] of kids) {
      const kidSlots = subtreeSlots.get(kid.session.id) ?? 1
      const kidX = (cursor + kidSlots / 2) * (TREE_CARD_W + TREE_SLOT_GAP)
      const kidY = (depth + 1) * (TREE_CARD_H + TREE_LAYER_GAP) + TREE_CARD_H / 2
      place(kid, depth + 1, cursor, kind, false)
      edges.push({
        fromId: n.session.id,
        toId: kid.session.id,
        edgeType: kind,
        // 连线端点：父底部中心 → 子顶部中心（斜向分杈）
        x1: x,
        y1: y + TREE_CARD_H / 2,
        x2: kidX,
        y2: kidY - TREE_CARD_H / 2
      })
      cursor += kidSlots
    }
  }
  place(node, 0, 0, null, true)

  const totalSlots = subtreeSlots.get(node.session.id) ?? 1
  return {
    nodes,
    edges,
    width: totalSlots * (TREE_CARD_W + TREE_SLOT_GAP),
    height: (maxDepth + 1) * (TREE_CARD_H + TREE_LAYER_GAP) - TREE_LAYER_GAP,
    maxDepth
  }
}

/**
 * 把逆生树森林逐棵布局为放射形画布列表（每株一棵独立树，纵向堆叠渲染）。
 * 为什么存在：多根会话池各成体系，需要按树分组并在界面上纵向排列；
 *  每株树内部是完整放射布局（根在上、开枝散叶），树与树互不影响且不横向混排。
 * 导出理由：纯函数，需经单元测试覆盖（多根森林逐棵布局、空森林）。
 * 不删理由：InternalSessionsView 树分组的单一数据来源。
 */
export function buildTreeLayouts(roots: SessionTreeNode[]): TreeLayout[] {
  return roots.map((r) => buildTreeLayout(r))
}

/**
 * 裁剪被折叠节点的后代（继承子 + 新话题分支 + 时间分叉），供折叠后重新布局。
 * 为什么存在：折叠不是"显示层隐藏"，而是让树把该节点视为叶子——
 * 否则后代仍占据布局槽位，折叠形同虚设。折叠状态由组件持有（Set of id），
 * 传入本函数在 buildSessionTree 之后、buildTreeLayout 之前裁剪。
 * 注意：裁剪是浅拷贝（session 引用不变），不修改原树，纯函数可安全单测。
 */
export function pruneCollapsed(nodes: SessionTreeNode[], collapsed: Set<string>): SessionTreeNode[] {
  return nodes.map((n) => pruneNode(n, collapsed))
}

// 递归剪枝：折叠节点保留自身、丢后代；未折叠节点原样递归。任何情况都返回节点（不删行），
// 因此无 null 分支；外层 pruneCollapsed 直接透传映射结果即可。
function pruneNode(n: SessionTreeNode, collapsed: Set<string>): SessionTreeNode {
  if (collapsed.has(n.session.id)) {
    // 被折叠：保留自身，丢掉全部后代（继承子 + 新话题分支 + 时间分叉）
    return { session: n.session, children: [], newBranches: [], timeFork: undefined }
  }
  return {
    session: n.session,
    children: n.children.map((c) => pruneNode(c, collapsed)),
    newBranches: n.newBranches.map((c) => pruneNode(c, collapsed)),
    timeFork: n.timeFork ? pruneNode(n.timeFork, collapsed) : undefined
  }
}

// ====== 密集分支降级（卡片退化为「点 + 单行标题」）======

/** 全局缩放降级阈值：画布缩放低于该倍率时所有节点降级为点形态。
 * 为什么存在：放大缩小到很小时，完整卡片（宽 320 高 176）会缩成不可读的
 * 色块；点 + 单行标题在极小倍率下仍可辨认结构，用户继续缩小即切换到
 * "只看拓扑"模式。阈值取在标题已明显低于可读字号的位置（0.5 倍）。
 */
export const DENSE_ZOOM_THRESHOLD = 0.5

/** 子树规模降级阈值：某节点的子树节点总数（含自身）超过该值时降级为点形态。
 * 为什么存在：单一来源的分支如果极密（宽树），完整卡片会互相遮挡、挤压画布；
 * 把超密分支的源节点降级为点（小标题即可），其余节点保持完整卡片，
 * 既保留结构辨识又不产生信息噪音。取 12：约一屏内可容纳、再密就降级。
 */
export const DENSE_SUBTREE_THRESHOLD = 12

/**
 * 计算逆生树森林中每个节点（含自身）的子树规模。
 * 为什么存在：降级判定需要稳定的子分支规模；若按折叠后的树计算，
 * 折叠/展开会反复触发形态跳变，所以必须在未裁剪的完整树上统计。
 * 遍历三个分支容器（继承子 / 新话题 / 时间分叉）累加，后序归并。
 */
export function computeSubtreeSizes(nodes: SessionTreeNode[]): Map<string, number> {
  const sizes = new Map<string, number>()
  const walk = (n: SessionTreeNode): number => {
    let total = 1
    // 三个分支容器都要计入：任何分支变密都应触发降级
    for (const c of n.children) total += walk(c)
    for (const nb of n.newBranches) total += walk(nb)
    if (n.timeFork) total += walk(n.timeFork)
    sizes.set(n.session.id, total)
    return total
  }
  for (const n of nodes) walk(n)
  return sizes
}
