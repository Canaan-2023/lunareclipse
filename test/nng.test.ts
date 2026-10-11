import { describe, it, expect } from 'vitest'
import {
  getNngPrefix,
  calcNngLevel,
  buildNngFileName,
  buildNngPath,
  buildNngSiblingFolder,
  getNngNameFromPath,
  findParentNngPath,
  buildNngObject,
  MAX_NNG_DESC_LENGTH
} from '../electron/main/models/nng'
import { CreateNngTool } from '../electron/main/tools/create-nng'
import type { ToolContext } from '../electron/main/tools/base-tool'

// 2026-08-15 重构：层级基准 = 一级节点目录（NNG/AI{aiId}/U{uid}/root）
// 2026-09-09 重构：文件名去掉层级号前缀，只留类型前缀 + 语义名
const LEVEL1_DIR = 'C:/data/abyssac_data/NNG/AI1/U1/root'

describe('getNngPrefix', () => {
  it('standard 类型无前缀', () => {
    expect(getNngPrefix('standard')).toBe('')
  })
  it('meta 类型前缀 meta_', () => {
    expect(getNngPrefix('meta')).toBe('meta_')
  })
  it('high 类型前缀 high_', () => {
    expect(getNngPrefix('high')).toBe('high_')
  })
})

describe('calcNngLevel', () => {
  it('一级节点目录本身返回 1', () => {
    expect(calcNngLevel(LEVEL1_DIR, LEVEL1_DIR)).toBe(1)
  })

  it('一级子文件夹返回 2', () => {
    expect(calcNngLevel(`${LEVEL1_DIR}/auth`, LEVEL1_DIR)).toBe(2)
  })

  it('二级子文件夹返回 3', () => {
    expect(calcNngLevel(`${LEVEL1_DIR}/auth/login`, LEVEL1_DIR)).toBe(3)
  })

  it('路径在一级目录外返回 1', () => {
    expect(calcNngLevel('C:/other/path', LEVEL1_DIR)).toBe(1)
  })

  it('Windows 反斜杠路径正常处理', () => {
    expect(calcNngLevel('C:\\data\\abyssac_data\\NNG\\AI1\\U1\\root\\auth', LEVEL1_DIR)).toBe(2)
  })

  it('尾部斜杠不影响结果', () => {
    expect(calcNngLevel(`${LEVEL1_DIR}/auth/`, LEVEL1_DIR)).toBe(2)
  })
})

describe('buildNngFileName', () => {
  it('standard 类型：{name}_nng.json（不带层级号前缀）', () => {
    expect(buildNngFileName(2, 'standard', 'login')).toBe('login_nng.json')
  })
  it('meta 类型：meta_{name}_nng.json', () => {
    expect(buildNngFileName(1, 'meta', 'overview')).toBe('meta_overview_nng.json')
  })
  it('high 类型：high_{name}_nng.json', () => {
    expect(buildNngFileName(3, 'high', 'critical')).toBe('high_critical_nng.json')
  })
  it('非法字符替换为下划线', () => {
    expect(buildNngFileName(1, 'standard', 'a/b:c')).toBe('a_b_c_nng.json')
  })
})

describe('buildNngPath', () => {
  it('拼接目标文件夹和文件名，统一用正斜杠', () => {
    const p = buildNngPath(`${LEVEL1_DIR}/auth`, 2, 'standard', 'login')
    expect(p).toBe(`${LEVEL1_DIR}/auth/login_nng.json`)
  })
})

describe('buildNngSiblingFolder', () => {
  it('生成同名文件夹路径（去掉 _nng.json 后缀）', () => {
    const p = buildNngSiblingFolder(`${LEVEL1_DIR}/auth`, 2, 'standard', 'login')
    expect(p).toBe(`${LEVEL1_DIR}/auth/login`)
  })
})

describe('getNngNameFromPath', () => {
  it('从路径提取 NNG 名称（去掉 _nng.json）', () => {
    expect(getNngNameFromPath(`${LEVEL1_DIR}/auth/login_nng.json`)).toBe('login')
  })
  it('meta 类型保留前缀', () => {
    expect(getNngNameFromPath(`${LEVEL1_DIR}/meta_overview_nng.json`)).toBe('meta_overview')
  })
})

describe('findParentNngPath', () => {
  it('一级节点目录下的一级 NNG 返回 null（父是 root.json 索引）', () => {
    expect(findParentNngPath(`${LEVEL1_DIR}/auth_nng.json`, LEVEL1_DIR)).toBeNull()
  })

  it('子文件夹中的 NNG 定位到父 NNG', () => {
    // NNG/AI1/U1/root/auth/login_nng.json → 父 = NNG/AI1/U1/root/auth_nng.json
    const child = `${LEVEL1_DIR}/auth/login_nng.json`
    const parent = findParentNngPath(child, LEVEL1_DIR)
    expect(parent).toBe(`${LEVEL1_DIR}/auth_nng.json`)
  })

  it('路径在一级目录外返回 null', () => {
    expect(findParentNngPath('C:/other/auth_nng.json', LEVEL1_DIR)).toBeNull()
  })

  it('多层嵌套正确定位直接父级', () => {
    // NNG/AI1/U1/root/auth/login/token_nng.json → 父 = NNG/AI1/U1/root/auth/login_nng.json
    const child = `${LEVEL1_DIR}/auth/login/token_nng.json`
    const parent = findParentNngPath(child, LEVEL1_DIR)
    expect(parent).toBe(`${LEVEL1_DIR}/auth/login_nng.json`)
  })
})

describe('MAX_NNG_DESC_LENGTH（设计依据：描述 >200 字即信息过载需拆子节点，硬上限防膨胀）', () => {
  it('上限为 200', () => {
    expect(MAX_NNG_DESC_LENGTH).toBe(200)
  })
})

describe('buildNngObject 路径规范化（回归：反斜杠输入 → 正斜杠）', () => {
  it('自身路径/关联记忆/上级NNG/下级NNG 全部规范化为正斜杠', () => {
    const nng = buildNngObject(
      {
        type: 'standard',
        name: '测试',
        目标文件夹: 'C:/data/root',
        描述: 'x',
        关联记忆: [{ 记忆路径: 'D:\\a\\b\\mem.json', 描述: 'm' }],
        上级NNG: ['D:\\a\\b\\parent_nng.json'],
        下级NNG: ['d:\\a\\b\\child_nng.json']
      },
      'D:\\data\\root\\测试_nng.json'
    )
    expect(nng.自身路径).toBe('D:/data/root/测试_nng.json')
    expect(nng.关联记忆[0].记忆路径).toBe('D:/a/b/mem.json')
    expect(nng.上级NNG).toEqual(['D:/a/b/parent_nng.json'])
    expect(nng.下级NNG).toEqual(['d:/a/b/child_nng.json'])
    // 整个对象不得残留反斜杠——反斜杠会破坏按字面量比较的去重/关联
    expect(JSON.stringify(nng)).not.toMatch(/\\/)
  })
})

describe('CreateNngTool 描述长度校验', () => {
  // 假 nngLevel1Dir：让「目标文件夹不在一级目录下」校验兜底失败，避免测试真实写盘
  const ctx = {
    paths: {
      nngRoot: 'C:/fake-root/NNG/AI1/U1',
      nngRootJson: 'C:/fake-root/NNG/AI1/U1/root.json',
      nngLevel1Dir: 'C:/fake-root/NNG/AI1/U1/root'
    }
  } as unknown as ToolContext

  it('描述恰好 200 字不触发超限拒绝（走到后续校验失败）', async () => {
    const tool = new CreateNngTool()
    const desc = '测'.repeat(200)
    const result = await tool.execute(
      {
        type: 'standard',
        name: 'limit_test',
        目标文件夹: 'C:/data/abyssac_data/NNG/AI1/U1/root',
        描述: desc,
        关联记忆: [{ 记忆路径: 'C:/data/abyssac_data/memory/normal/2026/08/12/1_test.json', 描述: 'test' }]
      },
      ctx
    )
    expect(result.ok).toBe(false)
    expect(result.error).toContain('目标文件夹')
    expect(result.error).not.toContain('超')
  })

  it('描述超过 200 字被拒绝', async () => {
    const tool = new CreateNngTool()
    const desc = '测'.repeat(201)
    const result = await tool.execute(
      {
        type: 'standard',
        name: 'limit_test',
        目标文件夹: 'C:/data/abyssac_data/NNG/AI1/U1/root',
        描述: desc,
        关联记忆: [{ 记忆路径: 'C:/data/abyssac_data/memory/normal/2026/08/12/1_test.json', 描述: 'test' }]
      },
      ctx
    )
    expect(result.ok).toBe(false)
    expect(result.error).toContain('200 字上限')
    expect(result.error).toContain('拆子节点')
  })
})
