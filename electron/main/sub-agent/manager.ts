/**
 * 子 agent 管理器：为什么存在——前端 AI 与 DMN 两条路径都要启动子 agent（串行/并行、
 * 超时/摘要/工具过滤），逻辑必须收敛为一份而不是各写各的。
 * 作用：统一管理子 agent 启动、并发上限、超时/轮次闸门、摘要截断与工具黑白名单过滤，
 * 通过注入的 executeFn 桥接不同执行引擎并广播生命周期事件。
 */
import { AsyncLocalStorage } from 'async_hooks'
import type { ChatMessage } from '@shared/types'
import type { ToolContext } from '../tools/base-tool'
import { runWithTeamContext } from '../services/team-manager'
import {
  globalSubAgentScheduler,
  resolveMaxConcurrency
} from '../services/subagent-scheduler'
import { registerManagedRun, formatConcurrencyAdvisory } from '../services/tool-run-registry'
import type {
  NamedTool,
  SubAgentLaunchOptions,
  SubAgentResult,
  ConcurrencyConfig,
  SubAgentExecuteFn,
  SubAgentEvent
} from './types'

/** 默认配置常量 */
// 子 agent 轮次上限取消（2026-10-02 按用户要求）：不再因跑满轮次中断子任务。
// 防失控由两层兜底：executeWithTimeout 超时软托管（DEFAULT_TIMEOUT_MS，转后台不硬断）+ llm-guardrails 护栏。
// 显式传 maxTurns 的调用方仍可自定义（如团队协作工具），未传即不限制。
const DEFAULT_MAX_TURNS = Number.POSITIVE_INFINITY
// 超时闸门：10 分钟兜底防永久挂死（Agent 工具已豁免外层 30s 超时；超时后转后台托管，AI 可 tool_watch/tool_stop）
const DEFAULT_TIMEOUT_MS = 600000
const DEFAULT_MAX_SPAWN_DEPTH = 1

// 并发上限默认 'auto'（机器配置自动计算）：用户明确要求"检查电脑配置、自动分配、排队"，
// 硬编码 10 在低配机器上会打爆资源、在高配机器上又浪费算力，auto 由 scheduler 统一决策。
const DEFAULT_MAX_CONCURRENT: number | 'auto' = 'auto'

/** 超时时长 / 摘要截断时使用的未知轮次标记（executeFn 不返回实际轮次） */
const TURNS_UNKNOWN = -1

/**
 * 异步上下文存储：在子 agent 执行链中传递嵌套深度。

 * 解决问题：launchSubAgent 闭包（server.ts / sub-agent-launcher.ts）无法感知
 * 当前是否在子 agent 上下文内。AsyncLocalStorage 在 async 调用链中自动传递，
 * 子 agent 内部调 Agent 工具时，闭包通过 getCurrentDepth() 读到当前深度。

 * 工作流：
 * - 主对话调 Agent 工具 → getCurrentDepth()=0 → launchBatch(tasks, mode, 0)
 * → launchOne 检查 0>=1=false，允许 → storage.run(1, execute)
 * - 子 agent 内部调 Agent 工具 → getCurrentDepth()=1 → launchBatch(tasks, mode, 1)
 * → launchOne 检查 1>=1=true，拒绝嵌套 ✅
 */
const subAgentDepthStorage = new AsyncLocalStorage<number>()

/** 子 agent 唯一 id 生成器（时间戳 + 递增序号，同毫秒并发也不冲突） */
let subAgentIdCounter = 0
function generateAgentId(): string {
  subAgentIdCounter++
  return `sa_${Date.now()}_${subAgentIdCounter}`
}

/** 子 agent 执行元信息（launchBatch 传入，供 start 事件与前端展示） */
interface SubAgentMeta {
  mode: 'serial' | 'parallel'
  index: number
  total: number
  /** 父工具调用 id（主对话 Agent 工具的 toolCallId，事件关联用） */
  parentToolCallId?: string
}

/**
 * 子 agent 管理器：统一前端 AI 和 DMN 的子 agent 启动逻辑。

 * 泛型参数 T：工具类型（前端 AI 用 ToolExecutor，DMN 用 AnyTool），约束为必须有 name 字段。
 * 执行引擎通过 executeFn 注入区分，上层编排逻辑（并发 / 超时 / 摘要 / 工具过滤）完全共用。
 */
export class SubAgentManager<T extends NamedTool> {
  private activeCount = 0

  /** 解析后的并发上限（'auto' 在构造时按机器配置定值；显式数字原样采用） */
  private readonly resolvedMaxConcurrent: number

  constructor(
    private executeFn: SubAgentExecuteFn<T>,
    private allTools: T[],
    private baseCtx: ToolContext,
    private concurrency: ConcurrencyConfig = {
      maxConcurrent: DEFAULT_MAX_CONCURRENT,
      maxSpawnDepth: DEFAULT_MAX_SPAWN_DEPTH
    },
    /** 子 agent 过程事件回调（start/tool_start/tool_end/output/done）。
     * 由上层（server.ts）转成 WS 消息推前端；不传则保持黑盒（DMN 路径兼容）。 */
    private onEvent?: (evt: SubAgentEvent) => void
  ) {
    // 为什么存在：批内信号量（runParallelWithLimit）需要确定的数字上限，
    // 'auto' 必须在创建时解析一次，避免每次 launch 重复探测机器配置。
    this.resolvedMaxConcurrent = resolveMaxConcurrency(concurrency.maxConcurrent)
  }

  /** 启动单个子 agent */
  async launchOne(
    options: SubAgentLaunchOptions,
    currentDepth: number = 0,
    meta?: SubAgentMeta
  ): Promise<SubAgentResult> {
    // 嵌套深度检查
    if (currentDepth >= this.concurrency.maxSpawnDepth) {
      return {
        output: '',
        timedOut: false,
        turns: 0,
        error: `子 agent 嵌套深度 ${currentDepth} 超过上限 ${this.concurrency.maxSpawnDepth}`
      }
    }

    const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const agentId = generateAgentId()
    const mode = meta?.mode ?? 'serial'
    const index = meta?.index ?? 0
    const total = meta?.total ?? 1
    // 父工具调用 id（主对话 Agent 工具的 toolCallId，由上层在 launchBatch 传入）
    const parentToolCallId = meta?.parentToolCallId
    // emit 闭包：统一补 agentId + parentToolCallId——executeFn 内部事件只带类型和内容，
    // 这里补上归属信息后转发给 onEvent，前端据此挂到主对话 Agent 工具卡
    const emit: (evt: SubAgentEvent) => void = (evt) => {
      this.onEvent?.({ ...evt, agentId, parentToolCallId })
    }

    // start 事件：manager 构造（含任务信息），executeFn 内部事件只带 agentId
    emit({
      type: 'start',
      agentId,
      prompt: options.systemPrompt,
      mode,
      index,
      total
    })

    // 工具过滤：先白名单，再黑名单
    const subTools = this.filterTools(options.allowedTools, options.disallowedTools, options.denyCaps)

    // 构造消息：独立上下文（干净上下文，不继承父对话历史）
    const messages: ChatMessage[] = []
    messages.push({
      id: `sub_sys_${Date.now()}`,
      role: 'system',
      content: options.systemPrompt,
      createdAt: Date.now()
    })
    messages.push({
      id: `sub_usr_${Date.now()}`,
      role: 'user',
      content: options.userMessage,
createdAt: Date.now()
    })

    this.activeCount++
    // 已获得全局调度槽位标记：只有 acquire 成功才允许 release，避免误放行排队任务
    let admittedSlot = false
    try {
      // 全局调度器排队：机器资源（CPU/内存）不足时按 FIFO 等待空位，不直接失败。
      // 为什么在这里：SubAgentManager（同步）与 AsyncDelegationManager（异步）共享
      // globalSubAgentScheduler 同一并发预算，跨入口统一限流，避免各自硬编码并发
      // 把机器打爆；acquire 无 signal（同步路径无打断）恒返回 true，无需分支处理。
      admittedSlot = await globalSubAgentScheduler.acquire()

      // 用 AsyncLocalStorage 传递 currentDepth+1 给子 agent 的 async 调用链
      // 子 agent 内部调 Agent 工具时，launchSubAgent 闭包通过 getCurrentDepth() 读到此值
      const runBody = () =>
        this.executeWithTimeout(messages, subTools, { maxTurns, timeoutMs, agentId, emit })

      // 任务模式（Agent Teams）：带 teamContext 时用团队 AsyncLocalStorage 注入成员身份，
      // 子 agent 工具循环内的 team_* 工具经 getTeamContext() 识别"我是谁"
      const result = options.teamContext
        ? await runWithTeamContext(options.teamContext, () => subAgentDepthStorage.run(currentDepth + 1, runBody))
: await subAgentDepthStorage.run(currentDepth + 1, runBody)

      // 子 agent 输出完整返回（不折叠不截断）：上下文压缩由主链路工具结果蒸馏统一负责
      const presentedOutput = result.output

      emit({
        type: 'done',
        agentId,
        output: presentedOutput,
        error: result.error,
        timedOut: result.timedOut,
        managedTaskId: result.managedTaskId
      })
      return {
        output: presentedOutput,
        timedOut: result.timedOut,
        turns: result.turns,
        error: result.error,
        managedTaskId: result.managedTaskId
      }
} finally {
      // 释放全局调度槽位：子 agent 结束后放行 FIFO 队首的排队任务。
      // 只有 acquire 成功才释放，防止未占槽时误唤醒等待者导致超并发。
      if (admittedSlot) globalSubAgentScheduler.release()
      this.activeCount--
    }
  }

  /** 批量启动（serial / parallel），parallel 受 maxConcurrent 限制 */
  async launchBatch(
    tasks: SubAgentLaunchOptions[],
    mode: 'serial' | 'parallel',
    currentDepth: number = 0,
    parentToolCallId?: string
  ): Promise<SubAgentResult[]> {
    if (tasks.length === 0) return []

if (mode === 'parallel') {
      // 并行 + 并发上限。limit 用构造时解析好的 resolvedMaxConcurrent（'auto' 已定值），
      // 不能直接传 this.concurrency.maxConcurrent——它可能是 'auto' 字符串，
      // 传入 runParallelWithLimit 会被当成数字参与 Math.min 得到 NaN。
      return this.runParallelWithLimit(
        tasks,
        (task, index) => this.launchOne(task, currentDepth, { mode, index, total: tasks.length, parentToolCallId }),
        this.resolvedMaxConcurrent
      )
    }

    // serial：前一个输出拼到后一个 prompt
    const results: SubAgentResult[] = []
    for (let i = 0; i < tasks.length; i++) {
      const task = tasks[i]
      // 第一个任务用原始 prompt；后续任务把前一个输出拼到 userMessage
      const effectiveTask: SubAgentLaunchOptions =
        i === 0
          ? task
          : {
              ...task,
              userMessage: `${task.userMessage}\n\n前一个子任务的输出：\n${results[results.length - 1].output}`
            }
      const result = await this.launchOne(effectiveTask, currentDepth, { mode, index: i, total: tasks.length, parentToolCallId })
      results.push(result)
    }
    return results
  }

  /** 获取当前活跃子 agent 数量 */
  getActiveCount(): number {
    return this.activeCount
  }

  /**
   * 获取当前异步上下文中的子 agent 深度（供 launchSubAgent 闭包读取）。
   * - 主对话调用时返回 0（无 AsyncLocalStorage 上下文）
   * - 子 agent 内部调用时返回 currentDepth+1（由 launchOne 的 storage.run 注入）
   */
  static getCurrentDepth(): number {
    return subAgentDepthStorage.getStore() ?? 0
  }

  /** 工具过滤：白名单优先，再移除黑名单，最后按 caps 过滤 */
  private filterTools(allowedTools?: string[], disallowedTools?: string[], denyCaps?: string[]): T[] {
    let tools = this.allTools
    if (allowedTools && allowedTools.length > 0) {
      const allowed = new Set(allowedTools)
      tools = tools.filter((t) => allowed.has(t.name))
    }
    if (disallowedTools && disallowedTools.length > 0) {
      const disallowed = new Set(disallowedTools)
      tools = tools.filter((t) => !disallowed.has(t.name))
    }
    if (denyCaps && denyCaps.length > 0) {
      const denied = new Set(denyCaps)
      tools = tools.filter((t) => {
        const caps = t.caps
        if (!caps || caps.length === 0) return true
        return !caps.some((c) => denied.has(c))
      })
    }
    return tools
  }

  /** 带超时的执行（软超时托管协议） */
  private async executeWithTimeout(
    messages: ChatMessage[],
    tools: T[],
    opts: { maxTurns: number; timeoutMs: number; agentId: string; emit?: (evt: SubAgentEvent) => void }
  ): Promise<{ output: string; timedOut: boolean; turns: number; error?: string; managedTaskId?: string }> {
    // 超时不硬截断：超时后不 abort 子 agent LLM 请求，而是转入后台托管继续运行，
    // 登记 taskId 后立即返回；AI 用 tool_watch(taskId, waitMs) 检查进度/设定新时间续期，
    // 用 tool_stop(taskId) 主动停止（abort 取消信号 → executeFn 感知后终止）。
    // 与 llm.ts 外墙对 run_command/code_run 的托管协议同构，AI 感知一致：
    // 「超时 ≠ 停止，只是外墙先返回，后台继续跑」。
    const abortCtrl = new AbortController()
    const startedAt = Date.now()
    // 执行 promise 只创建一次（race 与超时托管分支共享同一执行；重复调用会启动两个子 agent）
    const execPromise = this.executeFn(messages, tools, {
      maxTurns: opts.maxTurns,
      timeoutMs: opts.timeoutMs,
      signal: abortCtrl.signal,
      emit: opts.emit
    })
    let timeoutId: NodeJS.Timeout | undefined
    // 超时分支：resolve 一个「已托管」结果而非 reject 硬中断
    const timeoutPromise = new Promise<{ timedOut: true; managedTaskId: string }>((resolve) => {
      timeoutId = setTimeout(() => {
        // 超时一律转后台托管：不因任何条件退回硬截断（用户硬性要求：永不硬截断，
        // 只有 AI 用 tool_stop 主动停止）。后台任务是否堆积由 AI 用
        // tool_watch/tool_stop 自行管理，系统不代做「满即杀」的兜底决策；
        // 是否并发过多由 AI 依据动态负载上限自行排序取舍。
        // 登记托管：execPromise 继续在后台跑，落定后结果写入注册表（tool_watch 可取）
        const managedTaskId = registerManagedRun(
          'Agent',
          { agentId: opts.agentId, timeoutMs: opts.timeoutMs },
          startedAt,
          abortCtrl,
          execPromise
        )
        resolve({ timedOut: true, managedTaskId })
      }, opts.timeoutMs)
    })

    try {
      const output = await Promise.race([
        // emit 透传给 executeFn：子 agent 内部事件（工具开始/结束/输出）实时转发
        execPromise,
        timeoutPromise
      ])
      // 若走到这里且是托管结果（超时触发），返回 timedOut + taskId；否则为正常完成
      if (typeof output === 'object' && 'managedTaskId' in output) {
        return {
          output: '',
          timedOut: true,
          turns: TURNS_UNKNOWN,
          error:
            `子 agent 执行超时（${opts.timeoutMs}ms），已转入后台托管继续运行（未中断 LLM 调用）。` +
            `调 tool_watch(taskId="${output.managedTaskId}", waitMs) 检查进度或设定新检查时间；` +
            `确认无必要继续时调 tool_stop(taskId="${output.managedTaskId}")。` +
            formatConcurrencyAdvisory({ started: 'agent', taskId: output.managedTaskId }),
          managedTaskId: output.managedTaskId
        }
      }
      // executeFn 不返回实际轮次，turns 用 -1 表示未知
      return { output, timedOut: false, turns: TURNS_UNKNOWN }
    } catch (err) {
      const msg = (err as Error).message
      return { output: '', timedOut: false, turns: TURNS_UNKNOWN, error: msg }
    } finally {
      if (timeoutId) clearTimeout(timeoutId)
    }
  }

  /** 
   * 受并发限制的并行执行（信号量：计数器 + 递归队列，无新依赖）。
   * 泛型 U/R 与类泛型 T 区分，避免命名冲突。
   * 采用 collect-all 策略：所有任务均执行完毕后再抛首个错误，
   * 确保子 agent 资源回收和日志落盘不被提前中断。
   */
  private async runParallelWithLimit<U, R>(
    items: U[],
    fn: (item: U, index: number) => Promise<R>,
    limit: number
  ): Promise<R[]> {
    const results: R[] = new Array(items.length)
    let running = 0
    let nextIndex = 0
    let firstError: unknown = null

    const runNext = async (): Promise<void> => {
      const index = nextIndex++
      if (index >= items.length) return
      running++
      try {
        results[index] = await fn(items[index], index)
      } catch (e) {
        if (firstError === null) firstError = e
        results[index] = undefined as unknown as R
      } finally {
        running--
        if (nextIndex < items.length && running < limit) {
          await runNext()
        }
}
    }

    const initialBatch = Math.min(limit, items.length)
    await Promise.all(Array.from({ length: initialBatch }, () => runNext()))
    if (firstError !== null) throw firstError
    return results
  }
}
