/**
 * USER.md / AI.md 写入端：为什么存在——AI 需要把用户偏好与自我设定持久化为 MD 文件
 * （读取端见 prompts/abyss-md.ts），本模块是"AI 更新自己的记忆画像"的落地层。
 * 作用：提供 update_user_preference / update_abyss_md 工具，校验内容长度并写回文件。
 */
import { mkdirSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import type { AnyTool, ToolContext, ToolResult } from './base-tool'

const MAX_CONTENT_CHARS = 4000

export class UpdateAbyssMdTool {
  name = 'update_abyss_md'
  description = `更新你的自我认知——你对自己"我是谁"的理解（身份认同/思维方式/与用户的关系/成长轨迹等）。更新后下一轮对话起，这段内容会出现在你的提示词末尾，结构自由决定。

参数：content（必填，markdown 纯文本）。
约束：<= ${MAX_CONTENT_CHARS} 字符；{aiName}/{userName} 写原名即可，系统会自动替换；身份卡（你是哪个 AI/和谁说话）由系统生成，无需填写；只写自我认知（不写能力清单/踩坑记录/状态日志）；用户可直接编辑你的自我认知文件来覆盖。
重要：权限弹框被拒时，在回复中如实告知"自我认知更新未成功"及原因。`
  parameters = [
    {
      name: 'content',
      type: 'string' as const,
      description: `自我认知纯文本（markdown，<= ${MAX_CONTENT_CHARS} 字符）`,
      required: true
    }
  ]

  async execute(params: Record<string, unknown>, ctx?: ToolContext): Promise<ToolResult> {
    const content = params.content as string | undefined
    if (!content || typeof content !== 'string') {
      return { ok: false, error: 'content 参数必填（字符串）' }
    }
    if (content.length > MAX_CONTENT_CHARS) {
      return { ok: false, error: `content 超过字符上限 ${MAX_CONTENT_CHARS}（当前 ${content.length}）` }
    }

    const aiMd = ctx?.paths?.aiMd
    if (!aiMd) {
      return { ok: false, error: '无法定位 AI.md 文件路径（paths.aiMd 未注入）' }
    }

    if (ctx?.requestPermission) {
      const perm = await ctx.requestPermission({
        type: 'command',
        description: `AI 请求更新自我认知（${content.length} 字符）`,
        content: content.slice(0, 200) + (content.length > 200 ? '...' : ''),
        risk: 'low'
      })
      if (!perm.allowed) {
        return {
          ok: false,
          error: `【更新未成功】用户拒绝了权限弹框：${perm.reason ?? '无原因'}。请在回复中如实告知用户：自我认知更新未成功，因为权限请求被拒绝，并说明原因。`
        }
      }
    }

    mkdirSync(dirname(aiMd), { recursive: true })
    writeFileSync(aiMd, content, 'utf-8')

    return {
      ok: true,
      data: {
        message: '自我认知已写入 AI.md，下一轮对话生效',
        chars: content.length,
        path: aiMd
      }
    }
  }
}

/** 用户级个人资料卡文件（ABYSS/U{uid}/USER.md）：所有 AI 会话注入，个人中心/本工具读写。 */
export class UpdateUserPreferenceTool {
  name = 'update_user_preference'
  description = `更新当前用户的个人资料卡（会出现在提示词末尾，所有 AI 会话共享；个人中心可手动编辑）——称呼/性别/生日/职业/住址/联系方式/联系人/社交账号/性格/经历/沟通偏好等。

必填结构：content 保持「# 用户个人资料卡」标题 + 字段表（字段 | 内容），无信息字段填（未填写）：

| 字段 | 内容 |
| ---- | ---- |
| 姓名 | 用户希望被 AI 称呼的名字/昵称 |
| 性别 | 用户主动告知时记录，未告知留空 |
| 生日 | 出生日期（用户同意提供时记录，格式 YYYY-MM-DD 或农历说明） |
| 职业 | 工作/职业/身份（如前端工程师、学生） |
| 工作单位 | 公司/学校/机构名称（知道才填） |
| 性格 | 用户自我描述的性格特征 |
| 经历 | 对理解用户有意义的经历（教育/职业/生活节点） |
| 偏好 | 回答风格、语言、称呼、话题倾向、雷区（最影响每次对话质量，优先维护） |
| 住址 | 常住城市/区域即可，不必精确到门牌 |
| 联系方式 | 标注类型再填内容，多种用分号分隔，如：邮箱（xxx@example.com）；手机（+86 138...） |
| 联系人 | 关系 + 姓名 + 联系方式，如：家人（妈妈，手机 138...）；同事（老王，如流 id） |
| 社交账号 | 平台名（账号/主页），如：微信（xxx）；微博（xxx） |
| 时区 | 用户常驻时区（如 Asia/Shanghai），默认不填时按系统时区 |
| 备注 | 禁忌话题、使用习惯、长期约定等 |

填写规则：只记用户明确表达/认可的信息，不确定标「？（待确认）」不编造；联系方式/联系人必须标注类型；一字段一句话，重复并入对应字段；用户纠正即覆盖、删除的保持（未填写）不追问；每次只改实际变化字段行；维护优先级 偏好>备注>姓名/职业/性格>经历>性别/生日。
约束：<= ${MAX_CONTENT_CHARS} 字符；{aiName}/{userName} 写原名即可，系统会自动替换；这是用户资料非自我认知（后者用 update_abyss_md）；用户可在个人中心编辑覆盖。
重要：权限弹框被拒时，在回复中如实告知"个人偏好更新未成功"及原因。`
  parameters = [
    {
      name: 'content',
      type: 'string' as const,
      description: `个人偏好纯文本（markdown，<= ${MAX_CONTENT_CHARS} 字符）`,
      required: true
    }
  ]

  async execute(params: Record<string, unknown>, ctx?: ToolContext): Promise<ToolResult> {
    const content = params.content as string | undefined
    if (!content || typeof content !== 'string') {
      return { ok: false, error: 'content 参数必填（字符串）' }
    }
    if (content.length > MAX_CONTENT_CHARS) {
      return { ok: false, error: `content 超过字符上限 ${MAX_CONTENT_CHARS}（当前 ${content.length}）` }
    }

    const userMd = ctx?.paths?.userMd
    if (!userMd) {
      return { ok: false, error: '无法定位用户资料文件（paths.userMd 未注入；请在登录后使用）' }
    }

    if (ctx?.requestPermission) {
      const perm = await ctx.requestPermission({
        type: 'command',
        description: `AI 请求更新用户个人资料（${content.length} 字符）`,
        content: content.slice(0, 200) + (content.length > 200 ? '...' : ''),
        risk: 'low'
      })
      if (!perm.allowed) {
        return {
          ok: false,
          error: `【更新未成功】用户拒绝了权限弹框：${perm.reason ?? '无原因'}。请在回复中如实告知用户：个人资料更新未成功，因为权限请求被拒绝，并说明原因。`
        }
      }
    }

    mkdirSync(dirname(userMd), { recursive: true })
    writeFileSync(userMd, content, 'utf-8')

    return {
      ok: true,
      data: {
        message: '用户个人资料已写入 USER.md，下一轮对话对所有 AI 生效',
        chars: content.length,
        path: userMd
      }
    }
  }
}

export type { AnyTool, ToolContext, ToolResult }