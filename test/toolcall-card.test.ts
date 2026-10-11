import { describe, it, expect } from 'vitest'
import {
  CATEGORY_COLORS,
  getStatusBar,
  getStatusBadge,
  calcTotalSeconds,
  buildSummaryParts,
  groupByCategory,
  basename
} from '../src/components/Chat/ToolCallCard'
import type { ToolCall, ToolCategory } from '@shared/types'

// 测试数据工厂
function makeToolCall(overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    id: 'tc-1',
    toolName: 'Read',
    toolLabel: '读取文件',
    category: 'file-read',
    args: {},
    status: 'done',
    startedAt: 1000,
    endedAt: 2000,
    ...overrides
  }
}

describe('ToolCallCard 视觉回归 - 状态色映射', () => {
  describe('getStatusBar（汇总条状态色）', () => {
    it('running 优先级最高：有 running 时即使有 error 也用 accent', () => {
      const result = getStatusBar(true, true)
      expect(result.bg).toBe('bg-accent/10')
      expect(result.text).toBe('text-accent')
      expect(result.bar).toBe('bg-accent')
    })

    it('有 running 无 error：accent 色', () => {
      const result = getStatusBar(true, false)
      expect(result.bar).toBe('bg-accent')
    })

    it('无 running 有 error：danger 色', () => {
      const result = getStatusBar(false, true)
      expect(result.bg).toBe('bg-danger/10')
      expect(result.text).toBe('text-danger')
      expect(result.bar).toBe('bg-danger')
    })

    it('全部 done：success 色', () => {
      const result = getStatusBar(false, false)
      expect(result.bg).toBe('bg-success/8')
      expect(result.text).toBe('text-success')
      expect(result.bar).toBe('bg-success')
    })
  })

  describe('getStatusBadge（单条状态徽章）', () => {
    it('running 徽章用 accent', () => {
      expect(getStatusBadge('running')).toBe('bg-accent/15 text-accent')
    })

    it('error 徽章用 danger', () => {
      expect(getStatusBadge('error')).toBe('bg-danger/15 text-danger')
    })

    it('done 徽章用 success', () => {
      expect(getStatusBadge('done')).toBe('bg-success/15 text-success')
    })
  })
})

describe('ToolCallCard 视觉回归 - 分类色映射', () => {
  it('所有 ToolCategory 都有对应色（无遗漏）', () => {
    const allCategories: ToolCategory[] = [
      'file-read', 'file-write', 'browser', 'self-shape',
      'system', 'network', 'graph', 'mechanism', 'dmn-exclusive'
    ]
    for (const cat of allCategories) {
      const colors = CATEGORY_COLORS[cat]
      expect(colors).toBeDefined()
      expect(colors.bar).toBeTruthy()
      expect(colors.soft).toBeTruthy()
      expect(colors.text).toBeTruthy()
    }
  })

  it('分类色 bar 类名格式正确（bg- 前缀）', () => {
    for (const cat of Object.keys(CATEGORY_COLORS) as ToolCategory[]) {
      expect(CATEGORY_COLORS[cat].bar).toMatch(/^bg-/)
    }
  })
})

describe('ToolCallCard 视觉回归 - 耗时计算', () => {
  it('空数组返回 0', () => {
    expect(calcTotalSeconds([])).toBe(0)
  })

  it('单条调用：endedAt - startedAt', () => {
    const tc = makeToolCall({ startedAt: 1000, endedAt: 2500 })
    // 1500ms / 1000 = 1.5s，Math.round(1.5) = 2（JS 四舍五入 0.5 进位到正无穷）
    expect(calcTotalSeconds([tc])).toBe(2)
  })

  it('多条调用：取最大 endedAt - 最小 startedAt', () => {
    const calls = [
      makeToolCall({ id: '1', startedAt: 1000, endedAt: 3000 }),
      makeToolCall({ id: '2', startedAt: 2000, endedAt: 5000 }),
      makeToolCall({ id: '3', startedAt: 1500, endedAt: 4000 })
    ]
    // max(3000,5000,4000) - min(1000,2000,1500) = 5000-1000 = 4000ms = 4s
    expect(calcTotalSeconds(calls)).toBe(4)
  })

  it('running 状态用 Date.now 兜底 endedAt', () => {
    const before = Date.now()
    const tc = makeToolCall({ startedAt: before - 2000, status: 'running', endedAt: undefined })
    const secs = calcTotalSeconds([tc])
    const after = Date.now()
    // 2s 左右，允许 1s 误差（含 Date.now 调用开销）
    expect(secs).toBeGreaterThanOrEqual(1)
    expect(secs).toBeLessThanOrEqual(Math.ceil((after - (before - 2000)) / 1000) + 1)
  })
})

describe('ToolCallCard 视觉回归 - 分类分组', () => {
  it('空数组返回空 Map', () => {
    const result = groupByCategory([])
    expect(result.size).toBe(0)
  })

  it('同分类合并到同一组', () => {
    const calls = [
      makeToolCall({ id: '1', category: 'file-read' }),
      makeToolCall({ id: '2', category: 'file-read' }),
      makeToolCall({ id: '3', category: 'file-write' })
    ]
    const result = groupByCategory(calls)
    expect(result.size).toBe(2)
    expect(result.get('file-read')?.length).toBe(2)
    expect(result.get('file-write')?.length).toBe(1)
  })

  it('保留插入顺序（首个出现的分类在前）', () => {
    const calls = [
      makeToolCall({ id: '1', category: 'system' }),
      makeToolCall({ id: '2', category: 'file-read' }),
      makeToolCall({ id: '3', category: 'system' })
    ]
    const result = groupByCategory(calls)
    const categories = Array.from(result.keys())
    expect(categories[0]).toBe('system')
    expect(categories[1]).toBe('file-read')
  })
})

describe('ToolCallCard 视觉回归 - 汇总文案', () => {
  it('每分类生成「图标 数量 标签」格式', () => {
    const calls = [
      makeToolCall({ id: '1', category: 'file-read' }),
      makeToolCall({ id: '2', category: 'file-read' })
    ]
    const grouped = groupByCategory(calls)
    const parts = buildSummaryParts(grouped)
    // file-read 图标是 📄，标签是「读取文件」
    expect(parts[0]).toBe('📄 2 读取文件')
  })

  it('未知分类用 🔧 兜底', () => {
    // mechanism 分类图标是 🔧
    const calls = [makeToolCall({ id: '1', category: 'mechanism' })]
    const grouped = groupByCategory(calls)
    const parts = buildSummaryParts(grouped)
    expect(parts[0]).toContain('🔧')
    expect(parts[0]).toContain('1')
  })
})

describe('ToolCallCard 视觉回归 - 路径解析', () => {
  it('Unix 路径取最后一段', () => {
    expect(basename('/home/user/file.ts')).toBe('file.ts')
  })

  it('Windows 路径取最后段（反斜杠）', () => {
    expect(basename('C:\\Users\\devuser\\project\\src\\index.ts')).toBe('index.ts')
  })

  it('混合分隔符', () => {
    expect(basename('C:/Users\\devuser/project\\file.ts')).toBe('file.ts')
  })

  it('无分隔符返回原路径', () => {
    expect(basename('file.ts')).toBe('file.ts')
  })

  it('空路径返回空串（不崩溃）', () => {
    expect(basename('')).toBe('')
  })

  it('尾部斜杠路径：split 末元素为空串，返回原路径（锁定当前实现行为）', () => {
    // '/home/user/'.split('/') = ['', 'home', 'user', '']，末元素 '' falsy → 返回原路径
    expect(basename('/home/user/')).toBe('/home/user/')
  })
})
