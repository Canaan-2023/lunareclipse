/**
 * @category i18n
 * @summary `eval` 域文案分片（50 条 zh/en 配对）
 * 为什么存在：界面文案随 UI 域增长，全部塞进单个 `locales.ts` 会让任意 UI 域的改动
 * 都在同一文件上产生 merge 冲突；按域分片后各域独立演进（ADR-07）。
 * 不删理由：本文件是该域文案的唯一来源，宿主 barrel 用对象展开合并；条目保持
 * `{ zh, en }` 成对（按域拆、**不按语言拆**——配对是「单侧漏 key」的类型级防线）。
 */
import type { DictEntry } from '../dict-types'

const dict = {
  // ===== 评测 =====
  'settings.evalTaskCompletion': { zh: '任务完成', en: 'Task Completion' },
  'settings.evalToolSelection': { zh: '工具选择', en: 'Tool Selection' },
  'settings.evalTrajectory': { zh: '轨迹质量', en: 'Trajectory Quality' },
  'settings.evalCostLatency': { zh: '成本/延迟', en: 'Cost/Latency' },
  'settings.evalCode': { zh: '代码型', en: 'Code' },
  'settings.evalModel': { zh: '模型型', en: 'Model' },
  'settings.evalHuman': { zh: '人工型', en: 'Human' },
  'settings.evalRunFail': { zh: '运行失败', en: 'Run failed' },
  'settings.evalLoadFail': { zh: '加载套件列表失败', en: 'Failed to load suites' },
  'settings.evalJudgeConfig': { zh: 'Judge 配置（防 SPB）', en: 'Judge Config (anti-SPB)' },
  'settings.evalJudgeDesc': { zh: '配置独立 provider 后，judge 使用独立 LLMClient 评分，真正防 Self-Preference Bias。未配置 baseURL/apiKey 时 judge 完全回退主 LLM（模型也用主配置）。temperature 始终强制 0（评分确定性）。', en: 'Independent provider for judge prevents Self-Preference Bias. Without baseURL/apiKey, judge fully falls back to main LLM (model included). temperature forced to 0 (deterministic scoring).' },
  'settings.evalJudgeModel': { zh: 'judge 模型名', en: 'Judge model' },
  'settings.evalJudgeModelPh': { zh: '留空则用主 LLM 模型', en: 'Empty = use main model' },
  'settings.evalJudgeProvider': { zh: 'provider（独立家族）', en: 'Provider (independent)' },
  'settings.evalSameGen': { zh: '（同 generator）', en: '(same as generator)' },
  'settings.evalJudgeBasePh': { zh: 'https://api.anthropic.com/v1（留空则同 generator）', en: 'https://api.anthropic.com/v1 (empty = same as generator)' },
  'settings.evalJudgeKeyPh': { zh: '留空则同 generator', en: 'Empty = same as generator' },
  'settings.evalCostThreshold': { zh: '成本/延迟阈值', en: 'Cost/Latency Thresholds' },
  'settings.evalMaxToken': { zh: '最大 token', en: 'Max tokens' },
  'settings.evalMaxLatency': { zh: '最大耗时(ms)', en: 'Max latency (ms)' },
  'settings.evalMaxCost': { zh: '最大成本($)', en: 'Max cost ($)' },
  'settings.evalSuite': { zh: '评测套件', en: 'Eval Suite' },
  'settings.evalSelectSuite': { zh: '选择套件', en: 'Select suite' },
  'settings.evalQuality': { zh: '能力评估', en: 'Quality' },
  'settings.evalRegression': { zh: '回归评估', en: 'Regression' },
  'settings.evalTaskCount': { zh: '{n} 任务', en: '{n} tasks' },
  'settings.evalRun': { zh: '运行套件', en: 'Run suite' },
  'settings.evalRunning': { zh: '运行中…', en: 'Running…' },
  'settings.evalResult': { zh: '运行结果（{time}）', en: 'Results ({time})' },
  'settings.evalSuiteLabel': { zh: '套件', en: 'Suite' },
  'settings.evalTaskPass': { zh: '任务通过率', en: 'Task pass rate' },
  'settings.evalTrialPass': { zh: 'trial 通过率', en: 'Trial pass rate' },
  'settings.evalCostTime': { zh: '成本/耗时', en: 'Cost/Time' },
  'settings.evalTaskDetail': { zh: '任务详情（按 Pass@k / Pass^k 聚合）', en: 'Task Details (by Pass@k / Pass^k)' },
  'settings.evalAllPass': { zh: '全部通过', en: 'All pass' },
  'settings.evalPartialPass': { zh: '部分通过', en: 'Partial pass' },
  'settings.evalAllFail': { zh: '全部失败', en: 'All fail' },
  'settings.evalTrial': { zh: '{n} trial', en: '{n} trial' },
  'settings.eval4Axis': { zh: '4 轴评分', en: '4-axis Score' },
  'settings.evalTrajectorySteps': { zh: '轨迹（{n} 步）', en: 'Trajectory ({n} steps)' },
  'settings.evalHumanScore': { zh: '人工评分（校准模型型评分器）', en: 'Human Score (calibrate)' },
  'settings.evalScoreReason': { zh: '评分理由（可选）', en: 'Score reason (optional)' },
  'settings.evalSubmitted': { zh: '已提交', en: 'Submitted' },
  'settings.evalSubmitting': { zh: '提交中…', en: 'Submitting…' },
  'settings.evalSubmitFail': { zh: '提交失败', en: 'Submit failed' },
  'settings.evalSubmit': { zh: '提交', en: 'Submit' },
  'settings.evalEmptyHint': { zh: '选择套件并点击"运行套件"开始评测', en: 'Select a suite and click "Run" to start' },
  'settings.evalAboutTitle': { zh: '关于评测', en: 'About Eval' },
  'settings.evalAboutDesc': { zh: '4 轴指标：任务完成 / 工具选择 / 轨迹质量（LLM-as-judge）/ 成本延迟。Pass@k（any 模式）= k 次至少 1 次成功；Pass^k（all 模式）= k 次全部成功。', en: '4-axis metrics: Task completion / Tool selection / Trajectory quality (LLM-as-judge) / Cost-latency. Pass@k (any mode) = at least 1 of k succeeds; Pass^k (all mode) = all k succeed.' },
  'settings.evalAboutQuality': { zh: '能力评估（quality）通过率 30-50% 为正常；回归评估（regression）应接近 100%。', en: 'Quality eval: 30-50% pass is normal. Regression eval: ~100%.' },

} satisfies Record<string, DictEntry>

export default dict
