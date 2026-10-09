import { describe, it, expect } from 'vitest'
import { buildSelfAwarenessSection } from '../electron/main/kernel/introspection'

/**
 * 验证记录：系统提示词（自我认知段）已含新机制说明
 * kernel 段 = 系统认知（模块/记忆工作流/记忆构造/功能/改造自己），无数量统计；
 * ABYSS 体系（USER.md/AI.md）不再注入 kernel（移到 prompt 最后按 user_md/ai_md 段注入）。
 */
describe('系统提示词（introspection SELF_AWARENESS_RULES）已含新机制', () => {
  it('buildSelfAwarenessSection 输出含系统认知/正规通道/修改边界', () => {
    const s = buildSelfAwarenessSection('/data')
    expect(s).toContain('正规通道')
    expect(s).toContain('config_patch')
    expect(s).toContain('修改边界')
    expect(s).toContain('kernel_inspect')
    expect(s).toContain('记忆工作流')
    expect(s).toContain('skill_manage')
  })

  it('不含注册数量统计与 ABYSS 用户资料/自我认知内容', () => {
    const s = buildSelfAwarenessSection('/data')
    expect(s).not.toContain('当前注册统计')
    expect(s).not.toContain('USER.md')
    expect(s).not.toContain('AI.md')
  })
})