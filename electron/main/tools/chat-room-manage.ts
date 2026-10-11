/**
 * 局域网聊天室管理工具：为什么存在——不同机器上的月蚀实例需要多方交流场所（L2 层），
 * 聊天室支持真人成员与 AI 身份发言，是跨实例协作的主通道。
 * 作用：chat_room_manage 封装建室、邀请/加入、群聊与 AI 身份发言等动作。
 */
import type { ToolContext, ToolResult } from './base-tool'
import { MAIN_AI_ID, formatIdentity, parseIdentity } from '../multi-instance/lan/lan-types'

// chat_room_manage 工具：AI 操作局域网聊天室（L2）
//
// 聊天室是局域网内多个（含不同机器上的）月蚀实例的多方交流场所：
// 建室 → 邀请/加入 → 群聊。除真人成员外，聊天室还支持"AI 发言身份"
// （对外身份 = `UID-AIID`），由本机某个 AI 实体以室内名义发言——这是不同月蚀互相交流的主通道。
//
// 动作：
// - list 列出本机所在聊天室（含未读/最近消息）
// - create 创建聊天室（name，可选 desc）
// - detail 查看聊天室详情（gid，含成员列表与 AI 发言身份）
// - update 改聊天室名/简介（gid + name/desc）
// - invite 邀请局域网对端加入（gid + uid）
// - accept 接受邀请加入（gid）
// - leave 退出聊天室（gid；系统全员频道不可退出）
// - kick 踢出成员（gid + uid；仅室主/admin）
// - disband 解散聊天室（gid；仅室主）
// - messages 读取聊天记录（gid，可选 limit）
// - search 关键词搜索（keyword；可选 gid 限定某聊天室，可选 limit）
// - send 发言（gid + text；可选 aiIdentity 以某个 AI 发言身份发言，否则以本机用户身份并由 AI 代理标记）
// - add_ai 新增 AI 发言身份（gid + name 可选，可选 aiId），返回其 aiIdentity
// - remove_ai 移除 AI 发言身份（gid + aiIdentity）
// - ai_config 开关某聊天室的 AI 自动回复（gid + enabled）
export class ChatRoomManageTool {
  name = 'chat_room_manage'
  description = `操作局域网聊天室（L2）：与局域网内其他月蚀实例多方交流。action 见参数表。身份：UID-AIID=AI 身份（如 1-1=uid1 的 1 号 AI，编号先看本机 AI 编号列表，每个 AI 编号独立、无固定主次），纯 UID=真人。AI 发言主通道：先 add_ai 进场（返回 aiIdentity）再 send 带上。全员频道 gid=system-world-chat（自动加入不可退出）。聊天记录可能很长：先 search 定位再按需读取，不要一次拉全量。`

  parameters = [
    {
      name: 'action',
      type: 'string' as const,
      description:
        'list / create / search / detail / update / invite / accept / leave / kick / disband / messages / send / add_ai / remove_ai / ai_config',
      required: true
    },
    {
      name: 'gid',
      type: 'string' as const,
      description: '聊天室 ID（search 可选，用于限定某室；除 list/create/search 外均必填）',
      required: false
    },
    {
      name: 'keyword',
      type: 'string' as const,
      description: '搜索关键词（search 必填）：匹配聊天室名/简介与聊天记录正文',
      required: false
    },
    {
      name: 'name',
      type: 'string' as const,
      description: '聊天室名（create 必填；update 可选）或 AI 发言身份名（add_ai 可选，缺省取该 AI 的登记名字）',
      required: false
    },
    {
      name: 'desc',
      type: 'string' as const,
      description: '聊天室简介（create/update 可选）',
      required: false
    },
    {
      name: 'uid',
      type: 'number' as const,
      description: '局域网对端账号 ID（invite/kick 必填）',
      required: false
    },
    {
      name: 'aiIdentity',
      type: 'string' as const,
      description: 'AI 发言身份（格式 UID-AIID，如 1-1；send 可选，remove_ai 必填）',
      required: false
    },
    {
      name: 'aiId',
      type: 'number' as const,
      description: 'AI 实体编号（add_ai 可选，默认 1=月蚀，其余编号见 ai-registry.json）',
      required: false
    },
    {
      name: 'text',
      type: 'string' as const,
      description: '发言正文（send 必填）',
      required: false
    },
    {
      name: 'enabled',
      type: 'boolean' as const,
      description: '是否启用（ai_config 必填）',
      required: false
    },
    {
      name: 'limit',
      type: 'number' as const,
      description: '返回条数上限（messages/search 可选，默认 50，硬上限 200）',
      required: false
    }
  ]

  async execute(params: Record<string, unknown>, ctx?: ToolContext): Promise<ToolResult> {
    const rooms = ctx?.getMultiInstance?.()?.getChatRooms()
    if (!rooms) return { ok: false, error: '聊天室不可用（未初始化或未登录）' }

    const action = params.action as string | undefined
    const gid = (params.gid as string | undefined)?.trim()

    if (action === 'list') {
      return { ok: true, data: { rooms: rooms.list() } }
    }

    if (action === 'create') {
      const name = (params.name as string | undefined)?.trim()
      if (!name) return { ok: false, error: 'create 需要 name' }
      const desc = (params.desc as string | undefined)?.trim()
      const res = rooms.create(name, desc || undefined)
      if (!res.ok) return { ok: false, error: res.error ?? '创建失败' }
      return { ok: true, data: { gid: res.gid, note: `聊天室「${name}」已创建` } }
    }

    if (action === 'search') {
      const keyword = (params.keyword as string | undefined)?.trim()
      if (!keyword) return { ok: false, error: 'search 需要 keyword' }
      const limit = asNumber(params.limit) ?? 50
      const res = rooms.search(keyword, gid, limit)
      return {
        ok: true,
        data: {
          keyword,
          rooms: res.rooms,
          messages: res.messages,
          note: `命中聊天室 ${res.rooms.length} 个、消息 ${res.messages.length} 条`
        }
      }
    }

    if (!gid) return { ok: false, error: `${String(action)} 需要 gid` }

    if (action === 'detail') {
      const detail = rooms.detail(gid)
      if (!detail) return { ok: false, error: `聊天室不存在: ${gid}` }
      return { ok: true, data: { room: detail } }
    }

    if (action === 'update') {
      const patch: { name?: string; desc?: string } = {}
      const name = (params.name as string | undefined)?.trim()
      const desc = (params.desc as string | undefined)?.trim()
      if (name) patch.name = name
      if (desc !== undefined) patch.desc = desc
      if (Object.keys(patch).length === 0) return { ok: false, error: 'update 需要 name 或 desc' }
      return toResult(rooms.update(gid, patch), `聊天室 ${gid} 已更新`)
    }

    if (action === 'invite') {
      const uid = asNumber(params.uid)
      if (uid === undefined) return { ok: false, error: 'invite 需要 uid' }
      return toResult(rooms.invite(gid, uid), `已邀请 UID${uid} 加入`)
    }

    if (action === 'accept') {
      return toResult(rooms.acceptInvite(gid), `已加入聊天室 ${gid}`)
    }

    if (action === 'leave') {
      return toResult(rooms.leave(gid), `已退出聊天室 ${gid}`)
    }

    if (action === 'kick') {
      const uid = asNumber(params.uid)
      if (uid === undefined) return { ok: false, error: 'kick 需要 uid' }
      return toResult(rooms.kick(gid, uid), `已踢出 UID${uid}`)
    }

    if (action === 'disband') {
      return toResult(rooms.disband(gid), `聊天室 ${gid} 已解散`)
    }

    if (action === 'messages') {
      const raw = asNumber(params.limit) ?? 50
      const limit = Math.min(Math.max(1, Math.floor(raw)), 200)
      const all = rooms.messages(gid)
      return { ok: true, data: { gid, total: all.length, messages: all.slice(-limit) } }
    }

    if (action === 'send') {
      const text = (params.text as string | undefined)?.trim()
      if (!text) return { ok: false, error: 'send 需要 text' }
      // aiIdentity = UID-AIID：只取 AIID，uid 段由服务侧锁定为本机（不能以别人的 AI 名义发言）
      const aiIdentity = (params.aiIdentity as string | undefined)?.trim()
      let aiId: number | undefined
      if (aiIdentity) {
        const parsed = parseIdentity(aiIdentity)
        if (!parsed || parsed.aiId === undefined) return { ok: false, error: 'aiIdentity 格式应为 UID-AIID（如 1-1）' }
        aiId = parsed.aiId
      }
      // 工具发言一律是 AI 发起：未指定 aiIdentity 时以本机用户身份发出，必须打 AI 标记，
      // 否则会被当成真人消息触发本机 AI 回复自己（自聊）。
      const res = rooms.sendMessage(gid, text, aiId === undefined, aiId)
      if (!res.ok) return { ok: false, error: res.error ?? '发送失败' }
      return { ok: true, data: { note: aiIdentity ? `已以 AI 发言身份 ${aiIdentity} 发言` : '已发言', mode: res.mode } }
    }

    if (action === 'add_ai') {
      const name = (params.name as string | undefined)?.trim() ?? ''
      const aiId = asNumber(params.aiId) ?? MAIN_AI_ID
      const res = rooms.addAiSpeaker(gid, name, aiId)
      if (!res.ok) return { ok: false, error: res.error ?? '添加失败' }
      const myUid = ctx?.user?.UID
      const aiIdentity = myUid !== undefined ? formatIdentity(myUid, res.aiId ?? aiId) : undefined
      const aiName = res.name ?? name
      return {
        ok: true,
        data: { aiIdentity, aiId: res.aiId ?? aiId, name: aiName, note: `AI 发言身份「${aiName}」已加入${aiIdentity ? `（${aiIdentity}）` : ''}` }
      }
    }

    if (action === 'remove_ai') {
      const aiIdentity = (params.aiIdentity as string | undefined)?.trim()
      if (!aiIdentity) return { ok: false, error: 'remove_ai 需要 aiIdentity（UID-AIID）' }
      return toResult(rooms.removeAiSpeaker(gid, aiIdentity), `AI 发言身份 ${aiIdentity} 已移除`)
    }

    if (action === 'ai_config') {
      const store = ctx?.getMultiInstance?.()?.getAiAgentConfig()
      if (!store) return { ok: false, error: 'AI 代理配置不可用' }
      if (typeof params.enabled !== 'boolean') return { ok: false, error: 'ai_config 需要 enabled' }
      store.setChatRoom(gid, params.enabled)
      return { ok: true, data: { note: `聊天室 ${gid} 的 AI 自动回复已${params.enabled ? '开启' : '关闭'}` } }
    }

    return {
      ok: false,
      error: `未知 action: ${String(action)}（支持 list/create/search/detail/update/invite/accept/leave/kick/disband/messages/send/add_ai/remove_ai/ai_config）`
    }
  }
}

function asNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

function toResult(res: { ok: boolean; error?: string }, successNote: string): ToolResult {
  if (!res.ok) return { ok: false, error: res.error ?? '操作失败' }
  return { ok: true, data: { note: successNote } }
}
