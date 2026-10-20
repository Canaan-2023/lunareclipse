import { describe, it, expect, afterEach } from 'vitest'
import { createToolRegistry, executeTool } from '../electron/main/tools/index'
import type { AnyTool, ToolBehavior } from '../electron/main/tools/base-tool'
import {
  EnterAcceptEditsModeTool,
  ExitAcceptEditsModeTool,
  isAcceptEditsActive,
  resetAcceptEditsState
} from '../electron/main/tools/accept-edits-mode'

/**
 * 自动编辑模式（enter_accept_edits_mode / exit_accept_edits_mode + 执行链自动放行）
 * 为什么存在：批量化改文件时 Edit/Write/NotebookEdit 的逐次授权不再打断用户。
 * 本测试覆盖：进入/退出、白名单放行、白名单外不放行、deny 优先、无 requestPermission 时
 * 仍放行（自动放行不触碰授权通道）、会话隔离、重复进入幂等、状态清理。
 */

function makeRegistry(): ReturnType<typeof createToolRegistry> {
  const r = createToolRegistry({ config: {} } as never, {} as never)
  r.tools.set('enter_accept_edits_mode', new EnterAcceptEditsModeTool())
  r.tools.set('exit_accept_edits_mode', new ExitAcceptEditsModeTool())
  return r
}

/** 无副作用计数 probe（模拟 Edit/Write/NotebookEdit 等任意工具名） */
function makeProbe(name: string, behavior: ToolBehavior): { tool: AnyTool; calls: () => number } {
  let callCount = 0
  const tool: AnyTool = {
    name,
    description: `probe ${name}`,
    parameters: [{ name: 'key', type: 'string', description: '输入键' }],
    behavior,
    execute: () => {
      callCount++
      return { ok: true, data: { done: true } }
    }
  }
  return { tool, calls: () => callCount }
}

afterEach(() => {
  resetAcceptEditsState()
})

describe('自动编辑模式 × 执行链自动放行', () => {
  it('进入模式：状态激活；白名单编辑工具在 require-approval 下自动放行', async () => {
    const edit = makeProbe('Edit', { readOnly: false })
    const registry = makeRegistry()
    registry.tools.set(edit.tool.name, edit.tool)
    registry.ctx.sessionId = 's-ok'
    // require-approval 且 requestPermission 未初始化：非模式下必然被拒，模式放行
    ;(registry.ctx.config as Record<string, unknown>).toolPermissionOverrides = {
      Edit: 'require-approval'
    }

    const before = await executeTool(registry, 'Edit', {})
    expect(before.ok).toBe(false)
    expect(before.error).toContain('requestPermission 未初始化')

    const entered = await executeTool(registry, 'enter_accept_edits_mode', {})
    expect(entered.ok).toBe(true)
    expect(isAcceptEditsActive('s-ok')).toBe(true)

    const after = await executeTool(registry, 'Edit', {})
    expect(after.ok).toBe(true)
    expect(edit.calls()).toBe(1)
  })

  it('白名单外工具（如 DeleteFile）不受自动编辑影响，require-approval 仍拒绝', async () => {
    const del = makeProbe('DeleteFile', { readOnly: false })
    const registry = makeRegistry()
    registry.tools.set(del.tool.name, del.tool)
    registry.ctx.sessionId = 's-del'
    ;(registry.ctx.config as Record<string, unknown>).toolPermissionOverrides = {
      DeleteFile: 'require-approval'
    }

    await executeTool(registry, 'enter_accept_edits_mode', {})
    const r = await executeTool(registry, 'DeleteFile', {})
    expect(r.ok).toBe(false)
    expect(r.error).toContain('requestPermission 未初始化')
    expect(del.calls()).toBe(0)
  })

  it('deny 优先：模式激活下 deny 覆写仍拒绝（管理员收紧不能放宽）', async () => {
    const edit = makeProbe('Edit', { readOnly: false })
    const registry = makeRegistry()
    registry.tools.set(edit.tool.name, edit.tool)
    registry.ctx.sessionId = 's-deny'
    ;(registry.ctx.config as Record<string, unknown>).toolPermissionOverrides = {
      Edit: 'deny'
    }

    await executeTool(registry, 'enter_accept_edits_mode', {})
    const r = await executeTool(registry, 'Edit', {})
    expect(r.ok).toBe(false)
    expect(r.error).toContain('已被权限策略拒绝')
    expect(edit.calls()).toBe(0)
    expect(isAcceptEditsActive('s-deny')).toBe(true)
  })

  it('模式放行不触碰授权通道：模式激活下即使 requestPermission 存在也不调用（计数为 0）', async () => {
    const edit = makeProbe('Write', { readOnly: false })
    const registry = makeRegistry()
    registry.tools.set(edit.tool.name, edit.tool)
    registry.ctx.sessionId = 's-nocall'
    ;(registry.ctx.config as Record<string, unknown>).toolPermissionOverrides = {
      Write: 'require-approval'
    }
    let permissionCalls = 0
    registry.ctx.requestPermission = async () => {
      permissionCalls++
      return { allowed: true, reason: 'granted' }
    }

    await executeTool(registry, 'enter_accept_edits_mode', {})
    const r = await executeTool(registry, 'Write', {})
    expect(r.ok).toBe(true)
    expect(edit.calls()).toBe(1)
    expect(permissionCalls).toBe(0)
  })

  it('退出模式：恢复严格确认；未进入时退出返回提示且状态保持不激活', async () => {
    const edit = makeProbe('Edit', { readOnly: false })
    const registry = makeRegistry()
    registry.tools.set(edit.tool.name, edit.tool)
    registry.ctx.sessionId = 's-exit'
    ;(registry.ctx.config as Record<string, unknown>).toolPermissionOverrides = {
      Edit: 'require-approval'
    }

    await executeTool(registry, 'enter_accept_edits_mode', {})
    expect(isAcceptEditsActive('s-exit')).toBe(true)
    const exited = await executeTool(registry, 'exit_accept_edits_mode', {})
    expect(exited.ok).toBe(true)
    expect(isAcceptEditsActive('s-exit')).toBe(false)

    const after = await executeTool(registry, 'Edit', {})
    expect(after.ok).toBe(false)
    expect(after.error).toContain('requestPermission 未初始化')
  })

  it('重复进入幂等：仍激活且提示已在模式中', async () => {
    const registry = makeRegistry()
    registry.ctx.sessionId = 's-idem'

    await executeTool(registry, 'enter_accept_edits_mode', {})
    const again = await executeTool(registry, 'enter_accept_edits_mode', {})
    expect(again.ok).toBe(true)
    expect(String((again.data as { message?: string } | undefined)?.message)).toContain('已在自动编辑模式')
    expect(isAcceptEditsActive('s-idem')).toBe(true)
  })

  it('resetAcceptEditsState 清理全部会话状态', async () => {
    const registry = makeRegistry()
    registry.ctx.sessionId = 's-reset'

    await executeTool(registry, 'enter_accept_edits_mode', {})
    expect(isAcceptEditsActive('s-reset')).toBe(true)
    resetAcceptEditsState()
    expect(isAcceptEditsActive('s-reset')).toBe(false)
  })
})

describe('自动编辑模式 × 会话隔离', () => {
  it('仅当前会话激活，其他会话不受影响', async () => {
    const edit = makeProbe('Edit', { readOnly: false })
    const registry = makeRegistry()
    registry.tools.set(edit.tool.name, edit.tool)
    registry.ctx.sessionId = 's-a'
    ;(registry.ctx.config as Record<string, unknown>).toolPermissionOverrides = {
      Edit: 'require-approval'
    }

    await executeTool(registry, 'enter_accept_edits_mode', {})
    expect(isAcceptEditsActive('s-a')).toBe(true)
    expect(isAcceptEditsActive('s-b')).toBe(false)

    // 同一 registry 换会话：s-b 未激活，Edit 恢复逐次授权（无通道 → 拒绝）
    registry.ctx.sessionId = 's-b'
    const r = await executeTool(registry, 'Edit', {})
    expect(r.ok).toBe(false)
    expect(r.error).toContain('requestPermission 未初始化')
    expect(edit.calls()).toBe(0)
  })
})