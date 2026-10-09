/**
 * 为什么存在：hooks 是治理 AI 行为的机制（工具调用前/后、提交、停止等钩子），
 * 配置结构（事件 × matcher × handler）复杂且分全局/项目两层级，需要专门编辑 UI。
 * 作用：编辑全局与项目 hooks.json——事件列表 + matcher 组详情编辑 + 保存/启用应用 + 事件测试。
 */
import { useState, useEffect } from 'react'
import { Plus, Trash2, ShieldAlert, ShieldCheck, FlaskConical, Loader2 } from 'lucide-react'
import type { HooksConfig, HookEvent, HookScope, HookMatcherGroup, HookHandler, HookType } from '@shared/types'
import { Field } from '../Field'
import { useT } from '../../../i18n/useT'

/**
 * Hooks 配置区

 * 参考主流 agent 的 hooks.json 编辑 UI 形态。月蚀两层作用域：
 * - 全局（~/.lunareclipse/hooks.json）：所有项目共享
 * - 项目（{workspace}/.lunareclipse/hooks.json）：当前项目专属，覆盖全局

 * UI 结构：
 * - 顶部：作用域切换（全局/项目）+ 保存按钮 + 状态消息
 * - 左栏：事件列表（PreToolUse/PostToolUse/Stop/...），每个事件下按 matcher 组列出
 * - 右栏：选中 matcher 组的详情编辑（matcher 正则 + hooks 数组）

 * 数据结构：HooksConfig.hooks[event] = HookMatcherGroup[]
 * 每个 HookMatcherGroup = { matcher?: string, hooks: HookHandler[] }
 */
export function HooksConfigSection() {
  const t = useT()
  const [scope, setScope] = useState<HookScope>('global')
  const [config, setConfig] = useState<HooksConfig>({ hooks: {} })
  const [projectAvailable, setProjectAvailable] = useState<boolean>(true)
  const [selectedEvent, setSelectedEvent] = useState<HookEvent>('PreToolUse')
  const [selectedMatcherIdx, setSelectedMatcherIdx] = useState<number>(0)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<string>('')
  // 项目级 Hook 确认条（hooksHasProject → hasProject && !allowed 时展示）
  const [projStatus, setProjStatus] = useState<'checking' | 'pending' | 'approved'>('checking')
  const [confirming, setConfirming] = useState(false)
  // 事件测试（hooksTest，mock 上下文）
  const [testing, setTesting] = useState(false)
  const [testOutcome, setTestOutcome] = useState<{ ok: boolean; text: string } | null>(null)

  // 加载配置
  useEffect(() => {
    const api = window.lunareclipse
    if (!api?.hooksRead) return
    // 先查路径，判断项目级是否可用
    api.hooksGetPaths().then((paths: { global: string; project: string | null }) => {
      setProjectAvailable(paths.project !== null)
    }).catch(() => setProjectAvailable(false))
    api.hooksRead(scope).then((cfg: HooksConfig) => {
      setConfig(cfg)
      // 默认选中第一个有 matcher 组的事件
      const firstEvent = (Object.keys(cfg.hooks ?? {}) as HookEvent[])[0]
      if (firstEvent) {
        setSelectedEvent(firstEvent)
        setSelectedMatcherIdx(0)
      }
    }).catch((e: unknown) => {
      // 加载失败提示（评审 MINOR-9）：不静默停在「空配置」态，避免与「当前无配置」混淆
      setMsg(t('settings.hookSaveFail', { error: e instanceof Error ? e.message : String(e) }))
      setTimeout(() => setMsg(''), 5000)
    })
  }, [scope])

  // 项目级 Hook 确认状态：存在且未允许时展示确认条
  useEffect(() => {
    const api = window.lunareclipse
    if (!api?.hooksHasProject) return
    api
      .hooksHasProject()
      .then((r) => {
        setProjStatus(r.hasProject && !r.allowed ? 'pending' : 'approved')
      })
      .catch(() => setProjStatus('approved'))
  }, [])

  /** 确认启用项目级 Hook（主进程弹系统确认框并热重载） */
  const confirmProject = async () => {
    const api = window.lunareclipse
    if (!api?.hooksConfirmProject || confirming) return
    setConfirming(true)
    try {
      const res = await api.hooksConfirmProject()
      if (res.ok) {
        setProjStatus('approved')
        setMsg(t('settings.hookProjectConfirmed'))
        setTimeout(() => setMsg(''), 4000)
      } else {
        setMsg(res.error ?? t('settings.hookProjectCheckFail'))
        setTimeout(() => setMsg(''), 4000)
      }
    } catch {
      setMsg(t('settings.hookProjectCheckFail'))
      setTimeout(() => setMsg(''), 4000)
    } finally {
      setConfirming(false)
    }
  }

  /** 以 mock 上下文测试当前选中事件的全部 hook */
  const testEvent = async () => {
    const api = window.lunareclipse
    if (!api?.hooksTest || testing) return
    setTesting(true)
    setTestOutcome(null)
    try {
      const res = await api.hooksTest(selectedEvent, {
        event: selectedEvent,
        cwd: '',
        toolName: 'bash',
        toolParams: { command: 'echo hook-test' }
      })
      if (!res.ok) {
        setTestOutcome({ ok: false, text: res.error ?? t('settings.hookTestFail', { error: '' }) })
        return
      }
      // res.result 为 HookResult（action/message 等）或 undefined（无匹配）
      if (res.result === undefined || res.result === null) {
        setTestOutcome({ ok: true, text: t('settings.hookTestNoMatch') })
        return
      }
      setTestOutcome({ ok: true, text: JSON.stringify(res.result, null, 2) })
    } catch (err) {
      setTestOutcome({ ok: false, text: t('settings.hookTestFail', { error: (err as Error).message }) })
    } finally {
      setTesting(false)
    }
  }

  const events: HookEvent[] = ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'PreLLMCall', 'Stop', 'SubagentStop', 'Notification']
  const eventLabels: Record<HookEvent, string> = {
    PreToolUse: t('settings.hookPreToolUse'),
    PostToolUse: t('settings.hookPostToolUse'),
    UserPromptSubmit: t('settings.hookUserPrompt'),
    PreLLMCall: t('settings.hookPreLLMCall'),
    Stop: t('settings.hookStop'),
    SubagentStop: t('settings.hookSubagentStop'),
    Notification: t('settings.hookNotification')
  }

  const matcherGroups: HookMatcherGroup[] = config.hooks?.[selectedEvent] ?? []
  const selectedGroup = matcherGroups[selectedMatcherIdx]

  const updateGroup = (idx: number, patch: Partial<HookMatcherGroup>) => {
    if (!config.hooks) return
    const arr = [...(config.hooks[selectedEvent] ?? [])]
    if (!arr[idx]) return
    arr[idx] = { ...arr[idx], ...patch }
    setConfig({ hooks: { ...config.hooks, [selectedEvent]: arr } })
    setDirty(true)
  }

  const updateHandler = (groupIdx: number, handlerIdx: number, patch: Partial<HookHandler>) => {
    if (!config.hooks) return
    const arr = [...(config.hooks[selectedEvent] ?? [])]
    const group = arr[groupIdx]
    if (!group) return
    const hooks = [...group.hooks]
    if (!hooks[handlerIdx]) return
    hooks[handlerIdx] = { ...hooks[handlerIdx], ...patch }
    arr[groupIdx] = { ...group, hooks }
    setConfig({ hooks: { ...config.hooks, [selectedEvent]: arr } })
    setDirty(true)
  }

  const addMatcherGroup = () => {
    if (!config.hooks) return
    const arr = [...(config.hooks[selectedEvent] ?? [])]
    arr.push({ matcher: '.*', hooks: [{ type: 'javascript', handler: 'return { action: \'continue\' }' }] })
    setConfig({ hooks: { ...config.hooks, [selectedEvent]: arr } })
    setSelectedMatcherIdx(arr.length - 1)
    setDirty(true)
  }

  const removeMatcherGroup = (idx: number) => {
    if (!config.hooks) return
    const arr = [...(config.hooks[selectedEvent] ?? [])]
    arr.splice(idx, 1)
    setConfig({ hooks: { ...config.hooks, [selectedEvent]: arr } })
    if (selectedMatcherIdx >= arr.length) setSelectedMatcherIdx(Math.max(0, arr.length - 1))
    setDirty(true)
  }

  const addHandler = () => {
    if (!config.hooks || !selectedGroup) return
    const arr = [...(config.hooks[selectedEvent] ?? [])]
    arr[selectedMatcherIdx] = {
      ...selectedGroup,
      hooks: [...selectedGroup.hooks, { type: 'javascript', handler: 'return { action: \'continue\' }' }]
    }
    setConfig({ hooks: { ...config.hooks, [selectedEvent]: arr } })
    setDirty(true)
  }

  const removeHandler = (handlerIdx: number) => {
    if (!config.hooks || !selectedGroup) return
    const arr = [...(config.hooks[selectedEvent] ?? [])]
    const newHooks = [...selectedGroup.hooks]
    newHooks.splice(handlerIdx, 1)
    arr[selectedMatcherIdx] = { ...selectedGroup, hooks: newHooks }
    setConfig({ hooks: { ...config.hooks, [selectedEvent]: arr } })
    setDirty(true)
  }

  const save = async () => {
    const api = window.lunareclipse
    if (!api?.hooksWrite) return
    setSaving(true)
    try {
      const res = await api.hooksWrite(scope, config)
      if (res.ok) {
        setDirty(false)
        setMsg(t('settings.hookSaved'))
      } else {
        setMsg(t('settings.hookSaveFail', { error: res.error ?? '' }))
      }
    } catch (e) {
      // 异常兜底：IPC 异常也提示而不是让 saving 永久卡死（评审 MINOR-8）
      setMsg(t('settings.hookSaveFail', { error: e instanceof Error ? e.message : String(e) }))
    } finally {
      // 无论成败复位 saving，避免保存按钮被永久 disabled
      setSaving(false)
    }
    setTimeout(() => setMsg(''), 3000)
  }

  // 通用样式
  const inputCls = 'h-8 w-full rounded-btn border border-border bg-bg-elevated px-2.5 text-caption text-fg-primary focus:border-accent focus:outline-none'
  const btnCls = 'rounded-btn px-3 py-1.5 text-caption transition-all duration-150 active:scale-95'

  return (
    <div className="space-y-4">
      <div className="rounded-btn border border-border-subtle bg-bg-elevated px-3 py-2 text-[11px] text-fg-muted">
        {t('settings.hookHint')}
      </div>
      <div className="flex items-center justify-between">
        <div className="text-caption uppercase tracking-wider text-fg-muted">{t('settings.hookConfigTitle')}</div>
        <div className="flex items-center gap-2">
          {msg && <span className="text-[11px] text-fg-muted">{msg}</span>}
          <button
            onClick={save}
            disabled={!dirty || saving}
            className={`${btnCls} bg-accent text-accent-fg disabled:opacity-40 disabled:active:scale-100`}
          >
            {saving ? t('settings.mcpSaving') : t('settings.mcpSaveApply')}
          </button>
        </div>
      </div>

      {/* 项目级 Hook 确认条：存在且未确认时提醒（安全护栏，启用需主进程系统确认框二次确认） */}
      {projStatus === 'pending' && (
        <div className="flex items-start gap-2.5 rounded-btn border border-amber-500/30 bg-amber-500/10 px-3 py-2.5">
          <ShieldAlert size={14} className="mt-0.5 shrink-0 text-amber-400" />
          <div className="min-w-0 flex-1">
            <div className="text-caption font-medium text-amber-300">{t('settings.hookProjectConfirmBar')}</div>
            <div className="mt-0.5 text-[11px] leading-relaxed text-amber-300/70">{t('settings.hookProjectConfirmDesc')}</div>
          </div>
          <button
            onClick={() => void confirmProject()}
            disabled={confirming}
            className="flex shrink-0 items-center gap-1.5 rounded-btn bg-amber-500 px-2.5 py-1.5 text-caption font-medium text-black transition-all duration-150 hover:bg-amber-400 disabled:opacity-50 active:scale-95"
          >
            {confirming ? <Loader2 size={11} className="animate-spin" /> : <ShieldCheck size={11} />}
            {t('settings.hookConfirmEnable')}
          </button>
        </div>
      )}

      {/* 作用域切换 */}
      <div className="flex items-center gap-2">
        <span className="text-caption text-fg-muted">{t('settings.hookScope')}</span>
        <button
          onClick={() => setScope('global')}
          aria-pressed={scope === 'global'}
          className={`${btnCls} ${scope === 'global' ? 'bg-accent text-accent-fg' : 'border border-border-subtle text-fg-secondary hover:text-accent'}`}
        >
          {t('settings.hookScopeGlobal')}
        </button>
        <button
          onClick={() => projectAvailable && setScope('project')}
          disabled={!projectAvailable}
          aria-pressed={scope === 'project'}
          className={`${btnCls} ${scope === 'project' ? 'bg-accent text-accent-fg' : 'border border-border-subtle text-fg-secondary hover:text-accent'} disabled:opacity-40`}
          title={projectAvailable ? t('settings.hookScopeProjectTitle') : t('settings.hookScopeNoProject')}
        >
          {t('settings.hookScopeProject')}
        </button>
        <span className="text-[11px] text-fg-muted">
          {scope === 'global' ? '~/.lunareclipse/hooks.json' : '{workspace}/.lunareclipse/hooks.json'}
        </span>
      </div>

      <div className="flex gap-3" style={{ minHeight: '400px' }}>
        {/* 左栏：事件列表（收窄，把空间让给内容区） */}
        <div className="w-36 shrink-0 space-y-1">
          {events.map((ev) => {
            const count = (config.hooks?.[ev] ?? []).length
            return (
              <button
                key={ev}
                onClick={() => { setSelectedEvent(ev); setSelectedMatcherIdx(0) }}
                className={`mb-1 flex w-full items-center justify-between rounded-btn px-2 py-1.5 text-left transition-all duration-150 active:scale-95 ${
                  selectedEvent === ev ? 'bg-accent/10 text-accent' : 'text-fg-secondary hover:bg-bg-muted'
                }`}
              >
                <span className="text-[11px]">{eventLabels[ev]}</span>
                {count > 0 && (
                  <span className="rounded-full bg-bg-muted px-1.5 text-[10px] text-fg-muted">{count}</span>
                )}
              </button>
            )
          })}
        </div>

        {/* 中栏：matcher 组列表（收窄） */}
        <div className="w-40 shrink-0 space-y-1 overflow-hidden">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[11px] uppercase tracking-wider text-fg-muted">{t('settings.hookMatcherGroup')}</span>
            <button
              onClick={addMatcherGroup}
              className={`${btnCls} flex items-center gap-1 border border-border-subtle text-fg-secondary hover:text-accent`}
              title={t('settings.hookAddMatcher')}
              aria-label={t('settings.hookAddMatcher')}
            >
              <Plus size={12} />
            </button>
          </div>
          {matcherGroups.map((g, idx) => (
            <button
              key={idx}
              onClick={() => setSelectedMatcherIdx(idx)}
              className={`mb-1 flex w-full flex-col gap-0.5 overflow-hidden rounded-btn px-2.5 py-2 text-left transition-all duration-150 active:scale-95 ${
                selectedMatcherIdx === idx ? 'bg-accent/10 text-accent' : 'text-fg-secondary hover:bg-bg-muted'
              }`}
            >
              <span className="w-full truncate font-mono text-[11px]">{g.matcher ?? '.*'}</span>
              <span className="text-[10px] text-fg-muted">{t('settings.hookCount', { n: g.hooks.length })}</span>
            </button>
          ))}
          {matcherGroups.length === 0 && (
            <div className="text-caption text-fg-muted">{t('settings.hookNoMatcher')}</div>
          )}
        </div>

        {/* 右栏：matcher 组详情 */}
        {selectedGroup ? (
          <div className="flex-1 space-y-3">
            <Field label={t('settings.hookMatcherField')}>
              <input
                value={selectedGroup.matcher ?? ''}
                onChange={(e) => updateGroup(selectedMatcherIdx, { matcher: e.target.value })}
                className={inputCls}
                placeholder=".*"
              />
            </Field>

            {/* 事件测试：mock 上下文跑当前事件全部 hook，验证返回 action */}
            <div className="rounded-btn border border-border-subtle bg-bg-muted/40 p-2.5">
              <div className="flex items-center gap-2">
                <FlaskConical size={12} className="shrink-0 text-accent" />
                <span className="text-[11px] text-fg-secondary">{t('settings.hookTestHint')}</span>
                <div className="flex-1" />
                <button
                  onClick={() => void testEvent()}
                  disabled={testing}
                  className={`${btnCls} flex items-center gap-1.5 bg-accent text-accent-fg disabled:opacity-50`}
                >
                  {testing ? <Loader2 size={11} className="animate-spin" /> : <FlaskConical size={11} />}
                  {testing ? t('settings.hookTestRunning') : t('settings.hookTestEvent')}
                </button>
              </div>
              {testOutcome && (
                <pre
                  className={`mt-2 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded-btn bg-bg-base px-2.5 py-1.5 font-mono text-[11px] ${
                    testOutcome.ok ? 'text-fg-secondary' : 'text-red-400'
                  }`}
                >
                  {testOutcome.text}
                </pre>
              )}
            </div>

            <div className="flex items-center justify-between">
              <span className="text-[11px] uppercase tracking-wider text-fg-muted">{t('settings.hookList')}</span>
              <button
                onClick={addHandler}
                className={`${btnCls} flex items-center gap-1 border border-border-subtle text-fg-secondary hover:text-accent`}
              >
                <Plus size={12} /> {t('settings.hookAddHook')}
              </button>
            </div>

            {selectedGroup.hooks.map((h, hIdx) => (
              <div key={hIdx} className="space-y-2 rounded-card border border-border-subtle p-3">
                <div className="flex items-center gap-2">
                  <select
                    value={h.type}
                    onChange={(e) => updateHandler(selectedMatcherIdx, hIdx, { type: e.target.value as HookType })}
                    className={inputCls}
                  >
                    <option value="javascript">{t('settings.hookTypeJs')}</option>
                    <option value="command">{t('settings.hookTypeCmd')}</option>
                  </select>
                  <button
                    onClick={() => removeHandler(hIdx)}
                    className={`${btnCls} flex items-center gap-1 border border-danger/30 text-danger hover:bg-danger/10`}
                  >
                    <Trash2 size={12} />
                  </button>
                </div>

                {h.type === 'command' ? (
                  <>
                    <Field label={t('settings.hookCmdField')}>
                      <input
                        value={h.command ?? ''}
                        onChange={(e) => updateHandler(selectedMatcherIdx, hIdx, { command: e.target.value })}
                        className={inputCls}
                        placeholder={t('settings.hookCmdPh')}
                      />
                    </Field>
                    <Field label={t('settings.hookArgsField')}>
                      <input
                        value={(h.args ?? []).join(' ')}
                        onChange={(e) => updateHandler(selectedMatcherIdx, hIdx, { args: e.target.value.split(/\s+/).filter(Boolean) })}
                        className={inputCls}
                        placeholder={t('settings.hookArgsPh')}
                      />
                    </Field>
                  </>
                ) : (
                  <Field label={t('settings.hookJsField')}>
                    <textarea
                      value={h.handler ?? ''}
                      onChange={(e) => updateHandler(selectedMatcherIdx, hIdx, { handler: e.target.value })}
                      className="h-32 w-full resize-y rounded-btn border border-border bg-bg-elevated p-2 font-mono text-[11px] text-fg-primary focus:border-accent focus:outline-none"
                      placeholder={t('settings.hookJsPh')}
                    />
                  </Field>
                )}

                <Field label={t('settings.hookTimeout')}>
                  <input
                    type="number"
                    value={h.timeout ?? 10000}
                    onChange={(e) => updateHandler(selectedMatcherIdx, hIdx, { timeout: parseInt(e.target.value) || 10000 })}
                    className={inputCls}
                  />
                </Field>
              </div>
            ))}

            {selectedGroup.hooks.length === 0 && (
              <div className="text-caption text-fg-muted">{t('settings.hookNoHooks')}</div>
            )}

            <button
              onClick={() => removeMatcherGroup(selectedMatcherIdx)}
              className={`${btnCls} flex items-center gap-1 border border-danger/30 text-danger hover:bg-danger/10`}
            >
              <Trash2 size={12} /> {t('settings.hookDeleteGroup')}
            </button>
          </div>
        ) : (
          <div className="flex-1 text-caption text-fg-muted">{t('settings.hookSelectGroup')}</div>
        )}
      </div>

      <div className="rounded-btn bg-bg-muted/50 px-3 py-2 text-[11px] text-fg-muted">
        <div className="mb-1 font-medium text-fg-secondary">{t('settings.hookExitTitle')}</div>
        {t('settings.hookExitDesc')}
      </div>
    </div>
  )
}