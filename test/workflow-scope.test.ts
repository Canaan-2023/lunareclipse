/**
 * 工作流作用域解析（ADR-25 L6）契约测试。
 *
 * 为什么存在：`workflowCtx.paths` 此前在无显式作用域时**回落裸 BaseDataPaths**——
 * 它缺 `rawMemory` / `memoryNormal` / `userMd` 等 scoped 字段，工具读到 undefined 会
 * **静默写错位置**（L6）。现改为：显式作用域优先；无显式作用域时用**当前登录用户的默认作用域**
 * （uid + 月蚀）——用户从前端 / AI 工具直接触发的工作流从不 setWorkflowScope，这条路径必须可用；
 * 未登录（无用户可推导）→ 返回 null，调用方抛错（显式失败，不拿残缺路径集继续跑）。
 */
import { describe, it, expect } from 'vitest'
import { resolveWorkflowScope } from '../electron/main/bootstrap/assembly-kernel'
import { DEFAULT_AI_ID } from '../electron/main/models/path-context'

describe('resolveWorkflowScope（ADR-25 L6）', () => {
  it('显式作用域优先（记忆/日记调度器处理批次时设置）', () => {
    expect(resolveWorkflowScope({ uid: 7, aiId: 3 }, { UID: 1 })).toEqual({ uid: 7, aiId: 3 })
  })

  it('无显式作用域 → 用当前登录用户默认作用域（uid + 月蚀）', () => {
    expect(resolveWorkflowScope(null, { UID: 42 })).toEqual({ uid: 42, aiId: DEFAULT_AI_ID })
  })

  it('未登录（无用户可推导）→ null（调用方抛错，不再回落裸 BaseDataPaths）', () => {
    expect(resolveWorkflowScope(null, null)).toBeNull()
    expect(resolveWorkflowScope(null, undefined)).toBeNull()
  })
})
