import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ActivationManager } from '../electron/main/api/activation-manager'

describe('ActivationManager 外部事件激活', () => {
  let dir: string
  let am: ActivationManager

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'am-test-'))
    am = new ActivationManager(join(dir, '.activation'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('普通 external 事件不触发 onActivation（卡队列等下次注入）', () => {
    const onActivation = vi.fn()
    am.setActivationCallback(onActivation)
    am.pushExternalEvent('【健康检查】普通事件')

    expect(onActivation).not.toHaveBeenCalled()

    // 事件仍在队列，下次 consumeEvents 会注入
    const injected = am.consumeEvents()
    expect(injected).toContain('【健康检查】普通事件')
  })

  it('forceActivate=true 的 external 事件立即触发 onActivation', () => {
    const onActivation = vi.fn()
    am.setActivationCallback(onActivation)
    am.pushExternalEvent('【健康检查】typecheck 失败', true)

    expect(onActivation).toHaveBeenCalledTimes(1)
  })

  it('前端不空闲时 forceActivate 事件不立即触发，空闲后通过轮询触发', async () => {
    const onActivation = vi.fn()
    am.setActivationCallback(onActivation)
    let idle = false
    am.setFrontendIdleProvider(() => idle)

    am.pushExternalEvent('【健康检查】typecheck 失败', true)
    expect(onActivation).not.toHaveBeenCalled()

    // 变空闲后轮询（500ms 间隔）应触发
    idle = true
    await new Promise((r) => setTimeout(r, 700))
    expect(onActivation).toHaveBeenCalledTimes(1)
  })

  it('stream 活跃时 forceActivate 事件不触发，stream 结束后轮询触发', async () => {
    const onActivation = vi.fn()
    am.setActivationCallback(onActivation)
    am.setStreamActive(true)

    am.pushExternalEvent('【健康检查】typecheck 失败', true)
    expect(onActivation).not.toHaveBeenCalled()

    am.setStreamActive(false)
    await new Promise((r) => setTimeout(r, 700))
    expect(onActivation).toHaveBeenCalledTimes(1)
  })

  it('前端吞掉事件（触发后未消费）→ 轮询保留并节流重试；消费后停止重试', async () => {
    const amShort = new ActivationManager(dir, undefined, 50)
    const onActivation = vi.fn()
    amShort.setActivationCallback(onActivation)

    amShort.pushExternalEvent('【健康检查】typecheck 失败', true)
    expect(onActivation).toHaveBeenCalledTimes(1)

    // 前端"吞掉"事件 → 队列里事件仍在，轮询保留
    await new Promise((r) => setTimeout(r, 700))
    expect(onActivation).toHaveBeenCalledTimes(2)

    // 前端真正消费事件 → 轮询停止
    const injected = amShort.consumeEvents()
    expect(injected).toContain('【健康检查】typecheck 失败')
    const callsAfterConsume = onActivation.mock.calls.length
    await new Promise((r) => setTimeout(r, 700))
    expect(onActivation).toHaveBeenCalledTimes(callsAfterConsume)
  })

  it('普通 external 事件被吞后不会无限重试（不可激活，轮询停止）', async () => {
    const amShort = new ActivationManager(dir, undefined, 50)
    const onActivation = vi.fn()
    amShort.setActivationCallback(onActivation)

    amShort.pushExternalEvent('【普通事件】xxx')
    expect(onActivation).not.toHaveBeenCalled()
    await new Promise((r) => setTimeout(r, 700))
    expect(onActivation).not.toHaveBeenCalled()
  })

  it('consumeEvents 无事件时返回 null', () => {
    expect(am.consumeEvents()).toBeNull()
  })

  it('peekActivationContent 预览不消费队列，consumeEvents 仍能取到', () => {
    am.pushExternalEvent('【健康检查】peek 测试事件', true)
    const peeked = am.peekActivationContent()
    expect(peeked).toContain('【激活事件】')
    expect(peeked).toContain('peek 测试事件')

    // peek 不消费：consumeEvents 仍返回同样内容
    const consumed = am.consumeEvents()
    expect(consumed).toContain('peek 测试事件')

    // 消费后 peek 返回 null
    expect(am.peekActivationContent()).toBeNull()
  })

  it('peekActivationContent 无事件时返回 null', () => {
    expect(am.peekActivationContent()).toBeNull()
  })

  it('普通外部事件（健康检查/倒计时）不附带任务清单；仅中断恢复事件附带（会话级隔离）', () => {
    // 写入 session 级 todos 文件（todos-{sessionId}.json）
    const sessionId = 'test-session-1'
    writeFileSync(
      join(dir, '.activation', `todos-${sessionId}.json`),
      JSON.stringify([{ id: 't1', content: '任务1', status: 'pending', priority: 'high' }]),
      'utf-8'
    )
    // 健康检查等新事件自带任务说明，不携带历史任务清单（否则 AI 被拖去续做旧任务）
    am.pushExternalEvent('【健康检查】测试事件', true)
    const plain = am.consumeEvents(sessionId)
    expect(plain).toContain('【激活事件】')
    expect(plain).toContain('测试事件')
    expect(plain).not.toContain('【当前任务清单】')
    expect(plain).not.toContain('任务1')

    // 中断恢复事件：续接被打断的任务，才附带历史任务清单
    am.pushExternalEvent('【中断恢复】上一轮任务意外中断，继续推进', true)
    const recovered = am.consumeEvents(sessionId)
    expect(recovered).toContain('【当前任务清单】')
    expect(recovered).toContain('任务1')
  })

  it('不同 sessionId 读取各自的 todo 文件（会话隔离，仅中断恢复事件附带）', () => {
    const sid1 = 'session-a'
    const sid2 = 'session-b'
    writeFileSync(
      join(dir, '.activation', `todos-${sid1}.json`),
      JSON.stringify([{ id: 't1', content: '任务A', status: 'pending', priority: 'high' }]),
      'utf-8'
    )
    writeFileSync(
      join(dir, '.activation', `todos-${sid2}.json`),
      JSON.stringify([{ id: 't2', content: '任务B', status: 'pending', priority: 'medium' }]),
      'utf-8'
    )
    am.pushExternalEvent('【中断恢复】测试', true)
    const c1 = am.consumeEvents(sid1)
    expect(c1).toContain('任务A')
    expect(c1).not.toContain('任务B')

    am.pushExternalEvent('【中断恢复】测试', true)
    const c2 = am.consumeEvents(sid2)
    expect(c2).toContain('任务B')
    expect(c2).not.toContain('任务A')
  })
})
