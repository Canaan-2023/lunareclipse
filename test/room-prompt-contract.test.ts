/**
 * ROOM 自主规划轮提示词契约（0.53.10）。
 *
 * 锁定三件事：
 * 1. `purpose='room'` 时：身份卡改说「自主运行」、输出纪律换成 ROOM 版、
 *    末尾注入 room_contract（紧挨规划消息，优先级最高）；
 * 2. 后台轮次（room / lan-* / cli / system-*）**不消费**全局激活事件，
 *    避免健康检查告警被房间规划或局域网回复吞掉；
 * 3. 治理 hook（空转抑制等）不对 room 轮注入对话纪律（否则会逼模型输出 [TASK_COMPLETE]）。
 */
import { describe, it, expect, vi } from 'vitest'
import { createSegmentManifest, assembleSegments, type SegmentDeps } from '../electron/main/prompts/segments'
import { ROOM_CONTRACT_PROMPT, ROOM_OUTPUT_DISCIPLINE_PROMPT } from '../electron/main/prompts/room-discipline'
import { installIdleSuppression } from '../electron/main/kernel/governance'
import type { ExtensionRegistrar } from '../electron/main/kernel/extension'
import type { HookContext } from '../electron/main/hooks/types'

function buildDeps(overrides: Partial<SegmentDeps> = {}): SegmentDeps {
  return {
    getConfig: () => ({ persona: '', aiName: '月蚀', aiMode: 'coding' }) as never,
    getCurrentUser: () => ({ UID: 7, 用户名: '测试用户' }) as never,
    getAiIdentity: () => ({ aiId: 1, aiName: '月蚀' }),
    getSysPrompt: () => null,
    frontendPrompt: '内置前端提示词',
    sharedPrompts: '共享提示词',
    getActiveWorkspace: () => null,
    getDefaultWorkspaceConfigPath: () => '',
    getWorkspaceContext: () => null,
    buildSelfAwarenessSection: () => null,
    readUserMd: () => null,
    readAiMd: () => null,
    buildToolDescription: () => '工具描述',
    mcpClientManager: undefined,
    skillLoader: { listAutoInvocableBySource: () => [], getDomainGroups: () => [] },
    listTopicPrompts: () => [],
    toolCtx: { paths: undefined },
    activationManager: { consumeEvents: () => '【健康检查】typecheck 失败' },
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

describe('ROOM 规划轮提示词', () => {
  it('purpose=room：身份卡说自主运行、输出纪律为 ROOM 版、末尾有 room_contract', async () => {
    const segments = createSegmentManifest(buildDeps())
    const { prefix, suffix } = await assembleSegments(segments, {
      messages: [],
      sessionId: 'room-autonomous-U7-AI1',
      purpose: 'room'
    })

    const identity = prefix.find((m) => (m.content as string).includes('你是「月蚀」'))
    expect(identity?.content).toContain('自主房间（ROOM）')
    expect(identity?.content).not.toContain('正在与用户')

    expect(prefix.some((m) => m.content === ROOM_OUTPUT_DISCIPLINE_PROMPT)).toBe(true)
    // 末尾段（最靠近规划消息）是 ROOM 契约
    expect(suffix[suffix.length - 1]?.content).toBe(ROOM_CONTRACT_PROMPT)
  })

  it('purpose 未指定（前台对话）：身份卡说与用户对话、无 room_contract、输出纪律为通用版', async () => {
    const segments = createSegmentManifest(buildDeps())
    const { prefix, suffix } = await assembleSegments(segments, { messages: [], sessionId: 's1' })
    const identity = prefix.find((m) => (m.content as string).includes('你是「月蚀」'))
    expect(identity?.content).toContain('正在与用户')
    expect(suffix.some((m) => m.content === ROOM_CONTRACT_PROMPT)).toBe(false)
    expect(prefix.some((m) => m.content === ROOM_OUTPUT_DISCIPLINE_PROMPT)).toBe(false)
  })

  it('后台轮次不消费全局激活事件（前台轮次消费）', async () => {
    const consume = vi.fn(() => '【健康检查】typecheck 失败')
    const onConsumed = vi.fn()
    const segments = createSegmentManifest(
      buildDeps({ activationManager: { consumeEvents: consume }, onActivationConsumed: onConsumed })
    )

    // 后台：room / lan-chat / cli / system-injected 都不能吞掉健康检查告警
    for (const purpose of ['room', 'lan-chat', 'lan-direct', 'ai-social', 'publish-board', 'messaging', 'cli', 'system-injected'] as const) {
      consume.mockClear()
      onConsumed.mockClear()
      await assembleSegments(segments, { messages: [], sessionId: 's1', purpose })
      expect(consume, `${purpose} 不应消费激活事件`).not.toHaveBeenCalled()
      expect(onConsumed, `${purpose} 不应覆盖前台激活内容 ref`).not.toHaveBeenCalled()
    }

    // 前台（purpose 未指定）：正常消费并注入
    consume.mockClear()
    onConsumed.mockClear()
    const { suffix } = await assembleSegments(segments, { messages: [], sessionId: 's1' })
    expect(consume).toHaveBeenCalledTimes(1)
    expect(onConsumed).toHaveBeenCalledWith('【健康检查】typecheck 失败')
    expect(suffix.some((m) => (m.content as string).includes('系统激活消息'))).toBe(true)
  })

  it('治理 hook 对 room 轮不注入空转收束指令', async () => {
    const hooks: Array<{ event: string; fn: (ctx: HookContext) => Promise<unknown> }> = []
    const registrar = {
      registerHook: (event: string, fn: (ctx: HookContext) => Promise<unknown>) => {
        hooks.push({ event, fn })
        return { dispose: () => {} }
      }
    } as unknown as ExtensionRegistrar
    installIdleSuppression(registrar)
    const fn = hooks.find((h) => h.event === 'PreLLMCall')!.fn

    const roomResult = await fn({
      event: 'PreLLMCall',
      cwd: '',
      idleRounds: 4,
      purpose: 'room'
    })
    expect(roomResult).toEqual({ action: 'continue' })

    const chatResult = await fn({
      event: 'PreLLMCall',
      cwd: '',
      idleRounds: 4,
      governance: { idleSuppression: true }
    })
    expect(chatResult).toMatchObject({ action: 'continue' })
    expect((chatResult as { injectedContext?: string }).injectedContext).toContain('[TASK_COMPLETE]')
  })
})
