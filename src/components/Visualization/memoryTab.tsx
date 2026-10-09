/**
 * 为什么存在：记忆体系按分类文件夹组织（六分类懒加载），多 AI 各有其记忆，
 * 需要独立 Tab 呈现树形浏览（批次 E-5c 拆分产物）。
 * 作用：渲染记忆系统 Tab——分类文件夹树（懒加载展开）、文件预览列表，
 * 切换器按 AIID 动态渲染全部启用 AI。
 */
import { useEffect, useMemo, useState } from 'react'
import { FolderTree, Folder, FolderOpen, FileText, ChevronRight } from 'lucide-react'
import { useAppStore } from '../../stores/appStore'
import { aiAvatarFallback } from '../Ai/AiManagerPanel'
import { openFilePreview } from '../Workshop/FileWorkshopPanel'
import type { MemoryDirectoryNode } from '@shared/types'
import { SectionTitle } from './common'

/** 记忆系统 Tab（批次 E-5c 从 VisualizationPanel.tsx 拆出） */

/**
 * 记忆 tab：只显示分类文件夹树（六分类懒加载），
 * 移除 normal/meta/high 混排的「记忆文件」列表——文件按分类文件夹组织，点开才扫。
 * 多 AI：切换器按 AIID 动态渲染全部启用 AI（不再硬编码月蚀/莉莉丝），各看各的记忆体系
 */
export function MemoryTab() {
  const [tree, setTree] = useState<MemoryDirectoryNode[] | null>(null)
  const [aiId, setAiId] = useState<number>(1)
  const aiName = useAppStore((s) => s.config.aiName) || '月蚀'
  const ais = useAppStore((s) => s.ais)
  const currentAiId = useAppStore((s) => s.currentAiId)

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
    void window.lunareclipse?.vizMemoryTab?.(aiId).then((d) => {
      if (alive && d && Array.isArray((d as { directoryTree?: unknown }).directoryTree)) {
        setTree((d as { directoryTree: MemoryDirectoryNode[] }).directoryTree)
      }
    })
    return () => { alive = false }
  }, [aiId])

  if (!tree) return <div className="text-caption text-fg-muted">加载记忆数据中…</div>

  return (
    <div className="space-y-5">
      <section>
        <SectionTitle icon={FolderTree} title="记忆库结构（点开加载）" />
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
              {a.name}（AI {a.id}）
            </button>
          ))}
        </div>
        <p className="mb-2 text-caption text-fg-secondary">
          六个记忆分类文件夹，点开文件夹才扫描该层内容（普通记忆/元认知/高阶按 年/月/日 组织，RAW 按日期，NNG 按分类）。
        </p>
        <div className="max-h-[calc(100vh-300px)] space-y-0.5 overflow-y-auto rounded-btn border border-border-subtle bg-bg-muted/30 p-2">
          {tree.map((node, i) => (
            <DirTreeNode key={`${aiId}_${i}`} node={node} depth={0} />
          ))}
        </div>
      </section>
    </div>
  )
}

/** 文件夹树节点（可折叠，懒加载：目录展开时才拉取子层 viz:directoryChildren） */
function DirTreeNode({ node, depth }: { node: MemoryDirectoryNode; depth: number }) {
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
          title={`点击打开：${node.path}`}
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
          title={`在文件夹中显示：${node.path}`}
          aria-label={`在文件夹中显示：${node.path}`}
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
              <div style={pad} className="text-[10px] text-fg-muted">（空目录）</div>
            ) : (
              children.map((child, i) => <DirTreeNode key={i} node={child} depth={depth + 1} />)
            )}
          </div>
        ) : (
          <div style={pad} className="text-[10px] text-fg-muted">加载中…</div>
        ))}
    </div>
  )
}