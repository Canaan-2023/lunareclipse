/**
 * 为什么存在：模块注册表是系统内部结构的可观测入口，独立 Tab 呈现模块清单
 * 与运行时异常（批次 E-5c 拆分产物）。
 * 作用：渲染模块监控 Tab——模块注册清单（按分类展开/收拢），
 * 异常模块标红并显示错误摘要。
 */
import { useState } from 'react'
import { AlertTriangle, Boxes, Send } from 'lucide-react'
import type { ModuleInfo, VisualizationData } from '@shared/types'
import { SectionTitle, EmptyHint, StatCard } from './common'
import { formatDateTime } from '../../utils/time'

/** 模块监控 Tab（批次 E-5c 从 VisualizationPanel.tsx 拆出） */

const CATEGORY_ORDER: Array<ModuleInfo['category']> = ['核心', '工具', '记忆系统', '监控', '渲染', '基础设施']

/**
 * 全架构模块清单 + 运行时状态（报错标红）。
 * 数据来自主进程 ModuleRegistry.getSnapshot()（viz:getAll 附带 modules 字段）：
 * - 静态清单 = AI 盘点的月蚀全部架构模块（功能 + 关键文件）
 * - 动态状态 = 健康检查检查项失败/运行时崩溃同步标红；恢复自动变绿
 * AI 侧也可通过同一数据源主动盘点自己的模块（主对话查询 "有哪些模块"）。
 */
export function ModulesTab({ data }: { data: VisualizationData | null }) {
  const modules = data?.modules ?? null
  const [expanded, setExpanded] = useState<string | null>(null)

  if (!modules) {
    return (
      <div className="space-y-5">
        <SectionTitle icon={Boxes} title="模块监控" />
        <EmptyHint text="模块注册表未初始化（打包环境或模块未启动）" />
      </div>
    )
  }

  const failing = modules.filter((m) => m.ok === false)
  const healthy = modules.filter((m) => m.ok === true)
  const unknown = modules.filter((m) => m.ok === null)

  return (
    <div className="space-y-5">
      {/* 总览卡片 */}
      <div className="grid grid-cols-3 gap-2">
        <StatCard label="模块总数" value={modules.length} />
        <StatCard label="异常" value={failing.length} accent={failing.length > 0 ? 'danger' : 'normal'} />
        <StatCard label="健康/未知" value={healthy.length + unknown.length} />
      </div>

      {/* 异常模块优先置顶 */}
      <section>
        <SectionTitle icon={AlertTriangle} title={`异常模块（${failing.length}）`} />
        {failing.length === 0 ? (
          <div className="rounded-btn border border-border-subtle bg-bg-elevated px-3 py-2 text-caption text-fg-secondary">
            ✅ 所有模块正常，无异常上报
          </div>
        ) : (
          <div className="space-y-1.5">
            {failing.map((m) => (
              <ModuleRow key={m.id} m={m} expanded={expanded} setExpanded={setExpanded} />
            ))}
          </div>
        )}
      </section>

      {/* 全模块清单（按大类分组） */}
      {CATEGORY_ORDER.map((cat) => {
        const list = modules.filter((m) => m.category === cat)
        if (list.length === 0) return null
        return (
          <section key={cat}>
            <SectionTitle icon={Boxes} title={`${cat}（${list.length}）`} />
            <div className="space-y-1.5">
              {list.map((m) => (
                <ModuleRow key={m.id} m={m} expanded={expanded} setExpanded={setExpanded} />
              ))}
            </div>
          </section>
        )
      })}
    </div>
  )
}

function ModuleRow({
  m,
  expanded,
  setExpanded
}: {
  m: ModuleInfo
  expanded: string | null
  setExpanded: (id: string | null) => void
}) {
  const isOpen = expanded === m.id
  const dot = m.ok === false ? 'bg-red-400' : m.ok === true ? 'bg-green-400' : 'bg-fg-muted/40'
  const border = m.ok === false ? 'border-red-400/40 bg-red-400/5' : 'border-border-subtle bg-bg-elevated'
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState(false)

  const handleSendToAI = async (e: React.MouseEvent) => {
    e.stopPropagation()
    setSending(true)
    try {
      const ok = await window.lunareclipse.vizReferenceModule(m.id)
      if (ok) {
        setSent(true)
        setTimeout(() => setSent(false), 2000)
      }
    } finally {
      setSending(false)
    }
  }

  return (
    <div className={`rounded-btn border px-3 py-2 ${border}`}>
      <button onClick={() => setExpanded(isOpen ? null : m.id)} className="w-full text-left">
        <div className="flex items-center gap-2">
          <span className={`h-2 w-2 shrink-0 rounded-full ${dot}`} />
          <span className="flex-1 text-caption text-fg-primary">{m.name}</span>
          <span className="shrink-0 rounded bg-bg-muted px-1.5 py-0.5 text-[9px] text-fg-muted">{m.category}</span>
          {m.ok === false && <span className="shrink-0 text-[9px] text-red-400">异常</span>}
          {m.updatedAt && (
            <span className="shrink-0 text-[10px] text-fg-muted">
              {formatDateTime(m.updatedAt)}
            </span>
          )}
        </div>
        <div className="mt-0.5 text-[11px] text-fg-secondary">{m.description}</div>
      </button>
      {isOpen && (
        <div className="mt-2 space-y-1 border-t border-border-subtle pt-2">
          <div className="text-[10px] text-fg-muted">关键文件</div>
          {Array.isArray(m.keyFiles) && m.keyFiles.map((f) => (
            <div key={f} className="rounded bg-bg-base px-2 py-1 font-mono text-[10px] text-fg-secondary">{f}</div>
          ))}
          {m.ok === false && m.error && (
            <div className="mt-1">
              <div className="text-[10px] text-fg-muted">最近错误</div>
              <div className="mt-0.5 line-clamp-3 whitespace-pre-wrap break-all rounded bg-red-400/5 px-2 py-1 font-mono text-[10px] text-red-400">
                {m.error}
              </div>
            </div>
          )}
          <button
            onClick={handleSendToAI}
            disabled={sending || sent}
            className={`mt-1 flex items-center gap-1 rounded px-2 py-1 text-[10px] transition-colors ${
              sent ? 'bg-green-500/15 text-green-400' : 'bg-accent/10 text-accent hover:bg-accent/20'
            } disabled:opacity-60`}
          >
            <Send className="h-3 w-3" />
            {sent ? '已发送' : sending ? '发送中…' : '发送给 AI'}
          </button>
        </div>
      )}
    </div>
  )
}