/**
 * 创建自定义 AI 工具：为什么存在——系统 AI（月蚀）需要在对话内为用户创建新的 custom AI
 * （独立名字/prompt/性格），满足"再造一个助手"的需求。
 * 作用：create_ai 校验名称/描述/prompt 约束后，经 AiManager 注册新 AI 并持久化。
 */
import { join } from 'path'
import type { AnyTool, ToolContext, ToolResult } from './base-tool'
import { AiManager } from '../services/ai-manager'
import { ensureUserScopeSkeleton } from '../services/user-scope-skeleton'
import { readAiRegistry, findAiById } from '../models/ai-registry'

/**
 * create_ai 工具：系统 AI（月蚀）在对话内创建新的 custom AI
 *
 * 多 AI 子系统 P4：AI 自建 AI。
 * - 复用 AiManager.register 的全部校验（名字规则/简介/提示词长度/llm/toolPolicy/重名幂等/数量上限 20）
 * - parentAiId：自动溯源为"当前会话所属 AI 编号"（ctx.getSessionAiId），不信任 AI 自报
 * - 防递归：仅 kind='system' 的 AI（月蚀/莉莉丝）可创建；custom AI 不可再创建（阻止无限繁殖）
 * - 提示词继承：入参 systemPrompt 缺省时继承父 AI 提示词副本；父副本为空回退内置模板
 * （与 sys_prompt 注入的"副本非空用副本，空/缺回退内置"语义一致）
 * - 权限：首次调用弹框确认（risk=medium），用户拒绝则中止
 *
 * 前端可见性：创建成功后注册表已更新，前端 loadAis() 下次拉取自然可见，无需额外 IPC。
 */
export class CreateAiTool {
  name = 'create_ai'
  description = `创建新的自定义 AI（分身），创建后可作独立角色参与对话。name=新 AI 名字（必填，1-16 字符，中文/英文/数字/部分符号 · - . _）；description=简介（可选，≤200 字）；systemPrompt=专属提示词（可选，缺省继承当前 AI 提示词）；avatar=头像（emoji 或资源 key，可选，≤16 字符）。

约束：只有系统 AI（月蚀）可创建（自定义 AI 不能再建，防递归繁殖）；总数上限 20（含停用），同名自动复用不重复创建。

触发时机：用户明确要求"创建新 AI/分身/助手"时调用，未收到明确要求时不调用。`
  parameters = [
    {
      name: 'name',
      type: 'string' as const,
      description: '新 AI 的名字（1-16 字符，中文/英文/数字/部分符号）',
      required: true
    },
    {
      name: 'description',
      type: 'string' as const,
      description: '新 AI 的简介（≤200 字符，可空）',
      required: false
    },
    {
      name: 'systemPrompt',
      type: 'string' as const,
      description: '新 AI 的系统提示词（≤50000 字符，可空；缺省继承当前 AI 的提示词）',
      required: false
    },
    {
      name: 'avatar',
      type: 'string' as const,
      description: '头像标识（emoji 或资源 key，≤16 字符，可空）',
      required: false
    }
  ]

  async execute(params: Record<string, unknown>, ctx?: ToolContext): Promise<ToolResult> {
    const name = typeof params.name === 'string' ? params.name.trim() : ''
    if (!name) {
      return { ok: false, error: 'name 参数必填（字符串）' }
    }
    const description = typeof params.description === 'string' ? params.description.trim() : undefined
    const systemPrompt = typeof params.systemPrompt === 'string' ? params.systemPrompt.trim() : undefined
    const avatar = typeof params.avatar === 'string' ? params.avatar.trim() : undefined

    // 轻量预校验（与 AiManager.register 同一套规则，权限弹窗前拦截非法输入——避免打扰用户）；
    // register 仍为最终权威（兜底校验，双保险）
    const nameErr = validateCreateName(name)
    if (nameErr) return { ok: false, error: nameErr }
    if (description !== undefined && description.length > MAX_DESC_LEN) {
      return { ok: false, error: `简介过长（≤${MAX_DESC_LEN} 字符）` }
    }
    if (systemPrompt !== undefined && systemPrompt.length > MAX_PROMPT_LEN) {
      return { ok: false, error: `提示词过长（≤${MAX_PROMPT_LEN} 字符）` }
    }
    if (avatar !== undefined && avatar.length > MAX_AVATAR_LEN) {
      return { ok: false, error: `avatar 过长（≤${MAX_AVATAR_LEN} 字符）` }
    }

    // 数据路径：注册表 + 提示词副本根（serverCtx.paths 动态 getter 始终含这两项）
    const paths = ctx?.paths
    if (!paths?.aiRegistryJson || !paths.frontend) {
      return { ok: false, error: '无法访问 AI 注册表路径（paths 未注入）' }
    }
    const manager = new AiManager({
      registryPath: paths.aiRegistryJson,
      aiPromptsRoot: join(paths.frontend, 'ai-prompts')
    })

    // parentAiId 溯源：不信任 AI 自报，统一取"当前会话所属 AI"（回退 1 = 月蚀）
    const parentAiId = ctx?.getSessionAiId?.(ctx.sessionId ?? undefined) ?? 1

    // 防递归守卫：仅系统 AI 可创建；custom AI 调用即拒绝（阻止 AI 繁殖 AI 无上限）
    const registry = readAiRegistry(paths.aiRegistryJson)
    const parent = findAiById(registry, parentAiId)
    if (!parent) {
      return { ok: false, error: `创建者 AI（id=${parentAiId}）不存在，无法创建新 AI` }
    }
    if (parent.kind !== 'system') {
      return {
        ok: false,
        error: `自定义 AI（${parent.name}）不能再创建新 AI（防递归）。请切换回月蚀会话后发起创建。`
      }
    }

    // 提示词继承：入参缺省 → 继承父 AI 提示词副本（副本空/缺 = 不传，运行时回退内置模板）
    let effectivePrompt = systemPrompt
    if (effectivePrompt === undefined) {
      const parentPrompt = manager.readPrompt(parentAiId)
      if (parentPrompt) effectivePrompt = parentPrompt
    }

    // 权限确认（risk=medium：创建新实体，影响持久化注册表）
    if (ctx?.requestPermission) {
      const perm = await ctx.requestPermission({
        type: 'setting',
        description: `AI 请求创建新 AI"${name}"${parentAiId !== 1 ? `（由 ${parent.name} 创建）` : ''}`,
        content: [
          `名字：${name}`,
          description ? `简介：${description}` : '简介：（无）',
          effectivePrompt ? `提示词：${effectivePrompt.slice(0, 60)}${effectivePrompt.length > 60 ? '…' : ''}` : '提示词：继承内置模板',
          avatar ? `头像：${avatar}` : '头像：（默认）'
        ].join('\n'),
        risk: 'medium'
      })
      if (!perm.allowed) {
        return { ok: false, error: `用户拒绝了创建请求：${perm.reason ?? '无原因'}` }
      }
    }

    // 创建（AiManager.register 内置：名字/简介/提示词校验、重名幂等、上限 20、parentAiId 溯源）
    const result = manager.register({
      name,
      description,
      avatar,
      systemPrompt: effectivePrompt,
      parentAiId
    })
    if (!result.ok) {
      return { ok: false, error: result.error }
    }

    const record = result.record
    const recordSummary = {
      id: record.id,
      name: record.name,
      agent: record.agent,
      kind: record.kind,
      parentAiId: record.parentAiId
    }
    if (result.existing) {
      return {
        ok: true,
        data: {
          message: `已存在同名 AI"${record.name}"（id=${record.id}），未重复创建，可直接使用`,
          record: recordSummary
        }
      }
    }

    // 新建 → 补建该用户的作用域目录骨架（与 ai:register / 登录骨架同一入口）。
    // 为什么需要：骨架遍历发生在登录/注册时，运行期 AI 自建 AI 后新 AI 的作用域
    // （skills/config/skills_domains/memory/sessions 等）尚不存在，用户立即切换使用会
    // 撞目录缺失；ensureUserScopeSkeleton 按注册表全量补齐、幂等，已存在目录跳过。
    if (paths && ctx?.user?.UID != null) {
      try {
        ensureUserScopeSkeleton(paths as import('../models/paths').BaseDataPaths, ctx.user.UID)
      } catch (err) {
        console.error(`[create_ai] 为新 AI 补建作用域骨架失败 (uid=${ctx.user.UID}, aiId=${record.id}):`, err)
      }
    }

    return {
      ok: true,
      data: {
        message: `新 AI"${record.name}"已创建（id=${record.id}），可在新建会话中切换使用`,
        record: recordSummary
      }
    }
  }
}

// ===== 预校验（与 ai-manager 的 validateName 同规则，权限弹窗前拦截） =====

const MIN_NAME_LEN = 1
const MAX_NAME_LEN = 16
const NAME_PATTERN = /^[\u4e00-\u9fa5A-Za-z0-9·\-._\s]+$/
const MAX_DESC_LEN = 200
const MAX_PROMPT_LEN = 50_000
const MAX_AVATAR_LEN = 16

function validateCreateName(name: string): string | null {
  const trimmed = String(name ?? '').trim()
  if (trimmed.length < MIN_NAME_LEN || trimmed.length > MAX_NAME_LEN) {
    return `名字长度需在 ${MIN_NAME_LEN}-${MAX_NAME_LEN} 字符之间`
  }
  if (!NAME_PATTERN.test(trimmed)) {
    return '名字仅支持中文/英文/数字/部分符号（· - . _）'
  }
  return null
}

export type { AnyTool, ToolContext, ToolResult }