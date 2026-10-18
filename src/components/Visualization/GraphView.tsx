/**
 * GraphView：轻量自研 SVG 力导向关系图组件，画布化版。
 * 为什么存在：项目未引入 d3 / force-graph / cytoscape 等图可视化依赖，
 * 而 NNG/缓存图谱规模有限（深度 ≤3、节点数十级），以「分层初始布局 + 斥力/弹簧松弛」
 * 即可获得稳定布局，避免为单个面板引入重型依赖。
 * 作用：把「文件为点、同名文件夹为线」的树结构展平为真实关系图（文件=节点、同名
 * 文件夹=连线），并锚定 AI 内部会话逆生树的画布交互范式：
 * - 普通滚轮 / 触控板双指 = 平移；Ctrl/⌘+滚轮 = 以鼠标为锚点缩放（指数阻尼）；
 * - 空白区左键 / 任意处中键拖拽 = 平移（拖拽阈值区分点按与拖动）；
 * - 画布视图 zoom+pan 原子 state 更新，viewRef 渲染期同步规避闭包旧值；
 * - 右下角悬浮控件 − / 百分比 / + / 适应视图 / 重置视图；左下角手势提示常驻；
 * - fit 在挂载、视口尺寸变化与数据变更时自动执行；双击空白 = 适应视图；
 * - 节点支持拖拽与点击打开（onNodeClick → 面板 JSON 预览）；节点按类型着色
 *   （standard 绿 / meta 紫 / high 琥珀），低缩放时降级为纯点（隐藏标签）。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as RMouseEvent } from 'react'
import { Maximize, RotateCcw, ZoomIn, ZoomOut } from 'lucide-react'

/** 图节点数据（与后端 NngTreeNode 同构，仅取前端渲染需要的字段） */
export interface GraphNodeData {
  name: string
  path: string
  type: 'standard' | 'meta' | 'high'
  children: GraphNodeData[]
}

/** 节点类型 → 颜色（tailwind emerald/violet/amber-400 色值，与面板类型徽标一致） */
export const GRAPH_TYPE_COLOR: Record<GraphNodeData['type'], string> = {
  standard: '#34d399',
  meta: '#a78bfa',
  high: '#fbbf24'
}

interface GraphViewProps {
  nodes: GraphNodeData[]
  /** 数据加载中（首屏空态时显示加载文案） */
  loading?: boolean
  /** 空态文案（无节点时居中展示） */
  emptyText: string
  /** 当前选中节点路径（高亮外圈） */
  selectedPath?: string | null
  /** 点击节点：path 为该节点 JSON 文件完整路径 */
  onNodeClick: (path: string, name: string) => void
  /** 工具条按钮提示文案（i18n 由父组件传入，缺省英文） */
  labels?: {
    zoomIn?: string
    zoomOut?: string
    reset?: string
    loading?: string
    zoomFit?: string
    hint?: string
  }
}

interface LayoutNode {
  id: string
  name: string
  path: string
  type: GraphNodeData['type']
  depth: number
  children: string[]
  x: number
  y: number
  vx: number
  vy: number
}

interface LayoutEdge {
  source: string
  target: string
}

interface GraphLayout {
  nodes: LayoutNode[]
  edges: LayoutEdge[]
  positions: Record<string, { x: number; y: number }>
}

interface CanvasView {
  zoom: number
  pan: { x: number; y: number }
}

interface DragState {
  mode: 'node' | 'pan' | null
  id: string | null
  startX: number
  startY: number
  startPanX: number
  startPanY: number
  moved: boolean
}

const MIN_ZOOM = 0.25
const MAX_ZOOM = 3
const FIT_MAX_ZOOM = 1.6
const CLICK_SLOP = 4

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/** 树 → 图展平：每个文件一个节点，同名文件夹内的子文件作为边（父子关系） */
function flattenTree(roots: GraphNodeData[]): { nodes: LayoutNode[]; edges: LayoutEdge[] } {
  const nodes: LayoutNode[] = []
  const edges: LayoutEdge[] = []
  const visit = (n: GraphNodeData, parent: LayoutNode | null, depth: number): void => {
    const node: LayoutNode = {
      id: n.path,
      name: n.name,
      path: n.path,
      type: n.type,
      depth,
      children: [],
      x: 0,
      y: 0,
      vx: 0,
      vy: 0
    }
    nodes.push(node)
    if (parent) {
      parent.children.push(node.id)
      edges.push({ source: parent.id, target: node.id })
    }
    for (const c of n.children) visit(c, node, depth + 1)
  }
  for (const r of roots) visit(r, null, 0)
  return { nodes, edges }
}

/** 分层初始布局 + 斥力/弹簧松弛（一次性同步计算；规模小，迭代开销可忽略） */
function computeLayout(roots: GraphNodeData[], seed: number): GraphLayout {
  const { nodes, edges } = flattenTree(roots)
  if (nodes.length === 0) return { nodes, edges, positions: {} }

  // 确定性伪随机（seed 固定，布局稳定可预期；画布平移缩放不干涉布局）
  let rng = (seed * 2654435761) >>> 0
  const rand = () => {
    rng = (rng * 1664525 + 1013904223) >>> 0
    return rng / 4294967296
  }

  // 按深度分层横向均布（同层不相邻的问题由 nextTick 排除：先分组再铺开）
  const byDepth: Record<number, LayoutNode[]> = {}
  for (const n of nodes) {
    if (!byDepth[n.depth]) byDepth[n.depth] = []
    byDepth[n.depth].push(n)
  }
  let maxCount = 0
  for (const arr of Object.values(byDepth)) maxCount = Math.max(maxCount, arr.length)
  for (const [depthStr, arr] of Object.entries(byDepth)) {
    const depth = Number(depthStr)
    arr.forEach((n, i) => {
      const span = maxCount + 1
      n.x = ((i + 1) / (arr.length + 1) - 0.5) * span * 84 + (rand() - 0.5) * 16
      n.y = depth * 120 + (rand() - 0.5) * 16
    })
  }

  const idMap = new Map(nodes.map((n) => [n.id, n]))
  const k = 62          // 斥力强度
  const springK = 0.05  // 弹簧刚度
  const gravity = 0.012 // 中心引力（防止散开）
  const dt = 0.08

  for (let iter = 0; iter < 320; iter++) {
    // 斥力（库仑）：距离越近越强
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i]
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j]
        let dx = a.x - b.x
        let dy = a.y - b.y
        let dist2 = dx * dx + dy * dy
        if (dist2 < 1) {
          dx = rand() - 0.5
          dy = rand() - 0.5
          dist2 = 1
        }
        const dist = Math.sqrt(dist2)
        const f = (k * k) / dist2
        const fx = (dx / dist) * f
        const fy = (dy / dist) * f
        a.vx += fx
        a.vy += fy
        b.vx -= fx
        b.vy -= fy
      }
    }
    // 弹簧（边）：趋向理想长度（层级越深期望边越长）
    for (const e of edges) {
      const a = idMap.get(e.source)
      const b = idMap.get(e.target)
      if (!a || !b) continue
      const dx = a.x - b.x
      const dy = a.y - b.y
      let dist = Math.sqrt(dx * dx + dy * dy)
      if (dist < 0.01) dist = 0.01
      const rest = 96 + Math.min(a.depth, 2) * 26
      const f = (dist - rest) * springK
      const fx = (dx / dist) * f
      const fy = (dy / dist) * f
      a.vx -= fx
      a.vy -= fy
      b.vx += fx
      b.vy += fy
    }
    // 中心引力 + 积分 + 摩擦
    for (const n of nodes) {
      n.vx += -n.x * gravity
      n.vy += -n.y * gravity
      n.vx *= 0.84
      n.vy *= 0.84
      n.x += n.vx * dt
      n.y += n.vy * dt
    }
  }

  const positions: Record<string, { x: number; y: number }> = {}
  for (const n of nodes) positions[n.id] = { x: n.x, y: n.y }
  return { nodes, edges, positions }
}

export function GraphView({ nodes, loading, emptyText, selectedPath, onNodeClick, labels }: GraphViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const svgRef = useRef<SVGSVGElement | null>(null)

  // 布局：数据变化时重算（一次性计算结果，画布平移缩放与节点拖拽不触发重算）
  const layout = useMemo(() => computeLayout(nodes, 1), [nodes])
  const [positions, setPositions] = useState<Record<string, { x: number; y: number }>>(layout.positions)

  // 画布视图：zoom+pan 一个 state 原子更新，避免「读旧 zoom 算新 pan」的闭包竞态
  const [view, setView] = useState<CanvasView>({ zoom: 1, pan: { x: 0, y: 0 } })
  // 渲染视口引用（事件回调避免闭包旧值）
  const viewRef = useRef<CanvasView>(view)
  viewRef.current = view

  // 适配视口：内容完整可见、尽量大且居中。bbox 取自初始布局坐标（fit 不覆盖用户
  // 对节点的拖拽位置；节点位置是画布内容，视图适配只看布局整体范围）。
  const fit = useCallback(() => {
    const el = containerRef.current
    if (!el) return
    const vw = el.clientWidth
    const vh = el.clientHeight
    if (!vw || !vh) return
    const list = layout.nodes
    if (list.length === 0) return
    const xs = list.map((n) => layout.positions[n.id]?.x ?? n.x)
    const ys = list.map((n) => layout.positions[n.id]?.y ?? n.y)
    const x0 = Math.min(...xs)
    const x1 = Math.max(...xs)
    const y0 = Math.min(...ys)
    const y1 = Math.max(...ys)
    const bw = Math.max(x1 - x0, 1)
    const bh = Math.max(y1 - y0, 1)
    const pad = 70
    // 下限保护：视口小于 2*pad 时 zoom 会算出负值（scale 负 = 画布镜像），钳到 MIN_ZOOM
    const zoom = Math.max(MIN_ZOOM, Math.min((vw - pad * 2) / bw, (vh - pad * 2) / bh, FIT_MAX_ZOOM))
    const cx = (x0 + x1) / 2
    const cy = (y0 + y1) / 2
    setView({ zoom, pan: { x: vw / 2 - cx * zoom, y: vh / 2 - cy * zoom } })
  }, [layout])

  // 数据变更：重置节点位置并适配到新布局（挂载时也会执行一次 → 首屏自动 fit）
  useEffect(() => {
    setPositions(layout.positions)
    fit()
  }, [layout, fit])

  // 出图后随视口尺寸变化自动适配（拖拽侧栏/窗口缩放时保持整图可见）
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver(() => fit())
    ro.observe(el)
    return () => ro.disconnect()
  }, [fit])

  // 原生滚轮：React onWheel 是 passive，preventDefault 无效（拦不住 Ctrl+滚轮的
  // 浏览器页面缩放），必须 passive:false 手动绑定。Ctrl/⌘+滚轮（含触控板捏合）=
  // 以鼠标为锚点缩放（指数阻尼）；普通滚轮/双指滚动 = 平移画布。
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      const px = e.clientX - rect.left
      const py = e.clientY - rect.top
      if (e.ctrlKey || e.metaKey) {
        const factor = Math.exp(-e.deltaY * 0.0011)
        zoomAt(px, py, viewRef.current.zoom * factor)
      } else {
        setView((v) => ({ ...v, pan: { x: v.pan.x - e.deltaX, y: v.pan.y - e.deltaY } }))
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
    // zoomAt 每次渲染重建，不能放进依赖；其内部只依赖 stable 的 setView 与模块级
    // clamp，effect 闭包捕获首次渲染的 zoomAt 也没有旧值风险（依赖空数组，绑定一次）
  }, [])

  // 以视口坐标 (px, py) 为锚点缩放到 targetZoom：锚点下的内容点在缩放前后保持不动。
  // 单次 setView 原子更新：新 pan 依赖「旧 zoom 与旧 pan」同步计算。
  const zoomAt = (px: number, py: number, targetZoom: number) => {
    setView((v) => {
      const zoom = clamp(targetZoom, MIN_ZOOM, MAX_ZOOM)
      if (zoom === v.zoom) return v
      const contentX = (px - v.pan.x) / v.zoom
      const contentY = (py - v.pan.y) / v.zoom
      return { zoom, pan: { x: px - contentX * zoom, y: py - contentY * zoom } }
    })
  }

  // 视图中心缩放（工具栏按钮）：以视口中心为锚点，步进系数 1.2
  const zoomCenter = (factor: number) => {
    const el = containerRef.current
    if (!el) return
    zoomAt(el.clientWidth / 2, el.clientHeight / 2, viewRef.current.zoom * factor)
  }

  const drag = useRef<DragState>({ mode: null, id: null, startX: 0, startY: 0, startPanX: 0, startPanY: 0, moved: false })

  // 拖拽中的光标：直接操作 classList 即时切换，不依赖 React 重渲染
  const setGrabbing = (on: boolean) => {
    const el = svgRef.current
    if (!el) return
    el.classList.toggle('cursor-grabbing', on)
  }

  // 最新回调（mousedown 时绑定 window 级 move/up，保证移出面板仍可拖拽）
  const handlersRef = useRef<{ onMove: (e: MouseEvent) => void; onUp: () => void }>({
    onMove: () => {},
    onUp: () => {}
  })
  // 拖拽监听取消器：卸载时中止未完成拖拽的 window 监听，避免残留
  const dragAbort = useRef<AbortController | null>(null)

  const screenToLocal = (clientX: number, clientY: number): { x: number; y: number } => {
    const rect = svgRef.current?.getBoundingClientRect()
    if (!rect) return { x: 0, y: 0 }
    const v = viewRef.current
    return {
      x: (clientX - rect.left - v.pan.x) / v.zoom,
      y: (clientY - rect.top - v.pan.y) / v.zoom
    }
  }

  handlersRef.current.onMove = (e: MouseEvent) => {
    const d = drag.current
    if (!d.mode) return
    const dx = e.clientX - d.startX
    const dy = e.clientY - d.startY
    if (Math.abs(dx) + Math.abs(dy) > CLICK_SLOP) d.moved = true
    if (d.mode === 'pan') {
      setView((v) => ({ ...v, pan: { x: d.startPanX + dx, y: d.startPanY + dy } }))
    } else if (d.mode === 'node' && d.id) {
      const local = screenToLocal(e.clientX, e.clientY)
      setPositions((prev) => (prev[d.id!] ? { ...prev, [d.id!]: { x: local.x, y: local.y } } : prev))
    }
  }

  handlersRef.current.onUp = () => {
    const d = drag.current
    if (!d.mode) return
    if (d.mode === 'node' && !d.moved && d.id) {
      const node = layout.nodes.find((n) => n.id === d.id)
      if (node) onNodeClick(node.path, node.name)
    }
    drag.current = { ...d, mode: null, id: null }
    setGrabbing(false)
  }

  const bindDrag = () => {
    // 每次拖拽独立 AbortController：先取消上一次（快速连按 mousedown 不残留多余监听）；
    // 组件卸载时由下方 cleanup abort 收尾，杜绝 window 监听泄漏
    dragAbort.current?.abort()
    const ac = new AbortController()
    dragAbort.current = ac
    const move = (e: MouseEvent) => handlersRef.current.onMove(e)
    const up = () => {
      handlersRef.current.onUp()
      ac.abort()
    }
    window.addEventListener('mousemove', move, { signal: ac.signal })
    window.addEventListener('mouseup', up, { signal: ac.signal })
  }

  // 卸载时中止未完成的拖拽监听
  useEffect(() => () => dragAbort.current?.abort(), [])

  const onSvgMouseDown = (e: RMouseEvent<SVGSVGElement>) => {
    if (e.button !== 0 && e.button !== 1) return
    e.preventDefault()
    const v = viewRef.current
    // 中键任意处 = 平移；左键：节点上 = 拖节点，空白处 = 平移
    const target = e.target as Element
    const nodeEl = target.closest?.('[data-node-id]')
    const nodeId = nodeEl?.getAttribute('data-node-id')
    if (e.button === 1) {
      drag.current = { mode: 'pan', id: null, startX: e.clientX, startY: e.clientY, startPanX: v.pan.x, startPanY: v.pan.y, moved: false }
    } else if (nodeId) {
      drag.current = { mode: 'node', id: nodeId, startX: e.clientX, startY: e.clientY, startPanX: v.pan.x, startPanY: v.pan.y, moved: false }
    } else {
      drag.current = { mode: 'pan', id: null, startX: e.clientX, startY: e.clientY, startPanX: v.pan.x, startPanY: v.pan.y, moved: false }
    }
    setGrabbing(true)
    bindDrag()
  }

  const transform = `translate(${view.pan.x} ${view.pan.y}) scale(${view.zoom})`
  const empty = layout.nodes.length === 0

  return (
    <div
      ref={containerRef}
      className="relative h-full w-full overflow-hidden bg-bg-muted/20"
      onDoubleClick={(e) => {
        // 双击空白 = 适应视图；节点上的双击不抢手势（节点点击照常打开）
        if ((e.target as Element).closest?.('[data-node-id]')) return
        fit()
      }}
    >
      {!empty && (
        <>
          {/* 缩放控件：固定在视口右下角，不随画布变换（画布移走控件仍在） */}
          <div className="absolute bottom-3 right-3 z-10 flex items-center gap-0.5 rounded-card border border-border-subtle bg-bg-elevated/90 p-1 shadow-md backdrop-blur-sm">
            <button
              onClick={() => zoomCenter(1 / 1.2)}
              title={labels?.zoomOut ?? 'Zoom out'}
              aria-label={labels?.zoomOut ?? 'Zoom out'}
              className="flex h-6 w-6 items-center justify-center rounded text-fg-muted transition-colors hover:bg-bg-muted hover:text-fg-secondary"
            >
              <ZoomOut size={14} />
            </button>
            <span className="w-10 select-none text-center text-caption tabular-nums text-fg-muted/80">
              {Math.round(view.zoom * 100)}%
            </span>
            <button
              onClick={() => zoomCenter(1.2)}
              title={labels?.zoomIn ?? 'Zoom in'}
              aria-label={labels?.zoomIn ?? 'Zoom in'}
              className="flex h-6 w-6 items-center justify-center rounded text-fg-muted transition-colors hover:bg-bg-muted hover:text-fg-secondary"
            >
              <ZoomIn size={14} />
            </button>
            <span className="mx-0.5 h-4 w-px bg-border-subtle" />
            <button
              onClick={fit}
              title={labels?.zoomFit ?? 'Fit to view'}
              aria-label={labels?.zoomFit ?? 'Fit to view'}
              className="flex h-6 w-6 items-center justify-center rounded text-fg-muted transition-colors hover:bg-bg-muted hover:text-fg-secondary"
            >
              <Maximize size={14} />
            </button>
            <button
              onClick={() => setView({ zoom: 1, pan: { x: 0, y: 0 } })}
              title={labels?.reset ?? 'Reset view'}
              aria-label={labels?.reset ?? 'Reset view'}
              className="flex h-6 w-6 items-center justify-center rounded text-fg-muted transition-colors hover:bg-bg-muted hover:text-fg-secondary"
            >
              <RotateCcw size={14} />
            </button>
          </div>
          {/* 画布操作提示：左下角常驻一行小字，帮助用户发现画布手势 */}
          <div className="pointer-events-none absolute bottom-3 left-4 rounded-card bg-bg-elevated/70 px-2 py-1 text-caption text-fg-muted/70 backdrop-blur-sm">
            {labels?.hint ?? 'Scroll to pan · Ctrl+scroll to zoom · Drag canvas · Click a node'}
          </div>
        </>
      )}

      <svg
        ref={svgRef}
        className="h-full w-full cursor-grab"
        onMouseDown={onSvgMouseDown}
      >
        {!empty && (
          <g transform={transform}>
            {layout.edges.map((e) => {
              const a = positions[e.source]
              const b = positions[e.target]
              if (!a || !b) return null
              return (
                <line
                  key={`${e.source}\u0000${e.target}`}
                  x1={a.x}
                  y1={a.y}
                  x2={b.x}
                  y2={b.y}
                  stroke="#9ca3af"
                  strokeOpacity={0.4}
                  strokeWidth={1}
                />
              )
            })}
            {layout.nodes.map((n) => {
              const p = positions[n.id] ?? { x: n.x, y: n.y }
              const color = GRAPH_TYPE_COLOR[n.type]
              const radius = 7 + Math.min(n.children.length * 2.5, 7)
              const selected = selectedPath != null && selectedPath === n.id
              const label = n.name.length > 14 ? `${n.name.slice(0, 13)}…` : n.name
              const showLabel = view.zoom >= 0.5 || n.depth === 0 || selected
              return (
                <g key={n.id} data-node-id={n.id} className="cursor-grab active:cursor-grabbing">
                  {selected && (
                    <circle cx={p.x} cy={p.y} r={radius + 5} fill="none" stroke="#ffffff" strokeOpacity={0.85} strokeWidth={1.2} />
                  )}
                  <circle cx={p.x} cy={p.y} r={radius} fill={color} fillOpacity={0.16} stroke={color} strokeWidth={1.4} />
                  <circle cx={p.x} cy={p.y} r={Math.max(radius - 5, 3)} fill={color} fillOpacity={0.4} />
                  {showLabel && (
                    <text
                      x={p.x}
                      y={p.y - radius - 5}
                      textAnchor="middle"
                      fontSize={10}
                      fill={selected ? '#ffffff' : '#d1d5db'}
                      pointerEvents="none"
                      style={{ userSelect: 'none' }}
                    >
                      {label}
                    </text>
                  )}
                </g>
              )
            })}
          </g>
        )}
      </svg>

      {empty && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-6">
          <span className="text-caption text-fg-muted">
            {loading ? (labels?.loading ?? 'Loading…') : emptyText}
          </span>
        </div>
      )}
    </div>
  )
}