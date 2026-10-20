// ===== LLM 工具循环守卫（纯函数/纯常量）=====
// 为什么存在：AI 在主循环里会盲目重试失败工具、反复调用读类工具做无用功，
// 需要独立可测试的纯逻辑层判定“失败/无进展/循环过载”，并给 AI 换策略的机会——
// 从 llm.ts 的 streamWithTools 提取的纯逻辑层：无实例状态依赖，只依赖入参。
// 四类检测：exact_failure（同工具+同参数失败）/ same_tool_failure（同工具失败，参数可不同）/
// idempotent_no_progress（读类工具结果 hash 相同=无进展）/ loop_caps（runaway 上限）。
// 软 warn 先注入提示（给 AI 换策略的机会），硬 halt 才 break（切断空转）。

/** 失败熔断阈值：同工具+同参数连续失败 ≥3 次直接 halt */
export const TOOL_FAILURE_HALT = 3

/** 幂等/读类工具：结果 hash 相同 → 判定"无进展"（治工具成功但空转） */
export const IDEMPOTENT_TOOLS = new Set([
  'Read',
  'read_md',
  'Grep',
  'Glob',
  'LS',
  'nng_graph',
  'cache_graph',
  'memory',
  'web_search',
  'web_extract',
  'session_search',
  'context_usage',
  'browser_snapshot'
])

/** 单轮(round)内 runaway 上限：web_search 搜索风暴 / 子agent·团队启动风暴 */
export const LOOP_CAP = {
  webSearchPerRound: 30,
  subAgentPerRound: 30
}

/** 工具执行阶段分类：读-读可并行，含写同路径串行，交互式强制 barrier */
export const READ_TOOLS = new Set([
  'Read',
  'read_md',
  'Grep',
  'Glob',
  'LS',
  'nng_graph',
  'cache_graph',
  'memory',
  'web_search',
  'context_usage'
])

export const WRITE_TOOLS = new Set([
  'Write',
  'Edit',
  'MoveFile',
  'DeleteFile',
  'CopyFile',
  'Mkdir'
])

export const INTERACTIVE_TOOLS = new Set(['dmn_ask_user'])

/**
 * 失败结果判定：工具结果统一是 JSON 字符串（工具抛异常也被包成 {error} JSON）。
 * 只认结构化失败信号：顶层 ok:false 或顶层 error 字段。
 * 2026-09-12 修复：原实现对整个结果做 /超时|timeout|404|not found|.../ 全文正则，
 * 而 Read/Grep 返回的 content 里天然含 timeout/超时/error 等词（读源码必然命中），
 * 正常读取被误判为失败 → same_tool_failure 护栏累计 → 误打断（用户看到的「🔇 自动打断」）。
 * 故改为解析 JSON 看结构字段，不再对正文做裸词匹配。
 */
export function isFailureResult(result: string): boolean {
  if (!result) return true
  const t = result.trim()
  try {
    const parsed = JSON.parse(t)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>
      if (obj.ok === false) return true
      if ('error' in obj && obj.error) return true
      return false
    }
  } catch {
    // 非 JSON：工具结果理论上是 JSON，走到这里说明是罕见的裸文本，按成功处理避免误伤。
    void t
  }
  return false
}

/**
 * 失败指纹：toolName + 参数值的有序拼接（稳定，URL/路径等关键参数变化即视为不同调用）。
 * arguments 传进来的是 JSON 字符串（OpenAI 工具参数），直接用原文作稳定指纹；
 * 若已是对象则取排序后的值拼接。同一重复调用签名应完全一致。
 */
export function failureFingerprint(name: string, input: Record<string, unknown> | string): string {
  if (typeof input === 'string') {
    return `${name}|${input}`
  }
  const vals = Object.keys(input)
    .sort()
    .map((k) => String(input[k]))
    .join('|')
  return `${name}|${vals}`
}

/**
 * 结果规范化后哈希（稳定序列化；非 JSON 用原文）。
 * 幂等工具结果 hash 相同 = 无进展。
 *
 * 2026-10-17 修复（分发前审查 · AI 工程面）：
 * 原实现 `JSON.stringify(parsed, Object.keys(parsed).sort())` 把「排序后的顶层键」当 replacer
 * 数组传入——JSON.stringify 的数组型 replacer 会**递归**按属性名白名单过滤，嵌套对象里
 * 不在该白名单中的键会被整体丢弃（{ok:true,data:{x:1}} → {"ok":true,"data":{}}）。
 * 后果：读类工具返回「同形不同内容」的嵌套结果时算出相同 hash → 误判「无进展」→
 * 第 3 次误注入告警、第 6 次直接 halt 打断对话（与 2026-09-12 那次误打断同属一类）。
 * 改为递归稳定序列化：对象键递归排序、数组保序、保留全部嵌套内容。
 */
export function resultHash(result: string): string {
  try {
    const parsed = JSON.parse(result)
    return stableStringify(parsed)
  } catch {
    return result
  }
}

/**
 * 递归稳定序列化：对象键排序后输出、数组保序、原始值直接序列化。
 * 为什么不用 JSON.stringify 的 replacer 参数：数组型 replacer 是「属性名白名单」且递归生效，
 * 会丢嵌套内容（见 resultHash 注释）；键顺序无关的稳定输出必须自己递归实现。
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(',')}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`
}

/** 子 agent 类工具名（Agent 工具 / team_launch / delegate_task），loop_caps 计数用 */
export function isSubAgentish(name: string): boolean {
  return name === 'Agent' || name === 'team_launch' || name === 'delegate_task'
}

/** 文本重复检测常量：每 64 个 content token 检测一次，尾部 512 字符窗口 */
export const REPETITION_CHECK_INTERVAL = 64
export const REPETITION_WINDOW = 512
export const REPETITION_MIN_UNIT = 24
export const REPETITION_MIN_COUNT = 3

/**
 * 检测文本尾部是否存在重复模式（generation loop breaker）。
 * 算法：在窗口内尝试所有可能的单元长度（24..窗口/3），
 * 对每个长度 L，检查尾部是否 = 某个长度 L 的子串连续重复 ≥3 次。
 * 从短到长试，命中即返回 true（短单元重复 = 更激进的循环，优先打断）。

 * 2026-08-26（奥卡姆剃刀补洞）：原 24 字符最小单元拦不住 9 字符的短句复读
 * （实录："你是在做什么"连刷 30+ 遍未被打断）。短单元单独走一个更严格的分支：
 * - 单元 8..23 字符：连续重复 ≥5 次才打断（避免误伤正常排比/强调）
 * - 单元 ≥24 字符：连续重复 ≥3 次打断（原逻辑）
 */
export function detectTailRepetition(text: string): boolean {
  // 前置门槛：短单元分支（8 字符 × 5 次 = 40）或长单元（24 × 3 = 72）任一达到即可检测
  if (text.length < 8 * 5) return false
  const window = text.slice(-REPETITION_WINDOW)
  // 短单元分支：8..23 字符，连续 ≥5 次
  for (let unitLen = 8; unitLen < REPETITION_MIN_UNIT; unitLen++) {
    const unit = window.slice(-unitLen)
    let count = 1
    let pos = window.length - unitLen
    while (pos - unitLen >= 0 && window.slice(pos - unitLen, pos) === unit) {
      count++
      pos -= unitLen
    }
    if (count >= 5) return true
  }
  // 原长单元分支：24..窗口/3，连续 ≥3 次
  for (
    let unitLen = REPETITION_MIN_UNIT;
    unitLen <= Math.floor(window.length / REPETITION_MIN_COUNT);
    unitLen++
  ) {
    const unit = window.slice(-unitLen)
    let count = 1
    let pos = window.length - unitLen
    while (pos - unitLen >= 0 && window.slice(pos - unitLen, pos) === unit) {
      count++
      pos -= unitLen
    }
    if (count >= REPETITION_MIN_COUNT) return true
  }
  return false
}

/** 从工具参数提取路径（string 类型参数里像路径的） */
export function extractPaths(args: Record<string, unknown>): string[] {
  const paths: string[] = []
  for (const v of Object.values(args)) {
    if (typeof v === 'string' && (v.includes('/') || v.includes('\\')) && v.length < 500) {
      paths.push(v.replace(/\\/g, '/'))
    } else if (Array.isArray(v)) {
      for (const item of v) {
        if (
          typeof item === 'string' &&
          (item.includes('/') || item.includes('\\')) &&
          item.length < 500
        ) {
          paths.push(item.replace(/\\/g, '/'))
        }
      }
    }
  }
  return paths
}

/** 两批是否路径重叠（含写工具同路径 → 冲突） */
export function pathsConflict(a: string[], b: string[]): boolean {
  for (const pa of a) {
    for (const pb of b) {
      if (pa === pb || pa.startsWith(pb + '/') || pb.startsWith(pa + '/')) return true
    }
  }
  return false
}