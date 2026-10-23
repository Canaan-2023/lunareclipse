/**
 * 记忆/图谱数据面板（MemoryGraphPanel）。
 * 为什么存在：月蚀是多 AI 结构，每个 AI 各有 NNG 图谱与缓存镜像图谱（文件为点、同名文件夹为线）。
 * 面板只展示这两类图谱的真实关系图：顶部 AI 切换器按 ai-registry 动态渲染（各看各的图谱），
 * NNG/缓存双选项卡，点击图节点在底部预览该节点 JSON；保留刷新/关闭/Esc/遮罩行为。
 * 不再展示记忆文件列表与 <pre> 树形展开（用户定稿：只显示 NNG 和缓存图谱）。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { X, RefreshCw, Network, Database, Braces } from 'lucide-react'
import { useAppStore } from '../../stores/appStore'
import { useT } from '../../i18n/useT'
import { aiAvatarFallback } from '../Ai/AiManagerPanel'
import { GraphView, GRAPH_TYPE_COLOR, type GraphNodeData } from './GraphView'

type GraphKind = 'nng' | 'cache'

interface SelectedNode {
  kind: GraphKind
  path: string
  name: string
}

export function MemoryGraphPanel() {
  const open = useAppStore((s) => s.memoryGraphOpen)
  const close = () => useAppStore.getState().setMemoryGraphOpen(false)
  const t = useT()
  const aiName = useAppStore((s) => s.config.aiName) || '月蚀'
  const ais = useAppStore((s) => s.ais)
  const currentAiId = useAppStore((s) => s.currentAiId)

  const [aiId, setAiId] = useState<number>(1)
  const [kind, setKind] = useState<GraphKind>('nng')
  // null=未加载 / 数组=已加载（空数组即空态），与后端 { nng, cache } 对应
  const [nngNodes, setNngNodes] = useState<GraphNodeData[] | null>(null)
  const [cacheNodes, setCacheNodes] = useState<GraphNodeData[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState<SelectedNode | null>(null)
  const [jsonText, setJsonText] = useState<string | null>(null)
  const [jsonLoading, setJsonLoading] = useState(false)

  // AI 切换竞态守卫：每次发起加载自增请求序号，过期响应（序号不匹配）不写入 state、
  // 不置 loading，避免「先发慢后发快」时旧 AI 数据覆盖新 AI（上轮审查 MINOR）。
  const loadSeq = useRef(0)
  const openSeq = useRef(0)

  // 可切换 AI：全部启用 AI（停用不展示）；全停用/空时回退月蚀。排序：系统 AI 在前，其余按 id
  const switchable = useMemo(() => {
    const enabled = ais.filter((a) => a.deactivated !== true)
    if (enabled.length === 0) return [{ id: 1, name: aiName, avatar: undefined }]
    return [...enabled]
      .sort((a, b) => {
        const ak = a.kind === 'system' ? 0 : 1
        const bk = b.kind === 'system' ? 0 : 1
        return ak - bk || a.id - b.id
      })
      .map((a) => ({ id: a.id, name: a.name, avatar: a.avatar }))
  }, [ais, aiName])

  // 默认跟随当前会话所在 AI；当前 AI 不在列表（如已停用）时回退第一个
  useEffect(() => {
    if (switchable.some((a) => a.id === currentAiId) && currentAiId != null) {
      setAiId(currentAiId)
    } else {
      setAiId(switchable[0]?.id ?? 1)
    }
  }, [switchable, currentAiId])

  const load = async (id: number) => {
    const seq = ++loadSeq.current
    setLoading(true)
    try {
      const res = await window.lunareclipse?.vizGetGraph?.(id)
      if (seq !== loadSeq.current) return // 过期响应：另有更新的加载已发起，丢弃
      // 失败/缺方法时置空数组，回落到"暂无数据"空态而非卡在加载中
      setNngNodes(Array.isArray(res?.nng) ? (res.nng as GraphNodeData[]) : [])
      setCacheNodes(Array.isArray(res?.cache) ? (res.cache as GraphNodeData[]) : [])
    } catch (err) {
      if (seq !== loadSeq.current) return
      console.warn('[memoryGraph] load failed:', err)
      setNngNodes([])
      setCacheNodes([])
    } finally {
      if (seq === loadSeq.current) setLoading(false)
    }
  }

  // 打开面板 / 切换 AI 时并行拉取该 AI 的 NNG + 缓存图谱（文件系统遍历，按需加载）
  useEffect(() => {
    if (!open) return
    ++openSeq.current // 旧预览请求一并作废（视图已切换，路径不再有效）
    setNngNodes(null)
    setCacheNodes(null)
    setSelected(null)
    setJsonText(null)
    void load(aiId)
  }, [open, aiId])

  // Esc 关闭（与监控面板一致：window 级 keydown）
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') useAppStore.getState().setMemoryGraphOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  // 切换图谱视图时清掉上一视图的选中与预览（节点路径跨图谱无效）
  const switchKind = (next: GraphKind) => {
    if (next === kind) return
    ++openSeq.current // 作废上个视图未返回的预览请求
    setKind(next)
    setSelected(null)
    setJsonText(null)
  }

  const openContent = async (path: string, name: string) => {
    const seq = ++openSeq.current
    setSelected({ kind, path, name })
    setJsonText(null)
    setJsonLoading(true)
    try {
      const res =
        kind === 'nng'
          ? await window.lunareclipse?.vizGetNngContent?.(path)
          : await window.lunareclipse?.vizGetCacheContent?.(path)
      if (seq !== openSeq.current) return // 过期响应：期间已切换视图/节点，丢弃
      if (res == null) {
        setJsonText(t('memoryGraph.noContent'))
      } else {
        try {
          setJsonText(JSON.stringify(res, null, 2))
        } catch {
          setJsonText(String(res))
        }
      }
    } catch {
      if (seq !== openSeq.current) return
      setJsonText(t('memoryGraph.noContent'))
    } finally {
      if (seq === openSeq.current) setJsonLoading(false)
    }
  }

  if (!open) return null

  const activeNodes = kind === 'nng' ? nngNodes : cacheNodes

  return (
    // 遮罩：与监控面板同一层级 z-50，点击遮罩关闭
    <div className="fixed inset-0 z-50 flex justify-end bg-black/50" onClick={close}>
      <div
        className="flex h-full w-full max-w-[860px] flex-col border-l border-border bg-bg-surface shadow-2xl sm:w-[860px]"
        style={{ animation: 'viz-slide-in 0.25s ease-out' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* 标题栏 */}
        <div className="flex items-center justify-between border-b border-border-subtle px-5 py-3">
          <h2 className="flex items-center gap-2 text-title font-medium text-fg-primary">
            <Network size={14} className="text-fg-muted" />
            {t('memoryGraph.title')}
          </h2>
          <div className="flex items-center gap-2">
            <button
              onClick={() => void load(aiId)}
              disabled={loading}
              className="flex h-7 w-7 items-center justify-center rounded-btn text-fg-muted hover:bg-bg-muted hover:text-fg-primary disabled:opacity-50"
              title={t('memoryGraph.refresh')}
            >
              <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
            </button>
            <button
              onClick={close}
              aria-label={t('memoryGraph.closeAria')}
              title={t('memoryGraph.close')}
              className="flex h-7 w-7 items-center justify-center rounded-btn text-fg-muted hover:bg-bg-muted hover:text-fg-primary"
            >
              <X size={14} />
            </button>
          </div>
        </div>

        {/* AI 切换器（多 AI：按 AIID 动态渲染，各看各的图谱） */}
        <div className="border-b border-border-subtle px-4 py-2">
          <div className="flex items-center gap-1 rounded-btn border border-border-subtle bg-bg-muted/30 p-1">
            {switchable.map((a) => (
              <button
                key={a.id}
                onClick={() => setAiId(a.id)}
                className={`flex-1 rounded px-2 py-1 text-[11px] font-medium transition-colors ${
                  aiId === a.id ? 'bg-accent text-accent-fg' : 'text-fg-muted hover:bg-bg-muted hover:text-fg-secondary'
                }`}
              >
                <span className="mr-1">{a.avatar ?? aiAvatarFallback(a.id)}</span>
                {a.name}（AI {a.id}）
              </button>
            ))}
          </div>
        </div>

        {/* 视图切换 + 图例 + 操作提示 */}
        <div className="flex items-center gap-4 border-b border-border-subtle px-4 py-1.5">
          <div className="flex items-center gap-1 rounded-btn border border-border-subtle p-0.5">
            <button
              onClick={() => switchKind('nng')}
              className={`flex items-center gap-1.5 rounded px-2.5 py-1 text-[11px] font-medium transition-colors ${
                kind === 'nng' ? 'bg-accent text-accent-fg' : 'text-fg-muted hover:bg-bg-muted hover:text-fg-secondary'
              }`}
            >
              <Network size={11} />
              {t('memoryGraph.tab.nng')}
            </button>
            <button
              onClick={() => switchKind('cache')}
              className={`flex items-center gap-1.5 rounded px-2.5 py-1 text-[11px] font-medium transition-colors ${
                kind === 'cache' ? 'bg-accent text-accent-fg' : 'text-fg-muted hover:bg-bg-muted hover:text-fg-secondary'
              }`}
            >
              <Database size={11} />
              {t('memoryGraph.tab.cache')}
            </button>
          </div>

          <div className="hidden items-center gap-3 text-[10px] text-fg-muted sm:flex">
            {(Object.keys(GRAPH_TYPE_COLOR) as GraphNodeData['type'][]).map((ty) => (
              <span key={ty} className="flex items-center gap-1">
                <span className="h-2 w-2 rounded-full" style={{ background: GRAPH_TYPE_COLOR[ty] }} />
                {t(`memoryGraph.type.${ty}`)}
              </span>
            ))}
          </div>

          <span className="ml-auto hidden truncate text-[10px] text-fg-muted md:block">{t('memoryGraph.hint')}</span>
        </div>

        {/* 图谱画布 */}
        <div className="min-h-0 flex-1">
          <GraphView
            nodes={activeNodes ?? []}
            loading={activeNodes === null}
            emptyText={t('memoryGraph.empty')}
            selectedPath={selected?.kind === kind ? selected.path : null}
            onNodeClick={(path, name) => void openContent(path, name)}
            labels={{
              zoomIn: t('memoryGraph.zoomIn'),
              zoomOut: t('memoryGraph.zoomOut'),
              reset: t('memoryGraph.reset'),
              loading: t('memoryGraph.loading'),
              zoomFit: t('memoryGraph.zoomFit'),
              hint: t('memoryGraph.hint')
            }}
          />
        </div>

        {/* 节点 JSON 预览（点击图节点展开，可关闭） */}
        {selected && selected.kind === kind && (
          <div className="flex h-52 shrink-0 flex-col border-t border-border-subtle">
            <div className="flex items-center gap-2 border-b border-border-subtle px-4 py-1.5">
              <Braces size={12} className="shrink-0 text-fg-muted" />
              <span className="text-[10px] uppercase tracking-wider text-fg-muted">{t('memoryGraph.jsonPreview')}</span>
              <span className="truncate text-caption font-medium text-fg-secondary">{selected.name}</span>
              <button
                onClick={() => {
                  setSelected(null)
                  setJsonText(null)
                }}
                aria-label={t('memoryGraph.closePreview')}
                title={t('memoryGraph.closePreview')}
                className="ml-auto flex h-6 w-6 shrink-0 items-center justify-center rounded text-fg-muted hover:bg-bg-muted hover:text-fg-primary"
              >
                <X size={12} />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-auto bg-bg-muted/20 p-3">
              {jsonLoading || jsonText == null ? (
                <div className="text-caption text-fg-muted">{t('memoryGraph.loading')}</div>
              ) : (
                <pre className="whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed text-fg-primary">
                  {jsonText}
                </pre>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}