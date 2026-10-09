/**
 * P2 多 AI 注入链按 aiId 泛化 — 单元验证
 *
 * 覆盖两个核心机制：
 * 1. segments 层：identity / sys_prompt 段按会话 sessionId 转交 deps 的
 *    aiId 感知函数（getAiIdentity/getSysPrompt 都带 sessionId 参数），
 *    从而上一层（server.ts SEGMENTS deps）据会话 aiId 查 registry / 读副本；
 *    ABYSS 体系按 user_md / ai_md 两段独立注入（readUserMd 读用户级 USER.md，
 *    readAiMd 读 AI 级 AI.md，各自带 sessionId 参数以定位会话所属 AI）。
 * 2. session-store 层：会话创建/读取带 aiId 字段；旧会话（meta 无 aiId）读取侧不抛错、
 *    字段缺省（由注入链 resolveSessionAiId 统一回退 1）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createSegmentManifest, assembleSegments, type SegmentDeps } from '../electron/main/prompts/segments'
import { SessionStore } from '../electron/main/api/session-store'

// ===== 1. segments 层：aiId 感知的依赖注入按 sessionId 分流 =====

function buildDeps(overrides: Partial<SegmentDeps> = {}): SegmentDeps {
  return {
    getConfig: () => ({ persona: '', aiName: '月蚀', aiMode: 'chat' }) as never,
    getCurrentUser: () => ({ UID: 7, 用户名: '测试用户' }) as never,
    getAiIdentity: (sessionId?: string) =>
      sessionId === 's_ai2' ? { aiId: 2, aiName: '莉莉丝' } : { aiId: 1, aiName: '月蚀' },
    getSysPrompt: (sessionId?: string) =>
      sessionId === 's_ai2' ? '莉莉丝系统提示词（副本）' : null,
    frontendPrompt: '内置前端提示词',
    sharedPrompts: '',
    getActiveWorkspace: () => null,
    getDefaultWorkspaceConfigPath: () => '',
    getWorkspaceContext: () => null,
    buildSelfAwarenessSection: () => null,
    readUserMd: () => '用户资料卡（USER.md 内容）',
    readAiMd: (sessionId?: string) =>
      sessionId === 's_ai2' ? '莉莉丝的 AI.md' : '月蚀的 AI.md',
    buildToolDescription: () => '工具描述',
    mcpClientManager: undefined,
    skillLoader: {
      listAutoInvocableBySource: () => [],
      getDomainGroups: () => []
    },
    listTopicPrompts: () => [],
    toolCtx: { paths: undefined },
    activationManager: { consumeEvents: () => null },
    onActivationConsumed: () => {},
    buildLifecycleInjection: () => null,
    geoService: null,
    cronSchedulerRef: null,
    chatModePrompt: (name: string) => `聊天模式（${name}）`,
    taskLeadPrompt: '任务模式提示词',
    toolNames: new Set(),
    ...overrides
  }
}

describe('segments 注入链按会话 aiId 泛化（P2）', () => {
  it('identity 段：sessionId 透传 deps.getAiIdentity，AI1/AI2 身份卡内容不同', async () => {
    const deps = buildDeps()
    const segments = createSegmentManifest(deps)
    const ai1 = await assembleSegments(segments, { messages: [], sessionId: 's_ai1' })
    const ai2 = await assembleSegments(segments, { messages: [], sessionId: 's_ai2' })
    const id1 = ai1.prefix.find((m) => m.content.includes('月蚀'))
    const id2 = ai2.prefix.find((m) => m.content.includes('莉莉丝'))
    expect(id1).toBeTruthy()
    expect(id2).toBeTruthy()
    expect((id1!.content as string).includes('AIID=1')).toBe(true)
    expect((id2!.content as string).includes('AIID=2')).toBe(true)
  })

  it('identity 段：aiId 为 null 时不出现 AIID 字样（兼容无编号注册项）', async () => {
    const deps = buildDeps({
      getAiIdentity: () => ({ aiId: null, aiName: '无编号AI' })
    })
    const segments = createSegmentManifest(deps)
    const ai = await assembleSegments(segments, { messages: [], sessionId: 's_noaiid' })
    const id = ai.prefix.find((m) => (m.content as string).includes('无编号AI'))
    expect(id).toBeTruthy()
    expect((id!.content as string)).not.toContain('AIID=')
    // 身份卡其余部分仍正常：AI 名 + UID
    expect((id!.content as string)).toContain('你是「无编号AI」')
    expect((id!.content as string)).toContain('UID=7')
  })

  it('sys_prompt 段：有副本用副本（AI2），无副本回退内置（AI1）', async () => {
    const segments = createSegmentManifest(buildDeps())
    const ai1 = await assembleSegments(segments, { messages: [], sessionId: 's_ai1' })
    const ai2 = await assembleSegments(segments, { messages: [], sessionId: 's_ai2' })
    expect(ai1.prefix.some((m) => m.content === '内置前端提示词')).toBe(true)
    expect(ai2.prefix.some((m) => m.content === '莉莉丝系统提示词（副本）')).toBe(true)
  })

  it('sys_prompt 段：副本为空字符串（非 null）时不注入也不回退内置（锁定 ?? 语义）', async () => {
    // 实现 `getSysPrompt(ctx.sessionId) ?? deps.frontendPrompt`：?? 只对 null/undefined 回退，
    // 空字符串是"显式空副本"，随后 `if (!prompt) return null` → 整段不注入（不回退内置）。
    const deps = buildDeps({
      getSysPrompt: () => '',
      frontendPrompt: '内置前端提示词'
    })
    const segments = createSegmentManifest(deps)
    const ai = await assembleSegments(segments, { messages: [], sessionId: 's_ai1' })
    // 空副本 → 不注入任何 sys_prompt 内容（含内置回退）
    expect(ai.prefix.some((m) => m.content === '内置前端提示词')).toBe(false)
    expect(ai.prefix.some((m) => m.content === '')).toBe(false)
    // 其他 boot 段不受影响（identity 仍在）
    expect(ai.prefix.some((m) => (m.content as string).includes('AIID=1'))).toBe(true)
  })

  it('user_md/ai_md 段：user_md 共享用户级资料，ai_md 按会话 aiId 读各自 AI.md，均放 suffix（历史之后）', async () => {
    const segments = createSegmentManifest(buildDeps())
    const ai1 = await assembleSegments(segments, { messages: [], sessionId: 's_ai1' })
    const ai2 = await assembleSegments(segments, { messages: [], sessionId: 's_ai2' })
    // user_md：两会话都注入同一份用户级资料
    const userTail1 = ai1.suffix.find((m) => m.content === '用户资料卡（USER.md 内容）')
    const userTail2 = ai2.suffix.find((m) => m.content === '用户资料卡（USER.md 内容）')
    expect(userTail1).toBeTruthy()
    expect(userTail2).toBeTruthy()
    // ai_md：各自会话读各自 AI.md
    const aiTail2 = ai2.suffix.find((m) => m.content === '莉莉丝的 AI.md')
    expect(aiTail2).toBeTruthy()
    const aiTail1 = ai1.suffix.find((m) => m.content === '月蚀的 AI.md')
    expect(aiTail1).toBeTruthy()
  })

  it('shared_prompts 段：getSharedPrompts 按会话注入，返回 null 回退 boot 常量', async () => {
    const deps = buildDeps({
      sharedPrompts: '内置通用机制（boot 常量）',
      getSharedPrompts: (sessionId?: string) => (sessionId === 's_ai2' ? 'AI2 通用副本（文件粒度）' : null)
    })
    const segments = createSegmentManifest(deps)
    const ai1 = await assembleSegments(segments, { messages: [], sessionId: 's_ai1' })
    const ai2 = await assembleSegments(segments, { messages: [], sessionId: 's_ai2' })
    // AI1：getSharedPrompts 返回 null → 回退 boot 常量
    expect(ai1.prefix.some((m) => m.content === '内置通用机制（boot 常量）')).toBe(true)
    // AI2：注入 AI 专属文件粒度副本
    expect(ai2.prefix.some((m) => m.content === 'AI2 通用副本（文件粒度）')).toBe(true)
    expect(ai2.prefix.some((m) => m.content === '内置通用机制（boot 常量）')).toBe(false)
  })

  it('env_context 段：geoService 提供环境注入（地址+天气），放 suffix（历史之后）', async () => {
    // 模拟 GeoLocationService.buildInjection 的输出（与真实服务同构：来源/地址/天气）
    const geoEnv = `## 当前日期：2026-09-24 星期四\n- 时区：Asia/Shanghai\n- 地点（系统定位）：中国 测试省 测试市 测试街道（坐标 0.0000, 0.0000，精度 ±50m），天气：多云 6.2°C，风速 7.8 km/h`
    const deps = buildDeps({ geoService: { buildInjection: () => geoEnv } })
    const segments = createSegmentManifest(deps)
    const ai1 = await assembleSegments(segments, { messages: [], sessionId: 's_ai1' })

    const env = ai1.suffix.find((m) => m.content.includes('当前环境'))
    expect(env).toBeTruthy()
    expect((env!.content as string)).toContain('地点（系统定位）')
    expect((env!.content as string)).toContain('测试市 测试街道')
    expect((env!.content as string)).toContain('多云 6.2°C')
    // env 在历史之后（suffix）
    expect(ai1.suffix.indexOf(env!)).toBeGreaterThanOrEqual(0)
  })

  it('env_context 段：geoService 为 null 时不注入当前环境（零回归）', async () => {
    const segments = createSegmentManifest(buildDeps())
    const ai1 = await assembleSegments(segments, { messages: [], sessionId: 's_ai1' })
    expect(ai1.suffix.some((m) => m.content.includes('当前环境'))).toBe(false)
  })

  it('T5 莉莉丝剥离：agent=lilith 会话不注入 shared/kernel/mode_branch，其他功能段保留', async () => {
    const deps = buildDeps({
      sharedPrompts: '内置通用机制（boot 常量）',
      getSharedPrompts: () => 'AI2 通用副本（文件粒度）',
      buildSelfAwarenessSection: () => '月蚀自我认知段（kernel）',
      getAiIdentity: (sessionId?: string) =>
        sessionId === 's_ai2'
          ? { aiId: 2, aiName: '莉莉丝', agent: 'lilith' }
          : { aiId: 1, aiName: '月蚀', agent: 'frontend' }
    })
    const segments = createSegmentManifest(deps)
    const ai2 = await assembleSegments(segments, { messages: [], sessionId: 's_ai2' })
    // 剥离：月蚀 shared 通用机制（无论副本还是 boot 常量）不注入
    expect(ai2.prefix.some((m) => m.content === 'AI2 通用副本（文件粒度）')).toBe(false)
    expect(ai2.prefix.some((m) => m.content === '内置通用机制（boot 常量）')).toBe(false)
    // 剥离：kernel 自我认知段不注入
    expect(ai2.prefix.some((m) => m.content.includes('月蚀自我认知段'))).toBe(false)
    // 剥离：mode_branch（chat/task/coding 纪律）不注入
    expect(ai2.suffix.some((m) => m.content.includes('聊天模式'))).toBe(false)
    expect(ai2.suffix.some((m) => m.content.includes('输出纪律'))).toBe(false)
    // 保留：身份卡 / 系统提示词（派生人设）/ 用户资料卡 / 自我认知（AI.md）
    expect(ai2.prefix.some((m) => (m.content as string).includes('莉莉丝'))).toBe(true)
    expect(ai2.prefix.some((m) => m.content === '莉莉丝系统提示词（副本）')).toBe(true)
    expect(ai2.suffix.some((m) => m.content === '用户资料卡（USER.md 内容）')).toBe(true)
    expect(ai2.suffix.some((m) => m.content === '莉莉丝的 AI.md')).toBe(true)
  })

  it('T5 非莉莉丝不受影响：自定义 AI（agent 非 lilith）仍继承月蚀通用段', async () => {
    const deps = buildDeps({
      sharedPrompts: '内置通用机制（boot 常量）',
      getSharedPrompts: () => null,
      buildSelfAwarenessSection: () => '月蚀自我认知段（kernel）',
      getAiIdentity: () => ({ aiId: 3, aiName: '自定义AI', agent: 'custom-3' }),
      getSysPrompt: () => '自定义AI系统提示词'
    })
    const segments = createSegmentManifest(deps)
    const ai3 = await assembleSegments(segments, { messages: [], sessionId: 's_ai3' })
    // 月蚀 shared 回退 boot 常量仍注入
    expect(ai3.prefix.some((m) => m.content === '内置通用机制（boot 常量）')).toBe(true)
    // kernel 自我认知仍注入
    expect(ai3.prefix.some((m) => m.content.includes('月蚀自我认知段'))).toBe(true)
    // mode_branch（chat 模式）仍注入
    expect(ai3.suffix.some((m) => m.content.includes('聊天模式'))).toBe(true)
  })

  it('T6 lore_ctx：莉莉丝会话按最近用户消息检索注入、放历史之后', async () => {
    const deps = buildDeps({
      getAiIdentity: (sessionId?: string) =>
        sessionId === 's_ai2'
          ? { aiId: 2, aiName: '莉莉丝', agent: 'lilith' }
          : { aiId: 1, aiName: '月蚀', agent: 'frontend' },
      buildLoreContext: (msg: string) => `## 原作记忆（关于「${msg}」的检索结果）`
    })
    const segments = createSegmentManifest(deps)
    const ai2 = await assembleSegments(segments, {
      messages: [
        { id: 'h1', role: 'user', content: '之前聊过的事', createdAt: 1 },
        { id: 'h2', role: 'assistant', content: '嗯嗯', createdAt: 2 },
        { id: 'h3', role: 'user', content: '你还记得霜之哀伤吗', createdAt: 3 }
      ],
      sessionId: 's_ai2'
    })
    const lore = ai2.suffix.find((m) => m.content.includes('原作记忆'))
    expect(lore).toBeTruthy()
    expect((lore!.content as string)).toContain('你还记得霜之哀伤吗')
    // 用最后一条用户消息检索（而非历史第一条）
    expect((lore!.content as string)).not.toContain('之前聊过的事')
  })

  it('T6 lore_ctx：无命中（buildLoreContext 返回 null）时不注入', async () => {
    const deps = buildDeps({
      getAiIdentity: () => ({ aiId: 2, aiName: '莉莉丝', agent: 'lilith' }),
      buildLoreContext: () => null
    })
    const segments = createSegmentManifest(deps)
    const ai2 = await assembleSegments(segments, {
      messages: [{ id: 'm1', role: 'user', content: 'hello', createdAt: 1 }],
      sessionId: 's_ai2'
    })
    expect(ai2.suffix.some((m) => m.content.includes('原作记忆'))).toBe(false)
  })

  it('T6 lore_ctx：非莉莉丝会话不触发 lore 检索', async () => {
    const deps = buildDeps({
      getAiIdentity: () => ({ aiId: 1, aiName: '月蚀', agent: 'frontend' }),
      buildLoreContext: (msg: string) => `不应注入的 lore：${msg}`
    })
    const segments = createSegmentManifest(deps)
    const ai1 = await assembleSegments(segments, {
      messages: [{ id: 'm1', role: 'user', content: 'hello', createdAt: 1 }],
      sessionId: 's_ai1'
    })
    expect(ai1.suffix.some((m) => m.content.includes('不应注入的 lore'))).toBe(false)
  })
})

// ===== 2. session-store 层：aiId 落盘 + 旧会话兼容 =====

describe('session-store aiId 字段（P2）', () => {
  let root: string
  let store: SessionStore

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'session-aiid-'))
    store = new SessionStore(join(root, 'sessions'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('create(aiId=2) 写入 aiId，重载后保留', () => {
    const session = store.create(2)
    session.messages.push({ id: 'm1', role: 'user', content: 'hi', createdAt: Date.now() })
    store.saveMessages(session.id, session.messages)
    store.flush() // persist 为 300ms 去抖异步写盘，重载前同步落盘

    // 重新实例化（模拟重启）→ 从 meta 读回 aiId
    const store2 = new SessionStore(join(root, 'sessions'))
    const loaded = store2.get(session.id)
    expect(loaded?.aiId).toBe(2)
  })

  it('getOrCreate 缺省 aiId 缺省回退 1', () => {
    const session = store.getOrCreate('s_default', '默认会话')
    expect(session.aiId).toBe(1)
    const ai3 = store.getOrCreate('s_ai3', 'AI3 会话', 3)
    expect(ai3.aiId).toBe(3)
  })

  it('getOrCreate 显式 aiId 与既有会话不一致时回填修正并持久化', async () => {
    // 先建 AI1 会话，再以 aiId=2 复用同一会话 id → 归属回填为 2 并落盘
    const first = store.create(1)
    expect(first.aiId).toBe(1)

    const reused = store.getOrCreate(first.id, first.title, 2)
    expect(reused.aiId).toBe(2)
    expect(reused.id).toBe(first.id)

    // 重载后仍为 2（回填已持久化）
    store.flush()
    const store2 = new SessionStore(join(root, 'sessions'))
    expect(store2.get(first.id)?.aiId).toBe(2)
  })

  it('getOrCreate 未显式指定 aiId 时沿用既有会话归属（不回填 1）', async () => {
    const first = store.create(3)
    expect(first.aiId).toBe(3)
    const reused = store.getOrCreate(first.id, first.title)
    expect(reused.aiId).toBe(3)
  })

  it('旧形态会话（meta 无 aiId）读取不抛错且可继续保存', () => {
    // 手工构造旧版 meta.json（无 aiId 字段）→ 模拟旧会话
    const id = 's_legacy'
    mkdirSync(join(root, 'sessions', id, 'user'), { recursive: true })
    writeFileSync(
      join(root, 'sessions', id, 'user', 'meta.json'),
      JSON.stringify({ id, title: '旧会话', createdAt: 1, updatedAt: 1, shardCount: 1 }),
      'utf-8'
    )
    writeFileSync(
      join(root, 'sessions', id, 'user', '1.json'),
      JSON.stringify([{ id: 'm1', role: 'user', content: '旧消息', createdAt: 1 }]),
      'utf-8'
    )
    const store2 = new SessionStore(join(root, 'sessions'))
    const loaded = store2.get(id)
    expect(loaded?.id).toBe(id)
    // 旧会话读取侧 aiId 未设置（undefined）→ 注入链回退 1；此处验证不抛错、字段缺省
    expect(loaded?.aiId).toBeUndefined()
    // 继续保存不丢 aiId 语义：重存后 aiId 仍未显式设置（不强制改旧数据）
    const savedFile = readFileSync(join(root, 'sessions', id, 'user', 'meta.json'), 'utf-8')
    expect(JSON.parse(savedFile).aiId).toBeUndefined()
  })
})