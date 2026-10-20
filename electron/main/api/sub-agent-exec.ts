/**
 * @category 核心
 * @summary 子 agent 执行面装配：`buildSubAgentExecuteFn`（工具事件转发 + 蒸馏共用）+ 异步委托与长期目标（Mission）接线
 * @note 为什么存在：子 agent 的「流式执行函数」被同步路径（SubAgentManager）与异步路径（AsyncDelegationManager）
 * 共用，且两条路径的执行函数构造口径必须一致（否则事件/蒸馏行为分叉）；Mission 记账与瞬时失败自动重试
 * 只订阅 asyncDelegation 事件。三者同属「子 agent 执行面」，故合并为单模块并从宿主 `server.ts` 外移（ADR-02 第二轮）。
 * @note 不删理由：Mission 的自动重试与 `recoverAbandoned` 崩溃恢复是长期目标的可靠性来源，散回宿主会重新不可读。
 */
import type { LLMClient } from './llm'
import type { ToolExecutor } from './llm'
import type { SubAgentExecuteFn } from '../sub-agent'
import type { ChatMessage } from '@shared/types'
import type { BaseDataPaths } from '../models/paths'
import { SUBAGENT_GUARDRAIL_KEY } from './message-guardrail'
import { AsyncDelegationManager } from '../tools/sub-agent-engine/async-delegation'
import { SubAgentRegistry } from '../tools/sub-agent-engine/engine'
import { MissionStore } from '../tools/sub-agent-engine/mission-store'
import { ASYNC_DELEGATION_SYSTEM_PROMPT } from '../prompts/sub-agent'
import { serviceRefs } from './service-refs'
import type { DistillCallbacks } from './distill-callbacks'
import { join } from 'path'

/** 构造子 agent 执行函数的工厂签名（宿主与 Mission 接线共用同一实例） */
export type SubAgentExecuteFnFactory = (getLlmClient: () => LLMClient) => SubAgentExecuteFn<ToolExecutor>

/**
 * 子 agent executeFn 统一构造——子 agent 内部工具调用事件转发给 opts.emit
 * 由 SubAgentManager 补 agentId 后推前端；LLM 输出只累积（最终结果由 done 事件携带）。
 * 子 agent 内部的 streamWithTools 与主对话共用 LLMClient，但不推 token（避免刷屏）。
 */
export function createSubAgentExecuteFnFactory(deps: {
  makeDistillCallbacks: () => DistillCallbacks
}): SubAgentExecuteFnFactory {
  const { makeDistillCallbacks } = deps
  return (getLlmClient: () => LLMClient): SubAgentExecuteFn<ToolExecutor> => async (messages, tools, opts) => {
    let output = ''
    const emit = opts.emit
    await getLlmClient().streamWithTools(
      messages,
      tools,
      {
        onToken: (t) => {
          output += t
        },
        onDone: () => {},
        onError: (e) => {
          throw e
        },
        onToolStart: (toolName, toolCallId, args) => {
          emit?.({ type: 'tool_start', agentId: '', toolName, toolCallId, args })
        },
        onToolEnd: (toolName, toolCallId, result) => {
          emit?.({ type: 'tool_end', agentId: '', toolName, toolCallId, result })
        },
        // 子 agent 上下文内的工具结果同样走蒸馏（与主对话/无头会话共用同一回调工厂）：
        // 大体积工具结果（web_search/read_file 等）先经 LLM 提炼摘要再进子 agent 上下文，
        // 避免子 agent 上下文被大结果膨胀；失败重试一次仍失败保留原文，与主会话行为一致。
        ...makeDistillCallbacks()
      },
      {
        maxRounds: opts.maxTurns,
        signal: opts.signal,
        // 消息来源护栏：子 agent 内部上下文用独立固定键（不与会话哈希混淆）；
        // 子 agent 输出作为 tool 结果回流父对话时按工具名归类为 subagent
        guardrailSessionId: SUBAGENT_GUARDRAIL_KEY
      }
    )
    return output
  }
}

export interface MissionWiringDeps {
  /** 装配期快照的 scoped 根；null = 未登录（Mission 与异步委托落盘路径不建） */
  toolPaths: BaseDataPaths | null
  buildSubAgentExecuteFn: SubAgentExecuteFnFactory
  llmClientRef: { current: LLMClient }
  toolExecutorsRef: { current: ToolExecutor[] }
}

/**
 * 装配异步委托通道与长期目标（Mission）编排，并把两者登记进 `serviceRefs`（释放/WS 层读取）。
 * 副作用即目的：本函数无返回值，创建出的两个实例只经 serviceRefs 暴露（与拆分前闭包语义一致）。
 */
export function installMissionWiring(deps: MissionWiringDeps): void {
  const { toolPaths, buildSubAgentExecuteFn, llmClientRef, toolExecutorsRef } = deps

  // 异步委托通道：
  // 子 agent 后台跑、父对话不阻塞。
  // 独立于 SubAgentManager（同步路径不动），runner 复用 buildSubAgentExecuteFn。
  // llm.ts 已并发化（controllers Map 每请求独立 controller），并发调 streamWithTools 安全；
  // 且子 agent 请求不走 streamChain（那只约束主对话 runStream 路径），无串行冲突。
  const asyncDelegation = new AsyncDelegationManager(
    new SubAgentRegistry(),
    {
      runner: async (record, signal, budget) => {
        // 迭代预算：runner 每轮调 streamWithTools 前 consume；
        // 预算耗尽则标记并整段终止（由 AsyncDelegationManager 识别为 interrupted）
        if (!budget.consume()) {
          record.status = 'interrupted'
          record.error = 'iteration_budget_exhausted'
          return ''
        }
        const messages: ChatMessage[] = [
          {
            id: `sub_sys_${Date.now()}`,
            role: 'system',
            content: ASYNC_DELEGATION_SYSTEM_PROMPT,
            createdAt: Date.now()
          },
          { id: `sub_usr_${Date.now()}`, role: 'user', content: record.task, createdAt: Date.now() }
        ]
        return buildSubAgentExecuteFn(() => llmClientRef.current)(messages, toolExecutorsRef.current, {
          // 轮次上限已取消（2026-10-02）：不传 maxTurns，走 SubAgentManager 默认不限制；
          // 超时由 AsyncDelegationManager 的 HeartbeatMonitor(300_000ms) 兜底。
          timeoutMs: 300_000,
          signal
        })
      },
      // 委托记录落盘到 {root}/mission/delegations.json
      // 崩溃后 recoverAbandoned 把遗留 running 标记为 interrupted 留痕。
      persistencePath: toolPaths ? join(toolPaths.root, 'mission', 'delegations.json') : undefined
    }
  )
  // 恢复上次崩溃遗留的委托（running → interrupted 留痕），标记得可被续接/排查
  if (toolPaths) {
    try {
      const abandoned = asyncDelegation.recoverAbandoned()
      if (abandoned.length > 0) {
        console.warn(`[mission] 崩溃恢复：${abandoned.length} 个遗留委托标记为 interrupted`)
      }
    } catch (err) {
      console.error('[mission] recoverAbandoned error:', err)
    }
  }
  serviceRefs.asyncDelegationRef = asyncDelegation

  // ===== 长期目标（Mission）持久化 + 失败重试编排 =====
  // MissionStore 存长期目标的目的/累计预算/失败计数/阻塞状态（文件即真相源，{root}/mission/）。
  // 订阅 asyncDelegation 结果事件：completed → 记账；failed → 记账 + transient 未超 failureLimit 自动重试（续接同 mission id）。
  const missionStore = toolPaths ? new MissionStore(toolPaths.root) : null
  serviceRefs.missionStoreRef = missionStore
  if (missionStore) {
    asyncDelegation.on('completed', (rec) => {
      const m = missionStore.get(rec.id)
      if (m) {
        missionStore.completeSegment(rec.id, {
          usedThisSegment: rec.iterationsUsed ?? 0,
          ok: true,
          result: rec.result,
          done: true
        })
      }
    })
    asyncDelegation.on('failed', (rec, err) => {
      const m = missionStore.get(rec.id)
      if (!m) return
      missionStore.completeSegment(rec.id, {
        usedThisSegment: rec.iterationsUsed ?? 0,
        ok: false,
        error: err,
        blockKind: 'transient' // 默认按瞬时失败处理，可重试；truly-blocked 由任务语义显式标记
      })
      // 自动重试：仍 active（transient 未超 failureLimit）且剩余预算充足 → re-dispatch 续接同一 mission id
      const updated = missionStore.get(rec.id)
      if (updated && updated.status === 'active') {
        const remain = missionStore.remainingBudget(rec.id)
        if (remain > 0) {
          const retryTask = `${rec.task}\n[第 ${updated.segments + 1} 段续接；前次失败: ${err ?? 'unknown'}；继续推进该长期目标]`
          asyncDelegation.dispatch(retryTask, null, remain, rec.id) // 复用同 id → 同一 mission 累计
          console.warn(`[mission] ${rec.id} 瞬时失败自动重试（剩余预算 ${remain}）`)
        } else {
          console.warn(
            `[mission] ${rec.id} 失败但预算已尽（${updated.iterationsUsed}/${updated.maxIterations}），不再重试`
          )
        }
      }
    })
  }
}
