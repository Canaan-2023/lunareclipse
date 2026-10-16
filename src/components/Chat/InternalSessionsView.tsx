/**
 * 为什么存在：AI 维护的内部会话池是用户会话下的独立记忆检索子空间，需专门面板查看/编辑；
 * v11 起取代旧版块树视图（原位替换）。
 * 作用：以**逆生树**形式展示当前用户会话的内部会话「继承 × 时间 × 新话题」三轴森林——
 * 所有节点统一**向下生长**（v0.28 硬约束）：根节点置顶，分支逐层向两侧散开（开枝散叶，
 * 反对一列纵队）。连线由 SVG path 真实绘制（不是 CSS 边框模拟），线型语义（v0.28 定稿）：
 * - 继承（parentId，上下文压缩延续）= **实线**；时间分叉（timeBranchId，话题延续）= **实线**；
 * - 新会话（isNewTopic=true，AI 判定需要新开话题）= **虚线**——「延续用实线、新开用虚线」。
 * 节点卡片支持查看消息、就地增删改。右上角提供会话上限配置小卡片。
 * 布局策略（v0.28 重设计，放射形绝对定位）：放弃 v0.27 的「逐行缩进 + 引导线 token」，
 * 改为纯函数布局 session-chains.buildTreeLayout 输出坐标——每株树一个相对定位画布，
 * 节点按 (x, y) 绝对定位（根置顶居中、兄弟横向并排、深度越深横向越宽），连线层用
 * 一张铺满画布的 SVG 画斜向分杈 path（从父底部中心到子顶部中心）。
 * 卡片尺寸（沿用 v0.27 修复文字出框）：宽度固定 TREE_CARD_W（320px），高度改为**随内容
 * 自适应**（不再固定高度强截断——徽章多行/长摘要曾撑爆固定高度导致文字溢出边框）；
 * 摘要最多 3 行截断（line-clamp-3）兜底防超长文本，标题单行截断，
 * 保证任何内容量下文字都完整落在卡片边框内。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, Clock, ListTree, Maximize, MessageSquare, Pencil, Plus, RotateCcw, Trash2, ChevronLeft, Check, X, Settings2, ZoomIn, ZoomOut } from 'lucide-react'
import { useAppStore } from '../../stores/appStore'
import type { InternalMessage, InternalSessionSummary, SessionSummaryEffectiveInfo } from '@shared/types'
import { useT } from '../../i18n/useT'
import {
  buildSessionTree,
  buildTreeLayouts,
  computeSubtreeSizes,
  pruneCollapsed,
  DENSE_SUBTREE_THRESHOLD,
  DENSE_ZOOM_THRESHOLD,
  TREE_CARD_H,
  TREE_CARD_W,
  type SessionTreeNode,
  type TreeLayout
} from './session-chains'

/**
 * 内部会话面板（逆生树视图，v0.28）。
 *
 * 展示当前用户会话名下 AI 维护的内部会话池（sessions/{sessionId}/ai/）：
 * - 按三轴树（parentId 继承 + timeBranchId 时间分叉 + isNewTopic 新话题，见
 * session-chains.ts 的 buildSessionTree）组装为森林；每棵树根节点置顶、分支逐层
 * 向两侧散开（开枝散叶）。连线线型（v0.28 定稿）：继承/时间 = 实线（延续），
 * 新话题 = 虚线（AI 判定新开），直观体现「延续的还是新开的」；
 * - createdAt/updatedAt 展示；title/summary 就地编辑（Enter 保存）
 * - 打开会话查看消息，可增删改消息（乐观更新直落盘）
 * - 删除前需二次确认（落盘删除无回收站，误删代价高）
 */

function formatTime(ts: number): string {
  if (!ts) return ''
  return new Date(ts).toLocaleString('zh-CN', { hour12: false })
}

/** 画布视图：zoom = 内容缩放倍率，pan = 内容相对视口左上角的平移偏移（px） */
interface CanvasView {
  zoom: number
  pan: { x: number; y: number }
}

/** 缩放边界：0.2 倍可用于俯瞰整片森林；2.5 倍保证大图可细读（再大无信息增益） */
const ZOOM_MIN = 0.2
const ZOOM_MAX = 2.5
/** 缩放控件按钮单步步进（×/÷ 1.25）；滚轮缩放另有指数阻尼，见 onWheel */
const ZOOM_BUTTON_STEP = 1.25
/** 拖拽阈值（px）：移动超过该距离才视为拖动画布，否则视为点按（让卡片点击不被吞） */
const DRAG_THRESHOLD = 4

export function InternalSessionsView({ sessionId }: { sessionId: string }) {
  const t = useT()
  const list = useAppStore((s) => s.internalSessions)
  const active = useAppStore((s) => s.activeInternalSession)
  // AI 当前承接的内部会话 id（session_select 设置的 active 指针；与上面「点开的详情」不同）
  const activeInternalId = useAppStore((s) => s.activeInternalId)
  const loadInternalSessions = useAppStore((s) => s.loadInternalSessions)
  const createInternalSession = useAppStore((s) => s.createInternalSession)
  const setActiveInternalSession = useAppStore((s) => s.setActiveInternalSession)
  const [creating, setCreating] = useState(false)
  // 详情报错提示：getInternalSession IPC 读取失败时展示原因，避免点开无响应
  const [error, setError] = useState<string | null>(null)
  // 会话上限配置小卡片展开标记
  const [budgetOpen, setBudgetOpen] = useState(false)

  // 切换会话：刷新列表并关闭详情
  useEffect(() => {
    void loadInternalSessions(sessionId)
    setActiveInternalSession(null)
    setCreating(false)
    setBudgetOpen(false)
  }, [sessionId, loadInternalSessions, setActiveInternalSession])

  // buildSessionTree 纯函数组装「继承 × 时间 × 新话题」三边森林；useMemo 依赖 list，
  // 避免每次渲染重建树（坐标计算 O(n²)，会话多时不应在无变化时重复执行）
  const trees = useMemo(() => buildSessionTree(list), [list])

  const openDetail = async (internalId: string) => {
    try {
      const detail = await window.lunareclipse.getInternalSession(sessionId, internalId)
      setActiveInternalSession(detail)
      setError(null)
    } catch (err) {
      // IPC 读取失败时保持列表可见并给出原因，避免用户误以为点击无效
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="flex h-full flex-1 flex-col overflow-hidden bg-bg-base">
      {/* 头部（全宽）：标题 + 刷新 + 新建 + 上限配置开关。
          为什么保持全宽：挂载容器 ChatArea 是 flex-1 弹性区，外部已决定可用宽度，
          内部再限宽只会制造两侧留白；头部是分区栏不出长文本，全宽无行长牺牲。 */}
      <div className="shrink-0 border-b border-border-subtle">
        <div className="flex w-full items-center gap-2.5 px-5 py-2.5">
          <ListTree size={16} className="shrink-0 text-accent" />
          <span className="text-body font-medium text-fg-primary">
            {t('view.tree')}
          </span>
          <span className="rounded-full bg-bg-muted/60 px-2 py-0.5 text-caption text-fg-muted">
            {t('view.treeCount', { count: list.length })}
          </span>
          <div className="ml-auto flex items-center gap-1.5">
            <button
              onClick={() => void loadInternalSessions(sessionId)}
              className="flex h-7 w-7 items-center justify-center rounded-btn text-fg-muted transition-all hover:bg-bg-muted hover:text-fg-secondary"
              title={t('view.refresh')}
              aria-label={t('view.refresh')}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6" /></svg>
            </button>
            <button
              onClick={() => setCreating((v) => !v)}
              className="flex h-7 items-center gap-1.5 rounded-btn border border-border-subtle px-2.5 text-caption text-fg-secondary transition-all hover:border-accent/30 hover:text-accent"
            >
              <Plus size={14} />
              {t('internal.new')}
            </button>
            {/* 会话上限配置：右上角独立小卡片开关 */}
            <button
              onClick={() => setBudgetOpen((v) => !v)}
              className={`flex h-7 w-7 items-center justify-center rounded-btn transition-all hover:bg-bg-muted hover:text-fg-secondary ${budgetOpen ? 'bg-bg-muted text-fg-secondary' : 'text-fg-muted'}`}
              title={t('internal.budgetTooltip')}
              aria-label={t('internal.budgetTooltip')}
              aria-expanded={budgetOpen}
            >
              <Settings2 size={14} />
            </button>
          </div>
        </div>
      </div>

      {/* 会话上限配置小卡片：展开时渲染在头部下方右对齐，不占满全宽 */}
      {budgetOpen && (
        <div className="flex w-full justify-end px-5 pt-2.5">
          <div className="w-full max-w-md">
            <SessionBudgetCard onClose={() => setBudgetOpen(false)} />
          </div>
        </div>
      )}

      {/* 详情加载失败提示条：可手动关闭，不影响列表继续操作 */}
      {error && (
        <div className="shrink-0 border-b border-red-500/20 bg-red-500/10">
          <div className="flex w-full items-center gap-2 px-5 py-2 text-caption text-red-400">
            <span className="flex-1">{error}</span>
            <button onClick={() => setError(null)} className="shrink-0 text-red-400/70 hover:text-red-400" title={t('common.close')} aria-label={t('common.close')}>
              <X size={14} />
            </button>
          </div>
        </div>
      )}

      {/* 新建表单：固定 max-w，不再占满整个面板（反馈 v0.24「点新增几乎占满」） */}
      {creating && (
        <div className="flex w-full justify-center px-5 pt-3">
          <div className="w-full max-w-lg">
            <CreateForm
              onCancel={() => setCreating(false)}
              onSubmit={async (title, content) => {
                await createInternalSession(sessionId, title, content)
                setCreating(false)
              }}
            />
          </div>
        </div>
      )}

      {/* 详情视图 */}
      {active ? (
        <DetailView
          sessionId={sessionId}
          internalId={active.id}
          onBack={() => setActiveInternalSession(null)}
        />
      ) : (
        <>
          {/* 逆生树画布（v0.29）：视口容器接管滚动/缩放/平移，空态与树态区分渲染。
               视口 overflow-hidden（画布滚动改为 transform 平移，原生滚轮被 TreeCanvas
               内部接管）；空态内容少、直接文档流，无滚动需求。 */}
          <div className="flex-1 overflow-hidden">
            {trees.length === 0 ? (
              <div className="w-full px-5 py-4">
                <div className="flex flex-col items-start gap-2 pt-4">
                  <div className="flex items-center gap-2 text-fg-muted">
                    <ListTree size={18} />
                    <span className="text-body font-medium">{t('view.treeEmpty')}</span>
                  </div>
                  <div className="max-w-md text-caption leading-relaxed text-fg-muted/70">
                    {t('view.treeEmptyHint')}
                    <span className="mt-0.5 block">{t('view.treeEmptyDesc')}</span>
                  </div>
                  <button
                    onClick={() => setCreating(true)}
                    className="mt-1 flex h-7 items-center gap-1.5 rounded-btn border border-border-subtle px-2.5 text-caption text-fg-secondary transition-all hover:border-accent/30 hover:text-accent"
                  >
                    <Plus size={13} />
                    {t('internal.new')}
                  </button>
                </div>
              </div>
            ) : (
              <TreeCanvas
                trees={trees}
                sessionId={sessionId}
                activeInternalId={activeInternalId}
                onOpen={(id) => void openDetail(id)}
              />
            )}
          </div>
          {/* 底部编辑提示：压缩为单行小字，避免在列表下方再占一档空间 */}
          <div className="shrink-0 border-t border-border-subtle">
            <div className="w-full px-5 py-1 text-caption text-fg-muted/60">
              {t('internal.editHint')}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

/**
 * 逆生树画布：放射形绝对定位渲染（v0.28 布局 + v0.29 画布化）。
 * 为什么存在：v0.27 的「逐行缩进 + 引导线 token」本质仍是一列纵队，与用户定稿
 * 「开枝散叶（放射形）、反对一列纵队」不符。改为消费 session-chains.ts 的
 * buildTreeLayouts 纯函数坐标：每株树一个相对定位画布，节点按 (x, y) 绝对定位
 * （根置顶居中、兄弟横向并排、深度越深横向越宽），连线层是铺满画布的一张 SVG，
 * 用斜向分杈 <path>（父底部中心 → 子顶部中心）连接父子。
 * 线型语义（v0.28 定稿，与布局层一致）：
 * - inherit（继承延续）/ time（时间延续）= 实线；
 * - new（新话题，AI 判定新开）= 虚线。
 * v0.29 画布化（用户反馈「需要像画布一样自由放大缩小、移动」）：
 * 视口容器 overflow-hidden，整片森林内容层包在 translate(pan) scale(zoom) 变换里；
 * 交互——普通滚轮/触控板双指 = 平移，Ctrl/⌘+滚轮 = 以鼠标为锚点缩放，
 * 空白区/中键拖拽 = 平移（拖拽阈值区分点击），右下角悬浮缩放控件
 * （−/+/适应/重置）；内容按原生尺寸布局（缩放不改变文字排版逻辑，
 * transform 层做视觉缩放），fit 在挂载及视口尺寸变化时自动执行。
 * 密集降级（v0.29）：zoom ≤ DENSE_ZOOM_THRESHOLD 时全画布降级；或某节点
 * 子树规模 ≥ DENSE_SUBTREE_THRESHOLD 时该子树整支降级为「点 + 单行标题」。
 * 剪枝/折叠/语义元数据逻辑沿用 v0.26/27（pruneCollapsed + semanticMeta）。
 * 不删理由：逆生树视图的唯一渲染载体；会话树规模 = 内部会话数量（通常 < 200），
 * 绝对定位渲染成本可忽略，无需虚拟化。
 * 导出理由：渲染探针（test/internal-sessions-view-render.test.tsx）以 buildSessionTree
 * 产物直渲本组件验证放射布局生效；不依赖 store（SSR 下 useSyncExternalStore 走初始态）。
 */
export function TreeCanvas({
  trees,
  sessionId,
  activeInternalId,
  onOpen,
  initialZoom = 1
}: {
  trees: SessionTreeNode[]
  sessionId: string
  /** AI 当前承接的内部会话 id（高亮标记；null=无显式承接） */
  activeInternalId: string | null
  onOpen: (internalId: string) => void
  /** 初始缩放倍率（默认 1）：渲染探针可传 0.3 验证全局降级形态（v0.29） */
  initialZoom?: number
}) {
  const t = useT()
  // 折叠集合：折叠节点隐去其全部后代（见 pruneCollapsed）
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  // 画布视图：zoom 与 pan 合一个 state 原子更新，避免「读旧 zoom 算新 pan」的闭包竞态
  const [view, setView] = useState<CanvasView>({ zoom: initialZoom, pan: { x: 0, y: 0 } })
  const viewportRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  // 拖拽会话：pointer 按下瞬间的快照；move 时按增量更新 pan（避免闭包读旧 pan）
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; baseX: number; baseY: number } | null>(null)

  // 裁剪折叠 → 逐株树放射形布局，全部 useMemo，输入不变时零重算
  const pruned = useMemo(() => pruneCollapsed(trees, collapsed), [trees, collapsed])
  const layouts = useMemo(() => buildTreeLayouts(pruned), [pruned])

  // —— v0.29 密集降级准备 ——
  // 子树规模基于【原始树】（含已折叠后代）：折叠只改变显示哪些后代，
  // 不改变「该分支实际有多大」；与 semanticMeta 同一口径（都基于原始树）。
  const subtreeSizes = useMemo(() => computeSubtreeSizes(trees), [trees])
  // 密集集合：非树根节点子树规模 ≥ 阈值 → 该节点及其全部后代降级为点。
  // 为什么跳过树根：逆生树根是主线源头（整树规模的直接承担者），若根自身
  // 也按规模降级，root 子树=全树必然命中阈值，selfDense 传染会令整片画布
  // 全部退化为点——降级应压缩「分支」，不能抹掉主线入口。
  // 为什么向下传播：分支「大」是自顶向下拓扑事实——源节点分支大，其内部
  // 子孙自然同属该密集分支；只降源节点、后代保持大卡片会造成视觉断层。
  // 全局降级（zoom ≤ DENSE_ZOOM_THRESHOLD）单独走 globalDense，不混入集合。
  const denseIds = useMemo(() => {
    const set = new Set<string>()
    const walk = (n: SessionTreeNode, inherited: boolean, isTreeRoot: boolean) => {
      const selfDense = inherited || (!isTreeRoot && (subtreeSizes.get(n.session.id) ?? 0) >= DENSE_SUBTREE_THRESHOLD)
      if (selfDense) set.add(n.session.id)
      for (const c of n.children) walk(c, selfDense, false)
      for (const nb of n.newBranches) walk(nb, selfDense, false)
      if (n.timeFork) walk(n.timeFork, selfDense, false)
    }
    for (const n of trees) walk(n, false, true)
    return set
  }, [trees, subtreeSizes])
  // 全画布降级：缩放过小时完整卡片已缩成不可读的色块，整片切到点形态
  const globalDense = view.zoom <= DENSE_ZOOM_THRESHOLD

  // 节点语义元数据（基于【原始树】而非折叠后的裁剪树）：
  // 为什么不用裁剪树：pruneCollapsed 会清空折叠节点的 children/timeFork/newBranches，
  // 若在其上算 hasDescendants，折叠后按钮会消失（无法再展开）；isTail 也会把折叠的
  // 父误判成可承接。折叠只改变「显示哪些后代」，不改变节点自身的语义。
  const semanticMeta = useMemo(() => {
    const meta = new Map<
      string,
      { hasDescendants: boolean; isTail: boolean; isFrozen: boolean; isTimeFork: boolean; isTimeLocked: boolean; isNewTopic: boolean }
    >()
    const mark = (
      s: { id: string; timeBranchId?: string; isTimeFork?: boolean; isNewTopic?: boolean },
      hasInheritDesc: boolean,
      hasForkDesc: boolean,
      hasNewDesc: boolean
    ) => {
      const isTimeLocked = !!s.timeBranchId
      // 折叠按钮按「任意后代」（继承 + 时间分叉 + 新话题）判定，保证可再次展开
      const hasDescendants = hasInheritDesc || hasForkDesc || hasNewDesc
      meta.set(s.id, {
        hasDescendants,
        // 可承接尾端：无任何后代 且 未向时间下级延续（与路由候选同口径）
        isTail: !hasDescendants && !isTimeLocked,
        // 冻结底稿：仅被【继承】压缩出子会话的父会话（只读，可回翻/编辑修正）；
        // 时间分叉源由 isTimeLocked 标识，不在此列，避免两语义混淆。
        isFrozen: hasInheritDesc,
        isTimeFork: !!s.isTimeFork,
        isTimeLocked,
        isNewTopic: !!s.isNewTopic
      })
    }
    // 遍历整棵树：每个节点按【自身直接后代】标记语义。
    // 为什么不需要看间接后代：semanticMeta 基于折叠前的完整树（折叠节点 children 仍在），
    // 某节点「是否有后代」只取决于它的直接 children/timeFork/newBranches 是否非空；
    // 后代自己是否还有更深的子树，属于后代自己的 hasDescendants 判定。
    const walk = (n: SessionTreeNode) => {
      mark(n.session, n.children.length > 0, !!n.timeFork, n.newBranches.length > 0)
      for (const c of n.children) walk(c)
      for (const nb of n.newBranches) walk(nb)
      if (n.timeFork) walk(n.timeFork)
    }
    for (const n of trees) walk(n)
    return meta
  }, [trees])

  const toggleCollapse = (id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // —— v0.29 画布交互（缩放 / 平移）——
  // 渲染期同步最新视图到 ref：原生 wheel / pointer 事件回调直接读 ref.current，
  // 避免每次渲染重建监听器导致闭包读旧 view。
  const viewRef = useRef(view)
  viewRef.current = view

  // 以视口坐标 (px, py) 为锚点缩放到 targetZoom：锚点下的内容点在缩放前后保持不动。
  // 为什么单次 setView 原子更新：新 pan 依赖「旧 zoom 与旧 pan」同步计算，
  // 拆两个 state 异步更新会导致读到旧值时算出错误锚点（常见漂移 bug）。
  const zoomAt = (px: number, py: number, targetZoom: number) => {
    setView((v) => {
      const zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, targetZoom))
      if (zoom === v.zoom) return v
      const contentX = (px - v.pan.x) / v.zoom
      const contentY = (py - v.pan.y) / v.zoom
      return { zoom, pan: { x: px - contentX * zoom, y: py - contentY * zoom } }
    })
  }

  // 视图中心缩放（工具栏按钮）：以视口中心为锚点，步进系数 ZOOM_BUTTON_STEP
  const zoomCenter = (factor: number) => {
    const vp = viewportRef.current
    if (!vp) return
    zoomAt(vp.clientWidth / 2, vp.clientHeight / 2, viewRef.current.zoom * factor)
  }

  // 适配视口：内容完整可见、尽量大且居中；内容大于视口时贴左上（不裁剪不可达）。
  // scrollWidth/Height 取内容层布局尺寸（不含 transform），与当前缩放无关。
  const fit = useCallback(() => {
    const vp = viewportRef.current
    const body = contentRef.current
    if (!vp || !body) return
    const vw = vp.clientWidth
    const vh = vp.clientHeight
    const bw = body.scrollWidth
    const bh = body.scrollHeight
    if (!vw || !vh || !bw || !bh) return
    const zoom = Math.min(vw / bw, vh / bh, 1)
    setView({
      zoom,
      pan: { x: Math.max(0, (vw - bw * zoom) / 2), y: Math.max(0, (vh - bh * zoom) / 2) }
    })
  }, [])

  // 挂载 + 视口尺寸变化时自动适配（拖拽侧栏/窗口缩放时保持整树可见）。
  // ResizeObserver 仅在浏览器存在；SSR 渲染探针（renderToStaticMarkup）不执行 effect。
  useEffect(() => {
    fit()
    const vp = viewportRef.current
    if (!vp) return
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => fit()) : null
    ro?.observe(vp)
    return () => ro?.disconnect()
  }, [fit])

  // 原生滚轮：React onWheel 是 passive，preventDefault 无效（拦不住 Ctrl+滚轮的
  // 浏览器页面缩放），必须 passive:false 手动绑定。Ctrl/⌘+滚轮（含触控板捏合）= 
  // 以鼠标为锚点缩放（指数阻尼约每格 ×1.1）；普通滚轮/双指滚动 = 平移画布。
  useEffect(() => {
    const vp = viewportRef.current
    if (!vp) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const rect = vp.getBoundingClientRect()
      const px = e.clientX - rect.left
      const py = e.clientY - rect.top
      if (e.ctrlKey || e.metaKey) {
        const factor = Math.exp(-e.deltaY * 0.0011)
        zoomAt(px, py, viewRef.current.zoom * factor)
      } else {
        setView((v) => ({ ...v, pan: { x: v.pan.x - e.deltaX, y: v.pan.y - e.deltaY } }))
      }
    }
    vp.addEventListener('wheel', onWheel, { passive: false })
    return () => vp.removeEventListener('wheel', onWheel)
  }, [])

  // 拖拽平移：中键任意处可拖；左键仅空白处（卡片/按钮上的按下不抢手势，点击照常）。
  // pointer capture 保证移出视口仍持续跟手；DRAG_THRESHOLD 区分「点按」与「拖动」。
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = e.target as HTMLElement
    if (e.button !== 1 && (e.button !== 0 || el.closest('[data-node-card]') || el.closest('button'))) return
    if (e.button !== 0 && e.button !== 1) return
    e.preventDefault()
    dragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      baseX: viewRef.current.pan.x,
      baseY: viewRef.current.pan.y
    }
    e.currentTarget.setPointerCapture(e.pointerId)
    e.currentTarget.classList.add('cursor-grabbing')
  }
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current
    if (!d || d.pointerId !== e.pointerId) return
    const dx = e.clientX - d.startX
    const dy = e.clientY - d.startY
    if (Math.abs(dx) + Math.abs(dy) < DRAG_THRESHOLD) return
    setView((v) => ({ ...v, pan: { x: d.baseX + dx, y: d.baseY + dy } }))
  }
  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current && dragRef.current.pointerId === e.pointerId) dragRef.current = null
    e.currentTarget.classList.remove('cursor-grabbing')
  }

  if (layouts.length === 0) return null

  // 视口容器：相对定位铺满面板，overflow-hidden 让画布内容只在变换层内滚动。
  // cursor-grab / select-none：拖拽平移的视觉与文本选择气质（拖画布不是框选）。
  // style height 100%：父级 flex-1 已给高度，不用 h-full 类（渲染探针断言禁 h-full）。
  return (
    <div
      ref={viewportRef}
      className="relative cursor-grab overflow-hidden select-none"
      style={{ height: '100%' }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      {/* 内容层：整片森林 + 图例统一包进 transform，缩放平移作用于画布整体。
          transformOrigin 0 0 + translate(pan) scale(zoom)：锚点公式 zoomAt 与其配套（先平后缩）。 */}
      <div
        ref={contentRef}
        className="w-max will-change-transform"
        style={{ transform: `translate(${view.pan.x}px, ${view.pan.y}px) scale(${view.zoom})`, transformOrigin: '0 0' }}
      >
        <div className="px-5 py-4">
          <div className="flex flex-col gap-8">
            {/* 每株树一个独立画布：相对定位容器 + 绝对定位节点 + 铺满的 SVG 连线层。
                树与树纵向堆叠（gap-8），彼此互不影响坐标。 */}
            {layouts.map((layout, li) => (
              <TreeCanvasTree
                key={li}
                layout={layout}
                sessionId={sessionId}
                activeInternalId={activeInternalId}
                collapsed={collapsed}
                semanticMeta={semanticMeta}
                denseIds={denseIds}
                globalDense={globalDense}
                toggleCollapse={toggleCollapse}
                onOpen={onOpen}
              />
            ))}
          </div>
          {/* 连线图例（v0.28 线型定稿）：延续（继承/时间）= 实线；新会话 = 虚线 */}
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-caption text-fg-muted/70">
            <span className="flex items-center gap-1.5 text-fg-muted">
              <svg width="26" height="8" viewBox="0 0 26 8" className="text-fg-muted" fill="none" stroke="currentColor" strokeWidth="1.5">
                <line x1="0" y1="4" x2="26" y2="4" />
              </svg>
              {t('internal.inheritEdge')}（延续）
            </span>
            <span className="flex items-center gap-1.5 text-accent">
              <svg width="26" height="8" viewBox="0 0 26 8" className="text-accent" fill="none" stroke="currentColor" strokeWidth="1.5">
                <line x1="0" y1="4" x2="20" y2="4" />
                <polyline points="14,1 20,4 14,7" fill="none" />
              </svg>
              {t('internal.timeFork')}（延续）
            </span>
            <span className="flex items-center gap-1.5 text-fg-muted">
              <svg width="26" height="8" viewBox="0 0 26 8" className="text-fg-muted" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="5 4">
                <line x1="0" y1="4" x2="26" y2="4" />
              </svg>
              {t('internal.newEdge')}
            </span>
          </div>
        </div>
      </div>
      {/* 画布操作提示：左下角常驻一行小字，帮助用户发现画布手势 */}
      <div className="pointer-events-none absolute bottom-3 left-4 rounded-card bg-bg-elevated/70 px-2 py-1 text-caption text-fg-muted/70 backdrop-blur-sm">
        {t('view.canvasHint')}
      </div>
      {/* 缩放控件：固定在视口右下角，不随画布变换（画布移走控件仍在）。
          按钮带 title/aria-label（i18n），图标 14px 轻量不抢视觉。 */}
      <div className="absolute bottom-3 right-3 z-10 flex items-center gap-0.5 rounded-card border border-border-subtle bg-bg-elevated/90 p-1 shadow-md backdrop-blur-sm">
        <button
          onClick={() => zoomCenter(1 / ZOOM_BUTTON_STEP)}
          title={t('view.zoomOut')}
          aria-label={t('view.zoomOut')}
          className="flex h-6 w-6 items-center justify-center rounded text-fg-muted transition-colors hover:bg-bg-muted hover:text-fg-secondary"
        >
          <ZoomOut size={14} />
        </button>
        <span className="w-10 select-none text-center text-caption tabular-nums text-fg-muted/80">
          {Math.round(view.zoom * 100)}%
        </span>
        <button
          onClick={() => zoomCenter(ZOOM_BUTTON_STEP)}
          title={t('view.zoomIn')}
          aria-label={t('view.zoomIn')}
          className="flex h-6 w-6 items-center justify-center rounded text-fg-muted transition-colors hover:bg-bg-muted hover:text-fg-secondary"
        >
          <ZoomIn size={14} />
        </button>
        <span className="mx-0.5 h-4 w-px bg-border-subtle" />
        <button
          onClick={fit}
          title={t('view.zoomFit')}
          aria-label={t('view.zoomFit')}
          className="flex h-6 w-6 items-center justify-center rounded text-fg-muted transition-colors hover:bg-bg-muted hover:text-fg-secondary"
        >
          <Maximize size={14} />
        </button>
        <button
          onClick={() => setView({ zoom: 1, pan: { x: 0, y: 0 } })}
          title={t('view.zoomReset')}
          aria-label={t('view.zoomReset')}
          className="flex h-6 w-6 items-center justify-center rounded text-fg-muted transition-colors hover:bg-bg-muted hover:text-fg-secondary"
        >
          <RotateCcw size={14} />
        </button>
      </div>
    </div>
  )
}

/**
 * 单株树的放射形画布：相对定位容器铺满 layout 尺寸，节点绝对定位、连线 SVG 覆盖其上。
 * 为什么独立成组件：TreeCanvas 已在「剪刀步」内做折叠/元数据重用；把单株树渲染抽出来
 * 避免一株树一个巨型 JSX 嵌套（可读性差），也让 buildTreeLayout 探针有稳定的渲染出口。
 * 为什么要相对定位：布局坐标是相对每株树左上角的；若整片森林共用一个坐标空间，
 * 第二棵树会与第一棵重叠，必须每株一个独立容器。
 */
function TreeCanvasTree({
  layout,
  sessionId,
  activeInternalId,
  collapsed,
  semanticMeta,
  denseIds,
  globalDense,
  toggleCollapse,
  onOpen
}: {
  layout: TreeLayout
  sessionId: string
  activeInternalId: string | null
  collapsed: Set<string>
  semanticMeta: Map<string, { hasDescendants: boolean; isTail: boolean; isFrozen: boolean; isTimeFork: boolean; isTimeLocked: boolean; isNewTopic: boolean }>
  /** 密集降级集合：节点 id ∈ 集合 → 该节点及其后代以点形态渲染（v0.29） */
  denseIds: Set<string>
  /** 全局密集降级：zoom ≤ DENSE_ZOOM_THRESHOLD 时整片画布降级（v0.29） */
  globalDense: boolean
  toggleCollapse: (id: string) => void
  onOpen: (id: string) => void
}) {
  return (
    <div className="relative" style={{ width: layout.width, height: layout.height }}>
      {/* 连线层：铺满整株树画布，斜向分杈 path 从父底部中心到子顶部中心。
          线型与布局层一致：inherit/time=实线、new=虚线（stroke-dasharray）。 */}
      <svg
        className="pointer-events-none absolute left-0 top-0"
        width={layout.width}
        height={layout.height}
        aria-hidden="true"
      >
        {layout.edges.map((e) => {
          const dashed = e.edgeType === 'new'
          const color = e.edgeType === 'time' ? 'text-accent' : 'text-fg-muted'
          return (
            <path
              key={`${e.fromId}-${e.toId}`}
              d={`M ${e.x1} ${e.y1} L ${e.x2} ${e.y2}`}
              className={color}
              stroke="currentColor"
              strokeWidth="1.6"
              strokeDasharray={dashed ? '6 4' : undefined}
              strokeLinecap="round"
              opacity="0.6"
            />
          )
        })}
      </svg>
      {/* 节点层：绝对定位（布局给出的是节点中心坐标，卡片左/上 = 中心 - 半宽/半高） */}
      {layout.nodes.map((node) => {
        const s = node.session
        const m = semanticMeta.get(s.id) ?? { hasDescendants: false, isTail: false, isFrozen: false, isTimeFork: false, isTimeLocked: false, isNewTopic: false }
        const isCollapsed = collapsed.has(s.id)
        return (
          // data-node-card：拖拽平移的排除标记——卡片上的按下不触发画布拖动
          <div
            key={s.id}
            data-node-card
            className="absolute"
            style={{ left: `${node.x - TREE_CARD_W / 2}px`, top: `${node.y - TREE_CARD_H / 2}px` }}
          >
            <SessionCard
              sessionId={sessionId}
              summary={s}
              gen={s.gen ?? 1}
              isRoot={node.isRoot}
              isLatest={m.isTail}
              isFrozen={m.isFrozen}
              isActive={s.id === activeInternalId}
              isTimeFork={m.isTimeFork}
              isTimeLocked={m.isTimeLocked}
              isNewTopic={m.isNewTopic}
              hasDescendants={m.hasDescendants}
              isCollapsed={isCollapsed}
              dense={globalDense || denseIds.has(s.id)}
              onToggle={() => toggleCollapse(s.id)}
              onOpen={() => onOpen(s.id)}
            />
          </div>
        )
      })}
    </div>
  )
}

/** 新建内部会话表单：固定宽度居中，不再占满面板 */
function CreateForm({
  onCancel,
  onSubmit
}: {
  onCancel: () => void
  onSubmit: (title: string, content: string) => Promise<void>
}) {
  const t = useT()
  const [title, setTitle] = useState(t('internal.createTitle'))
  const [content, setContent] = useState('')
  const [busy, setBusy] = useState(false)

  return (
    <div className="space-y-2.5 rounded-card border border-accent/25 bg-bg-surface/60 p-3.5">
      <div className="flex items-center gap-1.5 text-caption font-medium text-fg-secondary">
        <Plus size={13} />
        {t('internal.new')}
      </div>
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        className="w-full rounded-btn border border-border-subtle bg-bg-elevated px-3 py-2 text-body text-fg-primary outline-none focus:border-accent/40"
        placeholder={t('internal.createTitle')}
      />
      <textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        rows={3}
        className="w-full resize-none rounded-btn border border-border-subtle bg-bg-elevated px-3 py-2 text-body text-fg-primary outline-none focus:border-accent/40"
        placeholder={t('internal.contentPlaceholder')}
      />
      <div className="flex items-center justify-end gap-2">
        <button
          onClick={onCancel}
          className="rounded-btn px-3 py-1.5 text-caption text-fg-muted transition-all hover:bg-bg-muted hover:text-fg-secondary"
        >
          {t('internal.createCancel')}
        </button>
        <button
          disabled={busy || !title.trim()}
          onClick={async () => {
            setBusy(true)
            await onSubmit(title.trim(), content)
          }}
          className="flex items-center gap-1.5 rounded-btn bg-accent/15 px-3 py-1.5 text-caption font-medium text-accent transition-all hover:bg-accent/25 disabled:opacity-40"
        >
          <Check size={13} />
          {t('internal.createConfirm')}
        </button>
      </div>
    </div>
  )
}

/**
 * 单条内部会话卡片（逆生树节点：宽度固定 TREE_CARD_W、高度随内容自适应）。
 * 为什么存在：树画布中的每个节点是一张卡片。宽度固定（TREE_CARD_W=320）保证
 * 森林内所有卡片视觉一致对齐；高度**随内容自适应**（v0.27 修复）——v0.26
 * 固定 96px 高度 + line-clamp-2 强截断，在「多徽章行 + 长摘要」时内容实际
 * 撑爆固定高度、文字溢出卡片边框（用户反馈「文字都出框了」）。改为 h-auto
 * 后卡片高度由徽章行/标题/摘要/元信息实际内容决定，任何内容量都不出框。
 * 内容字段（v0.26 精简，v0.28 增补新话题徽章）：① 徽章行——根/最新/时间副本/
 * 时间锁定/新话题 + 折叠钮 + 更新时间；② 标题（可打开/就地编辑）；③ 摘要
 * （3 行截断，可编辑）；④ 元信息行——消息数·字符数 + 打开。
 * 层级直观：根在上、分支开枝散叶向下，配合徽章一眼可辨「该会话是树中哪一环、
 * 是延续还是新开」。
 * 密集降级形态（v0.29，dense=true）：卡片退化为「圆点 + 单行标题」胶囊——
 * 仍占完整槽位（布局坐标/连线端点不回归），仅渲染内容收敛；
 * 圆点颜色复用徽章语义色（active=强调、latest=绿、时间副本=琥珀、冻结=灰），
 * 保留折叠钮与点击打开，隐藏编辑/摘要/元信息（点形态是浏览结构，详情交给点击）。
 */
function SessionCard({
  sessionId,
  summary,
  gen,
  isRoot,
  isLatest,
  isFrozen,
  isActive,
  isTimeFork,
  isTimeLocked,
  isNewTopic,
  hasDescendants,
  isCollapsed,
  dense,
  onToggle,
  onOpen
}: {
  sessionId: string
  summary: InternalSessionSummary
  /** 继承代数（根=1；展示用，服务端 gen 缺省视为 1） */
  gen: number
  /** 是否链首（根会话/断链孤儿） */
  isRoot: boolean
  /** 是否最尾端（无继承子 + 无时间下级；路由当前承接的会话） */
  isLatest: boolean
  /** 是否冻结底稿（有继承子 = 已被继承压缩，只读回翻用） */
  isFrozen: boolean
  /** 是否 AI 当前承接的会话（active 指针指向；画布高亮标记） */
  isActive: boolean
  /** 是否时间分叉副本（isTimeFork=true：由 timeFork 复制产生的话题延续会话） */
  isTimeFork: boolean
  /** 是否时间线已延续锁定（自身有 timeBranchId 指向下级 → 本会话只读） */
  isTimeLocked: boolean
  /** 是否新话题分支（isNewTopic=true：AI 判定新开话题，虚线引入） */
  isNewTopic: boolean
  /** 是否有后代（继承子/时间分叉/新话题），决定是否显示折叠按钮 */
  hasDescendants: boolean
  /** 是否已折叠（其后代隐去） */
  isCollapsed: boolean
  /** 是否降级为点形态（v0.29：全局缩放过低或该节点子树过密） */
  dense: boolean
  onToggle: () => void
  onOpen: () => void
}) {
  const t = useT()
  const updateInternalSession = useAppStore((s) => s.updateInternalSession)
  const deleteInternalSession = useAppStore((s) => s.deleteInternalSession)
  const [editingTitle, setEditingTitle] = useState(false)
  const [draftTitle, setDraftTitle] = useState(summary.title)
  const [editingSummary, setEditingSummary] = useState(false)
  const [draftSummary, setDraftSummary] = useState(summary.summary)
  const inputRef = useRef<HTMLInputElement>(null)
  const areaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (editingTitle) inputRef.current?.focus()
    if (editingSummary) areaRef.current?.focus()
  }, [editingTitle, editingSummary])

  const commitTitle = async () => {
    setEditingTitle(false)
    if (draftTitle.trim() && draftTitle.trim() !== summary.title) {
      await updateInternalSession(sessionId, summary.id, { title: draftTitle.trim() })
    }
  }
  const commitSummary = async () => {
    setEditingSummary(false)
    if (draftSummary !== summary.summary) {
      await updateInternalSession(sessionId, summary.id, { summary: draftSummary })
    }
  }

  // —— 密集降级形态（v0.29）：圆点 + 单行标题，点击打开详情 ——
  // 为什么提前 return：dense 与完整形态互斥，分支清晰免去整段 JSX 条件嵌套。
  // 圆点颜色 = 徽章语义色浓缩，画布缩小后仍能分辨「承接/延续/副本/冻结」。
  if (dense) {
    const dotColor = isActive
      ? 'bg-accent'
      : isLatest
        ? 'bg-emerald-400'
        : isTimeFork
          ? 'bg-amber-400'
          : isFrozen
            ? 'bg-fg-muted'
            : 'bg-fg-muted/50'
    // 槽位对齐：距顶 1/4 处放胶囊（父连线从槽位底中心来、去子槽位顶中心，
    // 胶囊居中在槽位垂直中线视觉上偏离连线端点）——vertical-center 更贴近
    // 连线端点（父底部/子顶部），故用 items-center 垂直居中。
    return (
      <div
        className={`group flex w-[320px] flex-col items-center justify-center rounded-card border bg-bg-surface/30 transition-all ${isActive ? 'border-accent bg-accent/10' : 'border-border-subtle'} hover:border-accent/25 hover:bg-bg-surface/60`}
        style={{ minHeight: TREE_CARD_H }}
      >
        <div className="flex max-w-full items-center gap-1.5 px-2 py-1">
          {hasDescendants && (
            <button
              onClick={onToggle}
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-fg-muted transition-all hover:bg-bg-muted hover:text-fg-secondary"
              title={isCollapsed ? t('internal.expand') : t('internal.collapse')}
              aria-label={isCollapsed ? t('internal.expand') : t('internal.collapse')}
              aria-expanded={!isCollapsed}
            >
              {isCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
            </button>
          )}
          <span className={`h-2 w-2 shrink-0 rounded-full ${dotColor}`} aria-hidden="true" />
          <button
            onClick={onOpen}
            className="min-w-0 max-w-[230px] flex-1 truncate text-left text-caption font-medium text-fg-secondary transition-colors hover:text-accent"
            title={summary.title}
          >
            {summary.title || t('internal.titlePlaceholder')}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className={`group flex w-[320px] shrink-0 flex-col rounded-card border bg-bg-surface/30 transition-all ${isActive ? 'border-accent bg-accent/10' : isTimeLocked ? 'border-border-subtle opacity-70' : isLatest ? 'border-accent/40' : 'border-border-subtle'} hover:border-accent/25 hover:bg-bg-surface/60`}>
      {/* 徽章行：可换行（flex-wrap），徽章多时向下折行而非撑出卡片边界；新增折叠按钮（条件=有后代） */}
      <div className="flex flex-wrap items-center gap-1.5 px-2.5 pt-1.5">
        {hasDescendants && (
          <button
            onClick={onToggle}
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-fg-muted transition-all hover:bg-bg-muted hover:text-fg-secondary"
            title={isCollapsed ? t('internal.expand') : t('internal.collapse')}
            aria-label={isCollapsed ? t('internal.expand') : t('internal.collapse')}
            aria-expanded={!isCollapsed}
          >
            {isCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
          </button>
        )}
        <span className={`rounded-full px-1.5 py-0.5 text-caption font-medium ${isRoot ? 'bg-accent/15 text-accent' : isLatest ? 'bg-emerald-500/15 text-emerald-400' : 'bg-bg-muted/80 text-fg-muted'}`}>
          {isRoot
            ? t('internal.genRoot')
            : t('internal.gen', { n: gen })}
        </span>
        {isActive && (
          <span className="rounded-full bg-accent/20 px-1.5 py-0.5 text-caption font-medium text-accent">
            {t('internal.activeBadge')}
          </span>
        )}
        {isLatest && !isActive && (
          <span className="rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-caption font-medium text-emerald-400">
            {t('internal.latest')}
          </span>
        )}
        {isFrozen && (
          <span
            className="rounded-full bg-bg-muted/80 px-1.5 py-0.5 text-caption font-medium text-fg-secondary"
            title={t('internal.frozenHint')}
          >
            {t('internal.frozenBadge')}
          </span>
        )}
        {isTimeFork && (
          <span className="flex items-center gap-0.5 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-caption font-medium text-amber-400">
            <Clock size={10} />
            {t('internal.forkBadge')}
          </span>
        )}
        {/* 新话题徽章：AI 判定新开会话（虚线引入），与线段样式对应 */}
        {isNewTopic && (
          <span className="rounded-full border border-dashed border-accent/40 bg-accent/5 px-1.5 py-0.5 text-caption font-medium text-accent">
            {t('internal.newBadge')}
          </span>
        )}
        {isTimeLocked && (
          <span className="rounded-full bg-bg-muted/80 px-1.5 py-0.5 text-caption font-medium text-fg-muted">
            {t('internal.timeLocked')}
          </span>
        )}
        <span className="ml-auto truncate text-caption tabular-nums text-fg-muted/70">
          {formatTime(summary.updatedAt)}
        </span>
      </div>

      {/* 标题行：就地编辑 / 点击打开 */}
      <div className="flex items-center gap-2 px-3 pt-1">
        {editingTitle ? (
          <input
            ref={inputRef}
            value={draftTitle}
            onChange={(e) => setDraftTitle(e.target.value)}
            onBlur={() => void commitTitle()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void commitTitle()
              if (e.key === 'Escape') { setDraftTitle(summary.title); setEditingTitle(false) }
            }}
            className="min-w-0 flex-1 rounded-btn border border-accent/40 bg-bg-elevated px-2 py-1 text-body font-medium text-fg-primary outline-none"
          />
        ) : (
          <>
            <MessageSquare size={14} className="shrink-0 text-accent/70" />
            <button
              onClick={onOpen}
              className="min-w-0 flex-1 truncate text-left text-body font-medium text-fg-primary transition-colors hover:text-accent"
              title={summary.title}
            >
              {summary.title || t('internal.titlePlaceholder')}
            </button>
            <button
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-btn text-fg-muted/40 opacity-0 transition-all hover:bg-bg-muted hover:text-accent group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100"
              title={t('internal.editTitle')}
              aria-label={t('internal.editTitle')}
              onClick={() => { setEditingTitle(true); setDraftTitle(summary.title) }}
            >
              <Pencil size={12} />
            </button>
            <button
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-btn text-fg-muted/40 opacity-0 transition-all hover:bg-red-500/10 hover:text-red-400 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100"
              title={t('internal.delete')}
              aria-label={t('internal.delete')}
              onClick={() => {
                // 内部会话连同其全部消息一并落盘删除且无回收站，误删代价高，先确认再执行
                if (!window.confirm(`删除内部会话「${summary.title || summary.id}」将永久移除其中全部消息。确定删除？`)) return
                void deleteInternalSession(sessionId, summary.id)
              }}
            >
              <Trash2 size={12} />
            </button>
          </>
        )}
      </div>

      {/* 摘要行：3 行截断 + 高度随内容自适应（不再依赖固定卡高的 flex-1），可点击打开 / 就地编辑 */}
      <div className="w-full px-3 pb-0.5 pt-0.5">
        {editingSummary ? (
          <textarea
            ref={areaRef}
            value={draftSummary}
            onChange={(e) => setDraftSummary(e.target.value)}
            onBlur={() => void commitSummary()}
            onKeyDown={(e) => {
              if (e.key === 'Escape') { setDraftSummary(summary.summary); setEditingSummary(false) }
            }}
            rows={2}
            className="w-full resize-none rounded-btn border border-accent/40 bg-bg-elevated px-2.5 py-1.5 text-caption text-fg-secondary outline-none"
          />
        ) : (
          <button
            onClick={onOpen}
            className="line-clamp-3 w-full text-left text-caption leading-relaxed text-fg-muted transition-colors hover:text-fg-secondary"
            title={summary.summary || undefined}
          >
            {summary.summary || <span className="text-fg-muted/50">{t('internal.summaryPlaceholder')}</span>}
          </button>
        )}
      </div>

      {/* 元信息行：消息数·字符数 + 打开按钮 */}
      <div className="flex shrink-0 items-center gap-2 border-t border-border-subtle/60 px-3 py-1 text-caption tabular-nums text-fg-muted/70">
        <span>{t('internal.messages', { count: summary.messageCount })}</span>
        <span>·</span>
        <span>{t('internal.totalChars', { count: summary.totalChars })}</span>
        <button
          className="ml-auto flex h-7 w-7 items-center justify-center rounded-btn text-fg-muted/50 transition-all hover:bg-bg-muted hover:text-accent"
          title={t('internal.open')}
          aria-label={t('internal.open')}
          onClick={onOpen}
        >
          <ChevronLeft size={14} className="rotate-180" />
        </button>
      </div>
    </div>
  )
}

/** 详情视图：消息增删改 */
function DetailView({
  sessionId,
  internalId,
  onBack
}: {
  sessionId: string
  internalId: string
  onBack: () => void
}) {
  const t = useT()
  const active = useAppStore((s) => s.activeInternalSession)
  const updateInternalSession = useAppStore((s) => s.updateInternalSession)
  const [newRole, setNewRole] = useState<InternalMessage['role']>('note')
  const [newContent, setNewContent] = useState('')
  const [busy, setBusy] = useState(false)
  // 同步防重入：setState 是异步生效的，快速双击 Enter 时 busy state 尚未 flush，
  // 会基于同一 messages 快照并发提交两次（服务端整体替换）导致首条消息被覆盖丢失
  const busyRef = useRef(false)

  const removeMessage = async (msgId: string) => {
    if (!active) return
    await updateInternalSession(sessionId, internalId, {
      messages: active.messages.filter((m) => m.id !== msgId)
    })
  }

  const addMessage = async () => {
    if (!active || !newContent.trim()) return
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    try {
      const msg: InternalMessage = {
        id: `m_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        role: newRole,
        content: newContent.trim(),
        createdAt: Date.now()
      }
      const ok = await updateInternalSession(sessionId, internalId, {
        messages: [...active.messages, msg]
      })
      if (ok) setNewContent('')
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  const saveMessage = async (msgId: string, content: string) => {
    if (!active) return
    await updateInternalSession(sessionId, internalId, {
      messages: active.messages.map((m) => (m.id === msgId ? { ...m, content } : m))
    })
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 详情头部（全宽，不留白） */}
      <div className="shrink-0 border-b border-border-subtle">
        <div className="flex w-full items-center gap-2.5 px-6 py-3">
          <button
            onClick={onBack}
            className="flex h-7 items-center gap-1 rounded-btn px-2 text-caption text-fg-muted transition-all hover:bg-bg-muted hover:text-fg-secondary"
          >
            <ChevronLeft size={15} />
            {t('internal.back')}
          </button>
          <span className="min-w-0 flex-1 truncate text-body font-medium text-fg-primary">
            {active?.title || ''}
          </span>
          <span className="shrink-0 text-caption tabular-nums text-fg-muted/70">
            {t('internal.messages', { count: active?.messages.length ?? 0 })}
          </span>
        </div>
      </div>

      {/* 消息列表：全宽，不留白 */}
      <div className="flex-1 overflow-y-auto">
        <div className="w-full space-y-2 px-6 py-4">
        {(active?.messages ?? []).map((m) => (
          <MessageRow
            key={m.id}
            msg={m}
            onDelete={() => void removeMessage(m.id)}
            onSave={(content) => void saveMessage(m.id, content)}
          />
        ))}
        </div>
      </div>

      {/* 新增消息（全宽，不留白） */}
      <div className="shrink-0 border-t border-border-subtle">
        <div className="w-full px-6 py-3">
          <div className="flex items-center gap-2.5">
            <select
              value={newRole}
              onChange={(e) => setNewRole(e.target.value as InternalMessage['role'])}
              className="rounded-btn border border-border-subtle bg-bg-elevated px-2 py-1.5 text-caption text-fg-secondary outline-none focus:border-accent/40"
            >
              <option value="user">{t('internal.role.user')}</option>
              <option value="assistant">{t('internal.role.assistant')}</option>
              <option value="note">{t('internal.role.note')}</option>
            </select>
            <input
              value={newContent}
              onChange={(e) => setNewContent(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void addMessage() }}
              className="flex-1 rounded-btn border border-border-subtle bg-bg-elevated px-3 py-2 text-body text-fg-primary outline-none focus:border-accent/40"
              placeholder={t('internal.contentPlaceholder')}
            />
            <button
              disabled={busy || !newContent.trim()}
              onClick={() => void addMessage()}
              className="flex h-8 shrink-0 items-center gap-1.5 rounded-btn bg-accent/15 px-3 text-caption font-medium text-accent transition-all hover:bg-accent/25 disabled:opacity-40"
            >
              <Plus size={14} />
              {t('internal.addMessage')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * 会话上限配置小卡片。
 * 为什么存在：用户需要在不离开内部会话视图的情况下查看/修改「会话上下文上限」
 * （summaryBudgetChars）——超限即触发原会话冻结 + 新建继承会话；
 * 自动模式（0）下需要把模型窗口 ×1/4 的推导结果直接展示出来，纯配置值
 * （0）对用户不可理解。放在头部右上角开关的独立卡片中（max-w-md，不占满面板）。
 * 作用：读 dmn:sessionSummary:effective 展示「配置/生效/自动 vs 手动/模型窗口」，
 * 支持输入 0=自动或正整数=手动值，写 dmn:config:update 落盘，保存后刷新生效值。
 * 校验纪律：非正整数（含负数/NaN）不提交并给出提示，防止把非法值写进配置。
 */
function SessionBudgetCard({ onClose }: { onClose: () => void }) {
  const t = useT()
  // effective 拉取结果；null=未加载/加载失败
  const [info, setInfo] = useState<SessionSummaryEffectiveInfo | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  // 输入草稿（初始为配置值；编辑时本地持有，Enter 保存）
  const [draft, setDraft] = useState('')
  // 校验错误：非法输入时不提交，提示用户
  const [draftError, setDraftError] = useState(false)
  // 保存反馈：idle=未保存 / saved=成功 / error=失败
  const [saveState, setSaveState] = useState<'idle' | 'saved' | 'error'>('idle')
  const [busy, setBusy] = useState(false)

  const load = async () => {
    try {
      const eff = await window.lunareclipse.dmnGetSessionSummaryEffective()
      if (eff) {
        setInfo(eff)
        setDraft(String(eff.configured))
        setLoadFailed(false)
      } else {
        setLoadFailed(true)
      }
    } catch {
      // IPC 异常：视为加载失败，展示重试入口而非静默
      setLoadFailed(true)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  const save = async () => {
    const v = Number(draft)
    if (!Number.isInteger(v) || v < 0) {
      setDraftError(true)
      return
    }
    setDraftError(false)
    setBusy(true)
    setSaveState('idle')
    try {
      const ok = await window.lunareclipse.dmnUpdateConfig({ sessionSummary: { summaryBudgetChars: v } })
      // 回执形态防御：先判对象再查 ok 字段（null/原始值直接视为失败，避免 'ok' in 抛错）
      if (!ok || typeof ok !== 'object' || !('ok' in ok) || ok.ok !== true) {
        setSaveState('error')
        return
      }
      setSaveState('saved')
      // 保存成功即刷新生效值：手动值下 effective=configured；自动值（0）下需重新推导
      await load()
    } catch {
      setSaveState('error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-2.5 rounded-card border border-border-subtle bg-bg-surface/80 p-3.5 shadow-lg backdrop-blur-sm">
      {/* 卡片头：标题 + 关闭 */}
      <div className="flex items-center gap-2">
        <Settings2 size={13} className="shrink-0 text-accent" />
        <span className="text-body font-medium text-fg-primary">{t('internal.budgetLabel')}</span>
        <button
          onClick={onClose}
          className="ml-auto flex h-6 w-6 items-center justify-center rounded-btn text-fg-muted transition-all hover:bg-bg-muted hover:text-fg-secondary"
          title={t('common.close')}
          aria-label={t('common.close')}
        >
          <X size={12} />
        </button>
      </div>

      {/* 加载失败：重试入口 */}
      {loadFailed && !info ? (
        <div className="flex items-center justify-between gap-2">
          <span className="text-caption text-red-400">{t('internal.budgetLoadFailed')}</span>
          <button
            onClick={() => void load()}
            className="flex h-7 items-center gap-1.5 rounded-btn border border-border-subtle px-2.5 text-caption text-fg-secondary transition-all hover:border-accent/30 hover:text-accent"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6" /></svg>
            {t('view.refresh')}
          </button>
        </div>
      ) : info ? (
        <>
          {/* 当前生效信息 */}
          <div className="space-y-1 rounded-btn border border-border-subtle bg-bg-elevated/60 px-3 py-2">
            <div className="flex items-center gap-2">
              <span className="text-caption text-fg-muted">{t('internal.budgetMode')}</span>
              <span className={`rounded-full px-2 py-0.5 text-caption font-medium ${info.auto ? 'bg-accent/15 text-accent' : 'bg-emerald-500/15 text-emerald-400'}`}>
                {info.auto ? t('internal.budgetAuto') : t('internal.budgetManual')}
              </span>
            </div>
            <div className="text-body tabular-nums text-fg-primary">
              {t('internal.budgetEffective', { n: info.effective.toLocaleString() })}
            </div>
            <div className="text-caption tabular-nums text-fg-muted/70">
              {t('internal.budgetModelWindow', { n: info.modelWindow.toLocaleString() })}
            </div>
          </div>

          {/* 输入 + 保存/取消 */}
          <div className="space-y-1.5">
            <div className="flex items-center gap-2">
              <input
                type="number"
                min="0"
                step="10000"
                value={draft}
                onChange={(e) => {
                  setDraft(e.target.value)
                  setDraftError(false)
                  setSaveState('idle')
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void save()
                  if (e.key === 'Escape') { setDraft(String(info.configured)); setDraftError(false); setSaveState('idle') }
                }}
                aria-label={t('internal.budgetInput')}
                aria-invalid={draftError}
                className="min-w-0 flex-1 rounded-btn border border-border-subtle bg-bg-elevated px-2.5 py-1.5 text-body tabular-nums text-fg-primary outline-none focus:border-accent/40"
              />
              <button
                disabled={busy}
                onClick={() => void save()}
                className="flex h-7 shrink-0 items-center gap-1.5 rounded-btn bg-accent/15 px-3 text-caption font-medium text-accent transition-all hover:bg-accent/25 disabled:opacity-40"
              >
                <Check size={13} />
                {t('internal.budgetSave')}
              </button>
            </div>
            <div className="text-caption text-fg-muted/80">
              {draftError
                ? <span className="text-red-400">{t('internal.budgetInvalid')}</span>
                : saveState === 'saved'
                  ? <span className="text-accent">{t('internal.budgetSaved')}</span>
                  : saveState === 'error'
                    ? <span className="text-red-400">{t('internal.budgetSaveFailed')}</span>
                    : t('internal.budgetInputHint')}
            </div>
          </div>
        </>
      ) : (
        /* 首次加载中：简短占位，避免布局跳动 */
        <div className="py-2 text-caption text-fg-muted/60">…</div>
      )}
    </div>
  )
}

/** 单条消息：就地编辑 + 删除 */
function MessageRow({
  msg,
  onDelete,
  onSave
}: {
  msg: InternalMessage
  onDelete: () => void
  onSave: (content: string) => void
}) {
  const t = useT()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(msg.content)
  const areaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (editing) areaRef.current?.focus()
  }, [editing])

  const roleLabel = t(`internal.role.${msg.role}` as const)
  const roleColor =
    msg.role === 'user' ? 'bg-accent/15 text-accent'
    : msg.role === 'assistant' ? 'bg-emerald-500/15 text-emerald-400'
    : 'bg-amber-500/15 text-amber-400'

  return (
    <div className="group rounded-card border border-border-subtle bg-bg-surface/30 p-3">
      <div className="mb-1.5 flex items-center gap-2.5">
        <span className={`rounded-full px-2 py-0.5 text-caption font-medium ${roleColor}`}>
          {roleLabel}
        </span>
        <span className="text-caption tabular-nums text-fg-muted/60">
          {formatTime(msg.createdAt)}
        </span>
        <div className="ml-auto flex items-center gap-1 opacity-0 transition-all group-hover:opacity-100 group-focus-within:opacity-100">
          <button
            className="flex h-7 w-7 items-center justify-center rounded-btn text-fg-muted/40 transition-all hover:bg-bg-muted hover:text-accent"
            title={t('internal.editTitle')}
            aria-label={t('internal.editTitle')}
            onClick={() => { setEditing(true); setDraft(msg.content) }}
          >
            <Pencil size={13} />
          </button>
          <button
            className="flex h-7 w-7 items-center justify-center rounded-btn text-fg-muted/40 transition-all hover:bg-red-500/10 hover:text-red-400"
            title={t('internal.delete')}
            aria-label={t('internal.delete')}
            onClick={() => {
              // 删除内部消息即时覆盖落盘，无撤销路径，先确认再删
              if (!window.confirm('删除该内部消息将永久移除且无法恢复。确定删除？')) return
              onDelete()
            }}
          >
            <Trash2 size={13} />
          </button>
        </div>
      </div>
      {editing ? (
        <div className="space-y-2">
          <textarea
            ref={areaRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={4}
            className="w-full resize-none rounded-btn border border-accent/40 bg-bg-elevated px-3 py-2 text-body leading-relaxed text-fg-primary outline-none"
          />
          <div className="flex items-center justify-end gap-1.5">
            <button
              onClick={() => { setEditing(false); setDraft(msg.content) }}
              className="flex items-center gap-1.5 rounded-btn px-3 py-1.5 text-caption text-fg-muted transition-all hover:bg-bg-muted"
            >
              <X size={13} />
              {t('internal.createCancel')}
            </button>
            <button
              onClick={() => { setEditing(false); onSave(draft) }}
              className="flex items-center gap-1.5 rounded-btn bg-accent/15 px-3 py-1.5 text-caption font-medium text-accent transition-all hover:bg-accent/25"
            >
              <Check size={13} />
              {t('internal.createConfirm')}
            </button>
          </div>
        </div>
      ) : (
        <div className="whitespace-pre-wrap break-words text-body leading-relaxed text-fg-secondary">
          {msg.content || <span className="text-fg-muted/40">—</span>}
        </div>
      )}
    </div>
  )
}