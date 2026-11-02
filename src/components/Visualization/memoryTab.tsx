/**
 * 为什么存在：记忆体系按分类文件夹组织（六分类懒加载），多 AI 各有其记忆，
 * 需要独立 Tab 呈现树形浏览（批次 E-5c 拆分产物）。
 * 作用：渲染记忆系统 Tab——分类文件夹树（懒加载展开）、文件预览列表，
 * 切换器按 AIID 动态渲染全部启用 AI。
 */
import { useEffect, useMemo, useState } from 'react'
import { FolderTree, Folder, FolderOpen, FileText, ChevronRight, ListTree, Network } from 'lucide-react'
import { useAppStore } from '../../stores/appStore'
import { aiAvatarFallback } from '../Ai/AiManagerPanel'
import { openFilePreview } from '../Workshop/filePreviewOpener'
import type { MemoryDirectoryNode } from '@shared/types'
import { SectionTitle } from './common'
import { useT } from '../../i18n/useT'

/** 记忆文件列表项（对应后端 viz:memoryTab 的 memories 字段，类型同 visualization-data.listMemories） */
interface MemoryListItem {
  name: string
  path: string
  type: 'normal' | 'meta' | 'high'
  size: number
  mtime: string
}

/** NNG 树节点（对应后端 viz:memoryTab 的 nngTree 字段，类型同 visualization-data.readNngTree） */
interface NngTreeNode {
  name: string
  path: string
  type: 'standard' | 'meta' | 'high'
  children: NngTreeNode[]
  jsonFile: string | null
}

/** 记忆系统 Tab（批次 E-5c 从 VisualizationPanel.tsx 拆出） */

/**
 * 记忆 tab：只显示分类文件夹树（六分类懒加载），
 * 移除 normal/meta/high 混排的「记忆文件」列表——文件按分类文件夹组织，点开才扫。
 * 多 AI：切换器按 AIID 动态渲染全部启用 AI，各看各的记忆体系
 */
export function MemoryTab() {
  const [tree, setTree] = useState<MemoryDirectoryNode[] | null>(null)
  const [memories, setMemories] = useState<MemoryListItem[] | null>(null)
  const [nngTree, setNngTree] = useState<NngTreeNode[] | null>(null)
  const [aiId, setAiId] = useState<number>(1)
  const aiName = useAppStore((s) => s.config.aiName) || '月蚀'
  const ais = useAppStore((s) => s.ais)
  const currentAiId = useAppStore((s) => s.currentAiId)
  const t = useT()

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

  useEffect(() => {
    let alive = true
    setTree(null)
    setMemories(null)
    setNngTree(null)
    void window.lunareclipse?.vizMemoryTab?.(aiId).then((d) => {
      if (!alive || !d) return
      const data = d as {
        directoryTree?: MemoryDirectoryNode[]
        memories?: MemoryListItem[]
        nngTree?: NngTreeNode[]
      } | null
      if (Array.isArray(data?.directoryTree)) setTree(data.directoryTree)
      if (Array.isArray(data?.memories)) setMemories(data.memories)
      if (Array.isArray(data?.nngTree)) setNngTree(data.nngTree)
    })
    return () => { alive = false }
  }, [aiId])

  if (!tree) return <div className="text-caption text-fg-muted">{t('vizui.memory.loadingData')}</div>

  return (
    <div className="space-y-5">
      <section>
        <SectionTitle icon={FolderTree} title={t('vizui.memory.structureTitle')} />
        {/* AI 切换器（多 AI：按 AIID 动态渲染，各看各的） */}
        <div className="mb-2 flex items-center gap-1 rounded-btn border border-border-subtle bg-bg-muted/30 p-1">
          {switchable.map((a) => (
            <button
              key={a.id}
              onClick={() => setAiId(a.id)}
              className={`flex-1 rounded px-2 py-1 text-[11px] font-medium transition-colors ${
                aiId === a.id ? 'bg-accent text-accent-fg' : 'text-fg-muted hover:bg-bg-muted hover:text-fg-secondary'
              }`}
            >
              <span className="mr-1">{a.avatar ?? aiAvatarFallback(a.id)}</span>
              {t('vizui.memory.aiSuffix', { name: a.name, id: a.id })}
            </button>
          ))}
        </div>
        <p className="mb-2 text-caption text-fg-secondary">
          {t('vizui.memory.structureDesc')}
        </p>
        <div className="max-h-[calc(100vh-300px)] space-y-0.5 overflow-y-auto rounded-btn border border-border-subtle bg-bg-muted/30 p-2">
          {tree.map((node, i) => (
            <DirTreeNode key={`${aiId}_${i}`} node={node} depth={0} />
          ))}
        </div>
      </section>

      {/* 记忆文件列表：后端 viz:memoryTab.memories 已递归扫好 normal/meta/high 三类文件，直接展示 */}
      <section>
        <SectionTitle icon={ListTree} title={t('vizui.memory.filesTitle')} />
        <div className="max-h-[260px] space-y-0.5 overflow-y-auto rounded-btn border border-border-subtle bg-bg-muted/30 p-2">
          {memories === null ? (
            <div className="text-[10px] text-fg-muted">{t('vizui.memory.loading')}</div>
          ) : memories.length === 0 ? (
            <div className="text-[10px] text-fg-muted">{t('vizui.memory.noFiles')}</div>
          ) : (
            memories.map((m, i) => <MemoryFileRow key={`${aiId}_${m.path}_${i}`} item={m} />)
          )}
        </div>
      </section>

      {/* NNG 树：后端 viz:memoryTab.nngTree 已展开最多 3 层，节点即 _nng.json 文件，点击右侧按钮打开 JSON */}
      <section>
        <SectionTitle icon={Network} title={t('vizui.memory.nngTitle')} />
        <div className="max-h-[300px] space-y-0.5 overflow-y-auto rounded-btn border border-border-subtle bg-bg-muted/30 p-2">
          {nngTree === null ? (
            <div className="text-[10px] text-fg-muted">{t('vizui.memory.loading')}</div>
          ) : nngTree.length === 0 ? (
            <div className="text-[10px] text-fg-muted">{t('vizui.memory.noNng')}</div>
          ) : (
            nngTree.map((node, i) => <NngTreeNodeRow key={`${aiId}_${i}`} node={node} depth={0} />)
          )}
        </div>
      </section>
    </div>
  )
}

/** 文件夹树节点（可折叠，懒加载：目录展开时才拉取子层 viz:directoryChildren） */
function DirTreeNode({ node, depth }: { node: MemoryDirectoryNode; depth: number }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [children, setChildren] = useState<MemoryDirectoryNode[]>(node.children ?? [])
  const [loaded, setLoaded] = useState(node.loaded === true)
  const pad = { paddingLeft: `${depth * 14 + 4}px` }
  if (node.type === 'file') {
    // 行内有两个动作（打开预览 / 在文件夹中显示），不能用「button 内嵌带 onClick 的 span」：
    // span 无焦点语义，键盘与读屏无法触发第二个动作，且嵌套交互元素点击目标重叠。
    // 改为外层 div 挂两个兄弟 button（预览占满剩余宽度、文件夹图标独立按钮），
    // 布局与 hover 态保持不变，两个动作各自焦点可达。
    return (
      <div style={pad} className="flex w-full items-center gap-1.5">
        <button
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded px-1 py-0.5 text-left text-[11px] text-fg-primary hover:bg-bg-muted/60 transition-colors"
          title={t('vizui.common.openPath', { path: node.path })}
          onClick={() => openFilePreview(node.path)}
        >
          <FileText size={11} className="shrink-0 text-fg-muted" />
          <span className="truncate">{node.name}</span>
          {typeof node.size === 'number' && (
            <span className="ml-auto shrink-0 text-[9px] text-fg-muted">{(node.size / 1024).toFixed(1)}KB</span>
          )}
        </button>
        <button
          className="shrink-0 rounded p-0.5 text-fg-muted hover:bg-bg-muted hover:text-accent"
          title={t('vizui.common.revealInFolder', { path: node.path })}
          aria-label={t('vizui.common.revealInFolder', { path: node.path })}
          onClick={() => void window.lunareclipse.showItemInFolder(node.path)}
        >
          <FolderOpen size={10} />
        </button>
      </div>
    )
  }
  const toggle = async () => {
    if (!open && !loaded) {
      // 懒加载：只扫这一层
      const res = await window.lunareclipse?.vizDirectoryChildren?.(node.path)
      if (Array.isArray(res)) {
        setChildren(res)
        setLoaded(true)
      }
    }
    setOpen(!open)
  }
  return (
    <div>
      <button
        style={pad}
        className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left text-[11px] font-medium text-fg-primary hover:bg-bg-muted/60 transition-colors"
        onClick={() => void toggle()}
      >
        <ChevronRight size={11} className={`shrink-0 text-fg-muted transition-transform ${open ? 'rotate-90' : ''}`} />
        <Folder size={11} className="shrink-0 text-fg-muted" />
        <span className="truncate">{node.name}</span>
        <span className="ml-auto shrink-0 text-[9px] text-fg-muted">
          {loaded ? children.length : node.hasMore === false ? 0 : '…'}
        </span>
      </button>
      {open &&
        (loaded ? (
          <div>
            {children.length === 0 ? (
              <div style={pad} className="text-[10px] text-fg-muted">{t('vizui.memory.emptyDir')}</div>
            ) : (
              children.map((child, i) => <DirTreeNode key={i} node={child} depth={depth + 1} />)
            )}
          </div>
        ) : (
          <div style={pad} className="text-[10px] text-fg-muted">{t('vizui.memory.loading')}</div>
        ))}
    </div>
  )
}

/** 记忆文件行（普通/元认知/高阶）：类型徽标 + 名称 + 大小 + 日期，点击在文件工坊打开只读预览 */
function MemoryFileRow({ item }: { item: MemoryListItem }) {
  const t = useT()
  const typeLabel = item.type === 'normal' ? t('vizui.memory.type.normal') : item.type === 'meta' ? t('vizui.memory.type.meta') : t('vizui.memory.type.high')
  const typeCls =
    item.type === 'normal'
      ? 'bg-sky-500/10 text-sky-400'
      : item.type === 'meta'
        ? 'bg-violet-500/10 text-violet-400'
        : 'bg-warning/10 text-warning'
  return (
    <button
      className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left text-[11px] text-fg-primary hover:bg-bg-muted/60 transition-colors"
      title={t('vizui.common.openPath', { path: item.path })}
      onClick={() => openFilePreview(item.path)}
    >
      <FileText size={11} className="shrink-0 text-fg-muted" />
      <span className={`shrink-0 rounded px-1 py-px text-[9px] ${typeCls}`}>{typeLabel}</span>
      <span className="truncate">{item.name}</span>
      <span className="ml-auto shrink-0 text-[9px] text-fg-muted">{(item.size / 1024).toFixed(1)}KB</span>
      <span className="shrink-0 text-[9px] text-fg-muted">{new Date(item.mtime).toLocaleDateString()}</span>
    </button>
  )
}

/** NNG 树节点（最多 3 层，节点即 _nng.json 文件）：
 * 主按钮展开/收起子节点（无子节点时直接打开文件），右侧独立按钮打开该节点 JSON。
 * 与目录树同一交互模式：外层 div 挂两个兄弟 button，各自焦点可达。 */
function NngTreeNodeRow({ node, depth }: { node: NngTreeNode; depth: number }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const pad = { paddingLeft: `${depth * 14 + 4}px` }
  const hasChildren = node.children.length > 0
  const typeLabel = node.type === 'standard' ? t('vizui.memory.type.normal') : node.type === 'meta' ? t('vizui.memory.type.meta') : t('vizui.memory.type.high')
  const typeCls =
    node.type === 'standard'
      ? 'bg-success/10 text-success'
      : node.type === 'meta'
        ? 'bg-violet-500/10 text-violet-400'
        : 'bg-warning/10 text-warning'
  return (
    <div>
      <div style={pad} className="flex w-full items-center gap-1.5">
        <button
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded px-1 py-0.5 text-left text-[11px] text-fg-primary hover:bg-bg-muted/60 transition-colors"
          title={hasChildren ? t('vizui.memory.toggleNode', { name: node.name }) : t('vizui.common.openPath', { path: node.path })}
          onClick={() => {
            if (hasChildren) {
              setOpen(!open)
            } else {
              openFilePreview(node.path)
            }
          }}
        >
          {hasChildren ? (
            <ChevronRight size={11} className={`shrink-0 text-fg-muted transition-transform ${open ? 'rotate-90' : ''}`} />
          ) : (
            <FileText size={11} className="shrink-0 text-fg-muted" />
          )}
          <span className={`shrink-0 rounded px-1 py-px text-[9px] ${typeCls}`}>{typeLabel}</span>
          <span className="truncate">{node.name}</span>
          <span className="ml-auto shrink-0 text-[9px] text-fg-muted">{hasChildren ? node.children.length : ''}</span>
        </button>
        <button
          className="shrink-0 rounded p-0.5 text-fg-muted hover:bg-bg-muted hover:text-accent"
          title={t('vizui.memory.openJson', { path: node.path })}
          aria-label={t('vizui.memory.openJson', { path: node.path })}
          onClick={() => openFilePreview(node.path)}
        >
          <FolderOpen size={10} />
        </button>
      </div>
      {open && hasChildren && (
        <div>
          {node.children.map((child, i) => (
            <NngTreeNodeRow key={i} node={child} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  )
}