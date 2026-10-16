import { describe, it, expect, afterAll } from 'vitest'
import { mkdtemp, rm, readFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { createToolRegistry, executeTool } from '../electron/main/tools/index'
import type { AnyTool, ToolBehavior } from '../electron/main/tools/base-tool'

/**
 * executeTool × 行为策略化消费（2026-10-14，契约层 ToolBehavior 落地后的执行器层配套）
 * 为什么存在：契约层新增 readOnly / concurrencySafe / inputFingerprint / resultLimitChars /
 *   checkAllowed 五项可选行为声明后，执行器必须按声明做差异化处理；这些处理全部 fail-closed，
 *   未声明行为时与改造前行为一致。本测试覆盖执行器层的四个消费点：
 *   等价去重（readOnly + inputFingerprint）、并发调度（concurrencySafe=false 串行）、
 *   权限前置（checkAllowed 拒绝）、大结果落盘（resultLimitChars 超限写盘返回摘要+路径）。
 */

/** 临时目录：大结果落盘测试用（工具名唯一避免与其他用例共享模块级去重/队列状态） */
let tempDir: string | undefined

async function makeRegistry(tool: AnyTool): ReturnType<typeof createToolRegistry> {
  const r = createToolRegistry({ config: {} } as never, {} as never)
  r.tools.set(tool.name, tool)
  return r
}

/** 构造一个执行体带副作用计数器的工具（用于验证串行/去重/拒绝） */
function makeProbe(
  name: string,
  opts: { behavior?: ToolBehavior; appDataDir?: string } = {}
): { tool: AnyTool; calls: () => number } {
  let callCount = 0
  const tool: AnyTool = {
    name,
    description: `probe ${name}`,
    parameters: [{ name: 'key', type: 'string', description: '输入键' }],
    behavior: opts.behavior,
    execute: (params, _ctx) => {
      callCount++
      const key = typeof params.key === 'string' ? params.key : ''
      // 大结果：key 输入固定返回 5000 字符的字符串，用于触发落盘阈值
      return { ok: true, data: { echo: key, blob: 'x'.repeat(5000) } }
    }
  }
  return { tool, calls: () => callCount }
}

afterAll(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true })
})

describe('executeTool × 等价去重（readOnly + inputFingerprint）', () => {
  it('相同输入只执行一次，第二次命中缓存', async () => {
    const { tool, calls } = makeProbe('__dedupe_same__', {
      behavior: {
        readOnly: true,
        inputFingerprint: (p) => (p as { key?: string }).key ?? ''
      }
    })
    const registry = await makeRegistry(tool)
    registry.ctx.sessionId = 's1'

    const r1 = await executeTool(registry, tool.name, { key: 'a' })
    const r2 = await executeTool(registry, tool.name, { key: 'a' })
    expect(r1.ok).toBe(true)
    expect(r2.ok).toBe(true)
    expect(calls()).toBe(1)
    expect((r2.data as { echo: string }).echo).toBe('a')
  })

  it('不同输入不命中缓存，各自执行', async () => {
    const { tool, calls } = makeProbe('__dedupe_diff__', {
      behavior: {
        readOnly: true,
        inputFingerprint: (p) => (p as { key?: string }).key ?? ''
      }
    })
    const registry = await makeRegistry(tool)
    await executeTool(registry, tool.name, { key: 'a' })
    await executeTool(registry, tool.name, { key: 'b' })
    expect(calls()).toBe(2)
  })

  it('非 readOnly 工具即使有 inputFingerprint 也不去重', async () => {
    const { tool, calls } = makeProbe('__dedupe_write__', {
      behavior: {
        readOnly: false,
        inputFingerprint: (p) => (p as { key?: string }).key ?? ''
      }
    })
    const registry = await makeRegistry(tool)
    await executeTool(registry, tool.name, { key: 'a' })
    await executeTool(registry, tool.name, { key: 'a' })
    expect(calls()).toBe(2)
  })
})

describe('executeTool × 并发调度（concurrencySafe=false 同会话串行）', () => {
  it('非并发安全工具并发调用按序排队执行（执行计数不变、都成功）', async () => {
    const { tool, calls } = makeProbe('__serial__', {
      behavior: { concurrencySafe: false }
    })
    const registry = await makeRegistry(tool)
    registry.ctx.sessionId = 's1'

    // 同一时刻发起 3 个调用：串行队列保证全部成功且计数为 3
    const [a, b, c] = await Promise.all([
      executeTool(registry, tool.name, { key: 'a' }),
      executeTool(registry, tool.name, { key: 'b' }),
      executeTool(registry, tool.name, { key: 'c' })
    ])
    expect(a.ok).toBe(true)
    expect(b.ok).toBe(true)
    expect(c.ok).toBe(true)
    expect(calls()).toBe(3)
  })

  it('缺省（未声明 concurrencySafe）按 riskLevel 推断：low 并行、medium 串行', async () => {
    // 未声明行为 + 无 meta（createToolRegistry 无 registry 元数据）→ riskLevel 缺失 → 按 low 并行
    const { tool } = makeProbe('__serial_default__')
    const registry = await makeRegistry(tool)
    const [a, b] = await Promise.all([
      executeTool(registry, tool.name, { key: 'a' }),
      executeTool(registry, tool.name, { key: 'b' })
    ])
    expect(a.ok).toBe(true)
    expect(b.ok).toBe(true)
  })
})

describe('executeTool × 工具级权限前置（checkAllowed）', () => {
  it('checkAllowed 返回 false → fail-closed 拒绝执行', async () => {
    const { tool, calls } = makeProbe('__forbidden__', {
      behavior: { checkAllowed: () => false }
    })
    const registry = await makeRegistry(tool)
    const res = await executeTool(registry, tool.name, { key: 'a' })
    expect(res.ok).toBe(false)
    expect(res.error ?? '').toContain('权限策略')
    expect(calls()).toBe(0)
  })

  it('checkAllowed 抛错 → fail-closed 拒绝执行', async () => {
    const { tool, calls } = makeProbe('__forbidden_err__', {
      behavior: {
        checkAllowed: () => {
          throw new Error('boom')
        }
      }
    })
    const registry = await makeRegistry(tool)
    const res = await executeTool(registry, tool.name, { key: 'a' })
    expect(res.ok).toBe(false)
    expect(res.error ?? '').toContain('权限策略')
    expect(calls()).toBe(0)
  })

  it('checkAllowed 放行 → 正常执行', async () => {
    const { tool, calls } = makeProbe('__allowed__', {
      behavior: { checkAllowed: () => true }
    })
    const registry = await makeRegistry(tool)
    const res = await executeTool(registry, tool.name, { key: 'a' })
    expect(res.ok).toBe(true)
    expect(calls()).toBe(1)
  })
})

describe('executeTool × 大结果落盘（resultLimitChars）', () => {
  it('结果超限 → 落盘返回摘要 + resultFile 路径，原文可读', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'lunar-tool-spill-'))
    const { tool } = makeProbe('__spill__', {
      behavior: { resultLimitChars: 100 },
      appDataDir: tempDir
    })
    const registry = await makeRegistry(tool)
    // 注意：resultLimitChars 落盘读取的是 ctx.appDataDir
    registry.ctx.appDataDir = tempDir

    const res = await executeTool(registry, tool.name, { key: 'k' })
    expect(res.ok).toBe(true)
    const data = res.data as { blob?: unknown; resultFile?: string; resultChars?: number }
    expect(typeof data.resultFile).toBe('string')
    expect(typeof data.resultChars).toBe('number')
    expect(data.resultChars ?? 0).toBeGreaterThan(100)
    // 摘要中的超长字符串已被截断（不再完整携带 5000 字符）
    expect(typeof data.blob).toBe('string')
    expect((data.blob as string).length).toBeLessThan(5000)
    // 落盘包含完整 JSON（含原始 5000 字符）
    const spilled = JSON.parse(await readFile(data.resultFile as string, 'utf-8')) as {
      data?: { blob?: string }
    }
    expect(spilled.data?.blob?.length).toBe(5000)
  })

  it('结果未超限 → 不落盘、不返回 resultFile', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'lunar-tool-no-spill-'))
    const { tool } = makeProbe('__no_spill__', {
      behavior: { resultLimitChars: 10_000_000 },
      appDataDir: tempDir
    })
    const registry = await makeRegistry(tool)
    registry.ctx.appDataDir = tempDir
    const res = await executeTool(registry, tool.name, { key: 'k' })
    expect(res.ok).toBe(true)
    expect((res.data as { resultFile?: string }).resultFile).toBeUndefined()
  })
})