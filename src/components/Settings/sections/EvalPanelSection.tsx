/**
 * 为什么存在：AI 评估（评测套件）需要配置评测后端并按批次运行质量/回归评测，
 * 与日常设置隔离，独立区块承载。
 * 作用：渲染评估套件设置——评测后端接入（哈希/直连）与质量评测成本阈值，
 * 运行/重跑质量与回归评测并展示评分结果。
 */
import { useState, useEffect } from 'react'
import { Gauge, Server, Activity, Layers } from 'lucide-react'
import type { AppConfig, LLMProvider, EvalJudgeConfig, EvalCostThresholds } from '@shared/types'
import { useT } from '../../../i18n/useT'

interface EvalSuiteMeta {
  name: string
  kind: 'quality' | 'regression'
  count: number
}
interface EvalGradeResult {
  axis: string
  grader: string
  pass: boolean
  score: number
  reason?: string
  durationMs: number
}
interface EvalTrajectoryStep {
  role: 'user' | 'assistant' | 'tool'
  content: string
  toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>
  toolResult?: { ok: boolean; data?: unknown; error?: string }
  timestamp: number
}
interface EvalTranscript {
  taskId: string
  trial: number
  steps: EvalTrajectoryStep[]
  totalTokens: number
  totalDurationMs: number
  estimatedCost: number
}
interface EvalTrialResult {
  taskId: string
  trial: number
  transcript: EvalTranscript
  grades: EvalGradeResult[]
  passed: boolean
}
interface EvalSuiteResult {
  suite: string
  kind: 'quality' | 'regression'
  results: EvalTrialResult[]
  passRate: number
  taskPassRate: number
  totalCost: number
  totalDurationMs: number
  runAt: string
}

export function EvalPanel({
  config,
  onChange
}: {
  config: AppConfig
  onChange: (config: AppConfig) => void
}) {
  const t = useT()
  const [suites, setSuites] = useState<EvalSuiteMeta[]>([])
  const [selectedSuite, setSelectedSuite] = useState('')
  const [result, setResult] = useState<EvalSuiteResult | null>(null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState('')
  const [expandedTask, setExpandedTask] = useState<string | null>(null)
  const [expandedTrial, setExpandedTrial] = useState<string | null>(null)
  const [showJudgeConfig, setShowJudgeConfig] = useState(false)
  // 人工评分表单状态（直接对展开的 trial 评分，无需选择 task/trial）
  const [humanGradePass, setHumanGradePass] = useState(true)
  const [humanGradeReason, setHumanGradeReason] = useState('')
  const [humanGradeMsg, setHumanGradeMsg] = useState('')
  // 评分提交 busy 态：防双击重复提交同一条评分污染标注数据（评审 MINOR-6）
  const [grading, setGrading] = useState(false)

  const axisLabels: Record<string, string> = {
    task_completion: t('settings.evalTaskCompletion'),
    tool_selection: t('settings.evalToolSelection'),
    trajectory_quality: t('settings.evalTrajectory'),
    cost_latency: t('settings.evalCostLatency')
  }
  const graderLabels: Record<string, string> = {
    code: t('settings.evalCode'),
    model: t('settings.evalModel'),
    human: t('settings.evalHuman')
  }

  // 加载套件列表 + 上次结果
  useEffect(() => {
    const api = window.lunareclipse
    if (!api?.evalListSuites) return
    api.evalListSuites().then((list: EvalSuiteMeta[]) => {
      setSuites(list)
      if (list.length > 0 && !selectedSuite) setSelectedSuite(list[0].name)
    }).catch((err: unknown) => {
      // 加载失败提示（评审 MINOR-7）：不静默留在空列表，区分「没有套件」与「加载失败」
      setError(err instanceof Error ? err.message : t('settings.evalLoadFail'))
    })
    api.evalGetLastResult?.().then((r: EvalSuiteResult | null) => {
      if (r) setResult(r)
    }).catch(() => {
      // 上次结果缺失不阻塞面板（仅无历史结果展示），静默即可
    })
  }, [])

  // 运行套件
  const runSuite = async () => {
    if (!selectedSuite || running) return
    const api = window.lunareclipse
    if (!api?.evalRunSuite) return
    setRunning(true)
    setError('')
    setResult(null)
    try {
      const res = await api.evalRunSuite(selectedSuite)
      if (res.ok && res.result) {
        setResult(res.result)
      } else {
        setError(res.error ?? t('settings.evalRunFail'))
      }
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setRunning(false)
    }
  }

  const inputCls =
    'h-8 w-full rounded-btn border border-border bg-bg-elevated px-2.5 text-caption text-fg-primary focus:border-accent focus:outline-none'
  const btnCls =
    'rounded-btn px-3 py-1.5 text-caption transition-all duration-150 active:scale-95'

  // 按 taskId 分组 trial
  const taskGroups = new Map<string, EvalTrialResult[]>()
  if (result) {
    for (const t of result.results) {
      const arr = taskGroups.get(t.taskId) ?? []
      arr.push(t)
      taskGroups.set(t.taskId, arr)
    }
  }

  // 更新 eval.judge 配置
  const updateJudge = (patch: Partial<EvalJudgeConfig>) => {
    const currentEval = config.eval ?? {}
    const currentJudge = currentEval.judge ?? {}
    onChange({
      ...config,
      eval: {
        ...currentEval,
        judge: { ...currentJudge, ...patch }
      }
    })
  }
  // 更新 eval.costThresholds 配置
  const updateThresholds = (patch: Partial<EvalCostThresholds>) => {
    const currentEval = config.eval ?? {}
    const currentThresholds = currentEval.costThresholds ?? {}
    onChange({
      ...config,
      eval: {
        ...currentEval,
        costThresholds: { ...currentThresholds, ...patch }
      }
    })
  }

  const judgeConfig = config.eval?.judge ?? {}
  const thresholds = config.eval?.costThresholds ?? {}

  return (
    <div className="space-y-4">
      {/* Judge 配置（折叠区） */}
      <section>
        <button
          onClick={() => setShowJudgeConfig(!showJudgeConfig)}
          className="flex w-full items-center justify-between rounded-btn bg-bg-muted/50 px-3 py-2 text-left transition-colors hover:bg-bg-muted"
        >
          <div className="flex items-center gap-2 text-caption uppercase tracking-wider text-fg-muted">
            <Server size={12} />
            {t('settings.evalJudgeConfig')}
          </div>
          <span className="text-[10px] text-fg-muted">{showJudgeConfig ? '▾' : '▸'}</span>
        </button>
        {showJudgeConfig && (
          <div className="mt-2 space-y-3 rounded-card border border-border-subtle bg-bg-elevated p-3">
            <div className="text-[11px] text-fg-muted">
              {t('settings.evalJudgeDesc')}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-[11px] text-fg-muted">{t('settings.evalJudgeModel')}</label>
                <input
                  type="text"
                  value={judgeConfig.model ?? ''}
                  onChange={(e) => updateJudge({ model: e.target.value })}
                  placeholder={t('settings.evalJudgeModelPh')}
                  className={inputCls}
                />
              </div>
              <div>
                <label className="mb-1 block text-[11px] text-fg-muted">{t('settings.evalJudgeProvider')}</label>
                <select
                  value={judgeConfig.provider ?? ''}
                  onChange={(e) => updateJudge({ provider: (e.target.value || undefined) as LLMProvider | undefined })}
                  className={inputCls}
                >
                  <option value="">{t('settings.evalSameGen')}</option>
                  <option value="openai">openai</option>
                  <option value="anthropic">anthropic</option>
                  <option value="ollama">ollama</option>
                  <option value="local">local</option>
                </select>
              </div>
              <div className="col-span-2">
                <label className="mb-1 block text-[11px] text-fg-muted">baseURL</label>
                <input
                  type="text"
                  value={judgeConfig.baseURL ?? ''}
                  onChange={(e) => updateJudge({ baseURL: e.target.value })}
                  placeholder={t('settings.evalJudgeBasePh')}
                  className={inputCls}
                />
              </div>
              <div className="col-span-2">
                <label className="mb-1 block text-[11px] text-fg-muted">apiKey</label>
                <input
                  type="password"
                  value={judgeConfig.apiKey ?? ''}
                  onChange={(e) => updateJudge({ apiKey: e.target.value })}
                  placeholder={t('settings.evalJudgeKeyPh')}
                  className={inputCls}
                />
              </div>
            </div>
            {/* 成本/延迟阈值 */}
            <div className="border-t border-border-subtle pt-3">
              <div className="mb-2 text-[11px] font-medium text-fg-secondary">{t('settings.evalCostThreshold')}</div>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="mb-1 block text-[11px] text-fg-muted">{t('settings.evalMaxToken')}</label>
                  <input
                    type="number"
                    value={thresholds.maxTokens ?? 50000}
                    onChange={(e) => updateThresholds({ maxTokens: Number(e.target.value) || undefined })}
                    className={inputCls}
                  />
                </div>
                <div>
                  <label className="mb-1 block text-[11px] text-fg-muted">{t('settings.evalMaxLatency')}</label>
                  <input
                    type="number"
                    value={thresholds.maxMs ?? 60000}
                    onChange={(e) => updateThresholds({ maxMs: Number(e.target.value) || undefined })}
                    className={inputCls}
                  />
                </div>
                <div>
                  <label className="mb-1 block text-[11px] text-fg-muted">{t('settings.evalMaxCost')}</label>
                  <input
                    type="number"
                    step="0.01"
                    value={thresholds.maxCost ?? 0.5}
                    onChange={(e) => updateThresholds({ maxCost: Number(e.target.value) || undefined })}
                    className={inputCls}
                  />
                </div>
              </div>
            </div>
          </div>
        )}
      </section>

      {/* 标题 + 套件选择 + 运行 */}
      <section>
        <div className="mb-3 flex items-center gap-2 text-caption uppercase tracking-wider text-fg-muted">
          <Gauge size={12} />
          {t('settings.evalSuite')}
        </div>
        <div className="flex items-end gap-3">
          <div className="flex-1">
            <label className="mb-1 block text-[11px] text-fg-muted">{t('settings.evalSelectSuite')}</label>
            <select
              value={selectedSuite}
              onChange={(e) => setSelectedSuite(e.target.value)}
              className={inputCls}
              disabled={running}
            >
              {suites.map((s) => (
                <option key={s.name} value={s.name}>
                  {s.name}（{s.kind === 'quality' ? t('settings.evalQuality') : t('settings.evalRegression')}，{t('settings.evalTaskCount', { n: s.count })}）
                </option>
              ))}
            </select>
          </div>
          <button
            onClick={runSuite}
            disabled={!selectedSuite || running}
            className={`${btnCls} bg-accent text-accent-fg disabled:opacity-40`}
          >
            {running ? t('settings.evalRunning') : t('settings.evalRun')}
          </button>
        </div>
        {error && (
          <div className="mt-2 rounded-btn bg-danger/10 px-3 py-1.5 text-[11px] text-danger">
            {error}
          </div>
        )}
      </section>

      {/* 结果概览 */}
      {result && (
        <section>
          <div className="mb-3 flex items-center gap-2 text-caption uppercase tracking-wider text-fg-muted">
            <Activity size={12} />
            {t('settings.evalResult', { time: new Date(result.runAt).toLocaleString() })}
          </div>
          <div className="grid grid-cols-4 gap-2">
            <div className="rounded-card border border-border-subtle bg-bg-elevated px-3 py-2">
              <div className="text-[10px] text-fg-muted">{t('settings.evalSuiteLabel')}</div>
              <div className="text-caption text-fg-primary">{result.suite}</div>
            </div>
            <div className="rounded-card border border-border-subtle bg-bg-elevated px-3 py-2">
              <div className="text-[10px] text-fg-muted">{t('settings.evalTaskPass')}</div>
              <div
                className={`text-caption font-medium ${
                  result.taskPassRate >= 0.95
                    ? 'text-success'
                    : result.taskPassRate >= 0.5
                      ? 'text-warning'
                      : 'text-danger'
                }`}
              >
                {(result.taskPassRate * 100).toFixed(1)}%
              </div>
            </div>
            <div className="rounded-card border border-border-subtle bg-bg-elevated px-3 py-2">
              <div className="text-[10px] text-fg-muted">{t('settings.evalTrialPass')}</div>
              <div className="text-caption text-fg-primary">
                {(result.passRate * 100).toFixed(1)}%
              </div>
            </div>
            <div className="rounded-card border border-border-subtle bg-bg-elevated px-3 py-2">
              <div className="text-[10px] text-fg-muted">{t('settings.evalCostTime')}</div>
              <div className="text-caption text-fg-primary">
                ${result.totalCost.toFixed(4)} · {(result.totalDurationMs / 1000).toFixed(1)}s
              </div>
            </div>
          </div>
        </section>
      )}

      {/* 任务详情列表 */}
      {result && taskGroups.size > 0 && (
        <section>
          <div className="mb-3 flex items-center gap-2 text-caption uppercase tracking-wider text-fg-muted">
            <Layers size={12} />
            {t('settings.evalTaskDetail')}
          </div>
          <div className="space-y-2">
            {Array.from(taskGroups.entries()).map(([taskId, trials]) => {
              const anyPass = trials.some((t) => t.passed)
              const allPass = trials.every((t) => t.passed)
              const taskExpanded = expandedTask === taskId
              return (
                <div
                  key={taskId}
                  className="rounded-card border border-border-subtle bg-bg-elevated"
                >
                  <button
                    onClick={() => setExpandedTask(taskExpanded ? null : taskId)}
                    className="flex w-full items-center justify-between px-3 py-2 text-left transition-colors hover:bg-bg-muted/50"
                  >
                    <div className="flex items-center gap-2">
                      <span
                        className={`inline-block h-2 w-2 rounded-full ${
                          allPass ? 'bg-success' : anyPass ? 'bg-warning' : 'bg-danger'
                        }`}
                      />
                      <span className="text-caption text-fg-primary">{taskId}</span>
                      <span className="text-[10px] text-fg-muted">
                        {t('settings.evalTrial', { n: trials.length })} · {allPass ? t('settings.evalAllPass') : anyPass ? t('settings.evalPartialPass') : t('settings.evalAllFail')}
                      </span>
                    </div>
                    <span className="text-[10px] text-fg-muted">{taskExpanded ? '▾' : '▸'}</span>
                  </button>

                  {taskExpanded && (
                    <div className="border-t border-border-subtle px-3 py-2">
                      {trials.map((trial) => {
                        const trialKey = `${trial.taskId}:${trial.trial}`
                        const trialExpanded = expandedTrial === trialKey
                        return (
                          <div key={trialKey} className="mb-2 last:mb-0">
                            <button
                              onClick={() => {
                                setExpandedTrial(trialExpanded ? null : trialKey)
                                // 切换 trial 时重置人工评分表单状态，避免残留上一个 trial 的值
                                if (!trialExpanded) {
                                  setHumanGradePass(true)
                                  setHumanGradeReason('')
                                  setHumanGradeMsg('')
                                }
                              }}
                              className="flex w-full items-center justify-between rounded-btn px-2 py-1 text-left hover:bg-bg-muted/50"
                            >
                              <div className="flex items-center gap-2">
                                <span
                                  className={`inline-block h-1.5 w-1.5 rounded-full ${
                                    trial.passed ? 'bg-success' : 'bg-danger'
                                  }`}
                                />
                                <span className="text-[11px] text-fg-secondary">
                                  Trial {trial.trial}
                                </span>
                                <span className="text-[10px] text-fg-muted">
                                  {trial.transcript.totalTokens} tokens ·{' '}
                                  {(trial.transcript.totalDurationMs / 1000).toFixed(1)}s · $
                                  {trial.transcript.estimatedCost.toFixed(4)}
                                </span>
                              </div>
                              <span className="text-[10px] text-fg-muted">
                                {trialExpanded ? '▾' : '▸'}
                              </span>
                            </button>

                            {trialExpanded && (
                              <div className="ml-4 mt-1 space-y-2 border-l border-border-subtle pl-3">
                                {/* 4 轴评分 */}
                                <div>
                                  <div className="mb-1 text-[10px] uppercase tracking-wider text-fg-muted">
                                    {t('settings.eval4Axis')}
                                  </div>
                                  {trial.grades.map((g, i) => (
                                    <div
                                      key={i}
                                      className="mb-1 flex items-start gap-2 text-[11px]"
                                    >
                                      <span
                                        className={`mt-0.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full ${
                                          g.pass ? 'bg-success' : 'bg-danger'
                                        }`}
                                      />
                                      <div className="flex-1">
                                        <span className="text-fg-secondary">
                                          {axisLabels[g.axis] ?? g.axis}
                                        </span>
                                        <span className="ml-1 text-[10px] text-fg-muted">
                                          ({graderLabels[g.grader] ?? g.grader},{' '}
                                          {(g.score * 100).toFixed(0)}%)
                                        </span>
                                        {g.reason && (
                                          <div className="mt-0.5 text-[10px] text-fg-muted">
                                            {g.reason}
                                          </div>
                                        )}
                                      </div>
                                    </div>
                                  ))}
                                </div>

                                {/* 轨迹步骤 */}
                                <div>
                                  <div className="mb-1 text-[10px] uppercase tracking-wider text-fg-muted">
                                    {t('settings.evalTrajectorySteps', { n: trial.transcript.steps.length })}
                                  </div>
                                  <div className="max-h-48 space-y-1 overflow-y-auto rounded-btn bg-bg-base/40 p-2">
                                    {trial.transcript.steps.map((step, i) => (
                                      <div key={i} className="text-[10px]">
                                        <span
                                          className={`font-medium ${
                                            step.role === 'user'
                                              ? 'text-accent'
                                              : step.role === 'assistant'
                                                ? 'text-fg-secondary'
                                                : 'text-fg-muted'
                                          }`}
                                        >
                                          [{step.role}]
                                        </span>
                                        <span className="ml-1 text-fg-muted">
                                          {step.content.slice(0, 200)}
                                          {step.content.length > 200 ? '…' : ''}
                                        </span>
                                        {step.toolCalls && step.toolCalls.length > 0 && (
                                          <div className="ml-3 text-warning">
                                            → {step.toolCalls.map((tc) => tc.name).join(', ')}
                                          </div>
                                        )}
                                      </div>
                                    ))}
                                  </div>
                                </div>

                                {/* 人工评分（直接对当前展开的 trial 评分） */}
                                <div className="rounded-btn bg-bg-muted/30 px-2 py-1.5">
                                  <div className="mb-1 text-[10px] text-fg-muted">
                                    {t('settings.evalHumanScore')}
                                  </div>
                                  <div className="flex items-center gap-2">
                                    <button
                                      onClick={() => setHumanGradePass(!humanGradePass)}
                                      className={`${btnCls} h-6 px-2 text-[11px] ${
                                        humanGradePass
                                          ? 'bg-success/20 text-success'
                                          : 'bg-danger/20 text-danger'
                                      }`}
                                    >
                                      {humanGradePass ? 'PASS' : 'FAIL'}
                                    </button>
                                    <input
                                      type="text"
                                      value={humanGradeReason}
                                      onChange={(e) => setHumanGradeReason(e.target.value)}
                                      placeholder={t('settings.evalScoreReason')}
                                      className={`${inputCls} h-6 flex-1 text-[11px]`}
                                    />
                                    <button
                                      onClick={async () => {
                                        const api = window.lunareclipse
                                        if (!api?.evalSubmitHumanGrade) return
                                        setGrading(true) // busy 阻断：防双击重复提交（评审 MINOR-6）
                                        try {
                                          const res = await api.evalSubmitHumanGrade(
                                            trial.taskId,
                                            trial.trial,
                                            humanGradePass,
                                            humanGradeReason
                                          )
                                          setHumanGradeMsg(
                                            res.ok ? t('settings.evalSubmitted') : res.error ?? t('settings.evalSubmitFail')
                                          )
                                          if (res.ok) setHumanGradeReason('')
                                        } catch (err) {
                                          setHumanGradeMsg((err as Error).message)
                                        } finally {
                                          setGrading(false)
                                        }
                                      }}
                                      disabled={grading}
                                      className={`${btnCls} h-6 px-2 text-[11px] bg-accent text-accent-fg disabled:opacity-50`}
                                    >
                                      {grading ? t('settings.evalSubmitting') : t('settings.evalSubmit')}
                                    </button>
                                  </div>
                                  {humanGradeMsg && (
                                    <div className="mt-1 text-[10px] text-fg-muted">
                                      {humanGradeMsg}
                                    </div>
                                  )}
                                </div>
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </section>
      )}

      {/* 空状态 */}
      {!result && !running && !error && (
        <div className="rounded-card border border-border-subtle bg-bg-elevated px-4 py-8 text-center text-caption text-fg-muted">
          {t('settings.evalEmptyHint')}
        </div>
      )}

      {/* 说明 */}
      <div className="rounded-btn bg-bg-muted/50 px-3 py-2 text-[11px] text-fg-muted">
        <div className="mb-1 font-medium text-fg-secondary">{t('settings.evalAboutTitle')}</div>
        {t('settings.evalAboutDesc')}
        {t('settings.evalAboutQuality')}
      </div>
    </div>
  )
}

/**
 * 工作区管理（AI 专属工作区）
 *
 * 设计与 MCP/Hooks 不同：工作区配置由后端持久化（.workspaces.json），
 * 每次 CRUD 操作直接走 IPC，后端写盘并返回新 config，前端只缓存内存副本。
 * - 列表：工作区名称 + 路径 + 激活标记
 * - 添加：选目录 → 输入名称 → IPC add
 * - 切换激活：点击列表项或单独按钮
 * - 删除：至少保留一个（后端强制）
 * - 重命名：双击名称进入编辑态
 *
 * 切换工作区会触发热重载：SkillLoader 重新读取项目级 .lunareclipse/skills/，
 * system prompt 重新注入新工作区路径 + 整洁规则。
 */
