/**
 * 工具注册表拆分后的不变量表征测试（ADR-06 协作交接建议）。
 *
 * 为什么存在：`shared/tools/registry.ts` 按 ADR-06 拆为 meta/catalog/dynamic/policies/labels
 * 五模块 + barrel。拆分本身靠 typecheck（`BuiltinToolId` 派生链）与既有工具测试兜底，但
 * 「目录与查找表一致」「动态注册合并查询与复位」这两条不变量此前没有直接断言——它们一旦破坏，
 * 表现为「工具列表少一项」或「MCP 工具不可用」这类静默故障。本文件把不变量固定下来。
 */
import { describe, it, expect, afterEach } from 'vitest'
import {
  TOOL_REGISTRY,
  TOOL_MAP,
  getAllToolMetas,
  clearDynamicToolMetas,
  registerMcpToolMetas,
  unregisterMcpServerTools,
  getFrontendTools,
  isToolEnabled
} from '@shared/tools/registry'

afterEach(() => {
  clearDynamicToolMetas()
})

describe('catalog ↔ TOOL_MAP 一致性', () => {
  it('TOOL_MAP 键集与 TOOL_REGISTRY 的 id 集逐字一致（无漏项、无多余项）', () => {
    const ids = TOOL_REGISTRY.map((t) => t.id)
    expect(Object.keys(TOOL_MAP).sort()).toEqual([...ids].sort())
    expect(new Set(ids).size).toBe(ids.length) // id 唯一
  })

  it('每条目录条目都有 id/name/category/agents（元数据形状不变量）', () => {
    for (const t of TOOL_REGISTRY) {
      expect(t.id.length).toBeGreaterThan(0)
      expect(t.name.length).toBeGreaterThan(0)
      expect(t.category.length).toBeGreaterThan(0)
      expect(Array.isArray(t.agents)).toBe(true)
      expect(t.agents.length).toBeGreaterThan(0)
    }
  })
})

describe('动态注册合并查询与复位（拆分后单例语义不变）', () => {
  it('无动态注册时 getAllToolMetas() 等于内置目录', () => {
    clearDynamicToolMetas()
    expect(getAllToolMetas()).toEqual([...TOOL_REGISTRY])
  })

  it('注册 MCP 工具 → 合并进查询面；注销该 server → 恢复内置目录', () => {
    clearDynamicToolMetas()
    registerMcpToolMetas([
      {
        id: 'mcp__probe__echo',
        name: 'echo',
        category: 'network',
        description: 'probe',
        defaultEnabled: false,
        riskLevel: 'low',
        agents: ['frontend'],
        source: 'mcp',
        mcpServer: 'probe'
      } as never
    ])
    const withMcp = getAllToolMetas()
    expect(withMcp.length).toBe(TOOL_REGISTRY.length + 1)
    expect(getFrontendTools().some((t) => t.id === 'mcp__probe__echo')).toBe(true)
    // 已注册的动态工具：查得到元数据 → 走元数据默认值（夹具 defaultEnabled=false → 未配置策略时关闭）
    expect(isToolEnabled('mcp__probe__echo', {})).toBe(false)
    // 未注册（查不到元数据）的 id → 走 MCP 回退语义：无策略配置时默认启用
    expect(isToolEnabled('mcp__unknown__not_registered', {})).toBe(true)

    unregisterMcpServerTools('probe')
    expect(getAllToolMetas()).toEqual([...TOOL_REGISTRY])
    expect(getFrontendTools().some((t) => t.id === 'mcp__probe__echo')).toBe(false)
  })
})

describe('barrel 导出面（拆分后消费方零改动的前提）', () => {
  it('关键符号可从宿主 barrel 取到', async () => {
    const barrel = await import('@shared/tools/registry')
    for (const sym of [
      'TOOL_REGISTRY',
      'TOOL_MAP',
      'registerMcpToolMetas',
      'clearDynamicToolMetas',
      'getAllToolMetas',
      'getFrontendTools',
      'getLilithTools',
      'getWorkflowTools',
      'isToolEnabled',
      'isToolForAgent',
      'buildLilithToolPolicy',
      'DEFAULT_LILITH_TOOL_POLICIES',
      'mergeLilithToolPolicy',
      'buildWorkflowToolPolicy',
      'DEFAULT_WORKFLOW_TOOL_POLICIES',
      'mergeWorkflowToolPolicies',
      'CATEGORY_LABELS',
      'CATEGORY_ICONS'
    ]) {
      expect(barrel, `barrel 缺符号 ${sym}`).toHaveProperty(sym)
    }
  })

  it('模块私有符号不外泄（findToolMeta / LILITH_EXCLUDED_TOOLS 不得从 barrel 导出）', async () => {
    const barrel = await import('@shared/tools/registry')
    expect(barrel).not.toHaveProperty('findToolMeta')
    expect(barrel).not.toHaveProperty('LILITH_EXCLUDED_TOOLS')
  })
})
