/**
 * ROOM 状态栏的相位→视觉映射（阶段 B）。
 *
 * 为什么测：状态栏的全部价值是「一眼看懂它在干什么」，靠的是**确定性映射**；
 * 映射错了不会报错，只会显示错的月相（静默错）。另锁两条硬要求：
 * - 状态**不只靠颜色**：不同相位必须给出**不同形状**（月相网格逐字符比对）；
 * - 月相网格是 16×16 且形状互不相同（否则「形状区分」形同虚设）。
 */
import { describe, it, expect } from 'vitest'
import { formatStandbyClock, statusText } from '../src/components/Room/PresenceBar'
import {
  STAGE_COUNT,
  activityZone,
  currentStageOf,
  moonRows,
  phaseLabelKey,
  phaseToMoon,
  phaseTone,
  stageFromEvents,
  stageIndex,
  stageLabelKey,
  toRoomSnapshot,
  type MoonKind,
  type RoomPhase
} from '../src/components/Room/room-status'

const KINDS: MoonKind[] = ['new', 'full', 'waning', 'eclipse', 'ring', 'red']

describe('currentStageOf：阶段取事件环尾部（不是 lastTick.phase）', () => {  it('尾事件是五个阶段之一 → 返回该阶段', () => {
    for (const p of ['collect', 'triage', 'recall', 'plan', 'execute']) {
      expect(stageFromEvents([{ phase: 'idle' }, { phase: p }])).toBe(p)
      expect(currentStageOf({ events: [{ phase: 'idle', ts: 1 }, { phase: p, ts: 2 }] })).toBe(p)
    }
  })

  it('尾事件是 idle / 其它 → undefined（交给散步），不会一直停在工坊', () => {
    expect(stageFromEvents([{ phase: 'plan' }, { phase: 'idle' }])).toBeUndefined()
    expect(stageFromEvents([{ phase: 'execute' }, { phase: 'error' }])).toBeUndefined()
    expect(stageFromEvents([])).toBeUndefined()
    expect(stageFromEvents(undefined)).toBeUndefined()
  })

  it('lastTick.phase 只有 execute/idle —— 这正是不能拿它当阶段的原因', () => {
    // 纯文档化断言：两个值都能被 stageIndex 识别，但 collect/triage/recall/plan 不在 tick 结果里
    expect(stageIndex('execute')).toBe(4)
    expect(stageIndex('idle')).toBe(-1)
  })
})

describe('toRoomSnapshot：直播场景 / 回复（主进程 → UI 的唯一桥）', () => {
  it('合法 scene / reply / replyAt 透传', () => {
    const s = toRoomSnapshot(
      { scene: { zone: 'plan', action: 'observe' }, lastReply: '我在。', lastReplyAt: 123 },
      0
    )
    expect(s.scene).toEqual({ zone: 'plan', action: 'observe' })
    expect(s.lastReply).toBe('我在。')
    expect(s.lastReplyAt).toBe(123)
  })

  it('非法 scene / 非字符串 reply / 非有限 replyAt → 丢弃，不污染快照', () => {
    const s = toRoomSnapshot(
      { scene: { zone: 'moon' }, lastReply: 123, lastReplyAt: Number.NaN },
      0
    )
    expect(s.scene).toBeUndefined()
    expect(s.lastReply).toBeUndefined()
    expect(s.lastReplyAt).toBeUndefined()
  })

  it('0.53.1：感知状态 / 最近唤醒 / 最近采集透传；来源闭集与时间必须合法', () => {
    const ok = toRoomSnapshot(
      {
        sensing: true,
        lastWake: { source: 'collector', detail: 'CPU 10% → 90%', at: 42 },
        lastCollect: { text: '平台 win32 · CPU 5%', at: 41 }
      },
      0
    )
    expect(ok.sensing).toBe(true)
    expect(ok.lastWake).toEqual({ source: 'collector', detail: 'CPU 10% → 90%', at: 42 })
    expect(ok.lastCollect?.text).toContain('CPU 5%')

    const bad = toRoomSnapshot(
      { sensing: 'yes', lastWake: { source: 'moon', at: 1 }, lastCollect: { text: '  ', at: 1 } },
      0
    )
    expect(bad.sensing).toBeUndefined()
    expect(bad.lastWake).toBeUndefined()
    expect(bad.lastCollect).toBeUndefined()
  })

  it('0.53.3：感知策略透传；非法策略丢弃（界面回落默认，不画歪）', () => {
    const ok = toRoomSnapshot(
      { sensorPolicy: { enabled: true, mute: ['cpu'], intervalMs: 60_000, thresholds: { cpuDeltaPct: 45 } } },
      0
    )
    expect(ok.sensorPolicy).toEqual({
      enabled: true,
      mute: ['cpu'],
      intervalMs: 60_000,
      thresholds: { cpuDeltaPct: 45 }
    })

    const bad = toRoomSnapshot({ sensorPolicy: { mute: ['moon'] } }, 0)
    expect(bad.sensorPolicy).toBeUndefined()
  })
})

describe('PresenceBar.statusText：空闲 ≠ 静默', () => {
  const t = (key: string): string => key

  it('idle 且感知中 → 状态词必须写出「感知中」', () => {
    expect(statusText({ phase: 'idle', llmFailed: false, stage: -1, sensing: true, t })).toBe(
      'room.phase.idle · room.status.sensing'
    )
    expect(statusText({ phase: 'idle', llmFailed: false, stage: -1, sensing: false, t })).toBe('room.phase.idle')
  })

  it('standby 且感知中 → 待机不等于闭眼，状态词也要写出来', () => {
    const s = statusText({ phase: 'standby', llmFailed: false, stage: -1, standbyUntil: 1000, sensing: true, t })
    expect(s).toContain('room.phase.standby')
    expect(s).toContain('room.status.sensing')
  })

  it('待机跨天 → 醒来时刻补日期（AI 可以把待机设到几天后）', () => {
    const now = new Date(2026, 9, 20, 12, 0, 0).getTime()
    const until = new Date(2026, 9, 23, 9, 5, 0).getTime()
    expect(formatStandbyClock(until, now)).toBe('10/23 09:05')
    expect(formatStandbyClock(new Date(2026, 9, 20, 18, 0, 0).getTime(), now)).toBe('18:00')
  })
})

describe('moonRows：16×16 像素月相', () => {
  it('每种月相都是 16 行 × 16 字符，且只含 # 与 .', () => {
    for (const k of KINDS) {
      const rows = moonRows(k)
      expect(rows).toHaveLength(16)
      for (const r of rows) {
        expect(r).toHaveLength(16)
        expect(/^[#.]+$/.test(r)).toBe(true)
      }
    }
  })

  it('形状互不相同（「不只靠颜色」的前提）', () => {
    const sigs = KINDS.map((k) => moonRows(k).join('\n'))
    expect(new Set(sigs).size).toBe(KINDS.length)
  })

  it('满月比新月亮像素多（形状语义正确）', () => {
    const count = (k: MoonKind): number => moonRows(k).join('').split('').filter((c) => c === '#').length
    expect(count('full')).toBeGreaterThan(count('ring'))
    expect(count('ring')).toBeGreaterThan(count('new'))
  })
})

describe('phaseToMoon：相位 → 月相', () => {
  it('待机=满月 / 执行=日偏食 / 空闲=渐亏 / 停止=新月', () => {
    expect(phaseToMoon('standby')).toBe('full')
    expect(phaseToMoon('running')).toBe('eclipse')
    expect(phaseToMoon('idle')).toBe('waning')
    expect(phaseToMoon('stopped')).toBe('new')
  })

  it('LLM 未回复（出错）优先于一切 → 红月', () => {
    const phases: RoomPhase[] = ['stopped', 'standby', 'idle', 'running']
    for (const p of phases) expect(phaseToMoon(p, { llmFailed: true })).toBe('red')
  })

  it('等待审批 → 环食（但已停止时不冒充「在等你」）', () => {
    expect(phaseToMoon('idle', { awaitingApproval: true })).toBe('ring')
    expect(phaseToMoon('stopped', { awaitingApproval: true })).toBe('new')
  })
})

describe('语气与文案键', () => {
  it('phaseTone：出错用 danger，其余按相位分档（语义 token，不写死 hex）', () => {
    expect(phaseTone('running', { llmFailed: true })).toBe('text-danger')
    expect(phaseTone('running')).toBe('text-success')
    expect(phaseTone('idle')).toBe('text-warning')
    expect(phaseTone('standby')).toBe('text-accent')
    expect(phaseTone('stopped')).toBe('text-fg-muted')
  })

  it('phaseLabelKey 四个相位各有键', () => {
    const phases: RoomPhase[] = ['stopped', 'standby', 'idle', 'running']
    expect(new Set(phases.map(phaseLabelKey)).size).toBe(4)
  })
})

describe('stageIndex：本轮阶段条', () => {
  it('五个阶段按序，未知/缺省为 -1（不显示）', () => {
    expect(['collect', 'triage', 'recall', 'plan', 'execute'].map(stageIndex)).toEqual([0, 1, 2, 3, 4])
    expect(stageIndex('idle')).toBe(-1)
    expect(stageIndex(undefined)).toBe(-1)
  })

  it('阶段数与文案键一致', () => {
    expect(STAGE_COUNT).toBe(5)
    expect(new Set(Array.from({ length: STAGE_COUNT }, (_, i) => stageLabelKey(i))).size).toBe(5)
  })
})

/**
 * 快照归一化（`toRoomSnapshot`）是渲染端状态的**唯一入口**（IPC 读取与主进程推送共用）。
 * 为什么测：它是 `unknown` 载荷到强类型的边界，归一化错了不会报错，只会显示错的状态。
 * 另锁一条：**采样时刻由调用方注入**（组件内不得调时间）。
 */
describe('toRoomSnapshot：IPC 载荷 → 界面快照', () => {
  it('完整载荷逐字段归一化；采样时刻来自调用方', () => {
    const snap = toRoomSnapshot(
      {
        phase: 'standby',
        running: true,
        avatarRev: 3,
        standbyUntil: 5000,
        lastTick: { phase: 'plan', mode: 'long-term' },
        lastPlan: { decisions: [{ toolName: 'read', description: '读' }] },
        events: [{ phase: 'plan', ts: 1 }],
        collectorView: { name: '视图', scopes: ['env'], fields: ['cpu'] }
      },
      1234
    )
    expect(snap.phase).toBe('standby')
    expect(snap.sampledAt).toBe(1234)
    expect(snap.running).toBe(true)
    expect(snap.avatarRev).toBe(3)
    expect(snap.standbyUntil).toBe(5000)
    expect(snap.lastTick?.phase).toBe('plan')
    expect(snap.lastPlan?.decisions).toHaveLength(1)
    expect(snap.events).toHaveLength(1)
    expect(snap.collectorView?.name).toBe('视图')
  })

  it('空 / 非法载荷 → 空快照语义（stopped、不在跑、无事件）', () => {
    for (const raw of [undefined, null, {}]) {
      const snap = toRoomSnapshot(raw, 0)
      expect(snap.phase).toBe('stopped')
      expect(snap.running).toBe(false)
      expect(snap.avatarRev).toBe(0)
      expect(snap.events).toEqual([])
      expect(snap.collectorView).toBeUndefined()
      expect(snap.landing).toBeUndefined()
      expect(snap.hostSessionId).toBeUndefined()
    }
  })

  it('承载会话与落点（ADR-30 R2 / 0.53.18）逐字段归一化；非法落点丢弃', () => {
    const snap = toRoomSnapshot(
      {
        phase: 'idle',
        hostSessionId: 's_chat_1',
        landing: { internalId: 'is_a' },
        events: []
      },
      7
    )
    expect(snap.hostSessionId).toBe('s_chat_1')
    expect(snap.landing).toEqual({ internalId: 'is_a' })

    // 落点只认 internalId；缺 internalId 整块丢弃
    expect(toRoomSnapshot({ landing: { internalId: 42 } }, 0).landing).toBeUndefined()
    expect(toRoomSnapshot({ landing: {} }, 0).landing).toBeUndefined()
    expect(toRoomSnapshot({ hostSessionId: '' }, 0).hostSessionId).toBeUndefined()
    // 旧字段（房间自持会话 / 两棵树）已退役：不再映射进快照
    expect(toRoomSnapshot({ sessionId: 'room-autonomous-U1-AI1' }, 0).hostSessionId).toBeUndefined()
  })

  it('规划者与前置规划历史条数（2026-10-31 前置规划功能）：合法透传、非法丢弃', () => {
    const snap = toRoomSnapshot({ planner: { kind: 'preplan' }, preplanHistoryCount: 7 }, 0)
    expect(snap.planner).toEqual({ kind: 'preplan' })
    expect(snap.preplanHistoryCount).toBe(7)

    // self 显式透传；缺省（旧状态不带）按 self 语义由界面回落
    expect(toRoomSnapshot({ planner: { kind: 'self' } }, 0).planner).toEqual({ kind: 'self' })
    expect(toRoomSnapshot({}, 0).planner).toBeUndefined()
    expect(toRoomSnapshot({}, 0).preplanHistoryCount).toBeUndefined()

    // 非法值整条丢弃：kind 闭集外的 planner、非有限数的条数
    expect(toRoomSnapshot({ planner: { kind: 'robot' } }, 0).planner).toBeUndefined()
    expect(toRoomSnapshot({ planner: 'preplan' }, 0).planner).toBeUndefined()
    expect(toRoomSnapshot({ preplanHistoryCount: '7' }, 0).preplanHistoryCount).toBeUndefined()
    expect(toRoomSnapshot({ preplanHistoryCount: NaN }, 0).preplanHistoryCount).toBeUndefined()
  })
})

describe('activityZone：背景跟着「在哪类空间做事」切', () => {
  it('AI 显式声明的 scene.zone 优先', () => {
    expect(
      activityZone({
        phase: 'running',
        stage: 'plan',
        scene: { zone: 'memory', action: 'read' },
        toolNames: []
      })
    ).toBe('memory')
  })

  it('执行阶段按工具类别改判：局域网工具 → 通信室，设备工具 → 设备间', () => {
    expect(activityZone({ phase: 'running', stage: 'execute', toolNames: ['friend_manage'] })).toBe('lan')
    expect(activityZone({ phase: 'running', stage: 'execute', toolNames: ['device_scan'] })).toBe('device')
    expect(activityZone({ phase: 'running', stage: 'execute', toolNames: ['write_file'] })).toBe('work')
  })

  it('非执行阶段不沿用上一轮的工具类别（否则回忆也会停在通信室）', () => {
    expect(activityZone({ phase: 'running', stage: 'recall', toolNames: ['friend_manage'] })).toBe('memory')
  })

  it('阶段兜底：采集→设备间 / 分诊·规划→规划室 / 回忆→记忆库 / 执行→工作间', () => {
    expect(activityZone({ phase: 'running', stage: 'collect' })).toBe('device')
    expect(activityZone({ phase: 'running', stage: 'triage' })).toBe('plan')
    expect(activityZone({ phase: 'running', stage: 'plan' })).toBe('plan')
    expect(activityZone({ phase: 'running', stage: 'recall' })).toBe('memory')
    expect(activityZone({ phase: 'running', stage: 'execute' })).toBe('work')
  })

  it('停止 / 待机 / 空闲 → 房间', () => {
    expect(activityZone({ phase: 'stopped' })).toBe('home')
    expect(activityZone({ phase: 'standby', stage: 'execute' })).toBe('home')
    expect(activityZone({ phase: 'idle' })).toBe('home')
    expect(activityZone({ phase: 'error' })).toBe('home')
  })
})
