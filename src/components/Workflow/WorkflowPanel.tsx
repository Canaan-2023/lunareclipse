/**
 * 为什么存在：工作流引擎的模板管理此前只有 AI 工具（workflow_define/save/edit）与底部状态条（运行中实例），
 * 缺少一个面向用户的「管理现有工作流」界面。本面板补齐：列出模板、删除、新建、编辑模板名描述、
 * 编排节点与连线（增删节点/连线、重命名），并支持列表排序（本地顺序，不影响主进程真源）。
 * 作用：右侧抽屉承载，340px 轻量面板，与 Skill/Plugin/Cron 同级。
 */
import { useEffect, useState, useMemo } from 'react'
import {
  Workflow, Plus, Trash2, X, ChevronUp, ChevronDown, ArrowLeft, Folder, Check, Copy, Brain, Split, CornerDownLeft, Flag, Wrench, Sparkles, MessageSquare
} from 'lucide-react'
import { useAppStore } from '../../stores/appStore'
import { useWorkflowStore } from '../../stores/workflowStore'
import type { WorkflowTemplate, NodeType, WorkflowNode, WorkflowEdge, WorkflowMode } from '@shared/workflow/types'

/** 节点类型 → 图标（与 WorkflowStatusBar 视觉语言一致） */
const NODE_TYPE_ICONS: Record<NodeType, typeof Brain> = {
  llm: Brain,
  tool: Wrench,
  skill: Sparkles,
  condition: Split,
  human: MessageSquare,
  answer: CornerDownLeft,
  end: Flag
}

/** 节点类型 → 中文标签 */
const NODE_TYPE_LABELS: Record<NodeType, string> = {
  llm: 'LLM',
  tool: '工具',
  skill: 'SKILL',
  condition: '条件',
  human: '人工',
  answer: '回复',
  end: '结束'
}

/** 新建节点时的最小配置（按类型） */
function defaultNodeConfig(type: NodeType) {
  switch (type) {
    case 'llm': return { prompt: '', stream: true }
    case 'tool': return { toolId: '', args: {} }
    case 'skill': return { skillId: '' }
    case 'condition': return {}
    case 'human': return { prompt: '', inputType: 'text' }
    case 'answer': return { content: '' }
    case 'end': return { output: '' }
  }
}

/** 本地顺序 key：模板列表排序（前端偏好，模板真源在主进程，仅控制展示顺序） */
const ORDER_KEY = 'workflow:templateOrder'

/** 将模板列表按本地顺序排序：有 order 的按 order，无 order 的按 updatedAt 倒序排后 */
function sortTemplates(templates: WorkflowTemplate[], order: string[]): WorkflowTemplate[] {
  const orderIndex = new Map(order.map((id, i) => [id, i]))
  return [...templates].sort((a, b) => {
    const ia = orderIndex.get(a.id)
    const ib = orderIndex.get(b.id)
    if (ia !== undefined && ib !== undefined) return ia - ib
    if (ia !== undefined) return -1
    if (ib !== undefined) return 1
    return b.updatedAt - a.updatedAt
  })
}

/**
 * 工作流分类键：由 template.tags 推导（记忆/日记/安全/其他）。
 * 内置模板自带 tags（见 default-templates.ts），用户/AI 新建模板可打同款 tag 自动归组。
 */
export function groupKeyOf(t: WorkflowTemplate): string {
  const tags = t.tags ?? []
  if (tags.includes('记忆')) return '记忆'
  if (tags.includes('日记')) return '日记'
  if (tags.includes('安全')) return '安全'
  return '其他'
}

/** 分类展示顺序：记忆 → 日记 → 安全 → 其他 */
export const WORKFLOW_CATEGORY_ORDER = ['记忆', '日记', '安全', '其他'] as const

/** 分组结果 */
export interface WorkflowGroup {
  key: string
  label: string
  items: WorkflowTemplate[]
}

/** 把模板列表按分类键分组（保持组内原有顺序，空组不输出） */
export function groupTemplates(templates: WorkflowTemplate[]): WorkflowGroup[] {
  const byKey = new Map<string, WorkflowTemplate[]>()
  for (const t of templates) {
    const k = groupKeyOf(t)
    const list = byKey.get(k)
    if (list) list.push(t)
    else byKey.set(k, [t])
  }
  const groups: WorkflowGroup[] = []
  for (const key of WORKFLOW_CATEGORY_ORDER) {
    const items = byKey.get(key)
    if (items && items.length > 0) groups.push({ key, label: `${key}工作流`, items })
  }
  return groups
}

/** 生成形如 wf_node_xxxx 的节点 id */
function genNodeId(): string {
  return `wf_node_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
}

/**
 * 判断某节点是否为起始节点：显式 startNode 优先；
 * 未显式指定时，无任何入边的节点即起始（与引擎 startInstance 的推导一致）。
 */
function isStartNode(tpl: WorkflowTemplate, nodeId: string): boolean {
  if (tpl.startNode) return tpl.startNode === nodeId
  return tpl.nodes.length > 0
    && !tpl.edges.some((e) => e.to === nodeId)
}

export function WorkflowPanel() {
  const closeDrawer = useAppStore((s) => s.closeDrawer)
  const templates = useWorkflowStore((s) => s.templates)
  const templatesLoaded = useWorkflowStore((s) => s.templatesLoaded)
  const refreshTemplates = useWorkflowStore((s) => s.refreshTemplates)
  const saveTemplate = useWorkflowStore((s) => s.saveTemplate)
  const deleteTemplate = useWorkflowStore((s) => s.deleteTemplate)
  const exportTemplate = useWorkflowStore((s) => s.exportTemplate)
  const importTemplate = useWorkflowStore((s) => s.importTemplate)

  // 视图状态：'list'（模板列表）| 'create'（新建表单）| 'detail'（选中模板详情/编排）
  const [view, setView] = useState<'list' | 'create' | 'detail'>('list')
  const [selected, setSelected] = useState<WorkflowTemplate | null>(null)
  // 本地排序
  const [order, setOrder] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem(ORDER_KEY)
      return raw ? (JSON.parse(raw) as string[]) : []
    } catch {
      return []
    }
  })
  const persistOrder = (next: string[]) => {
    setOrder(next)
    try {
      localStorage.setItem(ORDER_KEY, JSON.stringify(next))
    } catch {
      // 忽略 localStorage 失败（隐私模式等），仅影响展示顺序
    }
  }
  // 新建表单
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [mode, setMode] = useState<WorkflowMode>('workflow')
  const [error, setError] = useState('')

  useEffect(() => {
    if (!templatesLoaded) void refreshTemplates()
    // 关闭面板时同步一次模板（期间可能被他人/AI 修改）
    return () => {
      void refreshTemplates()
    }
  }, [refreshTemplates, templatesLoaded])

  const sorted = useMemo(() => sortTemplates(templates, order), [templates, order])

  // 选中模板后本地保留一份副本用于详情编辑，避免直接改 store 引用
  const openDetail = (t: WorkflowTemplate) => {
    setSelected(structuredClone(t))
    setView('detail')
    setError('')
  }

  /** 组内移动：目标模板与其同组相邻项交换，不跨组（分类由 tags 决定，跨组无意义） */
  const moveInGroup = (targetId: string, dir: -1 | 1) => {
    const idx = sorted.findIndex((t) => t.id === targetId)
    if (idx < 0) return
    const target = idx + dir
    if (target < 0 || target >= sorted.length) return
    if (groupKeyOf(sorted[idx]) !== groupKeyOf(sorted[target])) return
    const next = [...sorted]
    const [item] = next.splice(idx, 1)
    next.splice(target, 0, item)
    persistOrder(next.map((t) => t.id))
  }

  /** 组内上移/下移是否可用（边界=组内首/末项） */
  const canMoveInGroup = (t: WorkflowTemplate, dir: -1 | 1): boolean => {
    const idx = sorted.findIndex((x) => x.id === t.id)
    if (idx < 0) return false
    const target = sorted[idx + dir]
    return !!target && groupKeyOf(target) === groupKeyOf(t)
  }

  const handleCreate = async () => {
    setError('')
    const n = name.trim()
    if (!n) { setError('模板名称不能为空'); return }
    // 新建默认含一个起始节点（workflow→end / chatflow→answer），保证模板可直接运行
    const startType: NodeType = mode === 'chatflow' ? 'answer' : 'end'
    const t = await saveTemplate({
      name: n,
      description: description.trim(),
      mode,
      source: 'user',
      nodes: [{ id: 'start', type: startType, name: '开始', config: defaultNodeConfig(startType) }],
      edges: []
    })
    if (t) {
      setName('')
      setDescription('')
      setView('list')
    } else {
      setError('创建失败：主进程未返回模板')
    }
  }

  const handleDelete = async (t: WorkflowTemplate) => {
    if (!confirm(`删除工作流「${t.name}」？此操作不可撤销。`)) return
    await deleteTemplate(t.id)
    if (selected?.id === t.id) {
      setSelected(null)
      setView('list')
    }
  }

  const handleExport = async (t: WorkflowTemplate) => {
    const jsonStr = await exportTemplate(t.id)
    if (!jsonStr) { setError('导出失败'); return }
    try {
      await navigator.clipboard?.writeText(jsonStr)
      setError('已复制模板 JSON 到剪贴板')
    } catch {
      setError('导出成功，但剪贴板不可用')
    }
  }

  const handleImport = async () => {
    const jsonStr = prompt('粘贴工作流模板 JSON：')
    if (!jsonStr) return
    const t = await importTemplate(jsonStr)
    if (t) void refreshTemplates()
    else setError('导入失败：JSON 无法解析为模板')
  }

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-bg-surface">
      {/* 头部 */}
      <div className="flex items-center justify-between border-b border-border-subtle px-3 py-2">
        <div className="flex items-center gap-1.5 text-caption font-medium text-fg-secondary">
          {view === 'detail' ? (
            <button
              onClick={() => { setView('list'); setSelected(null) }}
              className="flex items-center gap-1 rounded-btn px-1 py-0.5 text-fg-muted hover:bg-bg-muted hover:text-fg-primary"
              title="返回列表"
              aria-label="返回工作流列表"
            >
              <ArrowLeft size={13} />
            </button>
          ) : (
            <Workflow size={13} className="text-accent" />
          )}
          {view === 'detail' ? selected?.name ?? '工作流详情' : '工作流'}
        </div>
        <div className="flex items-center gap-1">
          {view === 'list' && (
            <>
              <button
                onClick={handleImport}
                className="flex items-center gap-1 rounded-btn bg-bg-muted px-2 py-1 text-[11px] text-fg-secondary hover:bg-bg-muted/70"
                title="导入模板 JSON"
              >
                <Folder size={11} />
                导入
              </button>
              <button
                onClick={() => { setView('create'); setError('') }}
                className="flex items-center gap-1 rounded-btn bg-accent/15 px-2 py-1 text-[11px] text-accent hover:bg-accent/25"
              >
                <Plus size={11} />
                新增
              </button>
            </>
          )}
          <button
            onClick={closeDrawer}
            className="flex h-6 w-6 items-center justify-center rounded-btn text-fg-muted hover:bg-bg-muted hover:text-fg-primary"
            title="关闭"
            aria-label="关闭工作流面板"
          >
            <X size={12} />
          </button>
        </div>
      </div>

      {/* 新建表单 */}
      {view === 'create' && (
        <div className="border-b border-border-subtle bg-bg-base/50 p-3">
          <div className="mb-2">
            <label className="mb-1 block text-[10px] text-fg-muted">名称</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="如：日报生成"
              className="w-full rounded-btn border border-border bg-bg-elevated px-2 py-1 text-caption text-fg-primary placeholder:text-fg-muted focus:outline-none focus:border-accent/50"
            />
          </div>
          <div className="mb-2">
            <label className="mb-1 block text-[10px] text-fg-muted">描述</label>
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="（可选）"
              className="w-full rounded-btn border border-border bg-bg-elevated px-2 py-1 text-caption text-fg-primary placeholder:text-fg-muted focus:outline-none focus:border-accent/50"
            />
          </div>
          <div className="mb-2 flex items-center gap-2">
            {(['workflow', 'chatflow'] as WorkflowMode[]).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={`flex-1 rounded-btn border px-2 py-1 text-caption transition-colors ${
                  mode === m
                    ? 'border-accent/50 bg-accent/10 text-accent'
                    : 'border-border text-fg-muted hover:bg-bg-muted'
                }`}
              >
                {m === 'workflow' ? '一次性工作流' : '对话流'}
              </button>
            ))}
          </div>
          {error && <div className="mb-2 text-caption text-red-400">{error}</div>}
          <button
            onClick={handleCreate}
            className="flex w-full items-center justify-center gap-1 rounded-btn bg-accent px-2 py-1.5 text-caption text-accent-fg hover:bg-accent/80 active:scale-95"
          >
            <Check size={12} />
            创建模板
          </button>
        </div>
      )}

      {/* 详情/编排 */}
      {view === 'detail' && selected && (
        <WorkflowDetail
          template={selected}
          onChange={(next) => setSelected(next)}
          onRemove={handleDelete}
          onExport={handleExport}
        />
      )}

      {/* 模板列表（按分类分组陈列：记忆/日记/安全/其他） */}
      {view === 'list' && (
        <div className="flex-1 overflow-y-auto">
          {sorted.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 px-4 py-10 text-center">
              <Workflow size={20} className="text-fg-muted/50" />
              <span className="text-caption text-fg-muted">暂无工作流模板</span>
              <button
                onClick={() => { setView('create'); setError('') }}
                className="mt-1 flex items-center gap-1 rounded-btn bg-accent/15 px-3 py-1 text-caption text-accent hover:bg-accent/25"
              >
                <Plus size={11} />
                新建第一个工作流
              </button>
            </div>
          ) : (
            groupTemplates(sorted).map((group) => (
              <div key={group.key}>
                {/* 分组标题 */}
                <div className="sticky top-0 z-10 flex items-center gap-1.5 border-b border-border-subtle bg-bg-surface px-3 py-1.5">
                  <span className="text-[10px] font-medium uppercase tracking-wide text-fg-muted">{group.label}</span>
                  <span className="rounded bg-bg-muted px-1 text-[9px] text-fg-muted">{group.items.length}</span>
                </div>
                {group.items.map((t) => (
                  <div
                    key={t.id}
                    className="group flex items-start gap-1 border-b border-border-subtle px-3 py-2 transition-colors hover:bg-bg-muted/40"
                  >
                    {/* 排序手柄（组内移动） */}
                    <div className="flex w-5 shrink-0 flex-col items-center pt-1">
                      <button
                        onClick={() => moveInGroup(t.id, -1)}
                        disabled={!canMoveInGroup(t, -1)}
                        className="flex h-3.5 w-5 items-center justify-center rounded text-fg-muted/60 hover:text-accent disabled:opacity-20 disabled:hover:text-fg-muted/60"
                        title="组内上移"
                        aria-label={`上移${t.name}`}
                      >
                        <ChevronUp size={11} />
                      </button>
                      <button
                        onClick={() => moveInGroup(t.id, 1)}
                        disabled={!canMoveInGroup(t, 1)}
                        className="flex h-3.5 w-5 items-center justify-center rounded text-fg-muted/60 hover:text-accent disabled:opacity-20 disabled:hover:text-fg-muted/60"
                        title="组内下移"
                        aria-label={`下移${t.name}`}
                      >
                        <ChevronDown size={11} />
                      </button>
                    </div>

                    <button
                      onClick={() => openDetail(t)}
                      className="min-w-0 flex-1 text-left"
                    >
                      <div className="flex items-center gap-1.5">
                        <span className="truncate text-caption font-medium text-fg-primary">{t.name}</span>
                        <span className={`shrink-0 rounded px-1 py-0.5 text-[9px] ${
                          t.mode === 'chatflow' ? 'bg-accent/10 text-accent' : 'bg-bg-muted text-fg-muted'
                        }`}>
                          {t.mode === 'chatflow' ? '对话流' : '一次性'}
                        </span>
                        {t.source && (
                          <span className="shrink-0 rounded bg-bg-muted px-1 py-0.5 text-[9px] text-fg-muted">
                            {t.source === 'default' ? '内置' : t.source === 'ai' ? 'AI 编排' : t.source === 'imported' ? '导入' : '用户'}
                          </span>
                        )}
                      </div>
                      <div className="mt-0.5 truncate text-[11px] text-fg-muted">
                        {t.description || (t.nodes.length === 0 ? '（无节点）' : `${t.nodes.length} 个节点 · ${t.edges.length} 条连线`)}
                      </div>
                    </button>

                    <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                      <button
                        onClick={() => void handleExport(t)}
                        className="flex h-6 w-6 items-center justify-center rounded-btn text-fg-muted hover:bg-bg-muted hover:text-fg-primary"
                        title="导出 JSON 到剪贴板"
                        aria-label={`导出${t.name}`}
                      >
                        <Copy size={11} />
                      </button>
                      <button
                        onClick={() => void handleDelete(t)}
                        className="flex h-6 w-6 items-center justify-center rounded-btn text-fg-muted hover:bg-red-500/15 hover:text-red-400"
                        title="删除"
                        aria-label={`删除${t.name}`}
                      >
                        <Trash2 size={11} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            ))
          )}
        </div>
      )}

      {/* 底部错误提示条 */}
      {error && view === 'list' && (
        <div className="border-t border-border-subtle px-3 py-1.5 text-caption text-fg-muted">{error}</div>
      )}
    </div>
  )
}

/** 详情/编排视图：查看与修改模板的节点和连线 */
function WorkflowDetail({
  template,
  onChange,
  onRemove,
  onExport
}: {
  template: WorkflowTemplate
  onChange: (t: WorkflowTemplate) => void
  onRemove: (t: WorkflowTemplate) => void
  onExport: (t: WorkflowTemplate) => void
}) {
  const editTemplate = useWorkflowStore((s) => s.editTemplate)
  const refreshTemplates = useWorkflowStore((s) => s.refreshTemplates)
  // 新增节点表单
  const [newType, setNewType] = useState<NodeType>('llm')
  const [newNodeName, setNewNodeName] = useState('')
  // 新增连线表单
  const [edgeFrom, setEdgeFrom] = useState('')
  const [edgeTo, setEdgeTo] = useState('')
  const [edgeCond, setEdgeCond] = useState('')
  // 重命名表单
  const [editName, setEditName] = useState(template.name)
  const [editDesc, setEditDesc] = useState(template.description)
  const [error, setError] = useState('')

  const nodeIds = template.nodes.map((n) => n.id)

  // 模板被外部更新后同步（编辑名称描述时本地表单保持用户输入）
  useEffect(() => {
    setEditName(template.name)
    setEditDesc(template.description)
  }, [template.id, template.name, template.description])

  const applyEdit = async (op: Parameters<typeof editTemplate>[0]) => {
    const res = await editTemplate(op)
    if (res) {
      onChange(res)
      void refreshTemplates()
      setError('')
    } else {
      setError('操作失败：主进程未返回更新后的模板')
    }
  }

  const addNode = async () => {
    const node: WorkflowNode = {
      id: genNodeId(),
      type: newType,
      name: newNodeName.trim() || NODE_TYPE_LABELS[newType],
      config: defaultNodeConfig(newType)
    }
    await applyEdit({ templateId: template.id, action: 'add_node', payload: node as unknown as Record<string, unknown> })
    setNewNodeName('')
  }

  const removeNode = async (nodeId: string) => {
    if (!confirm(`删除节点「${nodeId}」及其连线？`)) return
    await applyEdit({ templateId: template.id, action: 'remove_node', payload: { nodeId } })
  }

  const addEdge = async () => {
    if (!edgeFrom || !edgeTo) { setError('请选择起点和终点节点'); return }
    if (edgeFrom === edgeTo) { setError('起点与终点不能相同'); return }
    const edge: WorkflowEdge = { from: edgeFrom, to: edgeTo }
    if (edgeCond.trim()) edge.condition = edgeCond.trim()
    await applyEdit({ templateId: template.id, action: 'add_edge', payload: edge as unknown as Record<string, unknown> })
    setEdgeTo('')
    setEdgeCond('')
  }

  const removeEdge = async (from: string, to: string) => {
    await applyEdit({ templateId: template.id, action: 'remove_edge', payload: { from, to } })
  }

  const saveMeta = async () => {
    const n = editName.trim()
    if (!n) { setError('模板名称不能为空'); return }
    await applyEdit({
      templateId: template.id,
      action: 'rename',
      payload: { name: n, description: editDesc.trim() }
    })
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex-1 overflow-y-auto">
        {/* 元信息编辑 */}
        <div className="border-b border-border-subtle p-3">
          <label className="mb-1 block text-[10px] text-fg-muted">名称</label>
          <input
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            className="mb-2 w-full rounded-btn border border-border bg-bg-elevated px-2 py-1 text-caption text-fg-primary focus:outline-none focus:border-accent/50"
          />
          <label className="mb-1 block text-[10px] text-fg-muted">描述</label>
          <input
            value={editDesc}
            onChange={(e) => setEditDesc(e.target.value)}
            className="mb-2 w-full rounded-btn border border-border bg-bg-elevated px-2 py-1 text-caption text-fg-primary focus:outline-none focus:border-accent/50"
          />
          <button
            onClick={saveMeta}
            className="flex w-full items-center justify-center gap-1 rounded-btn bg-accent/15 px-2 py-1 text-caption text-accent hover:bg-accent/25 active:scale-95"
          >
            <Check size={11} />
            保存修改
          </button>
        </div>

        {/* 节点列表 */}
        <div className="border-b border-border-subtle p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[10px] font-medium uppercase tracking-wider text-fg-muted">节点（{template.nodes.length}）</span>
          </div>
          {template.nodes.length === 0 ? (
            <div className="py-2 text-center text-caption text-fg-muted">暂无节点，请在下方添加</div>
          ) : (
            <div className="space-y-1">
              {template.nodes.map((n) => {
                const Icon = NODE_TYPE_ICONS[n.type] ?? Brain
                const isStart = isStartNode(template, n.id)
                return (
                  <div key={n.id} className="group flex items-center gap-1.5 rounded-btn bg-bg-muted/60 px-2 py-1.5">
                    <Icon size={11} className="shrink-0 text-fg-muted" />
                    <span className="min-w-0 flex-1 truncate text-caption text-fg-primary" title={n.id}>
                      {n.name}
                      <span className="ml-1 text-[10px] text-fg-muted/70">{n.type}</span>
                    </span>
                    {isStart && (
                      <span className="shrink-0 rounded bg-accent/10 px-1 py-0.5 text-[9px] text-accent">起始</span>
                    )}
                    <button
                      onClick={() => void removeNode(n.id)}
                      className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-fg-muted opacity-0 transition-opacity hover:text-red-400 group-hover:opacity-100"
                      title="删除节点"
                      aria-label={`删除节点${n.name}`}
                    >
                      <Trash2 size={10} />
                    </button>
                  </div>
                )
              })}
            </div>
          )}
          {/* 添加节点 */}
          <div className="mt-2 flex items-center gap-1.5">
            <select
              value={newType}
              onChange={(e) => setNewType(e.target.value as NodeType)}
              className="h-7 shrink-0 rounded-btn border border-border bg-bg-elevated px-1.5 text-caption text-fg-primary focus:outline-none focus:border-accent/50"
              title="节点类型"
            >
              {(Object.keys(NODE_TYPE_LABELS) as NodeType[]).map((t) => (
                <option key={t} value={t}>{NODE_TYPE_LABELS[t]}</option>
              ))}
            </select>
            <input
              value={newNodeName}
              onChange={(e) => setNewNodeName(e.target.value)}
              placeholder="节点名（可选）"
              className="h-7 min-w-0 flex-1 rounded-btn border border-border bg-bg-elevated px-2 text-caption text-fg-primary placeholder:text-fg-muted focus:outline-none focus:border-accent/50"
              onKeyDown={(e) => { if (e.key === 'Enter') void addNode() }}
            />
            <button
              onClick={() => void addNode()}
              className="flex h-7 shrink-0 items-center gap-1 rounded-btn bg-accent/15 px-2 text-caption text-accent hover:bg-accent/25"
              title="添加节点"
            >
              <Plus size={11} />
            </button>
          </div>
        </div>

        {/* 连线列表 */}
        <div className="border-b border-border-subtle p-3">
          <span className="mb-2 block text-[10px] font-medium uppercase tracking-wider text-fg-muted">连线（{template.edges.length}）</span>
          {template.edges.length === 0 ? (
            <div className="py-2 text-center text-caption text-fg-muted">暂无连线，请在下方添加</div>
          ) : (
            <div className="space-y-1">
              {template.edges.map((e, i) => (
                <div key={`${e.from}->${e.to}-${i}`} className="flex items-center gap-1.5 rounded-btn bg-bg-muted/60 px-2 py-1">
                  <span className="min-w-0 flex-1 truncate text-caption text-fg-primary">
                    <span className="text-fg-muted">{e.from}</span>
                    <span className="mx-1 text-fg-muted/60">→</span>
                    <span>{e.to}</span>
                    {e.condition && <span className="ml-1 text-[10px] text-accent">[{e.condition}]</span>}
                  </span>
                  <button
                    onClick={() => void removeEdge(e.from, e.to)}
                    className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-fg-muted opacity-0 transition-opacity hover:text-red-400 group-hover:opacity-100"
                    title="删除连线"
                    aria-label={`删除连线${e.from}到${e.to}`}
                  >
                    <Trash2 size={10} />
                  </button>
                </div>
              ))}
            </div>
          )}
          {/* 添加连线 */}
          <div className="mt-2 space-y-1.5">
            <div className="flex items-center gap-1.5">
              <select
                value={edgeFrom}
                onChange={(e) => setEdgeFrom(e.target.value)}
                className="h-7 min-w-0 flex-1 rounded-btn border border-border bg-bg-elevated px-1.5 text-caption text-fg-primary focus:outline-none focus:border-accent/50"
                title="起点节点"
              >
                <option value="">起点…</option>
                {nodeIds.map((id) => <option key={id} value={id}>{id}</option>)}
              </select>
              <span className="text-fg-muted/60">→</span>
              <select
                value={edgeTo}
                onChange={(e) => setEdgeTo(e.target.value)}
                className="h-7 min-w-0 flex-1 rounded-btn border border-border bg-bg-elevated px-1.5 text-caption text-fg-primary focus:outline-none focus:border-accent/50"
                title="终点节点"
              >
                <option value="">终点…</option>
                {nodeIds.map((id) => <option key={id} value={id}>{id}</option>)}
              </select>
            </div>
            <input
              value={edgeCond}
              onChange={(e) => setEdgeCond(e.target.value)}
              placeholder="条件表达式（可选，仅条件节点出边）"
              className="h-7 w-full rounded-btn border border-border bg-bg-elevated px-2 text-caption text-fg-primary placeholder:text-fg-muted focus:outline-none focus:border-accent/50"
              onKeyDown={(e) => { if (e.key === 'Enter') void addEdge() }}
            />
            <button
              onClick={() => void addEdge()}
              className="flex w-full items-center justify-center gap-1 rounded-btn bg-accent/15 px-2 py-1 text-caption text-accent hover:bg-accent/25"
            >
              <Plus size={11} />
              添加连线
            </button>
          </div>
        </div>

        {error && <div className="px-3 py-2 text-caption text-red-400">{error}</div>}
      </div>

      {/* 底部操作 */}
      <div className="flex items-center gap-2 border-t border-border-subtle px-3 py-2">
        <button
          onClick={() => void onExport(template)}
          className="flex flex-1 items-center justify-center gap-1 rounded-btn bg-bg-muted px-2 py-1.5 text-caption text-fg-secondary hover:bg-bg-muted/70"
        >
          <Copy size={11} />
          导出
        </button>
        <button
          onClick={() => onRemove(template)}
          className="flex flex-1 items-center justify-center gap-1 rounded-btn bg-red-500/10 px-2 py-1.5 text-caption text-red-400 hover:bg-red-500/20"
        >
          <Trash2 size={11} />
          删除模板
        </button>
      </div>
    </div>
  )
}