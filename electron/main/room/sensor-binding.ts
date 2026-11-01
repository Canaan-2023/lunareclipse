/**
 * @category ROOM
 * @summary 感知器绑定：把「感知器什么时候开、采样看什么、变化上报给谁」收成一处
 *
 * 为什么存在：`runtime.ts` 里感知器的创建 / 开关同步 / 策略更新原本散在三段闭包里，
 * 0.54.0 体量红线（800 行棘轮）要求移出，且这三段本就是同一件事的三面——放一起比留在主流程里更可读。
 * 感知器只在「驱动已 park 且相位为 idle / standby」时运行：采样不调用模型，`running` 与 `stopped` 都不采样。
 *
 * 不删理由：删掉即感知器无人开合，房间只能靠定时器醒（回到「没节拍器就永远睡」的老问题）。
 */
import { createRoomSensor, type RoomSensor } from './sensor'
import type { RoomPhase, RoomRuntimeDeps } from './runtime-types'
import type { CollectorView } from './collector-view'
import type { RoomSensorPolicy } from '@shared/room/sensor-policy'

export interface SensorBinding {
  /** 让开关与相位一致（幂等）：只在真的变了时回调 `onNotify` */
  sync: () => void
  /** 策略变了：把新策略推给已创建的感知器（未创建则等下次 `sync` 用最新策略建） */
  configure: () => void
  /** 当前是否正在感知（`getState` 下发快照用） */
  isSensing: () => boolean
}

/**
 * @param deps 只用其中与感知相关的注入项（sense / senseAllowed / reportWake / timers）
 * @param hooks 运行时侧的状态读取与回调：**用 getter 而不是值**——策略与相位每轮都可能变，
 *   把值传进来会在下一轮拿到过期快照。
 */
export function createSensorBinding(opts: {
  deps: Pick<RoomRuntimeDeps, 'sense' | 'senseAllowed' | 'reportWake' | 'timers'>
  getView: () => CollectorView
  getPolicy: () => RoomSensorPolicy
  getPhase: () => RoomPhase
  /** 驱动是否已 park（`stopFn == null`）：正在采集时不需要感知器 */
  canSense: () => boolean
  /** 感知到变化后的唤醒投递（生产走仲裁器；缺省直接 `wake`） */
  report: (detail: string) => boolean
  /** 感知开关变了（运行时用它在推送状态前先落地 `sensing` 值） */
  onSensingChange: () => void
}): SensorBinding {
  let sensor: RoomSensor | null = null
  let sensing = false

  const ensure = (): RoomSensor | null => {
    if (!opts.deps.sense) return null
    if (!sensor) {
      const policy = opts.getPolicy()
      sensor = createRoomSensor({
        sample: async () =>
          opts.deps.senseAllowed?.() === false ? null : opts.deps.sense!(opts.getView(), opts.getPolicy()),
        // 上报走仲裁器（生产注入 `reportRoomWake`）；缺省直接唤醒（单测 / 未装配兜底）。
        // **把接受 / 拒绝原样返回**：被去抖拦下时感知器保留基线，下一次重试。
        onChange: (reasons) => opts.report(reasons.join('；')),
        ...(opts.deps.timers ? { timers: opts.deps.timers } : {}),
        // AI 的初始策略：enabled / mute / 间隔 / 阈值。运行时后续用 `configure` 更新。
        enabled: policy.enabled,
        muted: policy.mute,
        ...(policy.intervalMs != null ? { intervalMs: policy.intervalMs } : {}),
        ...(policy.thresholds ? { thresholds: policy.thresholds } : {}),
        onError: (err) => console.error('[room] 感知采样失败:', err.message)
      })
    }
    return sensor
  }

  return {
    /**
     * **`standby` 也要感知**（用户 2026-10-20 纠正）：待机是 AI 说「先别主动做事」，
     * 不是「把眼睛闭上」——采集器仍应感知事件，真的有事时把 AI 叫醒；
     * `standbyMs` 只是「最迟多久后主动醒一次」的兜底。
     * 只有 `running`（正在采集）与 `stopped`（用户关停）不采样。
     */
    sync: () => {
      const phase = opts.getPhase()
      const sensingPhase = phase === 'idle' || phase === 'standby'
      // AI 可以完全关掉感知（sensor.enabled=false）：此时只剩待机到期这一条兜底。
      const shouldSense = sensingPhase && opts.getPolicy().enabled && opts.canSense() && opts.deps.sense != null
      if (shouldSense === sensing) return
      if (shouldSense) ensure()?.start()
      else sensor?.stop()
      sensing = shouldSense
      opts.onSensingChange()
    },
    configure: () => sensor?.configure(opts.getPolicy()),
    isSensing: () => sensing
  }
}
