/**
 * 内部会话层（api/internal-session.ts）契约测试。
 *
 * 为什么存在：该层是 v11 双层会话的核心（摘要配置合并与预算推导 / 上下文装配与注入预算截断 /
 * 路由两步「选择→确认→注入」与时间分叉 / 两写·摘要·超限继承的单飞延迟队列），0.15 与 0.17
 * 两次重写却没有一行测试；它的失效形态是「静默降级」（路由失败退线性管线、摘要失败保持旧值、
 * 队列失败只打日志），线上无报错、只在行为上悄悄退化，最需要契约钉住。
 *
 * 作用：用注入 deps 直接驱动 createInternalSessionLayer 工厂——该模块不 import electron，
 * 依赖面（configStore/sessionStore/toolCtx/makeLlmClient）全部显式，所以无需 vi.mock('electron')
 * 即可在真实磁盘（临时目录 + 真 InternalSessionStore）上跑端到端语义。
 *
 * 不删理由：这是该层唯一的测试网；异步队列与时间分叉的竞态（K3 单飞修复）只能靠本文件回归。
 * 关键口径（与生产代码同源，勿在测试内重写第二份）：
 * - 注入预算截断 `contextMsgs.length > 0 && usedChars + msgLen > budget` 用「严格大于」，故
 *   累计字符恰好等于预算时全部保留；
 * - 路由候选 = 逆生树可写尾端（自身无继承子 且 无 timeBranchId）；时间副本（被指向者）必须保留；
 * - 二次确认 fail-closed：确认失败/解析失败一律按不匹配处理，无关会话永不进入上下文；
 * - 摘要失败 = 该次未执行（旧摘要保持），继承失败 = 原会话保持不新建子会话。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'os'
import { join } from 'path'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import {
  createInternalSessionLayer,
  type InternalSessionLayer,
  type InternalSessionJob
} from '../electron/main/api/internal-session'
import { InternalSessionStore } from '../electron/main/services/internal-session-store'
import { DEFAULT_MONITOR_CONFIG } from '../electron/main/monitor/monitor-config'
import { resolveSummaryBudgetChars } from '../electron/main/api/server-utils'
import type { ConfigStore } from '../electron/main/api/config-store'
import type { SessionStore } from '../electron/main/api/session-store'
import type { ToolContext } from '../electron/main/tools/base-tool'
import type { LLMClient } from '../electron/main/api/llm'
import type { ChatMessage, InternalSession } from '@shared/types'

const OWNER = 'sess_owner_1'
/** 与 resolveSummaryBudgetChars 的推导口径同源：用中等窗口模型，自动预算 > 30000 保底 */
const MODEL = 'qwen2.5-72b-instruct'

const TEST_DIR = join(tmpdir(), `internal-session-test-${process.pid}-${Date.now()}`)

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** 轮询等待条件成立（队列是 500ms 定时 + 异步链，固定 sleep 在并行跑测时易抖动） */
async function waitFor(cond: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor 超时：条件未在预算内成立')
    await sleep(40)
  }
}

/** 摘要/路由被调用的种类（按系统提示词首句判定，与生产提示词同源） */
type ReplyKind = 'router' | 'confirm' | 'summary' | 'inheritance'
const REPLY_MARKERS: Array<[ReplyKind, string]> = [
  ['router', '你是会话路由器'],
  ['confirm', '你是会话相关性确认器'],
  ['summary', '你是内部会话摘要维护器'],
  ['inheritance', '你是内部会话继承摘要器']
]

/** 某类轻量调用的回复：字符串 = 原样返回；Error = 抛出（模拟 LLM 不可用）；函数 = 动态/可延时 */
type ReplyValue = string | Error | (() => string | Promise<string>)

const DEFAULT_REPLIES: Record<ReplyKind, string> = {
  router: JSON.stringify({ action: 'create', title: '路由新建' }),
  confirm: JSON.stringify({ matched: true }),
  summary: JSON.stringify({ summary: 'S1' }),
  inheritance: JSON.stringify({ summary: '继承摘要', title: '子会话' })
}

interface Harness {
  layer: InternalSessionLayer
  store: InternalSessionStore
  /** 每次轻量 LLM 调用的 [{ kind, system, user }]（供断言提示词内容与调用次数） */
  calls: Array<{ kind: ReplyKind; system: string; user: string }>
  countOf: (kind: ReplyKind) => number
  /** 覆盖某类回复：字符串 = 原样返回；Error = 抛出；函数 = 动态计算（可异步延时） */
  setReply: (kind: ReplyKind, value: ReplyValue) => void
  clientFactory: ReturnType<typeof vi.fn>
  writeMonitor: (cfg: unknown) => void
}

function mkMessage(patch: Partial<ChatMessage> = {}): ChatMessage {
  return { id: 'm1', role: 'user', content: '内容', createdAt: 1725000000000, ...patch }
}

function mkInternal(patch: Partial<InternalSession> = {}): InternalSession {
  const now = 1725000000000
  return {
    id: 'is_1',
    ownerSessionId: OWNER,
    title: '会话一',
    summary: '',
    createdAt: now,
    updatedAt: now,
    messages: [],
    totalChars: 0,
    cacheLocations: [],
    filePath: 'is_1.json',
    ...patch
  }
}

/** 组装被注入的依赖：真 store 落临时目录，假 LLM 按系统提示词分流回复 */
function createHarness(
  opts: {
    store?: InternalSessionStore
    /** 在真 store 外层包一层（用于注入存储层故障，验证队列的 catch 语义） */
    wrapStore?: (base: InternalSessionStore) => InternalSessionStore
    isReady?: () => boolean
  } = {}
): Harness {
  const root = join(TEST_DIR, 'root')
  const dataDir = join(TEST_DIR, 'sessions')
  mkdirSync(join(root, '.dmn_monitor'), { recursive: true })
  mkdirSync(dataDir, { recursive: true })

  const baseStore = opts.store ?? new InternalSessionStore(() => dataDir)
  const store = opts.wrapStore ? opts.wrapStore(baseStore) : baseStore
  const replies: Record<ReplyKind, ReplyValue> = { ...DEFAULT_REPLIES }
  const calls: Harness['calls'] = []

  const chatWithTools = async (
    messages: Array<{ role: string; content: string }>
  ): Promise<{ content: string }> => {
    const system = messages[0]?.content ?? ''
    const hit = REPLY_MARKERS.find(([, marker]) => system.includes(marker))
    if (!hit) throw new Error(`未识别的轻量 LLM 提示词: ${system.slice(0, 40)}`)
    const kind = hit[0]
    calls.push({ kind, system, user: messages[1]?.content ?? '' })
    const reply = replies[kind]
    if (reply instanceof Error) throw reply
    return { content: typeof reply === 'function' ? await reply() : reply }
  }

  const clientFactory = vi.fn(() => ({
    isReady: opts.isReady ?? (() => true),
    chatWithTools
  })) as unknown as ReturnType<typeof vi.fn>

  const configStore = { get: () => ({ llm: { model: MODEL } }) } as unknown as ConfigStore
  const sessionStore = { getDir: () => dataDir } as unknown as SessionStore
  const toolCtx = { paths: { root } } as unknown as ToolContext

  const layer = createInternalSessionLayer({
    configStore,
    sessionStore,
    sharedInternalSessionStore: store,
    toolCtx,
    makeLlmClient: clientFactory as unknown as (cfg: never) => LLMClient
  })

  return {
    layer,
    store,
    calls,
    countOf: (kind) => calls.filter((c) => c.kind === kind).length,
    setReply: (kind, value) => {
      replies[kind] = value
    },
    clientFactory,
    writeMonitor: (cfg) => {
      const body = typeof cfg === 'string' ? cfg : JSON.stringify(cfg)
      writeFileSync(join(root, '.dmn_monitor', 'config.json'), body, 'utf-8')
    }
  }
}

/** 只覆盖 monitor 的一个 sessionSummary 段，其余字段走单源默认值 */
function writeSummarySegment(cfg: Record<string, unknown>): unknown {
  return { sessionSummary: cfg }
}

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true })
})

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true })
})

/* ============================ 1. 配置合并与预算推导 ============================ */

describe('getSessionSummaryCfg：monitor 段合并与 summaryBudgetChars 生效值推导', () => {
  it('monitor 文件缺失 → 全量默认段，预算按模型窗口自动推导', () => {
    const h = createHarness()
    const cfg = h.layer.getSessionSummaryCfg()
    expect(cfg.enabled).toBe(true)
    expect(cfg.summaryMaxChars).toBe(DEFAULT_MONITOR_CONFIG.sessionSummary.summaryMaxChars)
    expect(cfg.routerMaxSessions).toBe(DEFAULT_MONITOR_CONFIG.sessionSummary.routerMaxSessions)
    expect(cfg.userShardMaxBytes).toBe(DEFAULT_MONITOR_CONFIG.sessionSummary.userShardMaxBytes)
    // 默认段 summaryBudgetChars=0（自动模式）→ 推导为模型窗口 × 1/4（保底 30000）
    expect(cfg.summaryBudgetChars).toBe(
      resolveSummaryBudgetChars(MODEL, DEFAULT_MONITOR_CONFIG.sessionSummary.summaryBudgetChars)
    )
    expect(cfg.summaryBudgetChars).toBeGreaterThan(0)
  })

  it('部分覆盖 → 覆盖项生效、未覆盖项保持单源默认（不出现第二份字面量）', () => {
    const h = createHarness()
    h.writeMonitor(writeSummarySegment({ summaryMaxChars: 99, routerMaxSessions: 7 }))
    const cfg = h.layer.getSessionSummaryCfg()
    expect(cfg.summaryMaxChars).toBe(99)
    expect(cfg.routerMaxSessions).toBe(7)
    expect(cfg.enabled).toBe(DEFAULT_MONITOR_CONFIG.sessionSummary.enabled)
    expect(cfg.userShardMaxBytes).toBe(DEFAULT_MONITOR_CONFIG.sessionSummary.userShardMaxBytes)
  })

  it('显式 summaryBudgetChars>0 → 手动值优先，不自动推导', () => {
    const h = createHarness()
    h.writeMonitor(writeSummarySegment({ summaryBudgetChars: 12345 }))
    expect(h.layer.getSessionSummaryCfg().summaryBudgetChars).toBe(12345)
  })

  it('显式 summaryBudgetChars=0 → 仍走自动推导（0 是「自动」语义而非「零预算」）', () => {
    const h = createHarness()
    h.writeMonitor(writeSummarySegment({ summaryBudgetChars: 0 }))
    expect(h.layer.getSessionSummaryCfg().summaryBudgetChars).toBe(
      resolveSummaryBudgetChars(MODEL, 0)
    )
  })

  it('配置文件损坏（非法 JSON）→ 回落默认段且不抛错', () => {
    const h = createHarness()
    h.writeMonitor('{ not json')
    const cfg = h.layer.getSessionSummaryCfg()
    expect(cfg.enabled).toBe(true)
    expect(cfg.summaryMaxChars).toBe(DEFAULT_MONITOR_CONFIG.sessionSummary.summaryMaxChars)
  })

  it('每轮读取：用户改开关后立即生效，无需重启', () => {
    const h = createHarness()
    expect(h.layer.getSessionSummaryCfg().summaryMaxChars).toBe(200)
    h.writeMonitor(writeSummarySegment({ summaryMaxChars: 42 }))
    expect(h.layer.getSessionSummaryCfg().summaryMaxChars).toBe(42)
  })
})

/* ============================ 2. 上下文装配与注入预算截断 ============================ */

describe('buildSessionContext：锚点装配、预算截断与缓存索引', () => {
  /** 用很小的手动预算让截断可被算术推导 */
  const withBudget = (h: Harness, budget: number): void =>
    h.writeMonitor(writeSummarySegment({ summaryBudgetChars: budget }))

  const internalMsg = (id: string, content: string, role: 'user' | 'assistant' | 'note' = 'user') => ({
    id,
    role,
    content,
    createdAt: 1725000000001
  })

  it('根会话锚点：role=system，含 id / 根会话代际 / 标题 / 无摘要占位', () => {
    const h = createHarness()
    const ctx = h.layer.buildSessionContext(mkInternal({ id: 'is_root', title: '我的会话' }))
    const anchor = ctx.anchorMessages[0]
    expect(anchor.id).toBe('internal_anchor_is_root')
    expect(anchor.role).toBe('system')
    expect(anchor.content).toContain('【内部会话】id=is_root')
    expect(anchor.content).toContain('代际：第 1 代（根会话，无父会话）')
    expect(anchor.content).toContain('标题：我的会话')
    expect(anchor.content).toContain('【会话摘要】（无摘要）')
    expect(anchor.createdAt).toBe(1725000000000)
    expect(ctx.internal.id).toBe('is_root')
  })

  it('继承会话锚点：代际取 gen 且注明父会话 id（AI 据此回翻）', () => {
    const h = createHarness()
    const ctx = h.layer.buildSessionContext(
      mkInternal({ id: 'is_child', parentId: 'is_root', gen: 3, cacheLocations: [] })
    )
    expect(ctx.anchorMessages[0].content).toContain(
      '代际：第 3 代（继承自 is_root，可回翻其会话文件获取原始上下文）'
    )
  })

  it('gen 缺省 → 视为第 1 代', () => {
    const h = createHarness()
    const ctx = h.layer.buildSessionContext(mkInternal({ parentId: 'is_root' }))
    expect(ctx.anchorMessages[0].content).toContain('代际：第 1 代（继承自 is_root')
  })

  it('摘要非空 → 注入摘要原文（锚点只是索引，不替换原文）', () => {
    const h = createHarness()
    const ctx = h.layer.buildSessionContext(mkInternal({ summary: '玩家偏好咖啡' }))
    expect(ctx.anchorMessages[0].content).toContain('【会话摘要】玩家偏好咖啡')
  })

  it('消息保序注入：note 角色映射为 system，content/createdAt 原样带过', () => {
    const h = createHarness()
    const ctx = h.layer.buildSessionContext(
      mkInternal({
        messages: [
          internalMsg('m1', '用户话', 'user'),
          internalMsg('m2', '内部笔记', 'note'),
          internalMsg('m3', 'AI 回复', 'assistant')
        ]
      })
    )
    const injected = ctx.anchorMessages.slice(1)
    expect(injected.map((m) => m.id)).toEqual(['m1', 'm2', 'm3'])
    expect(injected.map((m) => m.role)).toEqual(['user', 'system', 'assistant'])
    expect(injected[1].content).toBe('内部笔记')
    expect(injected[0].createdAt).toBe(1725000000001)
  })

  it('预算截断用严格大于：累计字符恰好等于预算 → 全部保留', () => {
    const h = createHarness()
    withBudget(h, 10)
    const ctx = h.layer.buildSessionContext(
      mkInternal({ messages: [internalMsg('m1', 'aaaaa'), internalMsg('m2', 'bbbbb')] })
    )
    expect(ctx.anchorMessages.slice(1).map((m) => m.id)).toEqual(['m1', 'm2'])
  })

  it('超预算 → 从最新往回累计，超出即丢弃更早的（按算术钉住边界）', () => {
    const h = createHarness()
    withBudget(h, 10)
    // 三条各 5 字符：m3 计入（5）→ m2 计入（5+5=10，不 > 10）→ m1 触发 10+5>10 中断
    const ctx = h.layer.buildSessionContext(
      mkInternal({
        messages: [internalMsg('m1', 'aaaaa'), internalMsg('m2', 'bbbbb'), internalMsg('m3', 'ccccc')]
      })
    )
    expect(ctx.anchorMessages.slice(1).map((m) => m.id)).toEqual(['m2', 'm3'])
  })

  it('至少保留最后一条：单条即超预算也必须注入（保证本轮可用）', () => {
    const h = createHarness()
    withBudget(h, 3)
    const ctx = h.layer.buildSessionContext(
      mkInternal({ messages: [internalMsg('m1', 'x'.repeat(100))] })
    )
    expect(ctx.anchorMessages.slice(1).map((m) => m.id)).toEqual(['m1'])
  })

  it('content 非字符串（存量脏数据）→ 按 0 字符计且不抛错', () => {
    const h = createHarness()
    withBudget(h, 10)
    const ctx = h.layer.buildSessionContext(
      mkInternal({
        messages: [{ id: 'm1', role: 'user', content: undefined as unknown as string, createdAt: 1 }]
      })
    )
    expect(ctx.anchorMessages).toHaveLength(2)
    expect(ctx.anchorMessages[1].content).toBeUndefined()
  })

  it('cacheLocations 非空 → 缓存索引消息追加在尾部（随本会话历史走）', () => {
    const h = createHarness()
    const ctx = h.layer.buildSessionContext(
      mkInternal({ cacheLocations: ['mem/a.json', 'mem/b.json'], updatedAt: 1725000009999 })
    )
    const tail = ctx.anchorMessages[ctx.anchorMessages.length - 1]
    expect(tail.id).toBe('cache_index_is_1')
    expect(tail.role).toBe('system')
    expect(tail.content).toContain('【记忆缓存位置】')
    expect(tail.content).toContain('- mem/a.json\n- mem/b.json')
    expect(tail.createdAt).toBe(1725000009999)
  })

  it('cacheLocations 为空 → 无缓存索引消息（锚点 + 保留消息）', () => {
    const h = createHarness()
    const ctx = h.layer.buildSessionContext(mkInternal({ messages: [internalMsg('m1', 'x')] }))
    expect(ctx.anchorMessages.map((m) => m.id)).toEqual(['internal_anchor_is_1', 'm1'])
  })

  it('顺序契约：锚点恒在首、缓存索引恒在尾、保留消息居中', () => {
    const h = createHarness()
    const ctx = h.layer.buildSessionContext(
      mkInternal({ messages: [internalMsg('m1', 'x')], cacheLocations: ['mem/a.json'] })
    )
    expect(ctx.anchorMessages.map((m) => m.id)).toEqual([
      'internal_anchor_is_1',
      'm1',
      'cache_index_is_1'
    ])
  })
})

/* ============================ 3. 路由 / 沿用 / fail-closed ============================ */

describe('resolveStreamSessionContext：路由两步、时间分叉与失败降级', () => {
  const SID = OWNER
  const userMsg = (content: string, patch: Partial<ChatMessage> = {}): ChatMessage =>
    mkMessage({ id: 'u_turn', role: 'user', content, ...patch })

  it('总开关关闭 → 不路由不注入，active 原样返回且零 LLM 调用', async () => {
    const h = createHarness()
    h.writeMonitor(writeSummarySegment({ enabled: false }))
    const active = { sessionId: SID, internalId: 'is_x' }
    const res = await h.layer.resolveStreamSessionContext({
      opts: undefined,
      sessionId: SID,
      messages: [userMsg('你好')],
      activeInternalContext: active
    })
    expect(res.sessionContext).toBeNull()
    expect(res.activeInternalContext).toBe(active)
    expect(h.calls).toHaveLength(0)
  })

  it('无 sessionId → 直接返回 null（线性管线）', async () => {
    const h = createHarness()
    const res = await h.layer.resolveStreamSessionContext({
      opts: undefined,
      sessionId: undefined,
      messages: [userMsg('你好')],
      activeInternalContext: null
    })
    expect(res).toEqual({ sessionContext: null, activeInternalContext: null })
    expect(h.calls).toHaveLength(0)
  })

  it('审查轮（systemOverride）→ 沿用 active 会话，不路由不新建', async () => {
    const h = createHarness()
    const seeded = h.store.create(SID, { title: '已选会话', content: '首条' })
    const res = await h.layer.resolveStreamSessionContext({
      opts: { systemOverride: '审查轮系统提示' },
      sessionId: SID,
      messages: [userMsg('再检查一遍')],
      activeInternalContext: { sessionId: SID, internalId: seeded.id }
    })
    expect(res.sessionContext?.internal.id).toBe(seeded.id)
    expect(res.activeInternalContext).toEqual({ sessionId: SID, internalId: seeded.id })
    expect(h.calls).toHaveLength(0)
    expect(h.store.list(SID)).toHaveLength(1)
  })

  it('审查轮 active 指向已删除会话 → 上下文为 null，active 保持传入值', async () => {
    const h = createHarness()
    const active = { sessionId: SID, internalId: 'is_gone' }
    const res = await h.layer.resolveStreamSessionContext({
      opts: { systemOverride: 'x' },
      sessionId: SID,
      messages: [userMsg('hi')],
      activeInternalContext: active
    })
    expect(res.sessionContext).toBeNull()
    expect(res.activeInternalContext).toBe(active)
  })

  it('审查轮 active 属于别的用户会话 → 不注入', async () => {
    const h = createHarness()
    const seeded = h.store.create(SID, { title: '会话' })
    const res = await h.layer.resolveStreamSessionContext({
      opts: { systemOverride: 'x' },
      sessionId: 'other_session',
      messages: [userMsg('hi')],
      activeInternalContext: { sessionId: SID, internalId: seeded.id }
    })
    expect(res.sessionContext).toBeNull()
    expect(res.activeInternalContext).toEqual({ sessionId: SID, internalId: seeded.id })
  })

  it('主回复轮 · 无候选 + 路由判「有新主题」→ 纯新建并注入', async () => {
    const h = createHarness()
    h.setReply('router', JSON.stringify({ action: 'create', title: '新主题' }))
    const res = await h.layer.resolveStreamSessionContext({
      opts: undefined,
      sessionId: SID,
      messages: [userMsg('帮我做个新任务')],
      activeInternalContext: null
    })
    const created = h.store.list(SID)
    expect(created).toHaveLength(1)
    expect(created[0].title).toBe('新主题')
    expect(res.activeInternalContext?.internalId).toBe(created[0].id)
    expect(res.sessionContext?.internal.id).toBe(created[0].id)
    // 新建会话的锚点必须已装配（否则注入段为空）
    expect(res.sessionContext?.anchorMessages[0].id).toBe(`internal_anchor_${created[0].id}`)
    expect(h.countOf('router')).toBe(1)
    expect(h.countOf('confirm')).toBe(0)
  })

  it('主回复轮 · 无候选 + 纯寒暄 → 建档兜底（寒暄不丢，全量留存）', async () => {
    const h = createHarness()
    h.setReply('router', JSON.stringify({ action: 'continue' }))
    const res = await h.layer.resolveStreamSessionContext({
      opts: undefined,
      sessionId: SID,
      messages: [userMsg('你好')],
      activeInternalContext: null
    })
    // 无候选时 continue 无对象 → 路由返回 create 兜底：每个输入（含寒暄）都进入内部会话
    expect(h.store.list(SID)).toHaveLength(1)
    expect(res.sessionContext?.internal.id).toBe(h.store.list(SID)[0].id)
    expect(res.activeInternalContext?.internalId).toBe(h.store.list(SID)[0].id)
  })

  it('主回复轮 · 无有效 user 输入（全 activation/非 user）→ 不建档、不调用 LLM', async () => {
    const h = createHarness()
    const res = await h.layer.resolveStreamSessionContext({
      opts: undefined,
      sessionId: SID,
      messages: [
        userMsg('自主激活内容', { activation: true }),
        mkMessage({ id: 'a1', role: 'assistant', content: 'AI 输出', createdAt: 2 })
      ],
      activeInternalContext: null
    })
    expect(res.sessionContext).toBeNull()
    expect(res.activeInternalContext).toBeNull()
    expect(h.store.list(SID)).toHaveLength(0)
    expect(h.calls).toHaveLength(0)
  })

  it('主回复轮 · 路由 continue + 二次确认 matched → 注入被选会话，不新建', async () => {
    const h = createHarness()
    const seeded = h.store.create(SID, { title: '既有主题', content: '上一轮' })
    h.setReply('router', JSON.stringify({ action: 'continue', internalId: seeded.id }))
    h.setReply('confirm', JSON.stringify({ matched: true }))
    const res = await h.layer.resolveStreamSessionContext({
      opts: undefined,
      sessionId: SID,
      messages: [userMsg('接着上次说')],
      activeInternalContext: null
    })
    expect(res.sessionContext?.internal.id).toBe(seeded.id)
    expect(res.activeInternalContext).toEqual({ sessionId: SID, internalId: seeded.id })
    expect(h.store.list(SID)).toHaveLength(1)
    expect(h.countOf('router')).toBe(1)
    expect(h.countOf('confirm')).toBe(1)
  })

it('主回复轮 · 确认 matched=false + 无 active → 新建新话题线（空白承接，不复制被否定内容）', async () => {
    const h = createHarness()
    const seeded = h.store.create(SID, { title: '无关旧会话', content: '别的内容' })
    h.setReply('router', JSON.stringify({ action: 'continue', internalId: seeded.id, title: '新分支' }))
    h.setReply('confirm', JSON.stringify({ matched: false }))
    const res = await h.layer.resolveStreamSessionContext({
      opts: undefined,
      sessionId: SID,
      messages: [userMsg('完全无关的新话题')],
      activeInternalContext: null
    })
    expect(res.sessionContext?.internal.id).not.toBe(seeded.id)
    // 确认不匹配 = AI 判定输入与该会话无关 → 新建【新话题线】（虚线）：空白承接当前输入，
    // 不复制被否定会话的任何内容（无关历史不进入上下文——用户定稿语义）
    expect(res.sessionContext?.internal.isNewTopic).toBe(true)
    expect(res.sessionContext?.internal.title).toBe('新内部会话') // 未被否定会话标题污染
    // 树形挂接：仍从最近可写尾端 seeded 分出（虚线），不另起独立根
    expect(res.sessionContext?.internal.parentId).toBe(seeded.id)
    const all = h.store.list(SID)
    expect(all).toHaveLength(2)
    expect(res.sessionContext?.internal.messages.map((m) => m.content)).toEqual([])
    expect(h.store.get(SID, seeded.id)?.timeBranchId).toBeUndefined()
    expect(all.find((s) => s.isTimeFork)).toBeUndefined()
    expect(res.sessionContext?.internal.filePath?.startsWith(`${seeded.id}/`)).toBe(true)
  })

  it('二次确认 fail-closed：LLM 返回非 JSON → 按不匹配处理，被选会话不进入上下文', async () => {
    const h = createHarness()
    const seeded = h.store.create(SID, { title: '候选', content: '内容' })
    h.setReply('router', JSON.stringify({ action: 'continue', internalId: seeded.id }))
    h.setReply('confirm', '不是 JSON')
    const res = await h.layer.resolveStreamSessionContext({
      opts: undefined,
      sessionId: SID,
      messages: [userMsg('新话题')],
      activeInternalContext: null
    })
    expect(res.sessionContext?.internal.id).not.toBe(seeded.id)
    expect(h.countOf('confirm')).toBe(1)
  })

  it('主回复轮 · 确认不匹配 + 有 active → 新建新话题线（空白承接，不复制 src 内容）', async () => {
    const h = createHarness()
    const src = h.store.create(SID, { title: '最新会话', content: '原始首条' })
    h.setReply('router', JSON.stringify({ action: 'continue', internalId: src.id }))
    h.setReply('confirm', JSON.stringify({ matched: false }))
    const res = await h.layer.resolveStreamSessionContext({
      opts: undefined,
      sessionId: SID,
      messages: [userMsg('换个话题')],
      activeInternalContext: { sessionId: SID, internalId: src.id }
    })
    const newId = res.activeInternalContext?.internalId
    expect(newId).toBeDefined()
    expect(newId).not.toBe(src.id)
    const created = h.store.get(SID, newId as string)
    // 分支语义：确认不匹配 = 新话题线（虚线）——空白承接，不复制 src 内容（无关历史不进上下文）
    expect(created?.isNewTopic).toBe(true)
    expect(created?.isTimeFork).toBeUndefined()
    expect(created?.timeSourceId).toBeUndefined()
    expect(created?.messages.map((m) => m.content)).toEqual([])
    expect(created?.title).toBe('新内部会话') // 不沿用被否定会话标题
    expect(created?.parentId).toBe(src.id)
    expect(created?.gen).toBe((src.gen ?? 1) + 1)
    // 父会话保持原样：不新增时间副本、不设 timeBranchId（老会话不被冻结、不被改写）
    const all = h.store.list(SID)
    expect(all).toHaveLength(2) // src + 新线
    expect(h.store.get(SID, src.id)?.timeBranchId).toBeUndefined()
    expect(all.find((s) => s.isTimeFork)).toBeUndefined()
    // 新会话落入 src 同名文件夹（一个会话文件 + 一个同名文件夹的 NNG 结构）
    expect(created?.filePath?.startsWith(`${src.id}/`)).toBe(true)
    expect(res.sessionContext?.internal.id).toBe(newId)
  })

  it('主回复轮 · 路由 create + 有 active → 从 active 分叉（采用路由标题，原样继承内容）', async () => {
    const h = createHarness()
    const src = h.store.create(SID, { title: '旧标题', content: '旧内容' })
    h.setReply('router', JSON.stringify({ action: 'create', title: '新标题' }))
    const res = await h.layer.resolveStreamSessionContext({
      opts: undefined,
      sessionId: SID,
      messages: [userMsg('新主题')],
      activeInternalContext: { sessionId: SID, internalId: src.id }
    })
    const created = h.store.get(SID, res.activeInternalContext?.internalId as string)
    // create 动作 → 从可写尾端分叉：新会话原样继承 src 内容、挂继承轴向下（父 = src），
    // 父会话保持原样——而非平铺新根、也不另造时间副本
    expect(created?.isTimeFork).toBeUndefined()
    expect(created?.title).toBe('新标题')
    expect(created?.messages.map((m) => m.content)).toEqual(['旧内容'])
    expect(created?.parentId).toBe(src.id)
    expect(created?.gen).toBe((src.gen ?? 1) + 1)
    expect(h.store.get(SID, src.id)?.timeBranchId).toBeUndefined()
    expect(h.store.list(SID)).toHaveLength(2)
  })

  it('主回复轮 · 路由 create 带 summary → 新会话写入初始摘要（原样继承父内容）', async () => {
    const h = createHarness()
    const src = h.store.create(SID, { title: '既有会话', content: '旧内容' })
    h.setReply('router', JSON.stringify({ action: 'create', title: '新线', summary: '这条新线负责做摘要契约闭环' }))
    const res = await h.layer.resolveStreamSessionContext({
      opts: undefined,
      sessionId: SID,
      messages: [userMsg('开始新线')],
      activeInternalContext: { sessionId: SID, internalId: src.id }
    })
    const created = h.store.get(SID, res.activeInternalContext?.internalId as string)
    // AI 路由 create 输出的 summary → 写入新会话顶层 summary 字段（选择时靠它识别这条线）
    expect(created?.summary).toBe('这条新线负责做摘要契约闭环')
    // 分支语义：新会话原样继承父内容，落入 src 同名文件夹；父会话保持原样
    expect(created?.messages.map((m) => m.content)).toEqual(['旧内容'])
    expect(created?.parentId).toBe(src.id)
    expect(created?.filePath?.startsWith(`${src.id}/`)).toBe(true)
    expect(h.store.get(SID, src.id)?.timeBranchId).toBeUndefined()
    expect(h.store.list(SID)).toHaveLength(2)
  })

  it('主回复轮 · 路由 create 带 newTopic=true → 新话题线（虚线）：空白承接，不复制父内容', async () => {
    const h = createHarness()
    const src = h.store.create(SID, { title: '旧话题', content: '旧内容', summary: '旧摘要' })
    h.setReply('router', JSON.stringify({ action: 'create', title: '全新话题', newTopic: true }))
    const res = await h.layer.resolveStreamSessionContext({
      opts: undefined,
      sessionId: SID,
      messages: [userMsg('开个新话题')],
      activeInternalContext: { sessionId: SID, internalId: src.id }
    })
    const created = h.store.get(SID, res.activeInternalContext?.internalId as string)
    // AI 判定新话题 → newTopic=true：不复制父的 messages/summary/cacheLocations，
    // 但保留树形挂接（parentId/gen 指向被切换的尾端，虚线从该尾端引出）
    expect(created?.isNewTopic).toBe(true)
    expect(created?.title).toBe('全新话题')
    expect(created?.messages.map((m) => m.content)).toEqual([])
    expect(created?.summary).toBe('')
    expect(created?.parentId).toBe(src.id)
    expect(created?.gen).toBe((src.gen ?? 1) + 1)
    expect(created?.filePath?.startsWith(`${src.id}/`)).toBe(true)
    expect(h.store.get(SID, src.id)?.timeBranchId).toBeUndefined()
    expect(h.store.list(SID)).toHaveLength(2)
  })

  it('主回复轮 · 路由 create 带 newTopic=true 且指定 parentId → 从指定尾端挂出新话题线', async () => {
    const h = createHarness()
    const parent = h.store.create(SID, { title: '承接线', content: '尾端内容' })
    h.setReply('router', JSON.stringify({ action: 'create', title: '分出新线', parentId: parent.id, newTopic: true }))
    const res = await h.layer.resolveStreamSessionContext({
      opts: undefined,
      sessionId: SID,
      messages: [userMsg('从这条线分个新话题')],
      activeInternalContext: null
    })
    const created = h.store.get(SID, res.activeInternalContext?.internalId as string)
    expect(created?.isNewTopic).toBe(true)
    expect(created?.parentId).toBe(parent.id)
    expect(created?.messages.map((m) => m.content)).toEqual([]) // 空白承接，不复制父内容
    expect(created?.filePath?.startsWith(`${parent.id}/`)).toBe(true)
    expect(res.sessionContext?.internal.id).toBe(created?.id)
  })

  it('主回复轮 · 首次建档路由 create 带 summary → 独立根也写入初始摘要', async () => {
    const h = createHarness()
    h.setReply('router', JSON.stringify({ action: 'create', title: '首个会话', summary: '这是第一个内部会话的自述' }))
    const res = await h.layer.resolveStreamSessionContext({
      opts: undefined,
      sessionId: SID,
      messages: [userMsg('第一个任务')],
      activeInternalContext: null
    })
    const created = h.store.get(SID, res.activeInternalContext?.internalId as string)
    expect(created?.parentId).toBeUndefined()
    expect(created?.title).toBe('首个会话')
    expect(created?.summary).toBe('这是第一个内部会话的自述')
    expect(created?.filePath).toBe(`${created?.id}.json`)
  })

  it('主回复轮 · 路由 create 显式带 parentId → 从指定可写尾端分叉（原样继承，落其同名文件夹）', async () => {
    const h = createHarness()
    const parent = h.store.create(SID, { title: '承接者', content: '尾端内容' })
    h.setReply('router', JSON.stringify({ action: 'create', title: '子话题', parentId: parent.id }))
    const res = await h.layer.resolveStreamSessionContext({
      opts: undefined,
      sessionId: SID,
      messages: [userMsg('新子主题')],
      activeInternalContext: { sessionId: SID, internalId: 'is_gone' } // active 失效，不影响父选择
    })
    const created = h.store.get(SID, res.activeInternalContext?.internalId as string)
    expect(created?.parentId).toBe(parent.id)
    expect(created?.gen).toBe((parent.gen ?? 1) + 1)
    expect(created?.messages.map((m) => m.content)).toEqual(['尾端内容'])
    // 新会话落入父同名文件夹内（一个会话文件 + 一个同名文件夹的 NNG 结构）
    expect(created?.filePath?.startsWith(`${parent.id}/`)).toBe(true)
    expect(h.store.get(SID, parent.id)?.timeBranchId).toBeUndefined()
    expect(h.store.list(SID)).toHaveLength(2)
    expect(res.sessionContext?.internal.id).toBe(created?.id)
  })

  it('主回复轮 · 首次建档（无候选且无 active）→ create 建独立根（不带 parentId）', async () => {
    const h = createHarness()
    h.setReply('router', JSON.stringify({ action: 'create', title: '首个会话' }))
    const res = await h.layer.resolveStreamSessionContext({
      opts: undefined,
      sessionId: SID,
      messages: [userMsg('第一个任务')],
      activeInternalContext: { sessionId: SID, internalId: 'is_gone' }
    })
    const created = h.store.get(SID, res.activeInternalContext?.internalId as string)
    expect(created?.parentId).toBeUndefined()
    expect(created?.title).toBe('首个会话')
    expect(created?.filePath).toBe(`${created?.id}.json`)
  })

  it('主回复轮 · 路由 LLM 抛错 + 有 active → 回退建档兜底（继承 src 承接输入，不丢记录）', async () => {
    const h = createHarness()
    const src = h.store.create(SID, { title: '源标题', content: '源内容' })
    h.setReply('router', new Error('llm down'))
    const res = await h.layer.resolveStreamSessionContext({
      opts: undefined,
      sessionId: SID,
      messages: [userMsg('继续')],
      activeInternalContext: { sessionId: SID, internalId: src.id }
    })
    // 路由 LLM 不可用 → create 兜底（不返回 null）：从可写尾端 src 原样继承分叉，
    // 本轮输入仍进入内部会话（全量留存），不阻塞主对话、不锁定原会话
    expect(res.sessionContext?.internal.id).not.toBe(src.id)
    expect(res.sessionContext?.internal.parentId).toBe(src.id)
    expect(res.sessionContext?.internal.messages.map((m) => m.content)).toEqual(['源内容'])
    expect(res.activeInternalContext?.internalId).toBe(res.sessionContext?.internal.id)
    expect(h.store.list(SID)).toHaveLength(2)
    expect(h.store.get(SID, src.id)?.timeBranchId).toBeUndefined()
    expect(h.countOf('confirm')).toBe(0)
  })

  it('候选 = 逆生树可写尾端：有继承子的父会话与已锁定会话被排除，时间副本被保留', async () => {
    const h = createHarness()
    const rootS = h.store.create(SID, { title: '根' })
    const child = h.store.create(SID, { title: '继承子', parentId: rootS.id, gen: 2 })
    const locked = h.store.create(SID, { title: '时间已延续' })
    await h.store.update(SID, locked.id, { timeBranchId: 'is_next' })
    const fork = h.store.create(SID, {
      title: '时间副本',
      isTimeFork: true,
      timeSourceId: rootS.id
    })
    h.setReply('router', JSON.stringify({ action: 'continue', internalId: child.id }))
    const res = await h.layer.resolveStreamSessionContext({
      opts: undefined,
      sessionId: SID,
      messages: [userMsg('继续话题')],
      activeInternalContext: null
    })
    const routerInput = h.calls.find((c) => c.kind === 'router')?.user ?? ''
    expect(routerInput).toContain(`[${child.id}]`)
    expect(routerInput).toContain(`[${fork.id}]`) // 被指向者是新的可写尾端，必须保留
    expect(routerInput).not.toContain(`[${rootS.id}]`) // 有继承子 → 已冻结
    expect(routerInput).not.toContain(`[${locked.id}]`) // timeBranchId 存在 → 已锁定
    expect(res.sessionContext?.internal.id).toBe(child.id)
  })

  it('装载阶段抛错 → fail-closed 回退线性管线（active 归 null，记日志）', async () => {
    const brokenStore = {
      list: () => {
        throw new Error('store 损坏')
      },
      get: () => null,
      create: () => {
        throw new Error('store 损坏')
      },
      update: async () => {},
      delete: () => {},
      appendMessages: async () => {}
    } as unknown as InternalSessionStore
    const h = createHarness({ store: brokenStore })
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const res = await h.layer.resolveStreamSessionContext({
        opts: undefined,
        sessionId: SID,
        messages: [userMsg('你好')],
        activeInternalContext: { sessionId: SID, internalId: 'is_x' }
      })
      expect(res).toEqual({ sessionContext: null, activeInternalContext: null })
      expect(errSpy).toHaveBeenCalledWith(
        '[session] 内部会话路由/装载失败，回退线性管线:',
        expect.any(Error)
      )
    } finally {
      errSpy.mockRestore()
    }
  })

  it('主回复轮 · 显式选择优先：active 指针存在且有效 → 直接装载所选会话，跳过自动路由 LLM', async () => {
    const h = createHarness()
    const seeded = h.store.create(SID, { title: '被选会话', content: '首条' })
    expect(h.store.getActive(SID)).toBeNull()
    expect(h.store.setActive(SID, seeded.id)).toBe(true)
    expect(h.store.getActive(SID)).toBe(seeded.id)
    expect(h.store.get(SID, seeded.id)?.id).toBe(seeded.id)
    const res = await h.layer.resolveStreamSessionContext({
      opts: undefined,
      sessionId: SID,
      messages: [userMsg('接着上次聊')],
      activeInternalContext: null
    })
    expect(res.sessionContext?.internal.id).toBe(seeded.id)
    expect(res.activeInternalContext).toEqual({ sessionId: SID, internalId: seeded.id })
    // 会话选择是 AI 自己路由的：显式指针存在时 router/confirm 一票都不该调用
    expect(h.calls).toHaveLength(0)
    expect(h.store.list(SID)).toHaveLength(1)
  })

  it('主回复轮 · 显式指针失效（指向已删会话）→ 清指针并回落自动路由', async () => {
    const h = createHarness()
    const seeded = h.store.create(SID, { title: '将被外部清理', content: 'x' })
    expect(h.store.setActive(SID, seeded.id)).toBe(true)
    // 绕过 store.delete（它自带清指针）：物理删除会话文件，模拟用户/外部手动清理
    rmSync(join(h.store.absFilePath(SID, seeded.filePath)))
    h.setReply('router', JSON.stringify({ action: 'create', title: '自动新建' }))
    const res = await h.layer.resolveStreamSessionContext({
      opts: undefined,
      sessionId: SID,
      messages: [userMsg('新话题')],
      activeInternalContext: null
    })
    // 失效指针已清理、自动路由兜底继续工作，且不会装载不存在的会话；
    // 自动路由建档遵循「建即承接」：active 指针落到新建分支而非停留在 null
    const created = h.store.list(SID)[0]
    expect(h.store.getActive(SID)).toBe(created.id)
    expect(h.countOf('router')).toBe(1)
    expect(res.sessionContext?.internal.id).not.toBe(seeded.id)
    expect(res.sessionContext?.internal.id).toBe(created.id)
  })

  it('主回复轮 · 显式指针指向已被压缩的父会话（有继承子）→ 视为失效，清指针回落自动路由', async () => {
    const h = createHarness()
    const parent = h.store.create(SID, { title: '父会话', content: '旧内容' })
    // 超限继承已发生：子会话接管，父会话冻结为只读底稿
    const child = h.store.create(SID, { title: '继承子', parentId: parent.id, gen: 2 })
    expect(h.store.setActive(SID, parent.id)).toBe(true)
    h.setReply('router', JSON.stringify({ action: 'continue', internalId: child.id }))
    h.setReply('confirm', JSON.stringify({ matched: true }))
    const res = await h.layer.resolveStreamSessionContext({
      opts: undefined,
      sessionId: SID,
      messages: [userMsg('继续聊')],
      activeInternalContext: null
    })
    // 父会话不再可写 → 指针被清、自动路由选中继承子（continuity 语义），绝不续写冻结的父会话
    expect(h.store.getActive(SID)).toBeNull()
    expect(res.sessionContext?.internal.id).toBe(child.id)
    expect(h.countOf('router')).toBe(1)
  })

  it('建即承接·手动新建后 active 指针指向新分支：后续消息注入新分支而非残留老承接', async () => {
    const h = createHarness()
    // 场景还原：老会话历史上被 AI 用 session_select 选中，active 指针残留指向它
    const oldSession = h.store.create(SID, { title: '老会话', content: '历史内容' })
    expect(h.store.setActive(SID, oldSession.id)).toBe(true)
    // 用户手动新建内部会话（等价 ipc session:createInternalSession：create + setActive）
    const created = h.store.create(SID, { title: '新分支', content: '首条' })
    expect(h.store.setActive(SID, created.id)).toBe(true)
    // 新消息来临时：显式选择优先应命中新分支，而非残留指针指向的老会话
    const res = await h.layer.resolveStreamSessionContext({
      opts: undefined,
      sessionId: SID,
      messages: [userMsg('新消息')],
      activeInternalContext: null
    })
    expect(res.sessionContext?.internal.id).toBe(created.id)
    expect(res.sessionContext?.internal.id).not.toBe(oldSession.id)
    expect(h.store.getActive(SID)).toBe(created.id)
    // 显式指针已指向新分支 → 不再触发自动路由 LLM（建即承接）
    expect(h.countOf('router')).toBe(0)
    expect(h.countOf('confirm')).toBe(0)
  })

  it('建即承接·自动路由新建完成后 active 指针指向新分支：下次消息直接注入新分支', async () => {
    const h = createHarness()
    const oldSession = h.store.create(SID, { title: '老会话', content: '旧内容' })
    // 场景还原：active 指针尚未建立（AI 从未 session_select、用户也从未手动新建）
    expect(h.store.getActive(SID)).toBeNull()
    // 本轮：用户开新话题 → 无显式指针，自动路由 create 新分支（createAndActivate 建后 setActive）
    h.setReply('router', JSON.stringify({ action: 'create', title: '新分支' }))
    const first = await h.layer.resolveStreamSessionContext({
      opts: undefined,
      sessionId: SID,
      messages: [userMsg('开个新话题')],
      activeInternalContext: null
    })
    const newId = first.activeInternalContext?.internalId
    expect(newId).toBeDefined()
    expect(newId).not.toBe(oldSession.id)
    expect(h.store.getActive(SID)).toBe(newId) // 建即承接：指针已迁移到新分支
    // 下一条消息：显式选择优先命中新分支，不会退回老会话（缺陷修复后的关键行为）
    const second = await h.layer.resolveStreamSessionContext({
      opts: undefined,
      sessionId: SID,
      messages: [userMsg('延续新分支')],
      activeInternalContext: first.activeInternalContext
    })
    expect(second.sessionContext?.internal.id).toBe(newId)
    expect(second.sessionContext?.internal.id).not.toBe(oldSession.id)
    expect(h.countOf('router')).toBe(1) // 仅第一次自动路由，第二次显式装载不再路由
    expect(h.countOf('confirm')).toBe(0)
  })

  it('建即承接·确认不匹配新建新话题线后：active 指针指向新话题线而非曾承接会话', async () => {
    const h = createHarness()
    const src = h.store.create(SID, { title: '最新会话', content: '原始首条' })
    h.setReply('router', JSON.stringify({ action: 'continue', internalId: src.id }))
    h.setReply('confirm', JSON.stringify({ matched: false }))
    const res = await h.layer.resolveStreamSessionContext({
      opts: undefined,
      sessionId: SID,
      messages: [userMsg('换个话题')],
      activeInternalContext: { sessionId: SID, internalId: src.id }
    })
    const newId = res.activeInternalContext?.internalId
    expect(newId).toBeDefined()
    expect(newId).not.toBe(src.id)
    // 新话题线（虚线）建即承接：指针指向它，下一轮消息进入它而非曾承接的 src
    expect(h.store.getActive(SID)).toBe(newId)
    expect(h.store.get(SID, newId as string)?.isNewTopic).toBe(true)
  })

  it('internalLlmChat：透出 content，且客户端未就绪时每次重建（配置变更即生效）', async () => {
    const summaryMsgs = [
      { role: 'system' as const, content: '你是内部会话摘要维护器。' },
      { role: 'user' as const, content: 'x' }
    ]
    const h = createHarness({ isReady: () => true })
    const out = await h.layer.internalLlmChat(summaryMsgs, MODEL)
    expect(out).toBe(DEFAULT_REPLIES.summary)
    await h.layer.internalLlmChat(summaryMsgs, MODEL)
    expect(h.clientFactory).toHaveBeenCalledTimes(1)

    const notReady = createHarness({ isReady: () => false })
    await notReady.layer.internalLlmChat(summaryMsgs)
    await notReady.layer.internalLlmChat(summaryMsgs)
    expect(notReady.clientFactory).toHaveBeenCalledTimes(2)
  })
})

/* ============================ 4. 两写/摘要/继承 单飞延迟队列 ============================ */

describe('enqueueInternalSessionJob：500ms 末次合并 + 串行单飞 + 超限继承', () => {
  const job = (id: string, user: string, ai: string, tools: string[] = []): InternalSessionJob => ({
    userMsg: mkMessage({ id: `u_${id}`, role: 'user', content: user }),
    aiMsg: mkMessage({ id: `a_${id}`, role: 'assistant', content: ai, createdAt: 1725000000002 }),
    toolSummaries: tools
  })

  it('单条 job → 500ms 后落库两写并按摘要回复更新 summary', async () => {
    const h = createHarness()
    const s = h.store.create(OWNER, { title: '会话' })
    h.layer.enqueueInternalSessionJob(OWNER, s.id, job('1', '用户说话', 'AI 回复'))
    // 等待条件必须落在「被断言的可观测结果」上：生产顺序是 appendMessages（落库消息）
    // → generateSummaryUpdate（此处 countOf 计数 +1）→ store.update（写入 summary）。
    // 以 countOf 为条件会在全量并行（16 worker）负载下抢跑——观察到计数 +1 时 update 还没写回，
    // summary 仍是旧值造成偶发假失败（本版全量实测失败一次）。故直接等新摘要落盘。
    await waitFor(() => h.store.get(OWNER, s.id)?.summary === 'S1')
    const after = h.store.get(OWNER, s.id)
    expect(after?.messages.map((m) => `${m.role}:${m.content}`)).toEqual([
      'user:用户说话',
      'assistant:AI 回复'
    ])
    expect(after?.summary).toBe('S1')
    expect(h.countOf('summary')).toBe(1)
    // 摘要输入含本轮两写与创建时间（口径与 session-summarizer 契约一致）
    const summaryInput = h.calls.find((c) => c.kind === 'summary')?.user ?? ''
    expect(summaryInput).toContain('用户说话')
    expect(summaryInput).toContain('AI 回复')
    expect(h.countOf('inheritance')).toBe(0)
  })

  it('500ms 内连发多轮 → 合并为一次批次（一次 append + 一次摘要），顺序保自然交替', async () => {
    const h = createHarness()
    const s = h.store.create(OWNER, { title: '会话' })
    h.layer.enqueueInternalSessionJob(OWNER, s.id, job('1', '第一轮用户', '第一轮 AI'))
    h.layer.enqueueInternalSessionJob(OWNER, s.id, job('2', '第二轮用户', '第二轮 AI'))
    await waitFor(() => h.countOf('summary') === 1)
    const after = h.store.get(OWNER, s.id)
    expect(after?.messages.map((m) => m.id)).toEqual(['u_1', 'a_1', 'u_2', 'a_2'])
    expect(h.countOf('summary')).toBe(1) // 合并成一次摘要调用（费用与时序双收益）
    const summaryInput = h.calls.find((c) => c.kind === 'summary')?.user ?? ''
    expect(summaryInput).toContain('第一轮用户')
    expect(summaryInput).toContain('第二轮用户')
  })

  it('跨越 500ms 边界 → 分两批串行执行（各自一次摘要）', async () => {
    const h = createHarness()
    const s = h.store.create(OWNER, { title: '会话' })
    h.layer.enqueueInternalSessionJob(OWNER, s.id, job('1', '甲', '甲回复'))
    await waitFor(() => h.countOf('summary') === 1)
    h.layer.enqueueInternalSessionJob(OWNER, s.id, job('2', '乙', '乙回复'))
    await waitFor(() => h.countOf('summary') === 2)
    expect(h.store.get(OWNER, s.id)?.messages).toHaveLength(4)
  })

  it('单飞：同一内部会话的维护任务不并发（第二批等第一批执行完）', async () => {
    const h = createHarness()
    const s = h.store.create(OWNER, { title: '会话' })
    // 首批摘要耗时 1000ms：批次在其执行窗口（500~1500ms）内到期入链 → 无单飞时会并发
    let active = 0
    let maxActive = 0
    h.setReply('summary', async () => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await sleep(1000)
      active -= 1
      return DEFAULT_REPLIES.summary
    })
    h.layer.enqueueInternalSessionJob(OWNER, s.id, job('1', '甲', '甲回复'))
    await sleep(700)
    h.layer.enqueueInternalSessionJob(OWNER, s.id, job('2', '乙', '乙回复'))
    await waitFor(() => h.countOf('summary') === 2)
    expect(maxActive).toBe(1)
    expect(h.store.get(OWNER, s.id)?.messages).toHaveLength(4)
  })

  it('摘要 LLM 抛错 → 旧摘要保持（summarizer 内部吞错），消息已落库，队列仍可继续', async () => {
    const h = createHarness()
    const s = h.store.create(OWNER, { title: '会话' })
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      h.setReply('summary', new Error('llm down'))
      h.layer.enqueueInternalSessionJob(OWNER, s.id, job('1', '甲', '甲回复'))
      await waitFor(() => h.countOf('summary') === 1)
      // 摘要失败语义 = 该次未执行（generateSummaryUpdate 捕获后返回 null），
      // 故队列链本身不报错、旧摘要（空）保持；消息在摘要之前已落库。
      await waitFor(() => (h.store.get(OWNER, s.id)?.messages.length ?? 0) === 2)
      const after = h.store.get(OWNER, s.id)
      expect(after?.summary).toBe('')
      expect(errSpy).not.toHaveBeenCalled()

      h.setReply('summary', DEFAULT_REPLIES.summary)
      h.layer.enqueueInternalSessionJob(OWNER, s.id, job('2', '乙', '乙回复'))
      await waitFor(() => h.store.get(OWNER, s.id)?.summary === 'S1')
    } finally {
      errSpy.mockRestore()
    }
  })

  it('存储层抛错（append 失败）→ 队列 catch 记日志且不向外抛出', async () => {
    const h = createHarness({
      wrapStore: (base) =>
        new Proxy(base, {
          get(target, prop, receiver) {
            if (prop === 'appendMessages') {
              return async () => {
                throw new Error('disk full')
              }
            }
            const v = Reflect.get(target, prop, receiver)
            return typeof v === 'function' ? v.bind(target) : v
          }
        }) as InternalSessionStore
    })
    const s = h.store.create(OWNER, { title: '会话' })
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      // 不 await 任何东西：入队后只观察日志，确保异常被链的 catch 吸收而非冒泡成 unhandled rejection
      h.layer.enqueueInternalSessionJob(OWNER, s.id, job('1', '甲', '甲回复'))
      await waitFor(() => errSpy.mock.calls.length > 0)
      expect(errSpy).toHaveBeenCalledWith(
        '[session] 内部会话两写/摘要维护失败:',
        expect.any(Error)
      )
      expect(h.countOf('summary')).toBe(0) // append 失败即中断，不会继续调摘要
    } finally {
      errSpy.mockRestore()
    }
  })

  it('toolSummaries 非空才写入字段；空数组不带该键', async () => {
    const h = createHarness()
    const s = h.store.create(OWNER, { title: '会话' })
    h.layer.enqueueInternalSessionJob(OWNER, s.id, job('1', '甲', '甲回复', ['Read: 读到 3 行']))
    h.layer.enqueueInternalSessionJob(OWNER, s.id, job('2', '乙', '乙回复'))
    await waitFor(() => h.countOf('summary') === 1)
    const msgs = h.store.get(OWNER, s.id)?.messages ?? []
    expect(msgs[1].toolSummaries).toEqual(['Read: 读到 3 行'])
    expect('toolSummaries' in (msgs[3] as object)).toBe(false)
    // 工具摘要并入摘要输入（多轮展平）
    expect(h.calls.find((c) => c.kind === 'summary')?.user ?? '').toContain('Read: 读到 3 行')
  })

  it('userMsg 缺省 / content 非字符串 → 防御为不再抛错的空串写入', async () => {
    const h = createHarness()
    const s = h.store.create(OWNER, { title: '会话' })
    h.layer.enqueueInternalSessionJob(OWNER, s.id, {
      aiMsg: mkMessage({ id: 'a_1', role: 'assistant', content: 123 as unknown as string }),
      toolSummaries: []
    })
    // 等待条件必须落在「被断言的可观测结果」上：摘要 LLM 被调用（countOf）发生在写库之前，
    // 以它为条件会在全量并行（16 worker）负载下抢跑——观察到调用数 +1 时 updateSummary 还没写盘，
    // 于是 summary 仍是旧值造成偶发假失败。故直接等 store 里的新摘要落盘。
    await waitFor(() => h.store.get(OWNER, s.id)?.summary === 'S1')
    const after = h.store.get(OWNER, s.id)
    expect(after?.messages.map((m) => `${m.role}:${m.content}`)).toEqual(['assistant:'])
    expect(after?.summary).toBe('S1')
  })

  it('超限继承：totalChars 超预算 → 新建子会话承接，原会话消息与摘要完整保留', async () => {
    const h = createHarness()
    h.writeMonitor(writeSummarySegment({ summaryBudgetChars: 10 }))
    const s = h.store.create(OWNER, { title: '父会话' })
    h.setReply('inheritance', JSON.stringify({ summary: '继承摘要', title: '子会话' }))
    h.layer.enqueueInternalSessionJob(OWNER, s.id, job('1', '用户输入很长很长很长很长', 'AI 回复'))
    await waitFor(() => h.store.list(OWNER).some((x) => x.parentId === s.id))
    const parent = h.store.get(OWNER, s.id)
    expect(parent?.messages).toHaveLength(2) // 不删消息
    expect(parent?.summary).toBe('S1') // 不覆盖旧摘要（继承摘要只进子会话）
    const children = h.store.list(OWNER).filter((x) => x.parentId === s.id)
    expect(children).toHaveLength(1)
    expect(children[0].gen).toBe(2)
    expect(children[0].summary).toBe('继承摘要')
    expect(children[0].title).toBe('子会话')
    expect(children[0].cacheLocations).toEqual(parent?.cacheLocations)
    // 文件层分支结构：原会话文件保留在 ai/ 根（父=一份他自己），子会话落入父同名文件夹
    // （父.json + 父/ 子.json ——「一个会话文件 + 一个同名文件夹」的 NNG 结构）
    expect(parent?.filePath).toBe(`${s.id}.json`)
    expect(children[0].filePath.startsWith(`${s.id}/`)).toBe(true)
    expect(h.countOf('inheritance')).toBe(1)
  })

  it('继承摘要给出 cacheLocations → 覆盖父会话缓存位置（不沿用旧值）', async () => {
    const h = createHarness()
    h.writeMonitor(writeSummarySegment({ summaryBudgetChars: 10 }))
    const s = h.store.create(OWNER, { title: '父会话', cacheLocations: ['mem/old.json'] })
    h.setReply(
      'inheritance',
      JSON.stringify({ summary: '继承摘要', cacheLocations: ['mem/new.json'] })
    )
    h.layer.enqueueInternalSessionJob(OWNER, s.id, job('1', '很长很长的用户输入内容', 'AI 回复'))
    await waitFor(() => h.store.list(OWNER).some((x) => x.parentId === s.id))
    const child = h.store.list(OWNER).find((x) => x.parentId === s.id)
    expect(child?.cacheLocations).toEqual(['mem/new.json'])
    expect(child?.title).toBe('父会话') // plan 未给 title → 沿用父标题
  })

  it('未超预算（默认自动预算）→ 不触发继承', async () => {
    const h = createHarness()
    const s = h.store.create(OWNER, { title: '会话' })
    h.writeMonitor(writeSummarySegment({ summaryBudgetChars: DEFAULT_MONITOR_CONFIG.sessionSummary.summaryBudgetChars }))
    h.layer.enqueueInternalSessionJob(OWNER, s.id, job('1', '短', '短回复'))
    // 等待条件必须落在「批次的可观测终态」上，不能落在假 LLM「被调用」上：
    // 非继承分支里 `await store.update` 是批次最后一个异步步骤，其后只剩同步的预算判定
    // （本用例预算为自动推导的大值、输入极短，判定必然为否）。若以 countOf('summary') 为条件，
    // 它在 calls.push 时即成立（早于 update 落盘、更早于预算判定），断言就可能先于判定执行——
    // 哪天预算逻辑回归成恒真，这条否定断言仍会假绿。等新摘要落盘即保证批次已走完
    // （promise 续体是微任务，必然先于下一次计时器轮询排空）。
    await waitFor(() => h.store.get(OWNER, s.id)?.summary === 'S1')
    expect(h.countOf('inheritance')).toBe(0)
    expect(h.store.list(OWNER)).toHaveLength(1)
  })

  it('继承摘要失败（非 JSON）→ 原会话保持、不新建子会话（下次批次再试）', async () => {
    const h = createHarness()
    h.writeMonitor(writeSummarySegment({ summaryBudgetChars: 10 }))
    const s = h.store.create(OWNER, { title: '父会话' })
    h.setReply('inheritance', '不是 JSON')
    h.layer.enqueueInternalSessionJob(OWNER, s.id, job('1', '用户输入很长很长很长很长', 'AI 回复'))
    await waitFor(() => h.countOf('inheritance') === 1)
    // 这里 countOf 是能拿到的最强信号（失败分支不产生任何可观测落盘，没有更晚的终态可等），
    // 但「调用发生」早于「分支收尾」：解析与 return null 都在假 LLM 返回之后的微任务里。
    // 让出一次宏任务即排空这些微任务（微任务队列先于计时器回调清空），断言的才是批次终态，
    // 否则若失败语义哪天回归成「兜底建子会话」，child 可能晚于断言落库而假绿。
    await sleep(0)
    expect(h.store.list(OWNER)).toHaveLength(1)
    expect(h.store.get(OWNER, s.id)?.messages).toHaveLength(2)
  })

  it('目标会话已删除 → 静默作废（不落库、不调 LLM、不抛错）', async () => {
    const h = createHarness()
    const s = h.store.create(OWNER, { title: '会话' })
    h.store.delete(OWNER, s.id)
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      h.layer.enqueueInternalSessionJob(OWNER, s.id, job('1', '甲', '甲回复'))
      await sleep(700)
      expect(h.store.get(OWNER, s.id)).toBeNull()
      expect(h.calls).toHaveLength(0)
      expect(errSpy).not.toHaveBeenCalled()
    } finally {
      errSpy.mockRestore()
    }
  })
})
