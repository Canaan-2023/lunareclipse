/**
 * hooks-prellm.test.ts —— PreLLMCall hook 链路 + 新工具注册（2026-08-13）
 *
 * 覆盖：
 * 1. hook-manager stdout JSON → injectedContext 注入：
 *    - exit 0 + {action, injectedContext} / {context} 无 action 两种形态
 *    - 非 JSON stdout → continue 不注入；exit 2 → block
 *    - 回归防护：HookExecutor.run() 必须透传 injectedContext（曾因末尾 return 新对象而静默丢弃）
 * 2. registry TOOL_MAP：session_search / curator 已注册且对 frontend 默认启用
 */
import { describe, it, expect } from 'vitest'
import { HookExecutor } from '../electron/main/hooks/hook-manager'
import type { ResolvedHook, HookContext } from '../electron/main/hooks/types'
import { TOOL_MAP } from '../shared/tools/registry'

const ctx: HookContext = {
  event: 'PreLLMCall',
  userPrompt: '测试',
  sessionId: 'verify_test',
  cwd: process.cwd()
}

function cmdHook(nodeScript: string): ResolvedHook[] {
  return [{
    event: 'PreLLMCall',
    handler: { type: 'command', command: 'node', args: ['-e', nodeScript], timeout: 5000 },
    matcher: '.*',
    scope: 'global',
    sourceFile: '<verify>'
  }]
}

describe('PreLLMCall: hook-manager stdout JSON 注入', () => {
  it('exit 0 + injectedContext → 注入文本', async () => {
    const exec = new HookExecutor()
    const res = await exec.run(cmdHook(`console.log(JSON.stringify({action:'continue',injectedContext:'记忆速览：测试注入' }))`), 'PreLLMCall', ctx)
    expect(res.action).toBe('continue')
    expect(res.injectedContext).toContain('记忆速览')
  })

  it('{context: "..."} 无 action → 视为 continue + 注入', async () => {
    const exec = new HookExecutor()
    const res = await exec.run(cmdHook(`console.log(JSON.stringify({context:'今天是验证日'}))`), 'PreLLMCall', ctx)
    expect(res.action).toBe('continue')
    expect(res.injectedContext).toContain('验证日')
  })

  it('stdout 非 JSON（纯日志）→ continue 不注入', async () => {
    const exec = new HookExecutor()
    const res = await exec.run(cmdHook(`console.log('plain log line')`), 'PreLLMCall', ctx)
    expect(res.action).toBe('continue')
    expect(res.injectedContext).toBeUndefined()
  })

  it('exit 2 → block 阻断', async () => {
    const exec = new HookExecutor()
    const res = await exec.run(cmdHook(`console.error('blocked'); process.exit(2)`), 'PreLLMCall', ctx)
    expect(res.action).toBe('block')
  })
})

describe('registry TOOL_MAP 新工具注册', () => {
  it('session_search 已注册，frontend 默认启用', () => {
    const meta = TOOL_MAP['session_search']
    expect(meta).toBeDefined()
    expect(meta.defaultEnabled).toBe(true)
    expect(meta.agents).toContain('frontend')
  })

  it('curator 已注册，frontend 默认启用', () => {
    const meta = TOOL_MAP['curator']
    expect(meta).toBeDefined()
    expect(meta.defaultEnabled).toBe(true)
    expect(meta.agents).toContain('frontend')
  })
})
