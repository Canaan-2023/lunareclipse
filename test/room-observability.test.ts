/**
 * ROOM 可观测与上线门禁（B-D）回归。
 *
 * 覆盖：
 * 1. **P2-8 修复**：`peekRoomRuntime` / `listRoomRuntimeAiIds` 是**无副作用读取**（不创建实例）；
 * 2. **事件落盘**：`RoomEventLog` 一行一条 JSON，可被解析回来；
 * 3. **SRE 门禁「无残留定时器」**：`start → stop` 反复十次后定时器注册表回零。
 *
 * 不可自动化的门禁（视图切换不改运行态 / 崩溃自愈 60s 内 running=false / 灰度 flag 一键回滚）
 * 属主进程窗口生命周期与人工演练范畴，见 `versions/<版本>/MANIFEST.md` 的遗留段。
 */
import { mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, it, expect } from 'vitest'
import {
  createRoomRuntime,
  listRoomRuntimeAiIds,
  peekRoomRuntime,
  setRoomRuntime,
  stopAllRoomRuntimes,
  type RoomRuntime
} from '../electron/main/room/runtime'
import { RoomEventLog } from '../electron/main/room/event-log'
import { TimerRegistry } from '../electron/main/monitor/timer-registry'

function fakeRuntime(): RoomRuntime {
  let running = false
  return {
    start: () => {
      running = true
    },
    stop: () => {
      running = false
    },
    isRunning: () => running,
    standby: () => undefined,
    wake: () => undefined,
    tick: async () => ({ phase: 'idle' as const, acted: false, executions: [] }),
    getState: () => ({ running, phase: running ? ('idle' as const) : ('stopped' as const), events: [], avatarRev: 0 })
  }
}

describe('peekRoomRuntime：无副作用读取（P2-8）', () => {
  it('未创建的 AI → null，且**不创建**实例', () => {
    stopAllRoomRuntimes()
    expect(peekRoomRuntime(7)).toBeNull()
    expect(listRoomRuntimeAiIds()).toEqual([])
  })

  it('已创建的 AI → 返回实例；aiIds 可列出', () => {
    stopAllRoomRuntimes()
    const rt = fakeRuntime()
    setRoomRuntime({ uid: 1, aiId: 7 }, rt)
    expect(peekRoomRuntime(7)).toBe(rt)
    expect(listRoomRuntimeAiIds()).toEqual([7])
    stopAllRoomRuntimes()
  })
})

describe('RoomEventLog：有界 JSONL', () => {
  it('一行一条 JSON，可解析回来', () => {
    const dir = mkdtempSync(join(tmpdir(), 'le-room-log-'))
    const log = new RoomEventLog(dir)
    log.append({ ts: 1, phase: 'idle', detail: '自主开启' })
    log.append({ ts: 2, phase: 'execute', detail: '唤醒（monitor）' })
    const lines = readFileSync(join(dir, 'room-events.jsonl'), 'utf-8').trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0])).toEqual({ ts: 1, phase: 'idle', detail: '自主开启' })
    expect(JSON.parse(lines[1]).detail).toBe('唤醒（monitor）')
  })
})

describe('SRE 门禁：无残留定时器', () => {
  it('start → stop 十次后注册表回零（且期间无 interval）', async () => {
    const reg = new TimerRegistry()
    const rt = createRoomRuntime({
      collect: async () => ({ ok: false, error: '未开启' }),
      plan: async () => '{"decisions":[]}',
      executor: {
        execute: async () => ({
          ok: true,
          decision: { allowed: true, tier: 'T2', code: 'allowed', reason: 'ok', auditId: 'a' }
        })
      },
      allowedTools: () => ['read'],
      timers: reg
    })
    for (let i = 0; i < 10; i++) {
      rt.start()
      await new Promise((r) => setTimeout(r, 5))
      rt.stop()
    }
    expect(reg.size()).toBe(0)
    expect(rt.isRunning()).toBe(false)
  })
})
