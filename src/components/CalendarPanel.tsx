/**
 * 为什么存在：日程/备忘/计划/提醒等时间性事务需要日历视图统一组织，且提醒依赖系统通知
 * 与开机自启配置，独立面板承载其管理。
 * 作用：月视图 + 左侧条目列表，支持备忘/计划/提醒的增删改与完成标记，按日详情侧栏查看。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Calendar,
  ChevronLeft,
  ChevronRight,
  Plus,
  X,
  CheckCircle2,
  Circle,
  Trash2,
  Loader2,
  StickyNote,
  Flag,
  Bell,
  Archive,
  BookOpen,
  Inbox
} from 'lucide-react'
import { useAppStore } from '../stores/appStore'

/** 日历条目（与主进程 ipc/handlers/calendar.ts 的 CalendarEntry 保持一致） */
interface CalendarEntry {
  id: string
  type: 'memo' | 'plan' | 'reminder' | 'backup'
  title: string
  content?: string
  date?: string
  remindAt?: string
  done?: boolean
  createdAt: string
}

const TYPE_META: Record<CalendarEntry['type'], { icon: typeof StickyNote; label: string; cls: string }> = {
  memo: { icon: StickyNote, label: '备忘', cls: 'bg-bg-muted text-fg-muted' },
  plan: { icon: Flag, label: '计划', cls: 'bg-accent/10 text-accent' },
  reminder: { icon: Bell, label: '提醒', cls: 'bg-warning-soft text-warning' },
  backup: { icon: Archive, label: '备份', cls: 'bg-info-soft text-info' }
}

const TYPE_OPTIONS: Array<{ value: CalendarEntry['type']; label: string }> = [
  { value: 'memo', label: '备忘' },
  { value: 'plan', label: '计划' },
  { value: 'reminder', label: '提醒' },
  { value: 'backup', label: '备份' }
]

function todayStr(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** 条目挂载日（date 优先，其次 remindAt，最后 createdAt） */
function entryDate(e: CalendarEntry): string {
  if (e.date) return e.date
  if (e.remindAt) return e.remindAt.slice(0, 10)
  return e.createdAt.slice(0, 10)
}

/**
 * 日历面板（右侧面板体系）：月历视图 + 条目列表 + 添加/完成/删除。
 * - 作为右侧面板 tab（calendar）存在，与浏览器/代码沙箱共用同一区域（fixed right-0）
 * - 数据走 IPC：calendar:list/add/update/delete → {aiDir}/calendar/entries.json（uid/aiId 隔离）
 * - 低俗轮询兜底（30s），主刷新时机为本地操作完成后主动 reload
 */
export function CalendarPanel() {
  const open = useAppStore((s) => s.activeDrawer === 'calendar' && !s.vizPanelOpen && !s.settingsOpen)
  const closeDrawer = useAppStore((s) => s.closeDrawer)

  const [entries, setEntries] = useState<CalendarEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string>(todayStr())
  const [diary, setDiary] = useState<string | null>(null)
  const [diaryLoading, setDiaryLoading] = useState(false)
  const [view, setView] = useState(() => {
    const now = new Date()
    return { year: now.getFullYear(), month: now.getMonth() }
  })
  const [showAdd, setShowAdd] = useState(false)
  // 添加表单
  const [form, setForm] = useState({
    type: 'memo' as CalendarEntry['type'],
    title: '',
    content: '',
    remindAt: ''
  })
  const [saving, setSaving] = useState(false)

  const reload = useCallback(async () => {
    setLoading(true)
    try {
const res = await window.lunareclipse.calendarList()
      if (res.ok && res.entries) {
        setEntries(res.entries)
        setError(null) // 为什么：上次失败的错误提示不应在成功刷新后继续残留，否则用户误以为数据仍有问题
      } else setError(res.error ?? '读取失败')
    } catch (e) {
      setError(e instanceof Error ? e.message : '读取失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!open) return
    void reload()
    const t = setInterval(() => void reload(), 30000)
    return () => clearInterval(t)
  }, [open, reload])

  // 选中日期变化时读取当天日记（raw_memory/YYYY/MM/DD/diary.md）
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setDiaryLoading(true)
    window.lunareclipse
      .diaryGet(selected)
      .then((res) => {
        if (!cancelled) setDiary(res.ok && res.content ? res.content : null)
      })
      .catch(() => {
        if (!cancelled) setDiary(null)
      })
      .finally(() => {
        if (!cancelled) setDiaryLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, selected])

  // 月历网格
  const grid = useMemo(() => {
    const { year, month } = view
    const first = new Date(year, month, 1)
    const daysInMonth = new Date(year, month + 1, 0).getDate()
    const lead = first.getDay() // 0=周日
    const cells: Array<number | null> = [
      ...Array.from({ length: lead }, () => null),
      ...Array.from({ length: daysInMonth }, (_, i) => i + 1)
    ]
    while (cells.length % 7 !== 0) cells.push(null)
    return cells
  }, [view])

  const byDate = useMemo(() => {
    const map = new Map<string, CalendarEntry[]>()
    for (const e of entries) {
      const d = entryDate(e)
      const list = map.get(d) ?? []
      list.push(e)
      map.set(d, list)
    }
    for (const list of map.values()) list.sort((a, b) => (a.done === b.done ? 0 : a.done ? 1 : -1))
    return map
  }, [entries])

  const selectedEntries = useMemo(() => {
    const list = byDate.get(selected) ?? []
    return [...list].sort((a, b) => (a.done === b.done ? 0 : a.done ? 1 : -1))
  }, [byDate, selected])

  const monthLabel = `${view.year}年${view.month + 1}月`
  const today = todayStr()
  const selectedMeta = selected === today ? '今天' : selected

  const prevMonth = () => setView((v) => (v.month === 0 ? { year: v.year - 1, month: 11 } : { year: v.year, month: v.month - 1 }))
  const nextMonth = () => setView((v) => (v.month === 11 ? { year: v.year + 1, month: 0 } : { year: v.year, month: v.month + 1 }))

  const submit = async () => {
    const title = form.title.trim()
    if (!title) return
    setSaving(true)
    try {
      const res = await window.lunareclipse.calendarAdd({
        type: form.type,
        title,
        content: form.content.trim(),
        date: selected,
        remindAt: form.type === 'reminder' && form.remindAt ? new Date(form.remindAt).toISOString() : undefined
      })
      if (res.ok) {
        setForm({ type: 'memo', title: '', content: '', remindAt: '' })
        setShowAdd(false)
        void reload()
      } else {
        setError(res.error ?? '添加失败')
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '添加失败')
    } finally {
      setSaving(false)
    }
  }

  const toggleDone = async (e: CalendarEntry) => {
    const res = await window.lunareclipse.calendarUpdate(e.id, { done: !e.done })
    if (res.ok) void reload()
    else setError(res.error ?? '更新失败')
  }

const remove = async (e: CalendarEntry) => {
    // 删除为不可逆操作 + 按钮 hover-only 隐藏：先确认再执行（评审 MINOR-11）
    if (!confirm(`删除「${e.title}」？此操作不可撤销。`)) return
    const res = await window.lunareclipse.calendarDelete(e.id)
    if (res.ok) void reload()
    else setError(res.error ?? '删除失败')
  }

  if (!open) return null

  return (
    <div className="flex h-full w-full flex-col bg-bg-surface">
      {/* 面板头 */}
      <div className="flex items-center gap-1 border-b border-border-subtle px-3 py-2">
        <Calendar size={14} className="shrink-0 text-accent" />
        <span className="shrink-0 text-caption font-medium text-fg-primary">日历</span>
        <span className="ml-auto shrink-0 font-mono text-[10px] text-fg-muted">{selectedMeta}</span>
        <button
          onClick={() => setShowAdd(!showAdd)}
          className={`ml-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-btn transition-colors ${
            showAdd ? 'bg-accent/15 text-accent' : 'text-fg-muted hover:bg-bg-muted hover:text-fg-primary'
          }`}
          title="添加条目"
          aria-label="添加条目"
        >
          {saving ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
        </button>
        <button
          onClick={() => closeDrawer()}
          className="ml-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-btn text-fg-muted transition-colors hover:bg-bg-muted hover:text-fg-primary"
          title="关闭日历面板"
          aria-label="关闭日历面板"
        >
          <X size={12} />
        </button>
      </div>

      {/* 添加表单 */}
      {showAdd && (
        <div className="shrink-0 space-y-1.5 border-b border-border-subtle bg-bg-muted/30 px-3 py-2">
          <div className="flex items-center gap-1">
            {TYPE_OPTIONS.map((o) => (
              <button
                key={o.value}
                onClick={() => setForm((f) => ({ ...f, type: o.value }))}
                className={`rounded-full px-2 py-0.5 text-[10px] transition-colors ${
                  form.type === o.value ? 'bg-accent/15 text-accent' : 'bg-bg-muted text-fg-muted hover:text-fg-primary'
                }`}
              >
                {o.label}
              </button>
            ))}
          </div>
          <input
            value={form.title}
            onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
            onKeyDown={(e) => e.key === 'Enter' && void submit()}
            placeholder="标题（必填）"
            className="w-full rounded-card border border-border-subtle bg-bg-surface px-2 py-1 text-[11px] text-fg-primary placeholder:text-fg-muted/50 focus:border-accent focus:outline-none"
          />
          <input
            value={form.content}
            onChange={(e) => setForm((f) => ({ ...f, content: e.target.value }))}
            onKeyDown={(e) => e.key === 'Enter' && void submit()}
            placeholder="内容（可选）"
            className="w-full rounded-card border border-border-subtle bg-bg-surface px-2 py-1 text-[11px] text-fg-primary placeholder:text-fg-muted/50 focus:border-accent focus:outline-none"
          />
          {form.type === 'reminder' && (
            <input
              type="datetime-local"
              value={form.remindAt}
              onChange={(e) => setForm((f) => ({ ...f, remindAt: e.target.value }))}
              className="w-full rounded-card border border-border-subtle bg-bg-surface px-2 py-1 text-[11px] text-fg-primary focus:border-accent focus:outline-none"
            />
          )}
          {error && <div className="text-[10px] text-danger">{error}</div>}
          <div className="flex justify-end gap-1">
            <button
              onClick={() => setShowAdd(false)}
              className="rounded-card px-2 py-1 text-[10px] text-fg-muted transition-colors hover:bg-bg-muted hover:text-fg-primary"
            >
              取消
            </button>
            <button
              onClick={() => void submit()}
              disabled={!form.title.trim() || saving}
              className="rounded-card bg-accent px-2.5 py-1 text-[10px] font-medium text-fg-primary transition-opacity hover:opacity-80 disabled:opacity-40"
            >
              保存
            </button>
          </div>
        </div>
      )}

      {/* 月历 */}
      <div className="shrink-0 border-b border-border-subtle px-3 py-2">
        <div className="mb-1.5 flex items-center justify-between">
          <button onClick={prevMonth} aria-label="上个月" title="上个月" className="flex h-5 w-5 items-center justify-center rounded text-fg-muted hover:bg-bg-muted hover:text-fg-primary">
            <ChevronLeft size={12} />
          </button>
          <span className="text-caption font-medium text-fg-primary">{monthLabel}</span>
          <button onClick={nextMonth} aria-label="下个月" title="下个月" className="flex h-5 w-5 items-center justify-center rounded text-fg-muted hover:bg-bg-muted hover:text-fg-primary">
            <ChevronRight size={12} />
          </button>
        </div>
        <div className="grid grid-cols-7 gap-px">
          {['日', '一', '二', '三', '四', '五', '六'].map((w) => (
            <div key={w} className="pb-0.5 text-center text-[9px] text-fg-muted/60">
              {w}
            </div>
          ))}
          {grid.map((d, i) => {
            if (d === null) return <div key={i} />
            const dateStr = `${view.year}-${String(view.month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`
            const has = (byDate.get(dateStr)?.length ?? 0) > 0
            const doneCount = byDate.get(dateStr)?.filter((e) => e.done).length ?? 0
            const isToday = dateStr === today
            const isSelected = dateStr === selected
            return (
              <button
                key={i}
                onClick={() => setSelected(dateStr)}
                className={`relative flex h-6 flex-col items-center justify-center rounded-card text-[10px] transition-colors ${
                  isSelected
                    ? 'bg-accent/15 text-accent font-medium'
                    : isToday
                      ? 'bg-bg-muted text-fg-primary font-medium'
                      : 'text-fg-muted hover:bg-bg-muted/50 hover:text-fg-primary'
                }`}
              >
                {d}
                {has && (
                  <span className={`absolute bottom-0.5 h-1 w-1 rounded-full ${doneCount === (byDate.get(dateStr)?.length ?? 0) ? 'bg-success' : 'bg-accent'}`} />
                )}
              </button>
            )
          })}
        </div>
      </div>

      {/* 当天日记（raw_memory/YYYY/MM/DD/diary.md） */}
      <div className="shrink-0 border-b border-border-subtle px-3 py-2">
        <div className="mb-1 flex items-center gap-1">
          <BookOpen size={11} className="shrink-0 text-fg-muted" />
          <span className="text-[10px] font-medium text-fg-primary">当天日记</span>
          <span className="ml-auto font-mono text-[9px] text-fg-muted">{selected}</span>
        </div>
        {diaryLoading ? (
          <div className="flex items-center gap-1.5 py-1 text-[10px] text-fg-muted">
            <Loader2 size={10} className="animate-spin" />
            读取中…
          </div>
        ) : diary ? (
          <div className="max-h-28 overflow-y-auto whitespace-pre-wrap rounded-card bg-bg-muted/40 px-2 py-1.5 font-mono text-[9px] leading-relaxed text-fg-muted">
            {diary}
          </div>
        ) : (
          <div className="py-0.5 text-[10px] text-fg-muted/50">这天没有日记</div>
        )}
      </div>

{/* 条目列表 */}
      <div className="flex-1 overflow-y-auto px-1 py-1">
        {error && entries.length === 0 ? (
          <div className="flex flex-col items-center gap-1.5 px-3 py-6 text-center">
            <span className="text-[11px] text-danger">加载失败：{error}</span>
            <button onClick={() => void reload()} className="rounded-card bg-bg-muted px-2 py-0.5 text-[10px] text-fg-primary hover:bg-bg-muted/70">
              重试
            </button>
          </div>
        ) : loading && entries.length === 0 ? (
          <div className="flex flex-col items-center gap-1.5 px-3 py-6 text-center">
            <Loader2 size={14} className="animate-spin text-fg-muted" />
            <span className="text-[11px] text-fg-muted">读取中…</span>
          </div>
        ) : selectedEntries.length === 0 ? (
          <div className="flex flex-col items-center gap-1.5 px-3 py-6 text-center">
            <Inbox size={14} className="text-fg-muted/50" />
            <span className="text-[11px] leading-relaxed text-fg-muted">
              {selected} 暂无条目
              <br />
              点右上 + 添加
            </span>
          </div>
        ) : (
          <div className="flex flex-col gap-0.5">
{selectedEntries.map((e) => {
              const meta = TYPE_META[e.type]
              return (
                <div
                  key={e.id}
                  className={`group flex items-start gap-1.5 rounded-card px-2 py-1.5 transition-colors ${
                    e.done ? 'opacity-60' : 'hover:bg-bg-muted/40'
                  }`}
                >
                  <button
                    onClick={() => void toggleDone(e)}
                    className="mt-0.5 shrink-0 text-fg-muted transition-colors hover:text-success"
                    title={e.done ? '标记未完成' : '标记完成'}
                  >
                    {e.done ? <CheckCircle2 size={12} className="text-success" /> : <Circle size={12} />}
                  </button>
                  <div className="min-w-0 flex-1">
                    <div className={`text-[11px] leading-snug ${e.done ? 'text-fg-muted line-through' : 'text-fg-primary'}`}>{e.title}</div>
                    {e.content && <div className="mt-0.5 text-[10px] leading-snug text-fg-muted">{e.content}</div>}
                    {e.remindAt && (
                      <div className="mt-0.5 font-mono text-[9px] text-warning">
                        ⏰ {new Date(e.remindAt).toLocaleString('zh-CN', { hour12: false })}
                      </div>
                    )}
                    <div className="mt-0.5 flex items-center gap-1">
                      <span className={`shrink-0 rounded-full px-1.5 py-px text-[9px] font-medium ${meta.cls}`}>
                        {meta.label}
                      </span>
                    </div>
                  </div>
<button
                    onClick={() => void remove(e)}
                    className="mt-0.5 shrink-0 text-fg-muted opacity-0 transition-all hover:text-danger group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100"
                    title="删除"
                    aria-label="删除日程"
                  >
                    <Trash2 size={11} />
                  </button>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
