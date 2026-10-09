/**
 * ui_snapshot 工具描述回归锁定
 *
 * 为什么存在：2026-09-28 评审发现 description 曾写"action=shot：截图保存 PNG 返回路径
 * （用视觉工具看图）"——但 read.ts 明确"月蚀当前无视觉、Read 读不了图片"，AI 拿到
 * imagePath 后无通道把本地 PNG 注入上下文，照描述会误以为能看图，属"AI 拿到后无法据此
 * 发挥明确作用"的误导描述（用户产出纪律要求：写出来的内容必须让使用者知道能发挥什么作用，
 * 做不到即垃圾写法须重写）。
 * 作用：锁定修复后的描述——structure 是 AI 感知界面的首选文本通道；shot 仅供用户 MEDIA
 * 预览/存档，明确 AI 读不了图；verify 是无需视觉的自动校验通道。
 * 不删理由：该断言是"工具描述与真实能力一致"的回归防线，防止未来再次写回误导性描述；
 * 描述文本是 AI 决策依据，失真会直接造成工具误用。
 */
import { describe, it, expect } from 'vitest'
import { ALL_TOOL_CTORS, toAnyTool } from '../electron/main/tools/tool-ctors'

function uiSnapshotDesc(): string {
  const row = ALL_TOOL_CTORS.find((r) => r.id === 'ui_snapshot')
  if (!row) throw new Error('ui_snapshot 未注册')
  const t = toAnyTool(row.ctor)
  return t.description
}

describe('ui_snapshot 工具描述与真实能力一致', () => {
  it('注册存在且描述完整（用途+各 action 作用+窗口可见约束）', () => {
    const d = uiSnapshotDesc()
    expect(d).toContain('截取月蚀自身窗口快照')
    expect(d).toContain('action=structure')
    expect(d).toContain('action=shot')
    expect(d).toContain('action=baseline')
    expect(d).toContain('action=verify')
    expect(d).toContain('窗口必须可见')
  })

  it('不误导 AI 能直接看图：shot 明确为存档/用户预览，structure 才是 AI 文本通道', () => {
    const d = uiSnapshotDesc()
    // 修复前描述写"用视觉工具看图"，与 read.ts「无视觉、Read 读不了图片」矛盾
    expect(d).not.toContain('用视觉工具看图')
    expect(d).toContain('纯文本可读，AI 感知界面内容的首选通道')
    expect(d).toContain('AI 无视觉、Read 读不了图片内容')
    expect(d).toContain('无需视觉')
  })

  it('所有 action 描述都落在"能发挥什么作用"上（用户产出纪律）', () => {
    const d = uiSnapshotDesc()
    // verify 必须说明它是自动校验（无需视觉），否则 AI 不知道何时用它
    expect(d).toContain('自动校验没改坏')
    // 每个 action 都要有明确产出：structure=结构清单 / shot=PNG 路径 / baseline=基线 / verify=差异比例
    expect(d).toContain('结构清单')
    expect(d).toContain('PNG 返回路径')
    expect(d).toContain('基线')
    expect(d).toContain('差异比例')
  })
})