/**
 * @category API
 * @summary 工具轮派发：assistant tool_calls 回写 → 参数解析分类 → 分段并行/串行 → 执行 → 结果回写
 *
 * 为什么独立成模块：这是 `streamWithTools` 里体量最大的一段（约 330 行），
 * 承载三套互不相同的规则——路径重叠判定（读读并行/写冲突串行/交互式 barrier）、
 * 外墙超时三态（豁免 / 软托管 / 强杀）、以及工具级取消信号桥接。与流解析、护栏判定
 * 混在同一方法里时，任何一处改动都要通读 1200 行；拆出后规则可逐条阅读。
 *
 * 什么作用：`dispatchToolCalls(toolCallMap, contentBuf, reasoningBuf, ctx)` 执行本轮全部工具调用，
 * 把结果按原顺序写回 `conversation` 并登记进蒸馏记账器；返回本轮执行结果与两类旁路（超时/托管）。
 *
 * 不删理由：删掉即工具调用不再被执行（LLM 只会一直请求工具）。
 *
 * 硬约束（ADR-03 §8 风险 2）：`MANAGED_TIMEOUT_TOOLS` 判定 + `registerManagedRun` 登记点不得移位——
 * 移位会让「软超时托管」退化为「强杀」或反之。判据：`test/llm-concurrency.test.ts` +
 * 手动 `run_command` 超时转后台冒烟。
 */
import { toolCallStorage, toolSignalStorage } from '../llm-types'
import type {
  StreamCallbacks,
  ToolCallResult,
  ToolExecutor,
  WireMessage
} from '../llm-types'
import {
  extractPaths,
  INTERACTIVE_TOOLS,
  pathsConflict,
  READ_TOOLS,
  WRITE_TOOLS
} from '../llm-guardrails'
import { classifyToolSource, wrapGuardrail } from '../message-guardrail'
// 软超时托管：外墙超时不打断可托管工具，转后台继续跑并登记 taskId（工具运行时长机制）
import { formatConcurrencyAdvisory, registerManagedRun } from '../../services/tool-run-registry'
import { MANAGED_TIMEOUT_TOOLS } from './session-state'
import type { DistillBookkeeper } from './tool-loop-distill'
import type { ManagedHandoff, ToolExecResult } from './tool-loop-guards'

export interface ToolDispatchContext {
  conversation: WireMessage[]
  /** 消息来源护栏作用域键（有值时工具结果按工具名分类包裹） */
  guardrailKey?: string
  tools: ToolExecutor[]
  callbacks: StreamCallbacks
  ctrl: AbortController
  bookkeeper: DistillBookkeeper
  isDeepSeekProvider: boolean
}

export interface ToolDispatchResult {
  execResults: ToolExecResult[]
  /** 本回合超时的工具名：执行后据此注入一次系统提示（提醒 AI 看原因，勿盲目重试） */
  timedOutTools: string[]
  /** 本回合转入后台托管的任务（软超时：进程不杀，AI 用 tool_watch/tool_stop 接管） */
  managedHandoffs: ManagedHandoff[]
}

export async function dispatchToolCalls(
  toolCallMap: Map<number, { id: string; name: string; args: string }>,
  contentBuf: string,
  reasoningBuf: string,
  ctx: ToolDispatchContext
): Promise<ToolDispatchResult> {
  const { conversation, guardrailKey, tools, callbacks, ctrl } = ctx

  // 把 assistant 的 tool_calls 加入会话
  const toolCalls: ToolCallResult[] = Array.from(toolCallMap.values()).map((t) => ({
    id: t.id || `call_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    type: 'function' as const,
    function: { name: t.name, arguments: t.args }
  }))
  conversation.push({
    role: 'assistant',
    content: contentBuf || '',
    tool_calls: toolCalls,
    // 2026-08-26 修复：本轮 reasoning 一并回传——带 tool_calls 的 assistant 消息在思考模式下
    // DeepSeek 硬性要求 reasoning_content 原样回传（仅 DeepSeek 系 API，其他网关回传会被拒绝）
    ...(ctx.isDeepSeekProvider && reasoningBuf ? { reasoning_content: reasoningBuf } : {})
  })

  // 执行工具调用（2026-08-10 路径重叠并行判定机制本土化）：
  // 读-读并行（Read/Grep/Glob 等只读工具任意并行）；
  // 含写工具（Write/Edit/MoveFile/DeleteFile）对同一路径 → 关段串行（避免读写竞争）；
  // 交互式工具（dmn_ask_user/requestPermission 等弹窗等用户）→ barrier 强制串行；
  // 参数解析失败的调用 → barrier（后续可能依赖其输出）。
  // 无冲突的调用保持并行（分段：parallel 段 / sequential barrier 段交替）。

  // 工具分类（READ_TOOLS / WRITE_TOOLS / INTERACTIVE_TOOLS 已移至 ./llm-guardrails）

  // ⚠️ 2026-08-12 修复：用户打断（abort）后工具快速收尾——
  // 默认 30s 超时会让旧流在 streamChain 上拖住新消息（用户感知"发消息不回复"）。
  // abort 后只给 3s 收尾：当前工具最多 3s 内被放弃，旧流立即结束，新消息马上开始。
  const TOOL_TIMEOUT_MS = ctrl.signal.aborted ? 3000 : 30000

  // extractPaths / pathsConflict 已移至 ./llm-guardrails

  // 解析所有调用（参数 + 分类），失败标记 barrier
  type ParsedCall = {
    tc: ToolCallResult
    args: Record<string, unknown>
    paths: string[]
    isWrite: boolean
    isInteractive: boolean
    parseFailed: boolean
    isRead: boolean
    // 结果处理模式：LLM 在工具参数里声明 _result_mode = 'full' 则不蒸馏原文保留；
    // 缺省 / 'distill' 走蒸馏。声明在解析层剥离，不传给工具本体。
    resultMode: 'full' | 'distill'
  }
  const parsedCalls: ParsedCall[] = toolCalls.map((tc) => {
    let args: Record<string, unknown> = {}
    let parseFailed = false
    try {
      args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {}
    } catch (err) {
      args = { _parseError: (err as Error).message }
      parseFailed = true
    }
    const name = tc.function.name
    const resultMode = args._result_mode === 'full' ? 'full' : 'distill'
    // 剥离控制声明：_result_mode 是系统层选项，不得作为真实参数落入工具本体
    if ('_result_mode' in args) delete args._result_mode
    return {
      tc,
      args,
      paths: extractPaths(args),
      isWrite: WRITE_TOOLS.has(name),
      isInteractive: INTERACTIVE_TOOLS.has(name),
      parseFailed,
      isRead: READ_TOOLS.has(name),
      resultMode
    }
  })

  // 分段：贪心把调用分成 parallel 段 / barrier 串行段
  const segments: ParsedCall[][] = []
  let current: ParsedCall[] = []
  for (const call of parsedCalls) {
    // barrier 条件：交互式 / 解析失败 / 与段内已有调用路径冲突（含写）
    const conflictsWithCurrent = current.some((c) => {
      if (call.isInteractive || call.parseFailed) return true
      if (call.isWrite && c.isWrite) return pathsConflict(call.paths, c.paths)
      if (call.isWrite && !c.isWrite && c.isRead) return pathsConflict(call.paths, c.paths)
      if (!call.isWrite && c.isWrite) return pathsConflict(call.paths, c.paths)
      return false
    })
    if (call.isInteractive || call.parseFailed || conflictsWithCurrent) {
      if (current.length > 0) {
        segments.push(current)
        current = []
      }
      // barrier 调用单独成段
      segments.push([call])
    } else {
      current.push(call)
    }
  }
  if (current.length > 0) segments.push(current)

  // 逐段执行（段内并行，段间串行）
  const execResults: ToolExecResult[] = []
  const timedOutTools: string[] = []
  const managedHandoffs: ManagedHandoff[] = []
  for (const segment of segments) {
    // 2026-08-12：abort 后跳过尚未执行的工具段（用户已打断，不再执行剩余工具）
    if (ctrl.signal.aborted) {
      for (const call of segment) {
        callbacks.onToolStart?.(call.tc.function.name, call.tc.id, {})
        const skipResult = JSON.stringify({ error: '工具调用已跳过（用户打断）' })
        callbacks.onToolEnd?.(call.tc.function.name, call.tc.id, skipResult)
        execResults.push({
          tc: call.tc,
          toolName: call.tc.function.name,
          toolCallId: call.tc.id,
          result: skipResult,
          resultMode: call.resultMode
        })
      }
      continue
    }
    const segResults = await Promise.all(
      segment.map(async (call): Promise<ToolExecResult> => {
        const tc = call.tc
        const tool = tools.find((t) => t.name === tc.function.name)
        if (!tool) {
          callbacks.onToolStart?.(tc.function.name, tc.id, {})
          const errMsg = `工具未注册: ${tc.function.name}`
          const errResult = JSON.stringify({ error: errMsg })
          callbacks.onToolEnd?.(tc.function.name, tc.id, errResult)
          return {
            tc,
            toolName: tc.function.name,
            toolCallId: tc.id,
            result: errResult,
            resultMode: call.resultMode
          }
        }

        callbacks.onToolStart?.(tc.function.name, tc.id, call.args)
        let result = ''
        let timedOut = false
        const startedAt = Date.now()
        try {
          // 工具执行超时保护，防止工具卡死阻塞整个 stream（本地工具 30s 上限）
          // 超时定时器在工具完成后必须 clearTimeout，否则 reject 后定时器仍挂在事件循环中
          // Agent 工具豁免外层超时：子 agent 由内层 SubAgentManager 超时管理
          // （默认 10 分钟、可按 task.timeoutMs 配置），外层 30s 会掐死长审查/长调研任务
          let timeoutTimer: ReturnType<typeof setTimeout> | null = null
          // 工具级取消信号：超时触发时 abort，让工具本身（经 ToolContext.signal）感知取消，
          // 而非旧实现只 reject 外层——底层工具在后台继续跑成孤儿（进程/请求泄漏）
          const toolAbort = new AbortController()
          try {
            // 工具执行链注入 toolCallId 上下文（subagent 事件关联用）：
            // 工具内部（尤其 Agent 工具 → launchSubAgent → SubAgentManager）可通过
            // getCurrentToolCallId() 读到本工具的调用 id，事件流据此挂到主对话卡片
            const execWithCtx = (): Promise<string> => {
              // Agent 与 team_launch 豁免外层超时：两者都启动子 agent，由内层
              // SubAgentManager 超时管理（默认 10 分钟），外层 30s 会掐死长任务
              // tool_watch / tool_stop 同样豁免：它们是托管协议的配套工具，
              // 承载 AI 设定的检查等待（waitMs 可达 5 分钟），外墙 30s 会误杀
              if (
                tc.function.name === 'Agent' ||
                tc.function.name === 'team_launch' ||
                tc.function.name === 'tool_watch' ||
                tc.function.name === 'tool_stop'
              ) {
                const exec = tool.execute(call.args)
                // 豁免工具与对话打断桥接：tool_watch 可能等至 5 分钟（AI 设定的
                // 检查时间），若用户在等待中途打断，必须立即让位结束旧流收尾，
                // 不能让等待继续拖着对话关停。桥接 ctrl（对话级取消）→ toolAbort
                // （工具级取消），tool_watch 内部按 ctx.signal 感知并提前返回。
                // Agent/team_launch 有独立子 agent 生命周期，不桥接（避免误中断
                // 已豁免的子任务内部逻辑）。
                if (tc.function.name === 'tool_watch' || tc.function.name === 'tool_stop') {
                  const onUserAbort = (): void => {
                    try {
                      toolAbort.abort()
                    } catch {
                      /* abort 本身不抛错，防御性兜底 */
                    }
                  }
                  ctrl.signal.addEventListener('abort', onUserAbort, { once: true })
                  // 工具先返回时摘除监听，避免 listener 悬挂到对话请求结束。
                  // 必须先 .catch 再 .finally：exec.finally() 会派生新 promise，
                  // exec reject 时派生链同样 reject 且无处处理（Node 默认
                  // --unhandled-rejections=throw，会拖垮测试/进程）——catch 先吞掉
                  // rejection，finally 链自此不再抛。
                  exec
                    .catch(() => {})
                    .finally(() => ctrl.signal.removeEventListener('abort', onUserAbort))
                }
                return exec
              }
              // 软超时托管：对可托管工具（真实子进程、可后台继续跑），外墙
              // 超时不 abort、不拒绝——工具转后台继续执行并登记 taskId，立即返回
              // 托管诊断结果；AI 用 tool_watch(taskId, waitMs) 设定新检查时间继续
              // 查看，到期未完成可再 watch 或 tool_stop 主动停止。彻底告别「锁死
              // 固定时间超时打断长任务」。不可托管工具（文件/查询等卡死无后台价值）
              // 仍走下方强杀路径（30s abort 防拖死对话）。
              if (MANAGED_TIMEOUT_TOOLS.has(tc.function.name) && !ctrl.signal.aborted) {
                const execPromise = tool.execute(call.args)
                return new Promise<string>((resolve) => {
                  let settled = false
                  // 工具在 30s 内完成 → 正常返回（与强杀路径同语义）。
                  // undefined 结果兜底为空串：JSON.stringify(undefined) 返回
                  // undefined（非 string），后续写 conversation 会得到缺失字段
                  execPromise.then(
                    (raw) => {
                      if (settled) return
                      settled = true
                      resolve(
                        typeof raw === 'string'
                          ? raw
                          : typeof raw === 'undefined'
                            ? ''
                            : JSON.stringify(raw)
                      )
                    },
                    (err) => {
                      if (settled) return
                      settled = true
                      resolve(JSON.stringify({ error: (err as Error).message }))
                    }
                  )
                  timeoutTimer = setTimeout(() => {
                    if (settled) return
                    settled = true
                    const taskId = registerManagedRun(
                      tc.function.name,
                      call.args,
                      startedAt,
                      toolAbort,
                      execPromise
                    )
                    managedHandoffs.push({ taskId, toolName: tc.function.name })
                    resolve(
                      JSON.stringify({
                        ok: false,
                        timeout: true,
                        managed: true,
                        taskId,
                        tool: tc.function.name,
                        elapsedMs: Date.now() - startedAt,
                        error: `工具「${tc.function.name}」执行超过外墙阈值（${TOOL_TIMEOUT_MS}ms），已转入后台继续运行（未中断进程）`,
                        suggestion:
                          `托管任务未被打断，正在后台继续执行。调 tool_watch(taskId="${taskId}", waitMs) 设定一个检查时间：` +
                          `完成则取回完整结果；到期未完成返回 running，可继续调 tool_watch 设定更长 waitMs 再查，` +
                          `或调 tool_stop(taskId) 主动停止。不要重复发起同一长命令。` +
                          formatConcurrencyAdvisory({ started: 'tool', taskId })
                      })
                    )
                  }, TOOL_TIMEOUT_MS)
                })
              }
              return Promise.race([
                tool.execute(call.args),
                new Promise<string>((_, reject) => {
                  timeoutTimer = setTimeout(() => {
                    timedOut = true
                    try {
                      toolAbort.abort()
                    } catch {
                      /* ignore */
                    }
                    reject(new Error('TOOL_TIMEOUT'))
                  }, TOOL_TIMEOUT_MS)
                })
              ])
            }
            result = await toolCallStorage.run(tc.id, () =>
              toolSignalStorage.run(toolAbort.signal, execWithCtx)
            )
          } finally {
            if (timeoutTimer) clearTimeout(timeoutTimer)
          }
        } catch (err) {
          if (!timedOut) result = JSON.stringify({ error: (err as Error).message })
        }
        // 超时诊断统一在此覆盖（不放 catch 内）：abort 取消信号可能让工具先返回
        // 「已取消」而外层 race 后 reject——若只在 catch 分支写诊断会丢失诊断信息。
        // 只要 timedOut 成立，就以诊断结果为准（不硬截断成一句「超时」）。
        if (timedOut) {
          const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1)
          result = JSON.stringify({
            ok: false,
            timeout: true,
            tool: tc.function.name,
            timeoutMs: TOOL_TIMEOUT_MS,
            elapsedMs: Date.now() - startedAt,
            error: `工具「${tc.function.name}」执行超时（阈值 ${TOOL_TIMEOUT_MS}ms，已等待 ${elapsed}s 未返回，已向工具发送取消信号）`,
            suggestion:
              '超时不等于失败终局，先判断原因：①工具/命令本身耗时长——外层 30s 是对话保护墙，' +
              '长命令请拆成可分段的小步骤，传更大的 timeoutMs 无效（那是工具内部计时，跨不过外层墙）；' +
              '②工具卡死/死循环；③在等待外部响应（网络/子进程）。看清原因再决定换方案还是收尾，不要原样重试同一调用。'
          })
          timedOutTools.push(tc.function.name)
        }
        callbacks.onToolEnd?.(tc.function.name, tc.id, result)
        return {
          tc,
          toolName: tc.function.name,
          toolCallId: tc.id,
          result,
          timedOut,
          resultMode: call.resultMode
        }
      })
    )
    execResults.push(...segResults)
  }

  // 按原顺序写回 conversation（tool_calls 顺序与结果一一对应，AI 依赖此顺序理解）
  for (const r of execResults) {
    // 消息来源护栏：工具结果按工具名分类包裹（网页搜索/文件读取/子AGENT/普通工具）
    const toolSource = guardrailKey ? classifyToolSource(r.toolName) : null
    conversation.push({
      role: 'tool',
      tool_call_id: r.tc.id,
      content:
        toolSource && guardrailKey ? wrapGuardrail(r.result, toolSource, guardrailKey) : r.result
    })
    ctx.bookkeeper.record({
      index: conversation.length - 1,
      toolName: r.toolName,
      toolCallId: r.toolCallId,
      result: r.result,
      // LLM 声明 full = 原文保留（跳过蒸馏）；缺省 / distill 走蒸馏
      resultMode: r.resultMode
    })
  }

  return { execResults, timedOutTools, managedHandoffs }
}
