import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { WebSocket } from 'ws'
import { StreamSession } from '../electron/main/api/stream-session'

const fakeWs = (): WebSocket => ({ readyState: WebSocket.OPEN, send: vi.fn() } as unknown as WebSocket)

describe('StreamSession', () => {
  let session: StreamSession

  beforeEach(() => {
    session = new StreamSession()
  })

  afterEach(() => {
    session.dispose()
  })

  it('初始相位 idle，begin 进入 streaming，finish 回到 idle', () => {
    const ws = fakeWs()
    expect(session.getPhase()).toBe('idle')
    session.begin(ws, 's1', 'm1')
    expect(session.getPhase()).toBe('streaming')
    expect(session.current()?.messageId).toBe('m1')
    session.finish(ws, 'm1')
    expect(session.getPhase()).toBe('idle')
    expect(session.current()).toBeNull()
  })

  it('enqueue 串行执行：前一任务完成前队列深度递增，任务依次运行', async () => {
    const order: number[] = []
    const gate = new Promise<void>((r) => setTimeout(r, 20))
    const p1 = session.enqueue(async () => {
      await gate
      order.push(1)
    })
    const p2 = session.enqueue(async () => {
      order.push(2)
    })
    expect(session.getQueueDepth()).toBeGreaterThanOrEqual(1)
    await Promise.all([p1, p2])
    expect(order).toEqual([1, 2])
    expect(session.getQueueDepth()).toBe(0)
  })

  it('enqueue 任务抛错不断链：后续任务照常执行，调用方拿到异常', async () => {
    const boom = session.enqueue(async () => {
      throw new Error('boom')
    })
    await expect(boom).rejects.toThrow('boom')
    const ran: string[] = []
    await session.enqueue(async () => {
      ran.push('after')
    })
    expect(ran).toEqual(['after'])
    expect(session.getQueueDepth()).toBe(0)
  })

  it('2026-08-24 修复：并发 enqueue 彼此排队（原 headless 路径只 await 未回写尾节点）', async () => {
    const order: string[] = []
    const release = new Promise<void>((r) => setTimeout(r, 20))
    const a = session.enqueue(async () => {
      await release
      order.push('a')
    })
    const b = session.enqueue(async () => {
      order.push('b')
    })
    await Promise.all([a, b])
    expect(order).toEqual(['a', 'b'])
  })

  it('appendOutput/appendReasoning 只累积匹配 messageId 的快照', () => {
    const ws = fakeWs()
    session.begin(ws, 's1', 'm1')
    session.appendOutput('m2', 'x')
    expect(session.current()?.output).toBe('')
    session.appendOutput('m1', 'hello ')
    session.appendOutput('m1', 'world')
    session.appendReasoning('m1', 'think')
    expect(session.current()?.output).toBe('hello world')
    expect(session.current()?.reasoning).toBe('think')
  })

  it('clearSnapshot 只清匹配 messageId；不匹配时保留', () => {
    const ws = fakeWs()
    session.begin(ws, 's1', 'm1')
    session.clearSnapshot('m2')
    expect(session.current()).not.toBeNull()
    session.clearSnapshot('m1')
    expect(session.current()).toBeNull()
    expect(session.getPhase()).toBe('idle')
  })

  it('takeover 改道归属并返回快照供重放；messageId 不匹配返回 null', () => {
    const wsA = fakeWs()
    const wsB = fakeWs()
    session.begin(wsA, 's1', 'm1')
    session.appendOutput('m1', 'partial')
    expect(session.takeover(wsB, 'm9')).toBeNull()
    const snap = session.takeover(wsB, 'm1')
    expect(snap).not.toBeNull()
    expect(snap?.output).toBe('partial')
    expect(session.isOwner(wsA)).toBe(false)
    expect(session.isOwner(wsB)).toBe(true)
  })

  it('ownerClosed 进入宽限；宽限内 takeover 救回则不触发孤儿回调', () => {
    vi.useFakeTimers()
    const onOrphan = vi.fn()
    const wsA = fakeWs()
    const wsB = fakeWs()
    session.begin(wsA, 's1', 'm1')
    session.ownerClosed(onOrphan, 5000)
    expect(session.getPhase()).toBe('grace')
    expect(session.takeover(wsB, 'm1')).not.toBeNull()
    expect(session.getPhase()).toBe('streaming')
    vi.advanceTimersByTime(6000)
    expect(onOrphan).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('ownerClosed 宽限超时仍无接管：清快照回 idle 并触发孤儿回调', () => {
    vi.useFakeTimers()
    const onOrphan = vi.fn()
    const wsA = fakeWs()
    session.begin(wsA, 's1', 'm1')
    session.ownerClosed(onOrphan, 5000)
    vi.advanceTimersByTime(5000)
    expect(onOrphan).toHaveBeenCalledTimes(1)
    expect(session.getPhase()).toBe('idle')
    expect(session.current()).toBeNull()
    vi.useRealTimers()
  })

  it('push 走归属连接而非 fallback；未 open 返回 false 不抛错', () => {
    const wsOwner = fakeWs()
    const wsFallback = fakeWs()
    session.begin(wsOwner, 's1', 'm1')
    expect(session.push(wsFallback, '{"a":1}')).toBe(true)
    expect(wsOwner.send).toHaveBeenCalledWith('{"a":1}')
    expect(wsFallback.send).not.toHaveBeenCalled()
    session.finish(wsOwner, 'm1')
    const closed = { readyState: WebSocket.CLOSED, send: vi.fn() } as unknown as WebSocket
    expect(session.push(closed, '{}')).toBe(false)
  })

  it('forwarder 绑定后转发子代理事件，置空后静默', () => {
    const fn = vi.fn()
    session.setForwarder(fn)
    session.forward({ type: 'start', agentId: 'a1' } as never)
    expect(fn).toHaveBeenCalledTimes(1)
    session.setForwarder(null)
    expect(() => session.forward({ type: 'start' } as never)).not.toThrow()
  })

  it('相位迁移历史可查（排查暗区的核心诉求）', () => {
    const ws = fakeWs()
    session.begin(ws, 's1', 'm1')
    session.finish(ws, 'm1')
    const h = session.getHistory()
    expect(h.map((r) => `${r.from}->${r.to}`)).toEqual(['idle->streaming', 'streaming->idle'])
  })

  it('dispose 清宽限计时器，不触发孤儿回调', () => {
    vi.useFakeTimers()
    const onOrphan = vi.fn()
    const ws = fakeWs()
    session.begin(ws, 's1', 'm1')
    session.ownerClosed(onOrphan, 5000)
    session.dispose()
    vi.advanceTimersByTime(10000)
    expect(onOrphan).not.toHaveBeenCalled()
    vi.useRealTimers()
  })
})
