/**
 * 修改 AI 显示名工具：为什么存在——AI 需要能自主更新自己的名字（同步界面角色标签、
 * 输入占位与 persona），而非只能被动接收设置。
 * 作用：update_ai_name 校验名称合法性后更新显示名并同步到界面与配置文件。
 */
import type { AnyTool, ToolContext, ToolResult } from './base-tool'

/**
 * update_ai_name 工具：让 AI 更新自己的显示名
 *
 * 修改立即生效，同步到界面角色标签、输入框占位符、persona 占位符 {aiName}。
 * 用户可随时在设置页手动修改覆盖。
 *
 * 防覆盖：若用户在设置页手动编辑过 aiName（aiNameManualEdited=true），
 * AI 调用本工具会被拒绝，需用户在设置页点"允许 AI 修改"重置标记。
 *
 * 权限：首次调用弹框确认（risk=low），该会话内不再问。
 */
const MIN_NAME_LEN = 1
const MAX_NAME_LEN = 16
// 不允许特殊符号（只允许中文/英文/数字/部分标点）
const NAME_PATTERN = /^[\u4e00-\u9fa5A-Za-z0-9·\-._\s]+$/

export class UpdateAiNameTool {
  name = 'update_ai_name'
  description = `更新你自己的显示名字（aiName）。修改立即生效，会同步到界面角色标签、输入框占位符、persona 占位符 {aiName}。用户可随时在设置页手动修改覆盖。

参数说明：
- aiName：新名字，${MIN_NAME_LEN}-${MAX_NAME_LEN} 字符，仅支持中文/英文/数字/部分符号（· - . _）

触发时机：用户明确要求"你以后叫小月""给自己起个名字"等时调用，未收到明确要求时不调用。`
  parameters = [
    {
      name: 'aiName',
      type: 'string' as const,
      description: `新名字（${MIN_NAME_LEN}-${MAX_NAME_LEN} 字符）`,
      required: true
    }
  ]

  async execute(params: Record<string, unknown>, ctx?: ToolContext): Promise<ToolResult> {
    const aiName = params.aiName as string | undefined
    if (!aiName || typeof aiName !== 'string') {
      return { ok: false, error: 'aiName 参数必填（字符串）' }
    }
    const trimmed = aiName.trim()
    if (trimmed.length < MIN_NAME_LEN || trimmed.length > MAX_NAME_LEN) {
      return { ok: false, error: `名字长度需在 ${MIN_NAME_LEN}-${MAX_NAME_LEN} 字符之间（当前 ${trimmed.length}）` }
    }
    if (!NAME_PATTERN.test(trimmed)) {
      return { ok: false, error: '名字仅支持中文/英文/数字/部分符号（· - . _）' }
    }

    // 读取当前 config
    const config = ctx?.config as Record<string, unknown> | undefined
    if (!config) {
      return { ok: false, error: '无法访问应用配置' }
    }

    // 防覆盖：用户手动编辑过则拒绝
    if (config.aiNameManualEdited === true) {
      return {
        ok: false,
        error: '用户已手动编辑 AI 名字，AI 不可覆盖。请让用户在设置页点"允许 AI 修改"后重试。'
      }
    }

    // 权限确认
    if (ctx?.requestPermission) {
      const perm = await ctx.requestPermission({
        type: 'command',
        description: `AI 请求把自己的名字改为"${trimmed}"`,
        content: trimmed,
        risk: 'low'
      })
      if (!perm.allowed) {
        return { ok: false, error: `用户拒绝了改名请求：${perm.reason ?? '无原因'}` }
      }
    }

    // 写入 config 并持久化
    if (!ctx?.updateConfig) {
      return { ok: false, error: '无法保存配置（updateConfig 未注入）' }
    }
    ctx.updateConfig((cfg) => ({
      ...cfg,
      aiName: trimmed,
      // AI 写入后重置手动编辑标记，下次 AI 可继续修改
      aiNameManualEdited: false
    }))

    return {
      ok: true,
      data: {
        message: `名字已更新为"${trimmed}"，立即生效`,
        aiName: trimmed
      }
    }
  }
}

export type { AnyTool, ToolContext, ToolResult }
