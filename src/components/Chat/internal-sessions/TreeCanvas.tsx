/**
 * @category 前端组件
 * @summary 逆生树画布与单株树渲染（放射形绝对定位 + SVG 连线 + 折叠/密集降级）
 * @note 为什么存在：原 `InternalSessionsView.tsx` 1408 行破 800 硬红线（ADR-27 拆分）；画布是面板最大的独立渲染单元，且渲染探针需要直渲本组件。
 * @note 不删理由：逆生树视图的唯一渲染载体；会话树规模通常 <200，绝对定位渲染成本可忽略，无需虚拟化。
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import {
  Maximize,
  RotateCcw,
  ZoomIn,
  ZoomOut
} from 'lucide-react'
import { useT } from '../../../i18n/useT'
import {
  buildTreeLayouts,
  computeSubtreeSizes,
  pruneCollapsed,
  DENSE_SUBTREE_THRESHOLD,
  DENSE_ZOOM_THRESHOLD,
  TREE_CARD_H,
  TREE_CARD_W,
  type SessionTreeNode,
  type TreeLayout
} from '../session-chains'
import { SessionCard } from './SessionCard'

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
