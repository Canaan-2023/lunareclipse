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
import {
  useEffect,
  useMemo,
  useState
} from 'react'
import {
  ListTree,
  Plus,
  X,
  Settings2
} from 'lucide-react'
import { DEFAULT_AI_ID } from '@shared/types'
import { useAppStore } from '../../stores/appStore'
import { useT } from '../../i18n/useT'
import { buildSessionTree } from './session-chains'
// ADR-27 拆分：画布 / 卡片 / 详情 / 表单 / 配置卡 已外移至 ./internal-sessions/。
import { TreeCanvas } from './internal-sessions/TreeCanvas'
import { CreateForm } from './internal-sessions/CreateForm'
import { DetailView } from './internal-sessions/DetailView'
import { SessionBudgetCard } from './internal-sessions/SessionBudgetCard'
// ADR-30 R3：归属切换器（看当前会话的树，还是看房间/自主的树）。
import { OwnerSwitcher, type TreeOwner } from './internal-sessions/OwnerSwitcher'
// 渲染探针（test/internal-sessions-view-render.test.tsx）仍从本入口导入 TreeCanvas：导出面保持不变。
export { TreeCanvas } from './internal-sessions/TreeCanvas'

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

export function InternalSessionsView({ sessionId }: { sessionId: string }) {
  const t = useT()
  const list = useAppStore((s) => s.internalSessions)
  const active = useAppStore((s) => s.activeInternalSession)
  // AI 当前承接的内部会话 id（session_select 设置的 active 指针；与上面「点开的详情」不同）
  const activeInternalId = useAppStore((s) => s.activeInternalId)
  const loadInternalSessions = useAppStore((s) => s.loadInternalSessions)
  const createInternalSession = useAppStore((s) => s.createInternalSession)
  const setActiveInternalSession = useAppStore((s) => s.setActiveInternalSession)
  const sessions = useAppStore((s) => s.sessions)
  const [creating, setCreating] = useState(false)
  // 详情报错提示：getInternalSession IPC 读取失败时展示原因，避免点开无响应
  const [error, setError] = useState<string | null>(null)
  // 会话上限配置小卡片展开标记
  const [budgetOpen, setBudgetOpen] = useState(false)

  // ===== 归属（ADR-30 R3）：看当前会话的树，还是看房间（自主）的树 =====
  // 房间自持会话 id 由主进程给出（`room:status` / `room:state-changed`）——**不在渲染侧拼 id**：
  // 格式真源是主进程的 `roomSessionId()`，拼一份必然漂移。
  const aiId = sessions.find((s) => s.id === sessionId)?.aiId ?? DEFAULT_AI_ID
  const [owner, setOwner] = useState<TreeOwner>('current')
  const [roomSessionId, setRoomSessionId] = useState<string | null>(null)
  useEffect(() => {
    const api = window.lunareclipse
    let alive = true
    // 挂载时读一次（房间可能早就在跑）；此后靠推送——**不轮询**（与 0.52.73 的口径一致）
    void api?.roomStatus?.(aiId).then((r) => {
      if (alive) setRoomSessionId(r?.status?.sessionId ?? null)
    })
    const off = api?.onRoomState?.((payload) => {
      if (payload.aiId !== aiId) return
      const st = payload.state as { sessionId?: unknown } | undefined
      if (typeof st?.sessionId === 'string' && st.sessionId) setRoomSessionId(st.sessionId)
    })
    return () => {
      alive = false
      off?.()
    }
  }, [aiId])
  // 房间不存在 → 回落到当前会话（切换器本身也不渲染，双保险防「切到空的房间树」）
  const roomAvailable = roomSessionId !== null
  const effectiveOwner: TreeOwner = owner === 'room' && roomAvailable ? 'room' : 'current'
  const ownerSessionId = effectiveOwner === 'room' && roomSessionId ? roomSessionId : sessionId

  // 切换归属：刷新列表并关闭详情
  useEffect(() => {
    void loadInternalSessions(ownerSessionId)
    setActiveInternalSession(null)
    setCreating(false)
    setBudgetOpen(false)
  }, [ownerSessionId, loadInternalSessions, setActiveInternalSession])

  // buildSessionTree 纯函数组装「继承 × 时间 × 新话题」三边森林；useMemo 依赖 list，
  // 避免每次渲染重建树（坐标计算 O(n²)，会话多时不应在无变化时重复执行）
  const trees = useMemo(() => buildSessionTree(list), [list])

  const openDetail = async (internalId: string) => {
    try {
      const detail = await window.lunareclipse.getInternalSession(ownerSessionId, internalId)
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
          {/* 归属切换（ADR-30 R3）：房间跑过才有第二棵树，故房间不可用时整块不渲染 */}
          <OwnerSwitcher owner={effectiveOwner} roomAvailable={roomAvailable} onSelect={setOwner} />
          <span className="rounded-full bg-bg-muted/60 px-2 py-0.5 text-caption text-fg-muted">
            {effectiveOwner === 'room'
              ? t('view.treeRoomCount', { count: list.length })
              : t('view.treeCount', { count: list.length })}
          </span>
          <div className="ml-auto flex items-center gap-1.5">
            <button
              onClick={() => void loadInternalSessions(ownerSessionId)}
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
                await createInternalSession(ownerSessionId, title, content)
                setCreating(false)
              }}
            />
          </div>
        </div>
      )}

      {/* 详情视图 */}
      {active ? (
        <DetailView
          sessionId={ownerSessionId}
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
                    <span className="text-body font-medium">
                      {effectiveOwner === 'room' ? t('view.treeRoomEmpty') : t('view.treeEmpty')}
                    </span>
                  </div>
                  <div className="max-w-md text-caption leading-relaxed text-fg-muted/70">
                    {effectiveOwner === 'room' ? (
                      t('view.treeRoomEmptyDesc')
                    ) : (
                      <>
                        {t('view.treeEmptyHint')}
                        <span className="mt-0.5 block">{t('view.treeEmptyDesc')}</span>
                      </>
                    )}
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
                sessionId={ownerSessionId}
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

