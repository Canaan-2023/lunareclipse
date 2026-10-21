/**
 * 账号检索工具组：为什么存在——AI 对话中需要按姓名/昵称定位用户 UID，并读取其 USER.md
 * 资料才能个性化交流；本模块把查找逻辑收敛为两个工具。
 * 作用：search_users 按姓名/昵称/用户名检索用户；get_user_profile 按 UID 读取用户资料。
 */
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import type { ToolContext, ToolResult } from './base-tool'

/**
 * @category 工具
 * @summary 账号检索工具组（AI 侧）：search_users 按姓名/昵称/用户名检索用户 UID；
 * get_user_profile 按 UID 读取该用户的 USER.md 个人资料。
 * @note 只读 users.json + ABYSS/U{uid}/USER.md；绝不返回密码哈希/盐等敏感字段。
 * USER.md 含联系方式/联系人等个人信息——工具 description 声明边界，且加入
 * LILITH_EXCLUDED_TOOLS（角色 AI 不参与跨用户账号管理）。
 */

const MAX_PROFILE_CHARS = 4000

/** 从 users.json 读取全部用户记录（无文件/解析失败返回 []） */
function readAllUsers(ctx: ToolContext | undefined): Array<{
  UID: number
  用户名: string
  昵称?: string
  禁用?: boolean
}> {
  if (!ctx?.paths) return []
  try {
    const raw = readFileSync(ctx.paths.usersJson, 'utf-8')
    const parsed = JSON.parse(raw) as {
      users?: Array<{ UID: number; 用户名: string; 昵称?: string; 禁用?: boolean }>
    }
    return parsed.users ?? []
  } catch {
    return []
  }
}

/** 读取指定用户的 USER.md「姓名」字段（markdown 表格行 `| 姓名 | xxx |`；文件缺失/解析失败返回 undefined） */
function readUserName(ctx: ToolContext | undefined, uid: number): string | undefined {
  if (!ctx?.paths) return undefined
  const mdPath = join(ctx.paths.abyss, `U${uid}`, 'USER.md')
  if (!existsSync(mdPath)) return undefined
  try {
    const content = readFileSync(mdPath, 'utf-8')
    const line = content
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => /^\|\s*姓名\s*\|/.test(l))
    if (!line) return undefined
    const m = line.match(/^\|\s*姓名\s*\|\s*([^|]*)\s*\|?/)
    if (!m) return undefined
    const name = m[1].trim()
    return name.length > 0 && name !== '（未填写）' ? name : undefined
  } catch {
    return undefined
  }
}

/**
 * search_users：按关键词检索用户（匹配 用户名/昵称/USER.md 姓名，模糊包含）。
 * 返回 UID/用户名/昵称/姓名/禁用状态，不含密码哈希等敏感字段。
 */
export class SearchUsersTool {
  name = 'search_users'
  description = `按关键词检索本机账号列表（匹配登录用户名 / 显示昵称 / USER.md 个人资料中的姓名，模糊包含），返回用户 UID 列表用于账号管理与资料核对。
- 用途：AI 需要根据用户提到的名字/昵称找到对应账号 UID，或确认某账号是否存在
- 返回每条：UID（数字，资料路径 ABYSS/U{uid}/USER.md 的编号）、用户名（登录名）、昵称、姓名（USER.md 中用户填写的姓名，可能为空）、禁用状态
- 不返回任何密码/哈希等凭据信息；仅本机已注册账号可检索
- 隐私边界：检索结果是账号基础信息，供账号管理与资料核对使用；关联的完整个人资料（含联系方式等）用 get_user_profile 时注意不外泄`
  parameters = [
    {
      name: 'keyword',
      type: 'string' as const,
      description: '检索关键词（匹配用户名/昵称/USER.md 姓名，模糊包含；空串返回全部账号）',
      required: true
    }
  ]

  async execute(params: Record<string, unknown>, ctx?: ToolContext): Promise<ToolResult> {
    const keyword = (params.keyword as string | undefined) ?? ''
    if (typeof keyword !== 'string') {
      return { ok: false, error: 'keyword 参数必填（字符串）' }
    }
    if (keyword.length > 100) {
      return { ok: false, error: 'keyword 过长（最多 100 字符）' }
    }
    const kw = keyword.trim()
    // 用户数通常很少（个位数），全量读取 + 单文件姓名解析成本可接受
    const users = readAllUsers(ctx)
    if (users.length === 0) {
      return { ok: true, data: { users: [], message: '本机暂无账号（users.json 为空或不可读）' } }
    }
    const results = []
    for (const u of users) {
      const name = readUserName(ctx, u.UID)
      const hit =
        kw.length === 0 ||
        u.用户名.includes(kw) ||
        (u.昵称 ?? '').includes(kw) ||
        (name ?? '').includes(kw)
      if (!hit) continue
      results.push({
        UID: u.UID,
        用户名: u.用户名,
        昵称: u.昵称,
        姓名: name,
        禁用: u.禁用 === true
      })
    }
    return {
      ok: true,
      data: {
        users: results,
        count: results.length,
        keyword: kw
      }
    }
  }
}

/**
 * get_user_profile：按 UID 读取该用户的 USER.md 个人资料卡（ABYSS/U{uid}/USER.md）。
 * 带截断保护（MAX_PROFILE_CHARS）与存在性校验；不返回 users.json 中的凭据字段。
 */
export class GetUserProfileTool {
  name = 'get_user_profile'
  description = `按 UID 读取指定账号的个人资料卡（该卡片会出现在所有 AI 会话的提示词中：姓名/职业/联系方式/联系人/偏好等）。
- 用途：账号管理中按 UID 核对用户资料；或 AI 需要查看某用户填写的个人偏好/备注时
- UID 数字从哪里来：用 search_users 按名字先查 UID
- 文件不存在返回明确错误（该账号可能未填写个人资料）
- 返回 content 为资料卡原文（含联系方式/联系人等个人信息，仅供账号管理与资料核对，不对外泄露；超 ${MAX_PROFILE_CHARS} 字符截断并标记 truncated）
- 隐私边界：这是他人个人资料，AI 仅在用户明确要求账号管理/资料核对时调用，不用于无关用途`
  parameters = [
    {
      name: 'uid',
      type: 'number' as const,
      description: '目标用户 UID（数字，来自 search_users 检索结果）',
      required: true
    }
  ]

  async execute(params: Record<string, unknown>, ctx?: ToolContext): Promise<ToolResult> {
    const uid = params.uid
    if (typeof uid !== 'number' || !Number.isInteger(uid) || uid <= 0) {
      return { ok: false, error: 'uid 参数必填（正整数，来自 search_users 检索结果）' }
    }
    if (!ctx?.paths) {
      return { ok: false, error: '无法定位数据路径（paths 未注入）' }
    }
    // users.json 存在性校验：UID 必须真实存在，防任意路径拼接
    const users = readAllUsers(ctx)
    const record = users.find((u) => u.UID === uid)
    if (!record) {
      return { ok: false, error: `用户不存在：UID=${uid}（本机未注册该账号）` }
    }
    const mdPath = join(ctx.paths.abyss, `U${uid}`, 'USER.md')
    if (!existsSync(mdPath)) {
      return {
        ok: true,
        data: {
          UID: uid,
          用户名: record.用户名,
          昵称: record.昵称,
          userMd: null,
          message: '该账号尚未填写 USER.md 个人资料（文件不存在）'
        }
      }
    }
    // 读取他人个人资料（USER.md 含联系方式/联系人等 PII）需用户确认——与 update_user_preference 写操作对称
    if (ctx.requestPermission) {
      const perm = await ctx.requestPermission({
        type: 'command',
        description: `AI 请求读取用户 UID=${uid} 的个人资料（${record.用户名}）`,
        content: `账号：${record.用户名}${record.昵称 ? `（昵称：${record.昵称}）` : ''}\n读取内容：ABYSS/U${uid}/USER.md（姓名/职业/联系方式/联系人/偏好等个人资料）`,
        risk: 'medium'
      })
      if (!perm.allowed) {
        return {
          ok: false,
          error: `【读取未完成】用户拒绝了权限弹框：${perm.reason ?? '无原因'}。你必须在回复中明确告知用户：个人资料读取未完成，因为权限请求被拒绝。不要假装读取成功。`
        }
      }
    }
    let content: string
    try {
      content = readFileSync(mdPath, 'utf-8')
    } catch (e) {
      return { ok: false, error: `读取 USER.md 失败：${(e as Error).message}` }
    }
    const truncated = content.length > MAX_PROFILE_CHARS
    const shown = truncated ? content.slice(0, MAX_PROFILE_CHARS) : content
    return {
      ok: true,
      data: {
        UID: uid,
        用户名: record.用户名,
        昵称: record.昵称,
        userMd: shown,
        chars: content.length,
        truncated
      }
    }
  }
}