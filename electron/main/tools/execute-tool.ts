/**
 * @category 工具
 * @summary 工具执行控制器：能力闸 + Pre/PostToolUse Hook + 行为策略化消费 + 超时/取消，统一入口 executeTool
 * @note 为什么存在：所有工具调用必须经过同一条执行链，否则任何旁路都会绕过安全审批与行为策略；
 * 本模块是唯一的工具执行入口。真实执行顺序（自上而下）：
 *   1. 计划模式只读闸：只放行 enter/exit_plan_mode、batch_tools 与 readOnly 工具（写操作获批后再动手）；
 *   2. 声明式能力闸：config 能力策略预检，未启用默认放行；自身异常按放行处理（fail-open，不误封工具）；
 *   3. 权限覆写 deny：管理策略 toolPermissionOverrides 显式拒绝（只能收紧不能放宽）；
 *   4. require-approval 审批层：acceptEdits 自动接受 / auto 分类器裁决 / 用户授权弹窗，deny 一律拒绝；
 *   5. 调用级动态描述：基于本次入参生成，供审批提示与审计日志使用；
 *   6. PreToolUse Hook：治理护栏（可阻断、可修订参数，修订后刷新动态描述）；
 *   7. 工具级权限前置校验 checkAllowed（fail-closed：校验抛错或被拒一律拒绝执行）；
 *   8. 等价去重：仅 readOnly + inputFingerprint 命中缓存直接复用上次结果（结果不变无需重复审计）；
 *   9. 统一执行体：信号竞速（取消/超时 abort）执行工具 + 大结果落盘（超过 resultLimitChars 先落盘返回摘要与路径）；
 *  10. 成功结果写入去重缓存（失败不入缓存，保留重试机会）；
 *  11. PostToolUse Hook：结果审计（可改写结果，不阻断已执行动作）。
 * 顺序纪律：先安全闸后执行、先权限后去重、先执行后审计——任何把执行提前的调整都会产生绕过窗口。
 *
 * 行为策略化消费（契约见 base-tool.ts ToolBehavior，缺省值见 resolveToolBehavior）：
 * - checkAllowed：工具级权限前置校验（能力闸与 PreToolUse 之后、实际执行之前，fail-closed）
 * - concurrencySafe=false 时：同会话同工具串行排队，防止并发写同一资源/状态
 * - readOnly + inputFingerprint：相同输入的重复调用 LRU 去重，直接复用上次结果
 * - resultLimitChars：结果序列化超限时先落盘、返回摘要与路径，替代固定字符数硬截断
 * 全部缺省 fail-closed：存量工具不做任何声明时，本层行为与改造前完全一致（零破坏）。
 */
import type { ToolResult } from './base-tool'
import { resolveToolBehavior } from './base-tool'
import { isPlanModeActive } from './plan-mode'
import { isAcceptEditsActive, isEditAutoApproved } from './accept-edits-mode'
import { isAutoPermissionActive, classifyToolCall, type AutoPermissionDecision } from './auto-classifier'
import type { ToolRegistry } from './tool-registry'
import type { HookContext } from '../hooks/types'
import type { ToolPermissionPolicy } from '@shared/types/command-policy'
import { checkCapability } from '../kernel'
import { getAllToolMetas } from '@shared/tools/registry'
import { getToolSignal } from '../api/llm-types'
import { getAppAnchor } from '../utils/app-root'
import { mkdir, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { randomUUID, createHash } from 'crypto'

// ===== 等价去重缓存（LRU）=====
// 只缓存 readOnly + inputFingerprint 的工具结果；键 = 会话 | 工具 | 输入指纹。
// LRU 实现：Map 天然保持插入序，命中时 delete+set 刷新到尾部，超容量淘汰头部。
const DEDUPE_CACHE_MAX = 512
const dedupeCache = new Map<string, ToolResult>()

function dedupeGet(key: string): ToolResult | undefined {
  const hit = dedupeCache.get(key)
  if (hit) {
    dedupeCache.delete(key)
    dedupeCache.set(key, hit)
  }
  return hit
}

function dedupeSet(key: string, result: ToolResult): void {
  dedupeCache.delete(key)
  dedupeCache.set(key, result)
  if (dedupeCache.size > DEDUPE_CACHE_MAX) {
    const oldest = dedupeCache.keys().next().value
    if (oldest !== undefined) dedupeCache.delete(oldest)
  }
}

// ===== 并发调度（同会话同工具串行队列）=====
// 只对 behavior.concurrencySafe=false 的工具生效（缺省按 riskLevel 推断：high/medium 串行、low 并行）。
// 队列尾部 Promise 永远不 reject（错误已由 task 内部收敛），保证链不断裂；队列清空时自动移除 key，防止长期累积。
const serialQueues = new Map<string, Promise<unknown>>()

function enqueueSerial<T>(key: string, task: () => Promise<T>): Promise<T> {
  const prev = serialQueues.get(key) ?? Promise.resolve()
  const run = prev.then(task, task)
  const tail = run.then(
    () => {
      if (serialQueues.get(key) === tail) serialQueues.delete(key)
    },
    () => {
      if (serialQueues.get(key) === tail) serialQueues.delete(key)
    }
  )
  serialQueues.set(key, tail)
  return run
}

// ===== 调用级动态描述缓存（LRU，inputHash）=====
// 只缓存 dynamicDescription 生成的描述；键 = 会话 | 工具 | 入参哈希。
// 语义与去重缓存一致：Map 保持插入序，命中刷新到尾部，超容量淘汰头部。
// 为什么缓存：动态描述按本次入参生成，同参连续调用（如 AI 反复读同一批文件）
// 不必重复构造字符串，也避免把可变上下文塞进描述造成抖动。
const DYNAMIC_DESC_CACHE_MAX = 512
const dynamicDescCache = new Map<string, string>()

function dynamicDescGet(key: string): string | undefined {
  const hit = dynamicDescCache.get(key)
  if (hit) {
    dynamicDescCache.delete(key)
    dynamicDescCache.set(key, hit)
  }
  return hit
}

function dynamicDescSet(key: string, value: string): void {
  dynamicDescCache.delete(key)
  dynamicDescCache.set(key, value)
  if (dynamicDescCache.size > DYNAMIC_DESC_CACHE_MAX) {
    const oldest = dynamicDescCache.keys().next().value
    if (oldest !== undefined) dynamicDescCache.delete(oldest)
  }
}

/** 入参哈希：稳定序列化 + sha256。
 * 为什么排序键：对象键顺序不代表语义差异，同一组参数仅因键序不同会生成不同指纹，
 * 白白降低去重/动态描述缓存命中率；递归排序后同参必同串。 */
function hashParams(params: Record<string, unknown>): string {
  return createHash('sha256').update(stableStringify(params)).digest('hex')
}

/** 稳定序列化：对象键递归排序后 JSON.stringify（数组元素顺序保留，数组内对象同样排序键） */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(',')}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  const parts = keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
  return `{${parts.join(',')}}`
}

// ===== 大结果落盘 =====
// 结果序列化超过工具声明的 resultLimitChars 时：整份 JSON 落盘到 appDataDir/tool-results 下，
// 返回 data（超长字符串已摘要化）+ resultFile 路径。AI 需要全文时用 Read 读该路径即可。
// 为什么替代固定字符数硬截断：原 buildToolSummary 的 4000 截断会把命令输出/大文件内容一刀切，
// AI 拿不到后半段且无路径可循；落盘方案保留全文可追溯，上下文只承载摘要。
const TOOL_RESULT_DIR_NAME = 'tool-results'
/** 落盘摘要中单个字符串字段的保留长度（低于截断阈值，兼顾上下文体积） */
const SPILL_TRIM_CHARS = 400
/** 深拷贝遍历深度上限（防止循环引用导致的无限递归） */
const SPILL_MAX_DEPTH = 4

function trimStringsDeep(value: unknown, depth = 0): unknown {
  if (depth > SPILL_MAX_DEPTH) return value
  if (typeof value === 'string') {
    if (value.length <= SPILL_TRIM_CHARS) return value
    return `${value.slice(0, SPILL_TRIM_CHARS)}\n... (已截断，全文见 resultFile)`
  }
  if (Array.isArray(value)) return value.map((v) => trimStringsDeep(v, depth + 1))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = trimStringsDeep(v, depth + 1)
    }
    return out
  }
  return value
}

async function spillLargeResult(
  result: ToolResult,
  toolName: string,
  appDataDir: string | undefined
): Promise<ToolResult> {
  const json = JSON.stringify(result)
  const dir = join(appDataDir ?? tmpdir(), TOOL_RESULT_DIR_NAME)
  await mkdir(dir, { recursive: true })
  const file = join(dir, `${toolName}-${Date.now()}-${randomUUID().slice(0, 6)}.json`)
  await writeFile(file, json, 'utf-8')
  const data = (result.data ?? {}) as Record<string, unknown>
  return {
    ok: true,
    data: {
      ...(trimStringsDeep(data) as Record<string, unknown>),
      resultFile: file,
      resultChars: json.length
    }
  }
}

export async function executeTool(
  registry: ToolRegistry,
  name: string,
  params: Record<string, unknown>,
  signal?: AbortSignal
): Promise<ToolResult> {
  const tool = registry.tools.get(name)
  if (!tool) {
    return { ok: false, error: `工具未注册: ${name}` }
  }

  if (signal?.aborted) {
    return { ok: false, error: '工具执行已被取消' }
  }

  // 行为解析：显式声明优先，未声明按 fail-closed 缺省值（readOnly=false、按风险推断并发、无权限前置/去重/落盘）
  const allMeta = getAllToolMetas()
  const meta = allMeta.find((m) => m.id === name)
  const behavior = resolveToolBehavior(tool.behavior, meta ? { riskLevel: meta.riskLevel } : undefined)

  // 会话 key（执行链统一口径：sessionId ?? taskId ?? 'global'）：
  // 提前定义供计划模式闸与调用级动态描述共享（后者在闭包内引用，需在闭包定义前声明）
  const sessionKey = registry.ctx.sessionId ?? registry.ctx.taskId ?? 'global'

  // ===== 计划模式只读闸 =====
  // 计划模式下只放行：计划模式出入口（enter/exit）、只读工具（behavior.readOnly=true）、
  // batch_tools（纯编排，其子步骤逐子走 executeTool 仍会被本闸拦截，写操作无法经批次绕过）。
  // 其余会改动文件/执行命令/产生其他影响的工具一律拒绝，保持"先探索设计、获批后再动手"的语义。
  if (
    isPlanModeActive(sessionKey) &&
    name !== 'enter_plan_mode' &&
    name !== 'exit_plan_mode' &&
    name !== 'batch_tools' &&
    !behavior.readOnly
  ) {
    return {
      ok: false,
      error:
        '计划模式只读阶段：本操作会改动文件、执行命令或产生其他影响，已被拒绝。请继续用只读工具探索设计；方案就绪后用 exit_plan_mode 提交计划并获批，再执行实际操作。'
    }
  }

  // 声明式能力闸（CapabilityGuard）：在 PreToolUse 用户 hook 之前做第一道结构化能力校验；
  // policy 存 config（getEffective 实时读，运行时可改、不触发插件 reload）。默认未开启 = 全放行。
  try {
    const decision = checkCapability(
      name,
      meta ? { caps: meta.caps, riskLevel: meta.riskLevel } : undefined,
      registry.ctx.config
    )
    if (!decision.allowed) {
      return { ok: false, error: `被能力策略拒绝: ${decision.reason ?? '未授权'}` }
    }
  } catch (err) {
    // 能力闸自身异常不阻塞工具（fail-open：策略不可用时放行，避免误封工具）；
    // 打印日志便于发现配置或策略代码问题
    console.warn(`[execute-tool] 能力闸检查异常，按放行处理: ${name}`, err)
  }

  // 工具级权限覆写（管理策略）：config.toolPermissionOverrides[name]
  // 为什么单独一层：工具默认审批由实现内建（run_command 的命令审批、system_setting 弹窗），
  // 管理员应在配置层对单个工具做统一收紧而不必改工具代码；只能收紧不能放宽——
  // deny 直接拒绝调用；require-approval 每次调用都要求用户授权（绿通开启时被全局授权
  // 覆盖：requestPermission 内部在绿通下直接放行，语义见 permission-bridge）。
  const rawConfig = (registry.ctx.config ?? {}) as { toolPermissionOverrides?: Record<string, ToolPermissionPolicy> }
  const permissionOverride = rawConfig.toolPermissionOverrides?.[name]
  if (permissionOverride === 'deny') {
    return { ok: false, error: `工具 ${name} 已被权限策略拒绝（deny）` }
  }
  // 自动编辑模式（acceptEdits）：编辑白名单工具（Edit/Write/NotebookEdit）自动接受逐次授权
  // 请求，不再打断用户。deny 优先（管理员收紧不能放宽）；能力闸与 PreToolUse 治理 hook 仍
  // 生效，不经由模式绕过；删除/移动/命令执行等破坏性工具不在白名单，照常按原审批。
  const acceptEditsAutoApproved = isAcceptEditsActive(sessionKey) && isEditAutoApproved(name)
  if (permissionOverride === 'require-approval' && !acceptEditsAutoApproved) {
    // 自动权限模式（auto 分类器，⑧ 替代）：require-approval 工具的逐次授权请求先交由主模型
    // 分类——allow 跳过人工审批直接放行；deny 直接拒绝（deny 优先）；review / LLM 未配置 /
    // 分类失败一律回退原人工审批（fail-closed，绝不因分类器不可用而放行）。
    // 与 acceptEdits 同层纪律：能力闸与 PreToolUse 治理 hook 仍生效，不经由模式绕过。
    let autoDecision: AutoPermissionDecision = 'review'
    if (isAutoPermissionActive(sessionKey)) {
      autoDecision = await classifyToolCall(registry.ctx.config, name, tool.description, params)
    }
    if (autoDecision === 'deny') {
      return { ok: false, error: `工具 ${name} 被自动权限分类器拒绝（deny）` }
    }
    if (autoDecision !== 'allow') {
      if (!registry.ctx.requestPermission) {
        return { ok: false, error: `工具 ${name} 需要用户授权，但 requestPermission 未初始化` }
      }
      const resp = await registry.ctx.requestPermission({
        type: 'setting',
        description: `允许 AI 调用工具 ${name}`,
        content: `工具 ${name} 被配置为每次调用需用户授权（toolPermissionOverrides）\n${tool.description.slice(0, 300)}`,
        risk: meta?.riskLevel ?? 'low'
      })
      if (!resp.allowed) {
        return { ok: false, error: `用户拒绝了工具调用 ${name}: ${resp.reason ?? '无原因'}` }
      }
    }
  }

  // 调用级动态描述：在执行前基于本次入参生成，供审批提示/审计日志使用（fail-safe）。
  // Hook 可能修改参数，故在 PreToolUse 与参数修订后各取一次；同参命中 inputHash 缓存。
  const resolveCallDescription = (p: Record<string, unknown>): string | undefined => {
    if (!behavior.dynamicDescription) return undefined
    try {
      const d = behavior.dynamicDescription(p, registry.ctx)
      if (typeof d !== 'string' || d.length === 0) return undefined
      const key = `${sessionKey}|${name}|${hashParams(p)}`
      const cached = dynamicDescGet(key)
      if (cached !== undefined) return cached
      dynamicDescSet(key, d)
      return d
    } catch {
      return undefined
    }
  }
  // 初版描述（供 PreToolUse 护栏参考；Hook 修订参数后可能刷新）
  let callDescription = resolveCallDescription(params)

  // 控制层：PreToolUse Hook（权限检查/参数校验/阻断）
  const hookManager = registry.ctx.hookManager
  if (hookManager && hookManager.isLoaded()) {
    // 治理开关透传（PreToolUse hook 用）：从 ctx.config getter 读当前生效配置
    const rawConfig = (registry.ctx.config ?? {}) as Record<string, unknown>
    const preResult = await hookManager.run('PreToolUse', {
      event: 'PreToolUse',
      toolName: name,
      toolParams: params,
      callDescription,
      destructive: behavior.destructive,
      sessionId: registry.ctx.sessionId ?? undefined,
      workflowId: registry.ctx.taskId,
      governance: (rawConfig.governance ?? undefined) as HookContext['governance'],
      cwd: getAppAnchor()
    })
    if (preResult.action === 'block') {
      return { ok: false, error: `被 Hook 阻止: ${preResult.message ?? ''}` }
    }
    if (preResult.action === 'error') {
      return { ok: false, error: `Hook 错误: ${preResult.message ?? ''}` }
    }
    // PreToolUse 可修改参数（指纹/执行都基于修改后的参数，保证与实际执行一致）
    if (preResult.modifiedParams) {
      Object.assign(params, preResult.modifiedParams)
      // 参数被护栏修订后刷新调用级描述，保证审批/审计描述与实际执行参数一致
      callDescription = resolveCallDescription(params)
    }
  }

  // 工具级权限前置校验：在 PreToolUse 之后、实际执行之前（fail-closed——校验抛错或被拒一律拒绝执行）
  if (behavior.checkAllowed) {
    let allowed: boolean
    try {
      allowed = await behavior.checkAllowed(registry.ctx)
    } catch {
      allowed = false
    }
    if (!allowed) {
      // 拒绝消息附带调用级描述，让用户/审计看到"本次具体要做什么"而不是只有工具名
      const suffix = callDescription ? `（${callDescription}）` : ''
      return { ok: false, error: `被工具权限策略拒绝: ${name}${suffix}` }
    }
  }

  // 等价去重：仅 readOnly + inputFingerprint 的工具；指纹返回 undefined = 不去重。
  // 命中缓存直接复用上次结果（跳过执行/落盘/PostToolUse，结果不变无需重复审计）。
  const cacheKey = (() => {
    if (!behavior.readOnly || !behavior.inputFingerprint) return undefined
    let fp: string | undefined
    try {
      fp = behavior.inputFingerprint(params)
    } catch {
      fp = undefined
    }
    return fp === undefined ? undefined : `${sessionKey}|${name}|${fp}`
  })()
  if (cacheKey) {
    const hit = dedupeGet(cacheKey)
    if (hit) return hit
  }

  // 统一执行体：信号竞速 + 取消 → 结果（并发调度只控制"何时开始"，不改变执行语义）
  const executeOnce = async (): Promise<ToolResult> => {
    let result: ToolResult
    try {
      // 取消信号来源：调用方显式传入（记忆工作流等）优先，否则读 llm.ts 工具循环经
      // AsyncLocalStorage 注入的信号（前端主链路）。注入 ToolContext.signal 后，
      // 工具监听 abort 在超时/打断时终止自身工作——契约见 base-tool.ts；
      // 当前 run_command 已按契约终止子进程树，其余长任务工具待接入（未接入者只会被外层放弃，不会真正取消）。
      const cancelSignal = signal ?? getToolSignal()
      if (cancelSignal?.aborted) {
        // 已中止：直接短路，不执行工具（ALS 信号可能在进入前就已 abort）
        result = { ok: false, error: '工具执行已被取消' }
      } else {
        const toolCtx = cancelSignal ? { ...registry.ctx, signal: cancelSignal } : registry.ctx
        const execPromise = Promise.resolve(tool.execute(params, toolCtx))
        if (cancelSignal) {
          let onAbort: (() => void) | undefined
          const abortPromise = new Promise<ToolResult>((resolve) => {
            onAbort = () => resolve({ ok: false, error: '工具执行已被取消（超时）' })
            cancelSignal.addEventListener('abort', onAbort, { once: true })
          })
          result = await Promise.race([execPromise, abortPromise])
          // 工具先返回时必须摘除监听器，否则它一直挂在 signal 上直到 GC（每次调用堆一个）
          if (onAbort) cancelSignal.removeEventListener('abort', onAbort)
        } else {
          result = await execPromise
        }
      }
    } catch (err) {
      result = { ok: false, error: (err as Error).message }
    }

    // 大结果落盘：仅对显式声明 resultLimitChars 的工具生效（undefined = 不做，保持既有行为）
    if (behavior.resultLimitChars) {
      try {
        const json = JSON.stringify(result)
        if (json.length > behavior.resultLimitChars) {
          result = await spillLargeResult(result, name, registry.ctx.appDataDir)
        }
      } catch {
        // 落盘失败不阻塞工具结果（上下文仍按原样返回，降级为不落盘）
      }
    }
    return result
  }

  // 并发调度：并发安全工具直接执行；非并发安全工具同会话同工具串行排队
  let result = behavior.concurrencySafe
    ? await executeOnce()
    : await enqueueSerial(`${sessionKey}|${name}`, executeOnce)

  // 写入去重缓存：仅成功结果入缓存（失败缓存会让 AI 永远拿不到重试机会）
  if (cacheKey && result.ok) {
    dedupeSet(cacheKey, result)
  }

  // 控制层：PostToolUse Hook（结果处理/日志/审计）
  if (hookManager && hookManager.isLoaded()) {
    const postResult = await hookManager.run('PostToolUse', {
      event: 'PostToolUse',
      toolName: name,
      toolParams: params,
      callDescription,
      destructive: behavior.destructive,
      toolResult: result,
      sessionId: registry.ctx.sessionId ?? undefined,
      workflowId: registry.ctx.taskId,
      cwd: getAppAnchor()
    })
    // PostToolUse 可修改结果
    if (postResult.modifiedResult) {
      result = postResult.modifiedResult
    }
    // PostToolUse 的 block 不阻断已执行的结果（工具已执行完），但记录日志
    if (postResult.action === 'block') {
      console.warn(`[hooks] PostToolUse block 被忽略（工具已执行）: ${postResult.message}`)
    }
    // PostToolUse 的 error 不影响工具结果，但记录日志便于诊断
    if (postResult.action === 'error') {
      console.warn(`[hooks] PostToolUse error: ${postResult.message}`)
    }
  }

  return result
}