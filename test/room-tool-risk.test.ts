/**
 * ROOM 只读判定真源回归（P0-2）：`resolveToolReadOnly` / `createToolReadOnlyResolver`。
 *
 * 为什么存在：执行器按「只读 → `t2.readonly-tools`（免授予）／其余 → `t1.executor-high-risk`（需授予）」分流。
 * 若这个判定采信 AI 输出（旧实现如此），AI 把写文件标成只读即可免授予执行——分级语义被一条字段绕过。
 * 本文件把「只读只认工具元数据、且 fail-closed」锁成机械守卫。
 *
 * 覆盖：显式 readOnly=true 放行 / 显式 false 拒 / **未声明一律按非只读** / 工具不在可用集合拒 /
 * 空工具名拒 / 注册表热更新后判定随之变化。
 */
import { describe, it, expect } from 'vitest'
import type { AnyTool } from '../electron/main/tools/base-tool'
import { resolveToolReadOnly, createToolReadOnlyResolver } from '../electron/main/room/tool-risk'

function makeTool(name: string, readOnly?: boolean): AnyTool {
  return {
    name,
    description: 'x',
    parameters: [],
    ...(readOnly === undefined ? {} : { behavior: { readOnly } }),
    execute: () => ({ ok: true })
  }
}

describe('resolveToolReadOnly：只读只认工具元数据', () => {
  it('显式 behavior.readOnly=true → 只读', () => {
    expect(resolveToolReadOnly(makeTool('read_file', true), 'read_file')).toBe(true)
  })

  it('显式 behavior.readOnly=false → 非只读', () => {
    expect(resolveToolReadOnly(makeTool('Write', false), 'Write')).toBe(false)
  })

  it('**未声明 behavior → 非只读（fail-closed）**', () => {
    expect(resolveToolReadOnly(makeTool('mystery'), 'mystery')).toBe(false)
  })

  it('工具不在可用集合（undefined）→ 非只读（fail-closed）', () => {
    expect(resolveToolReadOnly(undefined, 'ghost')).toBe(false)
  })
})

describe('createToolReadOnlyResolver：惰性读当前可用集合', () => {
  it('命中已声明只读的工具 → true；未登记 → false', () => {
    const tools = new Map<string, AnyTool>([['read_file', makeTool('read_file', true)]])
    const isReadOnly = createToolReadOnlyResolver(() => tools)
    expect(isReadOnly('read_file')).toBe(true)
    expect(isReadOnly('unknown_tool')).toBe(false)
    expect(isReadOnly('')).toBe(false)
  })

  it('工具策略热更新后判定随之变化（每次调用重读集合，不缓存）', () => {
    let tools = new Map<string, AnyTool>()
    const isReadOnly = createToolReadOnlyResolver(() => tools)
    expect(isReadOnly('read_file')).toBe(false)
    tools = new Map<string, AnyTool>([['read_file', makeTool('read_file', true)]])
    expect(isReadOnly('read_file')).toBe(true)
    tools = new Map<string, AnyTool>()
    expect(isReadOnly('read_file')).toBe(false)
  })
})
