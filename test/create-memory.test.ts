import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { CreateMemoryTool } from '../electron/main/tools/create-memory'
import { toToolExecutor } from '../electron/main/api/tool-bridge'
import type { DataPaths } from '../electron/main/models/paths'
import type { ToolContext } from '../electron/main/tools/base-tool'
import type { ToolRegistry } from '../electron/main/tools/tool-registry'

// 回归：RAW来源 schema 声明为 array+items（LLM 可传数组），执行层高/meta 数组不再被拒。
const tmpRoots: string[] = []
function makePaths(): DataPaths {
  const root = mkdtempSync(join(tmpdir(), 'lunar-create-mem-'))
  tmpRoots.push(root)
  const memory = join(root, 'memory')
  return {
    root,
    memory,
    memoryNormal: join(memory, 'normal'),
    memoryMeta: join(memory, 'meta'),
    memoryHigh: join(memory, 'high'),
    memoryCounter: join(memory, 'counter.json'),
    usersJson: join(root, 'users.json'),
    aiRegistryJson: join(root, 'ai-registry.json')
  } as unknown as DataPaths
}

afterEach(() => {
  while (tmpRoots.length) {
    const r = tmpRoots.pop()
    if (r) rmSync(r, { recursive: true, force: true })
  }
})

describe('create_memory RAW来源 数组链路（审计疑点 D 回归）', () => {
  it('schema 转换后 RAW来源 是 array 且带 items（LLM 能传 string[]）', () => {
    const registry = { tools: new Map(), ctx: {}, queriedTools: new Set() } as unknown as ToolRegistry
    const executor = toToolExecutor(new CreateMemoryTool(), registry)
    const props = (executor.parameters as { properties: Record<string, { type: string; items?: unknown }> }).properties
    expect(props['RAW来源'].type).toBe('array')
    expect(props['RAW来源'].items).toEqual({ type: 'string' })
  })

  it('high 类型 + RAW来源 数组（多条）执行成功', async () => {
    const paths = makePaths()
    const ctx = { paths } as unknown as ToolContext
    const tool = new CreateMemoryTool()
    const rawA = join(paths.memoryHigh, 'raw_memory/2026/08/09/1_能力扩展.md').replace(/\\/g, '/')
    const rawB = join(paths.memoryHigh, 'raw_memory/2026/08/09/2_协作.md').replace(/\\/g, '/')
    const result = await tool.execute(
      {
        type: 'high',
        精炼内容: '张力分析：A 与 B 冲突',
        RAW来源: [rawA, rawB],
        描述: 'tension_ab',
        备注: '回归测试：high 多条数组'
      },
      ctx
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.path.startsWith(paths.memoryHigh.replace(/\\/g, '/'))).toBe(true)
      expect(existsSync(result.data.path)).toBe(true)
    }
  })

  it('normal 类型 + RAW来源 字符串（兼容旧调用）执行成功', async () => {
    const paths = makePaths()
    const ctx = { paths } as unknown as ToolContext
    const tool = new CreateMemoryTool()
    const raw = join(paths.memoryNormal, 'raw_memory/2026/08/09/3_偏好.md').replace(/\\/g, '/')
    const result = await tool.execute(
      {
        type: 'normal',
        用户原话: '我喜欢简短的回答',
        AI回复: '用户偏好简短回答风格',
        RAW来源: raw,
        描述: 'user_pref_brief',
        备注: '回归测试：normal 单条字符串兼容',
        用户: { UID: 1, 用户名: 'Player' }
      },
      ctx
    )
    expect(result.ok).toBe(true)
  })
})