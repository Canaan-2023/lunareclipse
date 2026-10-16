import { describe, it, expect, vi } from 'vitest'
import { generateSummaryUpdate, generateInheritanceSummary } from '../electron/main/services/session-summarizer'
import { confirmSessionMatch, routeSession } from '../electron/main/services/session-router'
import type { SessionSummaryConfig, InternalSession, InternalSessionSummary } from '../shared/types'

/**
 * v11 双层会话服务回归（0.17 继承式改造后）：
 * 1) summarizer 常态增量 —— 截断输入/输出、失败=未执行(null)、旧摘要保持；
 * 2) summarizer 超限继承 —— AI 再加工旧会话产出继承摘要（summary 必填、title/cacheLocations
 *    可选）、失败=未继承；【不输出 keepIds、不删消息】——层内删消息的旧压缩方案已被
 *    用户否决（原会话不动，新建子会话承接，原始数据保留供回翻）；
 * 3) router —— 候选空→create、continue 目标必须命中候选、失败=无动作(null)、候选行含代际。
 */
const cfg: SessionSummaryConfig = {
  enabled: true,
  summaryMaxChars: 200,
  summaryBudgetChars: 700000,
  routerMaxSessions: 50,
  userShardMaxBytes: 500000
}

function internal(over: Partial<InternalSession> = {}): InternalSession {
  const base: InternalSession = {
    id: 'is_test',
    ownerSessionId: 'ses_1',
    title: '测试会话',
    summary: '旧摘要',
    createdAt: 1725000000000,
    updatedAt: 1725000000000,
    messages: [
      { id: 'm1', role: 'user', content: '问题一', createdAt: 1725000000000 },
      { id: 'm2', role: 'assistant', content: '回答一', createdAt: 1725000001000 },
      { id: 'm3', role: 'user', content: '问题二', createdAt: 1725000002000 }
    ],
    totalChars: 100,
    cacheLocations: ['memory/block-a', 'memory/block-b']
  }
  return { ...base, ...over }
}

function candidate(id: string, updatedAt: number, title = '会话', over: Partial<InternalSessionSummary> = {}): InternalSessionSummary {
  return {
    id,
    ownerSessionId: 'ses_1',
    title,
    summary: '摘要',
    createdAt: updatedAt - 1000,
    updatedAt,
    messageCount: 2,
    totalChars: 500,
    cacheLocations: [],
    ...over
  }
}

describe('session-summarizer 常态增量', () => {
  it('LLM 返回 JSON → 输出新摘要（按 summaryMaxChars 截断）', async () => {
    const chat = vi.fn().mockResolvedValue(JSON.stringify({ summary: '结论：采用 A 方案，B 路径已弃用' }))
    const out = await generateSummaryUpdate(chat, {
      oldSummary: '旧摘要',
      userContent: '我们选 A 还是 B？',
      assistantContent: '选 A。',
      toolSummaries: ['read: 文件内容'],
      createdAt: 1725000000000
    }, cfg)
    expect(out).toBe('结论：采用 A 方案，B 路径已弃用')
    expect(chat).toHaveBeenCalledTimes(1)
    const sys = chat.mock.calls[0][0][0].content
    expect(sys).toContain(String(cfg.summaryMaxChars))
    const user = chat.mock.calls[0][0][1].content
    expect(user).toContain('会话创建时间')
    expect(user).toContain('旧摘要')
  })

  it('LLM 返回带 markdown 围栏的 JSON → 仍能解析', async () => {
    const chat = vi.fn().mockResolvedValue('```json\n{"summary": "结论保持"}\n```')
    const out = await generateSummaryUpdate(chat, { oldSummary: '', userContent: 'x', assistantContent: 'y', toolSummaries: [], createdAt: 1 }, cfg)
    expect(out).toBe('结论保持')
  })

  it('LLM 抛错 → null（本次摘要未执行）', async () => {
    const chat = vi.fn().mockRejectedValue(new Error('upstream down'))
    const out = await generateSummaryUpdate(chat, { oldSummary: '旧', userContent: 'x', assistantContent: 'y', toolSummaries: [], createdAt: 1 }, cfg)
    expect(out).toBeNull()
  })

  it('解析失败/空摘要 → null', async () => {
    const chat = vi.fn().mockResolvedValue('这不是 JSON')
    const out = await generateSummaryUpdate(chat, { oldSummary: '旧', userContent: 'x', assistantContent: 'y', toolSummaries: [], createdAt: 1 }, cfg)
    expect(out).toBeNull()
    const chat2 = vi.fn().mockResolvedValue(JSON.stringify({ summary: '   ' }))
    const out2 = await generateSummaryUpdate(chat2, { oldSummary: '旧', userContent: 'x', assistantContent: 'y', toolSummaries: [], createdAt: 1 }, cfg)
    expect(out2).toBeNull()
  })

  it('输出超过 summaryMaxChars → 截断', async () => {
    const chat = vi.fn().mockResolvedValue(JSON.stringify({ summary: '啊'.repeat(500) }))
    const out = await generateSummaryUpdate(chat, { oldSummary: '', userContent: 'x', assistantContent: 'y', toolSummaries: [], createdAt: 1 }, cfg)
    expect(out?.length).toBe(200)
  })

  it('输入侧截断：超长用户输入与 AI 回复不超限直送', async () => {
    const chat = vi.fn().mockResolvedValue(JSON.stringify({ summary: 'ok' }))
    await generateSummaryUpdate(chat, {
      oldSummary: '旧',
      userContent: 'u'.repeat(5000),
      assistantContent: 'a'.repeat(5000),
      toolSummaries: ['t'.repeat(2000)],
      createdAt: 1
    }, cfg)
    const user = chat.mock.calls[0][0][1].content
    expect(user.length).toBeLessThan(4300) // 2000+2000+160 + 固定头部
  })
})

describe('session-summarizer 超限继承', () => {
  it('LLM 返回总结 → 继承摘要采纳（summary 必填、title/cacheLocations 可选采纳、纯文本不被当消息删除）', async () => {
    const session = internal()
    const chat = vi.fn().mockResolvedValue(JSON.stringify({
      summary: '本会话讨论 A 方案选型：选定 A，B 已弃用；下一步实现模块 X。',
      cacheLocations: ['memory/block-a'],
      title: 'A方案落地'
    }))
    const plan = await generateInheritanceSummary(chat, { internal: session })
    expect(plan).not.toBeNull()
    expect(plan!.summary).toContain('A 方案选型')
    expect(plan!.cacheLocations).toEqual(['memory/block-a'])
    expect(plan!.title).toBe('A方案落地')
    // 继承摘要契约：无 keepIds 字段——不删任何消息（原会话完整保留供回翻）
    expect(plan).not.toHaveProperty('keepIds')
  })

  it('summary 缺失/空 → 继承作废（原会话保持，宁可不继承）', async () => {
    const session = internal()
    const chat = vi.fn().mockResolvedValue(JSON.stringify({ title: '没有摘要' }))
    const plan = await generateInheritanceSummary(chat, { internal: session })
    expect(plan).toBeNull()
    const chat2 = vi.fn().mockResolvedValue(JSON.stringify({ summary: '   ' }))
    const plan2 = await generateInheritanceSummary(chat2, { internal: session })
    expect(plan2).toBeNull()
  })

  it('title/cacheLocations 缺省 → 继承摘要仅 summary（上层沿用父会话值）', async () => {
    const session = internal()
    const chat = vi.fn().mockResolvedValue(JSON.stringify({ summary: '仅摘要' }))
    const plan = await generateInheritanceSummary(chat, { internal: session })
    expect(plan).toEqual({ summary: '仅摘要' })
  })

  it('LLM 抛错 / 非法输出 / 字段类型错 → null（本次继承未执行）', async () => {
    const chat = vi.fn().mockRejectedValue(new Error('boom'))
    const out = await generateInheritanceSummary(chat, { internal: internal() })
    expect(out).toBeNull()
    const chat2 = vi.fn().mockResolvedValue('随便说说')
    const out2 = await generateInheritanceSummary(chat2, { internal: internal() })
    expect(out2).toBeNull()
    const chat3 = vi.fn().mockResolvedValue(JSON.stringify({ summary: 123 }))
    const out3 = await generateInheritanceSummary(chat3, { internal: internal() })
    expect(out3).toBeNull()
  })
})

describe('session-router', () => {
  it('候选为空且输入有实质主题 → create（调 LLM 判定，标题采纳）', async () => {
    const chat = vi.fn().mockResolvedValue(JSON.stringify({ action: 'create', title: '新主题', reason: '无会话建档' }))
    const out = await routeSession(chat, { userInput: '新任务开始', now: 1725000000000, candidates: [] }, cfg)
    expect(out?.action).toBe('create')
    expect(out?.title).toBe('新主题')
    expect(chat).toHaveBeenCalledTimes(1)
  })

  it('候选为空且纯寒暄 → create 建档兜底（寒暄不丢，全量留存）', async () => {
    const chat = vi.fn().mockResolvedValue(JSON.stringify({ action: 'continue', reason: '寒暄' }))
    const out = await routeSession(chat, { userInput: '你好', now: 1725000000000, candidates: [] }, cfg)
    // 无候选时 continue 无对象 → 强制建档（LLM 只提供 title/summary）——寒暄也有会话承接
    expect(out?.action).toBe('create')
    expect(chat).toHaveBeenCalledTimes(1)
  })

  it('候选为空且 LLM 失败 → create 建档兜底（不丢输入，默认标题）', async () => {
    const chat = vi.fn().mockRejectedValue(new Error('boom'))
    const out = await routeSession(chat, { userInput: '新任务开始', now: 1725000000000, candidates: [] }, cfg)
    expect(out?.action).toBe('create')
    expect(out?.title).toBeUndefined() // 默认标题交给调用方 createAndActivate 兜底
  })

  it('continue 且目标在候选清单 → 命中', async () => {
    const chat = vi.fn().mockResolvedValue(JSON.stringify({ action: 'continue', internalId: 'is_b', reason: '延续主题' }))
    const out = await routeSession(chat, {
      userInput: '继续刚才那个话题',
      now: 1725000000000,
      candidates: [candidate('is_a', 100), candidate('is_b', 200)]
    }, cfg)
    expect(out?.action).toBe('continue')
    expect(out?.internalId).toBe('is_b')
    expect(chat.mock.calls[0][0][1].content).toContain('创建于') // 清单必含 createdAt
  })

  it('候选行含代际信息（AI 可见结构化继承，UI 不显示）', async () => {
    const chat = vi.fn().mockResolvedValue(JSON.stringify({ action: 'continue', internalId: 'is_child', reason: 'x' }))
    await routeSession(chat, {
      userInput: '继续',
      now: 1,
      candidates: [
        candidate('is_child', 300, '子会话', { parentId: 'is_root', gen: 2 }),
        candidate('is_root', 100, '根会话', { gen: 1 })
      ]
    }, cfg)
    const user = chat.mock.calls[0][0][1].content
    expect(user).toContain('代际：第 2 代（继承自 is_root')
    expect(user).toContain('代际：第 1 代（根会话')
  })

  it('continue 但目标不在候选清单 → 回退 create 建档（绝不 continue 到非法目标）', async () => {
    const chat = vi.fn().mockResolvedValue(JSON.stringify({ action: 'continue', internalId: 'is_ghost', reason: 'x' }))
    const out = await routeSession(chat, { userInput: 'x', now: 1, candidates: [candidate('is_a', 1)] }, cfg)
    expect(out?.action).toBe('create')
    expect(out?.internalId).toBeUndefined()
  })

  it('create → 标题采纳（超长截断）', async () => {
    const chat = vi.fn().mockResolvedValue(JSON.stringify({ action: 'create', title: '新'.repeat(80), reason: '新主题' }))
    const out = await routeSession(chat, { userInput: '我们来做点别的', now: 1, candidates: [candidate('is_a', 1)] }, cfg)
    expect(out?.action).toBe('create')
    expect(out?.title?.length).toBeLessThanOrEqual(30)
  })

  it('create 带 parentId 且在候选内 → 采纳（新会话在逆生树中向下展开的挂接点）', async () => {
    const parent = candidate('is_parent', 300, '承接者')
    const chat = vi.fn().mockResolvedValue(JSON.stringify({ action: 'create', title: '子话题', parentId: parent.id, reason: '承接工作线' }))
    const out = await routeSession(chat, { userInput: '新子任务', now: 1, candidates: [parent] }, cfg)
    expect(out?.action).toBe('create')
    expect(out?.parentId).toBe(parent.id)
  })

  it('create 带 parentId 但不在候选内 → 忽略（绝不挂到已冻结/已锁定父下破坏继承语义）', async () => {
    const chat = vi.fn().mockResolvedValue(JSON.stringify({ action: 'create', title: '子话题', parentId: 'is_ghost', reason: 'x' }))
    const out = await routeSession(chat, { userInput: 'x', now: 1, candidates: [candidate('is_a', 1)] }, cfg)
    expect(out?.action).toBe('create')
    expect(out?.parentId).toBeUndefined()
  })

  it('LLM 失败 / 非法 action → 回退 create 建档；空输入 → null', async () => {
    const chat = vi.fn().mockRejectedValue(new Error('x'))
    const out1 = await routeSession(chat, { userInput: 'x', now: 1, candidates: [candidate('is_a', 1)] }, cfg)
    expect(out1?.action).toBe('create')
    expect(out1?.internalId).toBeUndefined()
    const chat2 = vi.fn().mockResolvedValue(JSON.stringify({ action: 'delete' }))
    const out2 = await routeSession(chat2, { userInput: 'x', now: 1, candidates: [candidate('is_a', 1)] }, cfg)
    expect(out2?.action).toBe('create')
    const chat3 = vi.fn()
    expect(await routeSession(chat3, { userInput: '   ', now: 1, candidates: [candidate('is_a', 1)] }, cfg)).toBeNull()
    expect(chat3).not.toHaveBeenCalled()
  })

  it('create 带 newTopic=true → 透传（AI 判定新话题，调用方画虚线空白承接）', async () => {
    const chat = vi.fn().mockResolvedValue(JSON.stringify({ action: 'create', title: '新话题', newTopic: true, reason: 'x' }))
    const out = await routeSession(chat, { userInput: '新开一个话题', now: 1, candidates: [candidate('is_a', 1)] }, cfg)
    expect(out?.action).toBe('create')
    expect(out?.newTopic).toBe(true)
  })

  it('create 无 newTopic 字段 → 缺省继承语义（延续实线）', async () => {
    const chat = vi.fn().mockResolvedValue(JSON.stringify({ action: 'create', title: '延续', reason: 'x' }))
    const out = await routeSession(chat, { userInput: '继续做', now: 1, candidates: [candidate('is_a', 1)] }, cfg)
    expect(out?.action).toBe('create')
    expect(out?.newTopic).toBeUndefined()
  })

  it('候选超过 routerMaxSessions → 只送前 N 个', async () => {
    const chat = vi.fn().mockResolvedValue(JSON.stringify({ action: 'create', reason: 'x' }))
    const candidates = Array.from({ length: 60 }, (_, i) => candidate(`is_${i}`, i))
    await routeSession(chat, { userInput: 'x', now: 1, candidates }, { ...cfg, routerMaxSessions: 5 })
    const user = chat.mock.calls[0][0][1].content
    expect(user).toContain('is_4')
    expect(user).not.toContain('is_5')
  })
})

describe('session-router 二次确认（选择→确认→注入，v0.22）', () => {
  const cand: InternalSessionSummary = candidate('is_match', 1725000000000, 'A方案选型', {
    summary: '讨论 A 方案与 B 方案的取舍，最终选定 A。',
    gen: 2,
    parentId: 'is_root'
  })
  const input = { userInput: '继续 A 方案的落地实现', now: 1725000000000, candidate: cand }

  it('LLM 确认 matched:true → 返回匹配（注入前置条件成立）', async () => {
    const chat = vi.fn().mockResolvedValue(JSON.stringify({ matched: true, reason: '延续 A 方案主题' }))
    const out = await confirmSessionMatch(chat, input)
    expect(out?.matched).toBe(true)
    expect(out?.reason).toBe('延续 A 方案主题')
    expect(chat).toHaveBeenCalledTimes(1)
    // 确认提示词必须让 AI 看到候选摘要与代际，否则无法裁决相关性
    const user = chat.mock.calls[0][0][1].content
    expect(user).toContain('用户输入')
    expect(user).toContain('A 方案与 B 方案的取舍')
    expect(user).toContain('第 2 代（继承自 is_root）')
  })

  it('LLM 确认 matched:false → 返回不匹配（调用方据此新建，不注入无关会话）', async () => {
    const chat = vi.fn().mockResolvedValue(JSON.stringify({ matched: false, reason: '输入是全新主题' }))
    const out = await confirmSessionMatch(chat, input)
    expect(out?.matched).toBe(false)
  })

  it('带回 markdown 围栏的 JSON → 仍能解析', async () => {
    const chat = vi.fn().mockResolvedValue('```json\n{"matched": true}\n```')
    const out = await confirmSessionMatch(chat, input)
    expect(out?.matched).toBe(true)
  })

  it('LLM 抛错 / 解析失败 / matched 非 boolean → null（fail-closed：按不匹配新建）', async () => {
    const boom = vi.fn().mockRejectedValue(new Error('upstream down'))
    expect(await confirmSessionMatch(boom, input)).toBeNull()
    const bad = vi.fn().mockResolvedValue('不是 JSON')
    expect(await confirmSessionMatch(bad, input)).toBeNull()
    const wrongType = vi.fn().mockResolvedValue(JSON.stringify({ matched: 'yes' }))
    expect(await confirmSessionMatch(wrongType, input)).toBeNull()
  })

  it('空输入 → null 且不调用 LLM', async () => {
    const chat = vi.fn()
    expect(await confirmSessionMatch(chat, { userInput: '   ', now: 1, candidate: cand })).toBeNull()
    expect(chat).not.toHaveBeenCalled()
  })
})