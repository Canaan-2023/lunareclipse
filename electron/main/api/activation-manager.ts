/**
 * 激活管理器：让 AI 不依赖用户消息也能自主“醒来”工作——
 * 倒计时任务、外部事件、DMN 协作与中断恢复统一进入激活队列，
 * 空闲时主动触发一次 AI 请求，忙碌时等待下次注入。
 */
import { setInterval, clearInterval, setTimeout, clearTimeout } from 'timers'
import { join } from 'path'
import { existsSync, mkdirSync } from 'fs'
import { writeFileSync, readFileSync } from 'fs'
import { readPersistedTodos } from '../tools/todo-write'
import type { TimerRegistry, TimerHandle } from '../monitor/timer-registry'

/**
 * 激活管理器（文档 15.2.1）

 * 激活源（设计变更：移除对话结束后自动反思触发，改为 AI 主动按时间规划）：
 * - 倒计时：AI 输出 [TIMER:时长:任务] 设定，系统到点注入激活事件（主要的自主激活方式）
 * - 外部事件：预留接口（API 回调/UI 事件等触发，由具体业务方调用 pushEvent；不监听数据目录文件变化）
 * - 后端协作：DMN 通过事件请求前端 AI 关注某事（如 DMN-6 检测到孤立记忆请求 AI 询问用户）
 * - 中断恢复：非用户中止的错误（网络/模型崩溃）触发，续接原任务而非开始新任务

 * 重要：自主激活不在对话结束后立即触发。AI 想自主继续必须主动设定 [TIMER:...]。
 * 激活事件统一存入队列。到点/事件发生时如果前端 AI 空闲，
 * 通过 onActivation 回调主动触发一次 AI 请求（不等用户发消息）；
 * 如果 AI 正忙，事件留在队列里等下次请求时注入。
 */

export interface ActivationEvent {
  id: string
  source: 'timer' | 'external' | 'reflection' | 'dmn'
  content: string
  createdAt: number
  /**
   * 会话级隔离标记：中断恢复事件携带产生该事件的会话 ID，
   * consumeEvents 只消费本会话的事件（sessionId 匹配或无 sessionId 的全局事件）。
   * 无 sessionId 的事件（timer/dmn/health-check）为全局事件，所有会话可见。
   */
  sessionId?: string
  /**
   * 强制可激活标记：即使持续激活关闭也允许触发 onActivation。
   * 用于系统自检等"已过防死循环节流"的事件（如健康检查报错，AlertGate
   * 已做指纹去重+冷却+连续失败静默），确保报错能被 AI 主动看到而非卡在队列。
   */
  forceActivate?: boolean
}

interface TimerRecord {
  id: string
  fireAt: number
  task: string
  handle: TimerHandle
}

const TIMER_REGEX = /\[TIMER:(\d+)([smh]?):([^\]]+)\]/g
const TIMER_CANCEL_REGEX = /\[TIMER_CANCEL:([^\]]+)\]/g

const TIMER_PERSIST_FILE = 'timers.json'

// ===== 等待型任务判定 =====
// 活跃 todo 全是等待型（等用户决策/授权/回复等外部条件）时，
// 外部事件注入的任务清单会过滤掉等待型项，避免逼 AI 复读"我在等你决定"。
// 等待型特征词（内容级启发式，覆盖 AI 常写的 TodoWrite 文案）。
const WAITING_TODO_PATTERNS = [
  /等你/,
  /等待用户/,
  /等用户/,
  /等你在/,
  /待你/,
  /需要你(?:回复|决定|确认|授权)/,
  /请你看看/,
  /等你决定/,
  /询问你/,
  /问你一下/,
  /依赖外部/,
  /等你确认/
]

/** 判断 todo 是否等待型（卡外部条件，不可自行推进） */
export function isWaitingTodo(content: string): boolean {
  return WAITING_TODO_PATTERNS.some((re) => re.test(content))
}

export class ActivationManager {
  private queue: ActivationEvent[] = []
  private timers: Map<string, TimerRecord> = new Map()
  private timersFile: string
  private reflectionPending = false
  private onActivation: (() => void) | null = null
  private isFrontendIdle: () => boolean = () => true
// stream 活跃标志：stream 进行中（包括重试中）时为 true，阻止自主激活触发
  // 用户明确要求：执行任务时不要跳自主激活，中断后应该续接原任务
  private streamActive = false
  // 中断恢复计数：仅用于展示「第 N 次自动恢复」文案；2026-10-02 起不设恢复次数上限
  // （原 MAX_INTERRUPT_RECOVERY=10，按用户要求取消），用户发新消息时仍重置计数
  private interruptRecoveryCount = 0
private pendingRecoveryHandles: TimerHandle[] = []
  private activationPollHandle: TimerHandle | null = null

  constructor(
    private watchDir: string,
    private timerRegistry?: TimerRegistry,
    private readonly activationThrottleMs = 15_000
  ) {
    this.timersFile = join(watchDir, TIMER_PERSIST_FILE)
    mkdirSync(watchDir, { recursive: true })
    this.loadTimers()
  }

  /**
   * 标记 stream 活跃状态
   * - stream 开始（含重试续接）时调 setStreamActive(true)
   * - stream 正常完成/用户中止时调 setStreamActive(false)
   * - stream 活跃时，isFrontendIdle() 返回 false，阻止 tryTriggerActivation 触发自主激活
   */
  setStreamActive(active: boolean): void {
    this.streamActive = active
  }

  /**
   * 设置激活回调：当有激活事件且前端 AI 空闲时调用，主动触发一次 AI 请求
   * 设置前端 AI 空闲状态查询函数
   */
  setActivationCallback(cb: () => void): void {
    this.onActivation = cb
  }

  setFrontendIdleProvider(provider: () => boolean): void {
    this.isFrontendIdle = provider
  }

/**
   * 事件入队后检查是否可以自主激活
   * 前端不空闲时启动轮询，等空闲后自动触发（避免事件卡在 queue 里永远不触发）
   */

  private enqueueEvent(evt: ActivationEvent): void {
    this.queue.push(evt)
    this.tryTriggerActivation()
  }

  /**
   * 尝试触发激活：前端空闲则立即触发，否则启动轮询等空闲

   * 事件触发规则：
    * - 中断恢复事件（source='external' 且 content 含【中断恢复】）：**始终自动触发 onActivation**，
    * 中断恢复是续接被打断的任务，不是启动新对话，必须自动恢复。
    * （用户主动点停止根本不会入队中断恢复事件，所以不存在"违反用户意愿"问题）
   * - 倒计时（timer）与后端协作（dmn）：**始终自动触发 onActivation**。timer 是 AI 显式规划的
   * 承诺（或用户要求"过会儿提醒我"），dmn 是 DMN 请求 AI 关注的协作请求——两者都是"系统委托"
   * 而非主动打断用户，纯用户模式下也应唤醒 AI 响应。
   * - reflection：持续激活开启时触发，关闭时不触发（已废弃自动触发，保留兼容）
   * - timer（用户主动设的定时器）和 forceActivate（健康检查等关键告警）可触发
   * - 其他事件留在队列等下次发消息时 consumeEvents 注入
   */
  private tryTriggerActivation(): void {
    if (this.queue.length === 0) return
    // stream 活跃中（包括重试续接）不触发自主激活——用户明确要求执行任务时不要跳自主激活。
    // 但必须启动轮询兜底：等 stream 结束后自动触发，否则 stream 期间入队的事件会永远卡住
    // （轮询回调里有 streamActive 检查，不会在输出中途打断）
    if (this.streamActive) {
      if (!this.activationPollHandle) {
        this.activationPollHandle = this.createPollInterval()
      }
      return
    }

    // 仅 timer（用户主动设的定时器）和 forceActivate（健康检查等关键告警）可触发
    const activatableEvents = this.queue.filter(
      (e) => e.forceActivate === true || e.source === 'timer'
    )
    if (activatableEvents.length === 0) return

    if (this.isFrontendIdle() && this.onActivation) {
      this.maybeFireActivation()
      // 无论本次是否触发成功（可能被节流拦截），都保留轮询兜底：
      // 事件未消费前轮询持续重试（maybeFireActivation 内部节流防刷屏），
      // 直到前端真正发起请求 consumeEvents 消费事件（queue 清空）才停止。
      if (!this.activationPollHandle) {
        this.activationPollHandle = this.createPollInterval()
      }
      return
    }
    // 前端不空闲，启动轮询（每 500ms 检查一次，直到前端 idle 或 queue 被消费）
    if (!this.activationPollHandle) {
      this.activationPollHandle = this.createPollInterval()
    }
  }

  /** 上次触发 onActivation 的时间（节流用） */
  private lastActivationAt = 0

  /**
   * 触发激活回调（带节流）。
   * 注意：触发后**不**清轮询——若前端当时忙（status=streaming）或没选会话，
   * triggerActivation() 会直接 return 吞掉事件；事件未消费（queue 非空）时轮询持续重试，
   * 直到前端真正发起请求（consumeEvents 消费事件，queue 清空）轮询才自动停止。
   */
  private maybeFireActivation(): void {
    if (!this.onActivation) return
    const now = Date.now()
    if (now - this.lastActivationAt < this.activationThrottleMs) return
    this.lastActivationAt = now
    this.onActivation()
  }

  private createPollInterval(): TimerHandle {
    const cb = (): void => {
      if (this.queue.length === 0) {
        this.clearPollHandle()
        return
      }
      // stream 活跃中不触发自主激活
      if (this.streamActive) return
      // 仅 timer 和 forceActivate 可触发（与 tryTriggerActivation 一致）
      const activatable = this.queue.filter(
        (e) => e.forceActivate === true || e.source === 'timer'
      )
      if (activatable.length === 0) {
        this.clearPollHandle()
        return
      }
      if (this.isFrontendIdle() && this.onActivation) {
        // 不 clearPollHandle：前端可能吞掉事件，保留轮询等 queue 被消费后自动停止
        this.maybeFireActivation()
      }
    }
    if (this.timerRegistry) {
      return this.timerRegistry.setInterval(cb, 500, 'activation.poll')
    }
    return setInterval(cb, 500) as unknown as TimerHandle
  }

  private clearPollHandle(): void {
    if (!this.activationPollHandle) return
    if (this.timerRegistry) {
      this.timerRegistry.clearInterval(this.activationPollHandle)
    } else {
      clearInterval(this.activationPollHandle as unknown as ReturnType<typeof setInterval>)
    }
    this.activationPollHandle = null
  }

  /**
   * 从 AI 输出中解析倒计时指令并注册
   */
  parseAIOutput(content: string): { setCount: number; cancelCount: number } {
    let setCount = 0
    let cancelCount = 0

    // 解析设定
    TIMER_REGEX.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = TIMER_REGEX.exec(content)) !== null) {
      const value = parseInt(match[1], 10)
      const unit = match[2] || 's'
      const task = match[3].trim()
      const ms = toMilliseconds(value, unit)
      if (ms > 0) {
        this.registerTimer(task, ms)
        setCount++
      }
    }

    // 解析取消
    TIMER_CANCEL_REGEX.lastIndex = 0
    while ((match = TIMER_CANCEL_REGEX.exec(content)) !== null) {
      const id = match[1].trim()
      if (this.cancelTimer(id)) {
        cancelCount++
      }
    }

    return { setCount, cancelCount }
  }

  /**
   * 注册倒计时
   */
  private registerTimer(task: string, ms: number): string {
    const id = `t_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
    const fireAt = Date.now() + ms

    const cb = (): void => {
      this.enqueueEvent({
        id: `evt_${Date.now()}`,
        source: 'timer',
        content: `【倒计时触发】任务：${task}（定时器 ${id}）。\n你之前设定了这个时间点要处理这件事，请自主判断是否执行。`,
        createdAt: Date.now()
      })
      this.timers.delete(id)
      this.persistTimers()
    }
    const handle = this.timerRegistry
      ? this.timerRegistry.setTimeout(cb, ms, `activation.timer.${id}`)
      : (setTimeout(cb, ms) as unknown as TimerHandle)

    this.timers.set(id, { id, fireAt, task, handle })
    this.persistTimers()
    return id
  }

  /**
   * 取消倒计时
   */
  cancelTimer(id: string): boolean {
    const rec = this.timers.get(id)
    if (!rec) return false
    if (this.timerRegistry) {
      this.timerRegistry.clearTimeout(rec.handle)
    } else {
      clearTimeout(rec.handle as unknown as ReturnType<typeof setTimeout>)
    }
    this.timers.delete(id)
    this.persistTimers()
    return true
  }

  /**
   * 当前活跃倒计时快照（供监控面板「定时器」tab 展示）。
   * 按触发时间升序，已到期的自动排除（fireAt <= now）。
   */
  getActiveTimers(): Array<{ id: string; task: string; fireAt: number; remainingMs: number }> {
    const now = Date.now()
    return Array.from(this.timers.values())
      .filter((t) => t.fireAt > now)
      .map((t) => ({ id: t.id, task: t.task, fireAt: t.fireAt, remainingMs: t.fireAt - now }))
      .sort((a, b) => a.fireAt - b.fireAt)
  }

  /**
   * 接收 DMN 事件并注入激活队列
   */
  pushDmnEvent(content: string): void {
    this.enqueueEvent({
      id: `evt_dmn_${Date.now()}`,
      source: 'dmn',
      content: `【后端协作】${content}`,
      createdAt: Date.now()
    })
  }

  /**
   * 文档 15.2.1：外部事件激活源
   * API 回调/UI 事件等触发，由具体业务方调用
   * @param content 事件内容
   * @param forceActivate 强制可激活（默认 false）：true 时即使持续激活关闭也触发 onActivation。
   * 仅用于已过自身防死循环节流的系统事件（如健康检查报错，AlertGate 已去重冷却），
   * 普通外部事件不要传 true，避免打扰用户。
   */
  pushExternalEvent(content: string, forceActivate = false): void {
    this.enqueueEvent({
      id: `evt_ext_${Date.now()}`,
      source: 'external',
      content: `【外部事件】${content}`,
      createdAt: Date.now(),
      forceActivate
    })
  }

  /**
   * 中断恢复：非用户中止的错误（网络断开、模型崩溃、空闲超时）触发

   * 设计要点：
   * - 延迟入队：让前端 AI 有时间回到空闲状态（前端收到 error 消息后才会 pushFrontendIdle(true)）
   * - 不设恢复次数上限（2026-10-02 按用户要求取消 MAX_INTERRUPT_RECOVERY=10）
   * - 用户发新消息时通过 resetInterruptRecovery 重置计数，表示中断恢复周期结束
   * - 恢复事件通过 activation: true 触发，不写 raw_memory，用户无感（只看到 AI 自主继续）
   */
  requestInterruptRecovery(reason: string, messageId: string, sessionId?: string): void {
    this.interruptRecoveryCount++
    const attempt = this.interruptRecoveryCount
    const interruptedAt = new Date().toLocaleString('zh-CN')

    // 直接入队，不延迟（原 3s 延迟是为了等前端 idle，但 tryTriggerActivation 已有轮询机制兜底）
    this.enqueueEvent({
      id: `evt_recover_${Date.now()}`,
      source: 'external',
      content:
        `【中断恢复】上一轮任务（messageId: ${messageId}）因「${reason}」于 ${interruptedAt} 意外中断（第 ${attempt} 次自动恢复）。\n` +
        `请检查 TodoWrite 任务清单状态，从最后一个 in_progress 的子任务继续。\n` +
        `- 中断前已输出的内容用户已看到，不要重复，直接续上。\n` +
        `- 如果任务实际已完成或不再需要继续，正常回复结束即可，不要为恢复而恢复。\n` +
        `- 如果需要用户决策才能继续，请询问用户。`,
      createdAt: Date.now(),
      sessionId
    })
  }

  /**
   * 重置中断恢复计数
   * 用户主动发新消息（非激活）时调用，表示中断恢复周期结束、新的对话开始
   */
  resetInterruptRecovery(): void {
    if (this.interruptRecoveryCount > 0) {
      this.interruptRecoveryCount = 0
    }
  }

  /**
   * 请求反思循环（已废弃自动触发）

   * 设计变更：用户明确要求自主激活不应在对话结束后立即触发，
   * 而应由 AI 规划任务时通过 [TIMER:时长:任务] 指令按时间定时重启。
   * server.ts 不再自动调用此方法。

   * 保留方法供未来需要时手动调用（如 AI 显式输出 [REFLECT] 指令时），
   * 但当前不再有任何调用方。reflectionPending 字段保留兼容。
   */
  requestReflection(sessionId: string): void {
    if (this.reflectionPending) return
    // 不再自动 enqueue 反思事件——避免"说完一句话就紧跟自主激活"
    // 如需反思，AI 应主动通过 [TIMER:...] 设定延迟反思
    void sessionId
  }

  /**
   * 消费激活事件队列（下次 AI 请求时调用）
   * 返回注入的 system message 内容，或 null

   * 仅处理外部事件（cron/健康检查/倒计时/DMN/中断恢复）。
   * 持续激活自动续接已移除——不再在无事件时基于待办清单生成续接提示。
   * sessionId 用于会话级隔离——读取该会话专属的 todo 文件。
   */
   consumeEvents(sessionId?: string): string | null {
    if (this.queue.length === 0) return null

    // 按会话过滤：本会话的事件 + 无 sessionId 标记的全局事件
    const mine: ActivationEvent[] = []
    const others: ActivationEvent[] = []
    for (const evt of this.queue) {
      if (evt.sessionId === undefined || evt.sessionId === sessionId) {
        mine.push(evt)
      } else {
        others.push(evt)
      }
    }
    if (mine.length === 0) return null
    // 只消费匹配的事件，其他会话的事件留在队列
    this.queue = others

    const lines: string[] = []

    lines.push('【激活事件】以下事件需要你自主判断是否响应：', '')
    for (const evt of mine) {
      lines.push(`[${evt.source}] ${evt.content}`)
      lines.push('')
    }

    // 附带当前任务清单（仅中断恢复事件：续接被打断的任务时才需要历史规划上下文；
    // 健康检查/倒计时/DMN 等新事件自带任务说明，带旧任务会让 AI 被拖去续做历史任务）。
    if (mine.some((e) => e.content.includes('【中断恢复】'))) {
      const root = join(this.watchDir, '..')
      const todos = readPersistedTodos(root, sessionId)
      const activeTodos = todos.filter((t) => t.status === 'pending' || t.status === 'in_progress')
      if (activeTodos.length > 0) {
        lines.push('【当前任务清单】你之前的规划状态（仅未完成项）：')
        for (const t of activeTodos) {
          const mark = t.status === 'in_progress' ? '▶' : '○'
          lines.push(`  ${mark} [${t.priority}] ${t.content}（id: ${t.id}）`)
        }
        lines.push('')
        lines.push(
          '请基于当前清单状态继续推进：执行 in_progress 任务、开始下一个 pending 任务，或根据激活事件调整规划。'
        )
        lines.push('')
      }
    }

    return lines.join('\n')
  }

  /**
   * 队列中是否已有内容包含 prefix 的待消费事件。
   * 用于周期任务做 single-flight 去重（已有未消费的同源事件时跳过本轮，避免堆积）。
   */
  hasPendingEvent(prefix: string): boolean {
    return this.queue.some((evt) => evt.content.includes(prefix))
  }

  /**
   * 预览待注入的激活内容（不消费队列）。
   * 用途：activation:trigger 事件把内容带给前端，前端把内容作为 user 消息插入对话流。
   * 与 consumeEvents 生成逻辑一致，但无副作用（不清空队列）。

   * 仅预览外部事件。持续激活续接已移除。
   * sessionId 用于会话级隔离——读取该会话专属的 todo 文件。
   */
  peekActivationContent(sessionId?: string): string | null {
    if (this.queue.length === 0) return null

    // 按会话过滤：只预览本会话的事件 + 无 sessionId 标记的全局事件
    const visible = this.queue.filter(
      (evt) => evt.sessionId === undefined || evt.sessionId === sessionId
    )
    if (visible.length === 0) return null

    const lines: string[] = []
    lines.push('【激活事件】以下事件需要你自主判断是否响应：', '')
    for (const evt of visible) {
      lines.push(`[${evt.source}] ${evt.content}`)
      lines.push('')
    }

    // 附带当前任务清单（仅中断恢复事件：续接被打断的任务时才需要历史规划上下文，
    // 与 consumeEvents 口径一致；健康检查/倒计时/DMN 等新事件自带任务说明）
    if (visible.some((e) => e.content.includes('【中断恢复】'))) {
      const root = join(this.watchDir, '..')
      const todos = readPersistedTodos(root, sessionId)
      const activeTodos = todos.filter((t) => t.status === 'pending' || t.status === 'in_progress')
      if (activeTodos.length > 0) {
        lines.push('【当前任务清单】你之前的规划状态（仅未完成项）：')
        for (const t of activeTodos) {
          const mark = t.status === 'in_progress' ? '▶' : '○'
          lines.push(`  ${mark} [${t.priority}] ${t.content}（id: ${t.id}）`)
        }
        lines.push('')
        lines.push(
          '请基于当前清单状态继续推进：执行 in_progress 任务、开始下一个 pending 任务，或根据激活事件调整规划。'
        )
        lines.push('')
      }
    }

    return lines.join('\n')
  }



  /**
   * 持久化定时器（重启后恢复）
   */
  private persistTimers(): void {
    const data = Array.from(this.timers.values()).map(({ id, fireAt, task }) => ({
      id,
      fireAt,
      task
    }))
    writeFileSync(this.timersFile, JSON.stringify(data, null, 2), 'utf-8')
  }

  /**
   * 加载持久化的定时器
   */
  private loadTimers(): void {
    if (!existsSync(this.timersFile)) return
    const raw = readFileSync(this.timersFile, 'utf-8')
      const data = JSON.parse(raw) as Array<{ id: string; fireAt: number; task: string }>
      const now = Date.now()
      for (const t of data) {
        const remaining = t.fireAt - now
        if (remaining <= 0) {
          // 已过期的定时器，立即触发（启动后 AI 空闲时通过 onActivation 自主激活）
          this.enqueueEvent({
            id: `evt_${Date.now()}`,
            source: 'timer',
            content: `【倒计时触发】任务：${t.task}（定时器 ${t.id}）。\n系统重启后发现此定时器已到期，请自主判断是否执行。`,
            createdAt: Date.now()
          })
          // 过期定时器必须从持久化文件移除——
          // 原实现只入队不清理：文件记录原样保留，重启 N 次触发 N 次同一过期事件。
          this.timers.delete(t.id)
        } else {
          // 重新注册
          const cb = (): void => {
            this.enqueueEvent({
              id: `evt_${Date.now()}`,
              source: 'timer',
              content: `【倒计时触发】任务：${t.task}（定时器 ${t.id}）。\n请自主判断是否执行。`,
              createdAt: Date.now()
            })
            this.timers.delete(t.id)
            this.persistTimers()
          }
          const handle = this.timerRegistry
            ? this.timerRegistry.setTimeout(cb, remaining, `activation.timer.${t.id}`)
            : (setTimeout(cb, remaining) as unknown as TimerHandle)
          this.timers.set(t.id, { ...t, handle })
        }
      }
      // 循环内可能删除了过期定时器（timers.delete），
      // 这里统一持久化，把已删除的过期记录从文件清除（否则下次启动再次触发）
      this.persistTimers()
  }

  /**
   * 停止所有定时器
   */
  stop(): void {
    for (const t of this.timers.values()) {
      if (this.timerRegistry) {
        this.timerRegistry.clearTimeout(t.handle)
      } else {
        clearTimeout(t.handle as unknown as ReturnType<typeof setTimeout>)
      }
    }
    this.timers.clear()
    // 清理待触发的恢复事件
    for (const h of this.pendingRecoveryHandles) {
      if (this.timerRegistry) {
        this.timerRegistry.clearTimeout(h)
      } else {
        clearTimeout(h as unknown as ReturnType<typeof setTimeout>)
      }
    }
    this.pendingRecoveryHandles = []
    // 清理轮询
    this.clearPollHandle()
  }

  /**
   * 获取当前定时器列表（供 UI 或调试用）
   */
  getTimers(): Array<{ id: string; fireAt: number; task: string }> {
    return Array.from(this.timers.values()).map(({ id, fireAt, task }) => ({ id, fireAt, task }))
  }
}

function toMilliseconds(value: number, unit: string): number {
  switch (unit) {
    case 's':
      return value * 1000
    case 'm':
      return value * 60 * 1000
    case 'h':
      return value * 60 * 60 * 1000
    default:
      return value * 1000
  }
}
