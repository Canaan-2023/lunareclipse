/**
 * 技能调用前缀协议单测：
 *  - InputArea 生成（buildSkillInvocationPrefix）与 MessageBubble 解析（parseSkillInvocation）共用同一协议；
 *  回归场景：多技能必须一条前缀内全部解析出来，领域调用展开为真实技能名。
 */
import { describe, it, expect } from 'vitest'
import { buildSkillInvocationPrefix, parseSkillInvocation } from '../src/utils/skillInvocation'

describe('buildSkillInvocationPrefix', () => {
  it('多技能合并为一条连续前缀（连续「」序列）', () => {
    expect(buildSkillInvocationPrefix(['skill-a', 'skill-b', 'skill-c'])).toBe(
      '请使用技能「skill-a」「skill-b」「skill-c」完成下面的任务：\n\n'
    )
  })

  it('单技能保持原历史格式兼容', () => {
    expect(buildSkillInvocationPrefix(['skill-a'])).toBe('请使用技能「skill-a」完成下面的任务：\n\n')
  })

  it('空列表返回空前缀（不注入）', () => {
    expect(buildSkillInvocationPrefix([])).toBe('')
  })

  it('重复技能名去重，不生成重复「」', () => {
    expect(buildSkillInvocationPrefix(['skill-a', 'skill-a', 'skill-b'])).toBe(
      '请使用技能「skill-a」「skill-b」完成下面的任务：\n\n'
    )
  })

  it('领域调用展开为真实技能名（不再合成「领域（a、b）」假名）', () => {
    expect(buildSkillInvocationPrefix(['a', 'b', 'c'])).toBe('请使用技能「a」「b」「c」完成下面的任务：\n\n')
  })
})

describe('parseSkillInvocation', () => {
  it('解析一条连续前缀中的全部技能名（回归：多技能此前只命中第一个）', () => {
    const r = parseSkillInvocation('请使用技能「skill-a」「skill-b」「skill-c」完成下面的任务：\n\n帮我做这些')
    expect(r).not.toBeNull()
    expect(r!.skillLabels).toEqual(['skill-a', 'skill-b', 'skill-c'])
    expect(r!.body).toBe('帮我做这些')
  })

  it('兼容历史单技能格式', () => {
    const r = parseSkillInvocation('请使用技能「skill-a」完成下面的任务：\n\n正文内容')
    expect(r!.skillLabels).toEqual(['skill-a'])
    expect(r!.body).toBe('正文内容')
  })

  it('无技能前缀的消息返回 null（普通消息不进 chip 渲染）', () => {
    expect(parseSkillInvocation('普通消息，不含前缀')).toBeNull()
    expect(parseSkillInvocation('')).toBeNull()
  })

  it('前缀后无换行的畸形文本返回 null（协议要求 \n 分隔，InputArea 固定生成 \n\n）', () => {
    expect(parseSkillInvocation('请使用技能「skill-a」完成下面的任务：')).toBeNull()
    expect(parseSkillInvocation('请使用技能「skill-a」完成下面的任务：没换行正文')).toBeNull()
  })

  it('build 与 parse 往返一致：生成的前缀能被完整解析回全部技能名', () => {
    const names = ['x', 'y', 'z']
    const prefix = buildSkillInvocationPrefix(names)
    const r = parseSkillInvocation(prefix + '任务正文')
    expect(r!.skillLabels).toEqual(names)
    expect(r!.body).toBe('任务正文')
  })
})