/**
 * 为什么存在：定时任务（cron jobs）与 AI 倒计时（[TIMER:...]）分属不同来源的"定时"能力，
 * 聚合到一个面板便于统一查看与管理。
 * 作用：展示/管理定时任务（三种 schedule 格式：间隔型、cron 5 段、ISO 一次性）
 * 与 AI 运行时倒计时，支持校验、启停、删除与打开任务目录。
 */
import { useEffect, useState, useCallback } from 'react'
import { Timer, Plus, Trash2, FolderOpen, AlertTriangle, Clock, Hourglass, X } from 'lucide-react'
import { useAppStore } from '../../stores/appStore'

/**
 * 倒计时显示格式化（纯函数，供渲染与单测共用）：
 * 为什么存在——UI 每秒重算剩余秒数并转为"xh xm xs"文本，格式化规则须稳定可测；
 * 不删理由：组件内联写的公式无法单测，且口径（超时归零、满小时进位）必须唯一。
 * @param fireAtMs 定时器触发时间戳（ms）
 * @param nowMs 当前时间戳（ms），默认 Date.now() 便于测试注入
 */
export function formatCountdown(fireAtMs: number, nowMs: number = Date.now()): string {
  // 剩余毫秒为负说明已到期：倒计时显示必须归零而非负数
  const s = Math.max(0, Math.floor((fireAtMs - nowMs) / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return h > 0 ? `${h}时${m}分${sec}秒` : m > 0 ? `${m}分${sec}秒` : `${sec}秒`
}

/**
 * 定时任务面板（右侧栏 tab）：
 * - 定时任务（cron jobs.json）：schedule 三格式（间隔型/cron 5 段/ISO 一次性）+ prompt 描述
 * - AI 倒计时（[TIMER:...] 运行时倒计时）合并显示——一个地方看全部"定时"
 */
interface CronJobInfo {
  id: string
  schedule: string
  prompt: string
  enabled: boolean
}

/** schedule 校验：间隔型（30m/2h/every 6h）| cron 5 段 | ISO 一次性（本地提示，最终以主进程为准） */
function isValidSchedule(expr: string): { ok: boolean; hint?: string } {
  const s = expr.trim()
  // 间隔型
  if (/^(?:every\s+)?\d+\s*(s|m|h|d)$/i.test(s)) return { ok: true }
  // ISO 一次性
  if (!Number.isNaN(Date.parse(s)) && s.includes('T')) return { ok: true }
  // cron 5 段
  const fields = s.split(/\s+/)
  if (fields.length !== 5) {
    return { ok: false, hint: 'schedule 需为：间隔型 every 6h/30m/2h，或 cron 5 段"0 9 * * 1-5"，或 ISO 时间戳' }
  }
  const ranges = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]]
  for (let i = 0; i < 5; i++) {
    const parts = fields[i].split(',')
    for (const part of parts) {
      const p = part.trim()
      if (p === '*') continue
      if (/^\*\//.test(p)) {
        const step = parseInt(p.slice(2), 10)
        if (isNaN(step) || step <= 0) return { ok: false, hint: `第 ${i + 1} 字段步进非法: ${p}` }
        continue
      }
      const m = p.match(/^(\d+)-(\d+)(?:\/(\d+))?$/)
      if (m) {
        const lo = parseInt(m[1], 10), hi = parseInt(m[2], 10)
        if (lo < ranges[i][0] || hi > ranges[i][1] || lo > hi) return { ok: false, hint: `第 ${i + 1} 字段范围非法: ${p}` }
        continue
      }
      if (!/^\d+$/.test(p)) return { ok: false, hint: `第 ${i + 1} 字段无法解析: ${p}` }
      const v = parseInt(p, 10)
      if (v < ranges[i][0] || v > ranges[i][1]) return { ok: false, hint: `第 ${i + 1} 字段越界: ${v}` }
    }
  }
  return { ok: true }
}

/** 已知内置任务用途说明（用户/系统建的固定任务） */
const KNOWN_JOBS: Record<string, { label: string; desc: string }> = {
  'review-thinking-gate': { label: '决策复盘', desc: '每 6 小时复盘 thinking-log 思考日志，提炼经验固化为技能或记忆' },
  'curator-skill-sweep': { label: '技能库维护', desc: '每天 4 点归档长期未使用的技能（先备份），保持技能库精简' }
}

export function CronPanel() {
  const open = useAppStore((s) => s.activeDrawer === 'cron' && !s.vizPanelOpen && !s.settingsOpen)
  const closeDrawer = useAppStore((s) => s.closeDrawer)
  // selector 不能返回新引用（?? [] 每次新建数组 → zustand 无限重渲染）
  const vizTimers = useAppStore((s) => s.visualization?.timers ?? null)
  const [jobs, setJobs] = useState<CronJobInfo[]>([])
  const [showForm, setShowForm] = useState(false)
  const [id, setId] = useState('')
  const [schedule, setSchedule] = useState('every 6h')
  const [prompt, setPrompt] = useState('')
  const [error, setError] = useState('')
  // 保存 busy 态：防双击重复写 jobs.json（评审 MINOR-10）
  const [saving, setSaving] = useState(false)
  // 本地时钟节拍：驱动 AI 倒计时显示每秒刷新。
  // 为什么存在：TimerInfo.remainingMs 是 viz 快照时点计算值（主进程侧不常驻推送），
  // 若直接渲染它会永远停在打开面板那一刻的数字——倒计时「冻结」。
  // 用每秒强制的 useState 更新触发 CronPanel 重渲染，倒计时依据 fireAt - Date.now() 重算。
  // 不删理由：这个 tick 就是"剩余时间会走"的唯一驱动源；删掉则倒计时退回静态数字，功能失真。
  const [, setNowTick] = useState(0)
  useEffect(() => {
    if (!open) return
    const iv = window.setInterval(() => setNowTick((n) => n + 1), 1000)
    return () => window.clearInterval(iv)
  }, [open])

  const load = useCallback(async () => {
    const res = await window.lunareclipse.cronList()
    if (res.ok && res.jobs) setJobs(res.jobs)
  }, [])

  useEffect(() => {
    if (open) void load()
  }, [open, load])

  const save = async () => {
    setError('')
    if (!id.trim()) { setError('任务 id 不能为空'); return }
    if (!prompt.trim()) { setError('任务描述不能为空'); return }
    const v = isValidSchedule(schedule)
    if (!v.ok) { setError(v.hint ?? 'schedule 表达式非法'); return }
    setSaving(true)
    try {
      const res = await window.lunareclipse.cronUpsert({ id: id.trim(), schedule: schedule.trim(), prompt: prompt.trim() })
      if (!res.ok) {
        setError(res.error ?? '保存失败')
        return
      }
      setId('')
      setSchedule('every 6h')
      setPrompt('')
      setShowForm(false)
      void load()
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const toggle = async (jobId: string, enabled: boolean) => {
    await window.lunareclipse.cronToggle(jobId, enabled)
    void load()
  }

  const remove = async (jobId: string) => {
    // 删除为不可逆操作，先确认再执行（评审 MINOR-10）
    if (!confirm('删除该定时任务？此操作不可撤销。')) return
    await window.lunareclipse.cronDelete(jobId)
    void load()
  }

  const openJobs = async () => {
    await window.lunareclipse.cronOpenJobs()
  }

  const cancelTimer = useCallback((id: string) => void useAppStore.getState().cancelTimer(id), [])

  if (!open) return null

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-bg-surface">
      {/* 头部 */}
      <div className="flex items-center justify-between border-b border-border-subtle px-3 py-2">
        <div className="flex items-center gap-1.5 text-caption font-medium text-fg-secondary">
          <Timer size={13} className="text-accent" />
          定时任务
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => void openJobs()}
            className="flex items-center gap-1 rounded-btn bg-bg-muted px-2 py-1 text-[11px] text-fg-secondary hover:bg-bg-muted/70"
            title="打开 jobs.json"
          >
            <FolderOpen size={11} />
            jobs.json
          </button>
          <button
            onClick={() => setShowForm(!showForm)}
            className="flex items-center gap-1 rounded-btn bg-accent/15 px-2 py-1 text-[11px] text-accent hover:bg-accent/25"
          >
            <Plus size={11} />
            新增
          </button>
          <button
            onClick={() => closeDrawer()}
            className="flex h-6 w-6 items-center justify-center rounded-btn text-fg-muted hover:bg-bg-muted hover:text-fg-primary"
            title="关闭"
            aria-label="关闭定时任务面板"
          >
            <X size={12} />
          </button>
        </div>
      </div>

      {/* 新增表单 */}
      {showForm && (
        <div className="border-b border-border-subtle bg-bg-base/50 p-3">
          <div className="mb-2">
            <label className="mb-1 block text-[10px] text-fg-muted">任务 id（唯一，kebab-case）</label>
            <input
              value={id}
              onChange={(e) => setId(e.target.value)}
              placeholder="如 daily9am"
              className="w-full rounded-btn border border-border-subtle bg-bg-base px-2 py-1.5 text-caption text-fg-primary outline-none focus:border-accent"
            />
          </div>
          <div className="mb-2">
            <label className="mb-1 block text-[10px] text-fg-muted">
              调度表达式：<code className="text-accent">every 6h</code>（间隔）/ <code className="text-accent">0 9 * * 1-5</code>（cron）/ ISO 时间戳（一次性）
            </label>
            <input
              value={schedule}
              onChange={(e) => setSchedule(e.target.value)}
              className="w-full rounded-btn border border-border-subtle bg-bg-base px-2 py-1.5 font-mono text-caption text-fg-primary outline-none focus:border-accent"
            />
          </div>
          <div className="mb-2">
            <label className="mb-1 block text-[10px] text-fg-muted">任务描述（到点唤醒 AI 干活的指令）</label>
            <input
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="如：检查今日待办并汇报"
              className="w-full rounded-btn border border-border-subtle bg-bg-base px-2 py-1.5 text-caption text-fg-primary outline-none focus:border-accent"
            />
          </div>
          {error && (
            <div className="mb-2 flex items-center gap-1 rounded bg-danger-soft opacity-50 px-2 py-1 text-[10px] text-danger">
              <AlertTriangle size={10} />
              {error}
            </div>
          )}
          <button
            onClick={() => void save()}
            disabled={saving}
            className="w-full rounded-btn bg-accent py-1.5 text-caption font-medium text-accent-fg hover:bg-accent/90 disabled:opacity-50"
          >
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      )}

      {/* 任务列表 + AI 倒计时 */}
      <div className="flex-1 overflow-y-auto p-2">
        {/* AI 倒计时（运行时 [TIMER:...]） */}
        {vizTimers && vizTimers.length > 0 && (
          <div className="mb-3">
            <div className="mb-1.5 flex items-center gap-1.5 px-1 text-[10px] font-medium uppercase tracking-wider text-fg-muted">
              <Hourglass size={11} className="text-accent" />
              AI 倒计时（运行中）
            </div>
            <div className="space-y-1.5">
              {vizTimers.map((t) => {
                // 剩余时间以 fireAt 与本地时钟差实时重算（见组件头部 tick 注释）：
                // 快照 remainingMs 会旧，冻结显示即由此修复；格式化口径收敛在 formatCountdown
                const label = formatCountdown(t.fireAt)
                return (
                  <div key={t.id} className="flex items-center gap-2 rounded-btn border border-border-subtle bg-bg-elevated px-2.5 py-1.5">
                    <Clock size={11} className="shrink-0 text-accent" />
                    <span className="flex-1 truncate text-caption text-fg-primary">{t.task}</span>
                    <span className="shrink-0 font-mono text-[11px] text-accent">{label}</span>
                    <button
                      onClick={() => cancelTimer(t.id)}
                      className="rounded bg-bg-muted px-1.5 py-0.5 text-[10px] text-fg-secondary hover:text-red-400"
                    >
                      取消
                    </button>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* 定时任务 */}
        {jobs.length === 0 ? (
          <div className="px-3 py-8 text-center text-caption text-fg-muted">
            暂无定时任务
            <div className="mt-2 text-[11px] leading-relaxed">
              点「新增」创建任务，到点后月蚀会唤醒 AI 按任务描述干活
            </div>
          </div>
        ) : (
          jobs.map((job) => {
            const known = KNOWN_JOBS[job.id]
            return (
              <div
                key={job.id}
                className="mb-2 rounded-card border border-border-subtle bg-bg-base/50 p-2.5"
              >
                <div className="flex items-center justify-between">
                  <div className="flex min-w-0 items-center gap-1.5">
                    {known && (
                      <span className="shrink-0 rounded bg-accent/15 px-1.5 py-0.5 text-[10px] text-accent">{known.label}</span>
                    )}
                    <span className="truncate text-caption font-medium text-fg-primary">{job.prompt}</span>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <button
                      onClick={() => void toggle(job.id, !job.enabled)}
                      role="switch"
                      aria-checked={job.enabled}
                      aria-label={job.enabled ? '禁用此定时任务' : '启用此定时任务'}
                      className={`relative h-4 w-7 rounded-full transition-colors ${job.enabled ? 'bg-accent' : 'bg-bg-muted'}`}
                      title={job.enabled ? '点击禁用' : '点击启用'}
                    >
                      <span
                        className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-all ${job.enabled ? 'left-3.5' : 'left-0.5'}`}
                      />
                    </button>
                    <button
                      onClick={() => void remove(job.id)}
                      className="flex h-5 w-5 items-center justify-center rounded text-fg-muted hover:bg-danger-soft hover:text-danger"
                      title="删除"
                      aria-label="删除此定时任务"
                    >
                      <Trash2 size={11} />
                    </button>
                  </div>
                </div>
                <div className="mt-1 font-mono text-[11px] text-accent">{job.schedule}</div>
                <div className="mt-0.5 text-[10px] text-fg-muted/70">
                  id: {job.id}
                  {known ? ` · ${known.desc}` : ''}
                </div>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
