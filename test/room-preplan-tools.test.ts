/**
 * 前置规划功能 M3 回归：只读工具面收窄（restrictTools）+ 前置规划轮全跳过落盘/路由 + ai-scope 自描述 id 解析。
 *
 * 为什么存在（2026-10-31 用户裁决）：前置规划是每个有 aiId 主AI的**专属影子**——只给方向、不执行、
 * 不占 aiId、不写 RAW、不进记忆工作流。这三条边界各有一个「破功点」必须锁成机械守卫：
 * 1. **工具面**：前置规划轮的写入/高危工具必须**物理不可见**（收窄），而不是门控拒绝——
 *    门控拒绝仍把工具 schema 摆给模型看，收窄才是「清单里根本没有」；
 * 2. **落盘**：room-preplan 轮若落 sessionStore，前置规划会话会出现在用户侧栏（前端无前缀过滤），
 *    若走逆生树路由会为它建档内部会话节点——两者都与「影子、自管理」冲突；
 * 3. **作用域**：前置规划不落 sessionStore，整条注入/工具链的 aiId 必须改由自描述 id
 *    （`room-preplan-U{uid}-AI{aiId}`）解析——否则回落 AI1，前置规划读错记忆域。
 *
 * 覆盖：收窄只留名单内工具 / 收窄覆盖用途专属追加（追加不是绕过口子）/ 名单 null 与未注入
 * 零变化 / room-preplan 不触 sessionStore、不走路由、不写 RAW / ai-scope 模式解析与回落审计。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createHeadlessChatRunner, type HeadlessChatDeps } from '../electron/main/api/run-headless-chat'
import { resolveSessionAiIdWithAudit } from '../electron/main/api/ai-scope'
import type { SessionStore } from '../electron/main/api/session-store'
import type { ChatMessage } from '@shared/types'

afterEach(() => {
  vi.restoreAllMocks()
})

// ===== 无头链路收窄测试的夹具（在 headless-session-context.test.ts 的同款上加两个探针）=====

interface HarnessProbe {
  /** streamWithTools 第 2 参：本轮实际可用的工具执行器名单 */
  executorNames: string[][]
  sessionStoreCalls: string[]
  resolveContextCalls: number
  injectedSessionContexts: unknown[]
  saves: ChatMessage[][]
  raws: number
}

function makeHarness(over: Partial<HeadlessChatDeps> = {}) {
  const probe: HarnessProbe = {
    executorNames: [],
    sessionStoreCalls: [],
    resolveContextCalls: 0,
    injectedSessionContexts: [],
    saves: [],
    raws: 0
  }
  const serverCtx: { sessionId?: string } = {}
  let chain: Promise<unknown> = Promise.resolve()
  const llm = {
    isReady: () => true,
    streamWithTools: async (_m: unknown, executors: Array<{ name: string }>, cb?: { onToken?: (t: string) => void }) => {
      probe.executorNames.push(executors.map((t) => t.name))
      cb?.onToken?.('ok')
      return 'ok'
    }
  }
  const deps = {
    configStore: { get: () => ({ llm: {} }) },
    sessionStore: {
      get: () => {
        probe.sessionStoreCalls.push('get')
        return { id: 'sess-1', messages: [] }
      },
      getOrCreate: () => {
        probe.sessionStoreCalls.push('getOrCreate')
        return { id: 'sess-1', messages: [] }
      },
      saveMessages: (_id: string, messages: ChatMessage[]) => {
        probe.sessionStoreCalls.push('saveMessages')
        probe.saves.push(messages)
      }
    },
    buildInjectedMessages: async (
      _m: ChatMessage[],
      _sid?: string,
      sessionContext?: unknown
    ): Promise<ChatMessage[]> => {
      probe.injectedSessionContexts.push(sessionContext)
      return []
    },
    lastInjectedEstimateRef: { current: null },
    streamSession: {
      enqueue: (fn: () => Promise<unknown>) => {
        const run = chain.then(fn)
        chain = run.catch(() => {})
        return run
      },
      setForwarder: () => {},
      isOpen: () => false,
      push: () => {}
    },
    llmClientRef: { current: llm },
    makeLlmClient: () => llm,
    toolExecutorsRef: { current: [{ name: 'Read' }, { name: 'Write' }, { name: 'Grep' }] },
    makeDistillCallbacks: () => ({}),
    rowIdRef: { current: 0 },
    writeRawMemoryForStream: () => {
      probe.raws += 1
    },
    serverCtx,
    ...over
  } as unknown as HeadlessChatDeps
  return { runner: createHeadlessChatRunner(deps), probe }
}

describe('前置规划工具面：restrictTools 收窄（名单外工具物理不可见）', () => {
  it('room-preplan + 只读名单 → 本轮工具集只剩名单内工具（写工具不可见）', async () => {
    const { runner, probe } = makeHarness({
      restrictTools: (purpose) => (purpose === 'room-preplan' ? ['Read', 'Grep'] : null)
    })
    await runner('前置规划提示词', 'room-preplan-U7-AI1', 1, 'room-preplan')
    expect(probe.executorNames).toEqual([['Read', 'Grep']])
  })

  it('收窄作用于合并后集合：用途专属追加不在名单内也被移除（追加不是绕过收窄的口子）', async () => {
    const { runner, probe } = makeHarness({
      extraToolExecutors: () => [{ name: 'room_note' }] as never,
      restrictTools: (purpose) => (purpose === 'room-preplan' ? ['Read'] : null)
    })
    await runner('前置规划提示词', 'room-preplan-U7-AI1', 1, 'room-preplan')
    expect(probe.executorNames).toEqual([['Read']])
  })

  it('名单返回 null → 工具面零变化（含追加；普通轮次行为与引入前逐字一致）', async () => {
    const { runner, probe } = makeHarness({
      extraToolExecutors: () => [{ name: 'room_note' }] as never,
      restrictTools: () => null
    })
    await runner('规划提示词', 'sess-1', 1, 'room')
    expect(probe.executorNames).toEqual([['Read', 'Write', 'Grep', 'room_note']])
  })

  it('未注入 restrictTools → 工具面零变化（缺省路径不感知该能力）', async () => {
    const { runner, probe } = makeHarness()
    await runner('你好', 'sess-1')
    expect(probe.executorNames).toEqual([['Read', 'Write', 'Grep']])
  })
})

describe('前置规划轮落盘与路由：room-preplan 全跳过（影子定位）', () => {
  it('不触 sessionStore（get/getOrCreate/saveMessages 零调用）、不走逆生树路由、不写 RAW', async () => {
    const { runner, probe } = makeHarness({
      resolveSessionContext: async () => {
        probe.resolveContextCalls += 1
        return null
      }
    })
    await runner('前置规划提示词', 'room-preplan-U7-AI2', 2, 'room-preplan')
    expect(probe.sessionStoreCalls).toEqual([])
    expect(probe.resolveContextCalls).toBe(0)
    // 注入组装仍发生（前置规划要拿到身份卡与系统提示词），但锚点固定 null
    expect(probe.injectedSessionContexts).toEqual([null])
    expect(probe.raws).toBe(0)
  })

  it('对照：room 用途仍走 getOrCreate（承载会话）但只写 RAW 不落会话历史', async () => {
    const { runner, probe } = makeHarness()
    await runner('规划提示词', 'sess-1', 1, 'room')
    expect(probe.sessionStoreCalls).toEqual(['get'])
    expect(probe.saves).toHaveLength(0)
    expect(probe.raws).toBe(1)
  })
})

describe('ai-scope：前置规划自描述 id 解析（不落 sessionStore 的作用域来源）', () => {
  /** store.get 被调用即记录；preplan 模式命中时**不应**走到 store */
  function makeStore(getResult: { aiId?: unknown } | undefined) {
    const calls: string[] = []
    const store = {
      get: (id: string) => {
        calls.push(id)
        return getResult
      }
    } as unknown as SessionStore
    return { store, calls }
  }

  it('room-preplan-U7-AI3 → 3：不查 store、不记审计（设计内路径）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { store, calls } = makeStore(undefined)
    expect(resolveSessionAiIdWithAudit('room-preplan-U7-AI3', store)).toBe(3)
    expect(calls).toEqual([])
    expect(warn).not.toHaveBeenCalled()
  })

  it('room-preplan-U1-AI1 → 1（合法下界：AI1 的前置规划仍是 AI1 作用域）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { store, calls } = makeStore(undefined)
    expect(resolveSessionAiIdWithAudit('room-preplan-U1-AI1', store)).toBe(1)
    expect(calls).toEqual([])
    expect(warn).not.toHaveBeenCalled()
  })

  it('形似但不合法的 id 不走捷径：AI0 / 非数字段 → 落到 store 查询路径', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { store, calls } = makeStore(undefined)
    // AI0 不合法（aiId >= 1）→ 模式放过，走 store；store 也没有 → 回落 1 + 审计
    expect(resolveSessionAiIdWithAudit('room-preplan-U1-AI0', store)).toBe(1)
    expect(resolveSessionAiIdWithAudit('room-preplan-Ux-AI2', store)).toBe(1)
    expect(calls).toEqual(['room-preplan-U1-AI0', 'room-preplan-Ux-AI2'])
    expect(warn).toHaveBeenCalledTimes(2)
  })

  it('普通会话 id 行为不变：store 有合法 aiId 用之，无则回落 1 并记一次审计', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { store } = makeStore({ aiId: 5 })
    expect(resolveSessionAiIdWithAudit('chat-1', store)).toBe(5)
    const { store: empty } = makeStore(undefined)
    expect(resolveSessionAiIdWithAudit('chat-2', empty)).toBe(1)
    expect(warn).toHaveBeenCalledTimes(1)
  })
})
