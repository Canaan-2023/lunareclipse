import { describe, it, expect } from 'vitest'
import { buildMemoryObject } from '../electron/main/models/memory'

describe('buildMemoryObject 路径规范化（回归：反斜杠输入 → 正斜杠）', () => {
  it('自身路径/RAW来源/关联文件 全部规范化为正斜杠', () => {
    const mem = buildMemoryObject(
      {
        type: 'normal',
        RAW来源: ['D:\\a\\b\\raw.md'],
        描述: 'x',
        备注: '',
        关联文件: ['D:\\a\\b\\f.txt']
      },
      'D:\\data\\normal\\2026\\09\\12\\1_x.json',
      '2026-09-12T02:00:00+08:00'
    )
    expect(mem.自身路径).toBe('D:/data/normal/2026/09/12/1_x.json')
    expect(mem.RAW来源).toEqual(['D:/a/b/raw.md'])
    expect(mem.关联文件).toEqual(['D:/a/b/f.txt'])
    // 整个对象不得残留反斜杠（memory-sync 的 expectedSelf 按字面量比较，格式不一致会回写抖动）
    expect(JSON.stringify(mem)).not.toMatch(/\\/)
  })

  it('RAW来源为字符串时同样规范化', () => {
    const mem = buildMemoryObject(
      { type: 'meta', RAW来源: 'D:\\a\\b\\raw.md', 描述: 'x', 备注: '' },
      'D:\\x.json',
      't'
    )
    expect(mem.自身路径).toBe('D:/x.json')
    expect(mem.RAW来源).toBe('D:/a/b/raw.md')
  })
})
