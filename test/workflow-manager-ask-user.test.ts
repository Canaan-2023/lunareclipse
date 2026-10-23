/**
 * T6 批次4：workflow/manager.ts ask_user 竞态窗口修复单测
 *
 * 为什么存在：C4 双阶段设计（askUser 放 placeholder → waitForAskUserResponse
 * 覆盖真 resolver）存在竞态——用户在前端弹窗先点（IPC 快）而 LLM 工具调用链
 * 后注册 resolver 时，响应会 resolve 空函数被静默丢弃、等待方永久挂起。
 * 作用：验证"响应/取消先于 resolver 注册到达"时被缓冲且不被丢失。
 * 不删理由：该竞态会直接造成 ask_user 交互死锁（用户答了但 AI 收不到），
 * 是问用户链路的可靠性回归护栏。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { WorkflowManager } from '../electron/main/workflow/manager'
import type { WorkflowManagerDeps } from '../electron/main/workflow/manager'

function makeManagerDeps(root: string): WorkflowManagerDeps {
  return {
    paths: {
      root,
      workflows: join(root, 'workflows'),
      workflowTemplates: join(root, 'workflows', 'templates'),
      workflowInstances: join(root, 'workflows', 'instances')
    } as unknown as WorkflowManagerDeps['paths'],
    llmClient: {} as WorkflowManagerDeps['llmClient'],
    toolRegistry: { tools: new Map() } as unknown as WorkflowManagerDeps['toolRegistry'],
    skillLoader: {} as WorkflowManagerDeps['skillLoader'],
    emit: vi.fn()
  }
}

describe('WorkflowManager ask_user 竞态窗口', () => {
  let root: string
  let manager: WorkflowManager

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'wf-mgr-ask-'))
    manager = new WorkflowManager(makeManagerDeps(root))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('正常链路：askUser → waitForAskUserResponse → respondAskUser 收到响应', async () => {
    const requestId = manager.askUser({ question: '继续吗？', inputType: 'confirm' })
    const waiting = manager.waitForAskUserResponse(requestId)
    expect(manager.respondAskUser(requestId, '是')).toBe(true)
    await expect(waiting).resolves.toBe('是')
  })

  it('竞态：响应先于 resolver 注册到达 → 缓冲后仍被 waitForAskUserResponse 消费', async () => {
    const requestId = manager.askUser({ question: '继续吗？', inputType: 'confirm' })
    // 用户先点（respondAskUser 先执行，此时 resolver 还是 placeholder）
    expect(manager.respondAskUser(requestId, '否')).toBe(true)
    // LLM 工具调用链后注册 resolver → 应直接消费缓冲，不挂起
    await expect(manager.waitForAskUserResponse(requestId)).resolves.toBe('否')
  })

  it('竞态：取消先于 resolver 注册到达 → waitForAskUserResponse 以取消错误 reject', async () => {
    const requestId = manager.askUser({ question: '继续吗？', inputType: 'confirm' })
    expect(manager.cancelAskUser(requestId)).toBe(true)
    await expect(manager.waitForAskUserResponse(requestId)).rejects.toThrow('用户取消了输入')
  })

  it('重复 waitForAskUserResponse（resolver 已存在）→ reject 防止双消费', async () => {
    const requestId = manager.askUser({ question: '问题', inputType: 'text' })
    void manager.waitForAskUserResponse(requestId)
    await expect(manager.waitForAskUserResponse(requestId)).rejects.toThrow('已有等待中的 resolver')
  })

  it('respondAskUser 未知 requestId → false（不误消费）', () => {
    expect(manager.respondAskUser('nope', 'x')).toBe(false)
    expect(manager.cancelAskUser('nope')).toBe(false)
  })
})