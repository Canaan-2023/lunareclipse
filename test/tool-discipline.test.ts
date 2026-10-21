/**
 * 工具纪律内建测试（2026-10-15）。
 *
 * 为什么存在：搜索/派发纪律原先靠内置 PreToolUse Hook 拦截维持工具运行（"靠 HOOK
 * 拦截一部分指令"的 hack），本测试钉住纪律已内建到工具自身 execute 层：
 * 1. Grep 无 path/glob → ok:false（禁止无界全项目扫描）；content 模式无 head_limit → ok:false；
 * 2. LS 无 path → ok:false（禁止无参列举）；
 * 3. Agent tasks 超限 → ok:false（并行≤5 / 串行≤8）；
 * 4. 默认 Hook 列表只含 PostToolUse 审计，不再含 PreToolUse 守卫（defaults.ts 清理后）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { GrepTool } from '../electron/main/tools/grep'
import { LSTool } from '../electron/main/tools/ls'
import { AgentTool, AGENT_PARALLEL_LIMIT, AGENT_SERIAL_LIMIT } from '../electron/main/tools/agent'
import { getDefaultHooks } from '../electron/main/hooks/defaults'
import type { ToolContext } from '../electron/main/tools/base-tool'

const emptyCtx: ToolContext = {}

describe('GrepTool 内建搜索纪律', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'grep-disc-'))
    writeFileSync(join(root, 'a.ts'), 'HelloWorld\n', 'utf-8')
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('无 path 且无 glob 被拦截（禁止无界扫描）', async () => {
    const res = await new GrepTool().execute({ pattern: 'Hello' }, emptyCtx)
    expect(res.ok).toBe(false)
    expect(res.error).toContain('搜索纪律守护')
    expect(res.error).toContain('path')
  })

  it('content 模式无 head_limit 被拦截', async () => {
    const res = await new GrepTool().execute({ pattern: 'Hello', path: root, output_mode: 'content' }, emptyCtx)
    expect(res.ok).toBe(false)
    expect(res.error).toContain('搜索纪律守护')
    expect(res.error).toContain('head_limit')
  })

  it('带 path + glob（files_with_matches）可正常执行', async () => {
    const res = await new GrepTool().execute({ pattern: 'Hello', path: root, glob: '*.ts' }, emptyCtx)
    expect(res.ok).toBe(true)
    const data = res.data as { files: string[] }
    expect(data.files).toHaveLength(1)
  })

  it('content 模式带 head_limit 可正常执行', async () => {
    const res = await new GrepTool().execute({ pattern: 'Hello', path: root, output_mode: 'content', head_limit: 5 }, emptyCtx)
    expect(res.ok).toBe(true)
    const data = res.data as { count: number }
    expect(data.count).toBe(1)
  })
})

describe('LSTool 内建搜索纪律', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ls-disc-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('无 path 被拦截（禁止无参列举）', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await new LSTool().execute({} as any, emptyCtx)
    expect(res.ok).toBe(false)
    expect(res.error).toContain('搜索纪律守护')
    expect(res.error).toContain('path')
  })

  it('带 path 可正常列目录', async () => {
    writeFileSync(join(root, 'x.txt'), 'x\n', 'utf-8')
    const res = await new LSTool().execute({ path: root }, emptyCtx)
    expect(res.ok).toBe(true)
    const data = res.data as { count: number }
    expect(data.count).toBe(1)
  })
})

describe('AgentTool 内建派发上限', () => {
  const ctx: ToolContext = {
    launchSubAgent: async () => ['ok']
  }

  it('并行超限被拦截', async () => {
    const tasks = Array.from({ length: AGENT_PARALLEL_LIMIT + 1 }, (_, i) => ({ prompt: `task ${i}` }))
    const res = await new AgentTool().execute({ tasks, mode: 'parallel' }, ctx)
    expect(res.ok).toBe(false)
    expect(res.error).toContain('并行守护')
    expect(res.error).toContain(`最多派 ${AGENT_PARALLEL_LIMIT}`)
  })

  it('串行超限被拦截（上限更宽松）', async () => {
    const tasks = Array.from({ length: AGENT_SERIAL_LIMIT + 1 }, (_, i) => ({ prompt: `task ${i}` }))
    const res = await new AgentTool().execute({ tasks, mode: 'serial' }, ctx)
    expect(res.ok).toBe(false)
    expect(res.error).toContain('并行守护')
    expect(res.error).toContain(`最多派 ${AGENT_SERIAL_LIMIT}`)
  })

  it('并行未超限正常派发', async () => {
    const tasks = Array.from({ length: AGENT_PARALLEL_LIMIT }, (_, i) => ({ prompt: `task ${i}` }))
    const res = await new AgentTool().execute({ tasks, mode: 'parallel' }, ctx)
    expect(res.ok).toBe(true)
  })

  it('串行未超限正常派发（默认 mode 视为串行）', async () => {
    const tasks = Array.from({ length: AGENT_SERIAL_LIMIT }, (_, i) => ({ prompt: `task ${i}` }))
    const res = await new AgentTool().execute({ tasks }, ctx)
    expect(res.ok).toBe(true)
  })
})

describe('defaults.ts 默认 Hook 清理', () => {
  it('默认列表只含 PostToolUse 审计 hook，不再含 PreToolUse 守卫', () => {
    const hooks = getDefaultHooks()
    expect(hooks.length).toBeGreaterThan(0)
    expect(hooks.every((h) => h.event === 'PostToolUse')).toBe(true)
    expect(hooks.some((h) => h.event === 'PreToolUse')).toBe(false)
  })

  it('审计 hook 的 matcher 覆盖所有工具且为 javascript 类型', () => {
    const hooks = getDefaultHooks()
    for (const h of hooks) {
      expect(h.handler.type).toBe('javascript')
      expect(h.matcher).toBe('.*')
    }
  })
})