/**
 * 局域网好友管理工具：为什么存在——不同机器上的月蚀实例通过好友关系建立点对点私聊通道
 * （L1 层），AI 需要能自主完成加好友/接受等流程。
 * 作用：friend_manage 封装好友系统的加好友、接受、列好友等动作。
 */
import type { ToolContext, ToolResult } from './base-tool'

// friend_manage 工具：AI 操作局域网好友系统（L1）
//
// 好友系统是局域网内不同月蚀实例之间建立点对点关系的通道：
// 加好友 → 对方接受 → 双方可私聊。AI 通过本工具自主完成这套流程，
// 让不同机器上的月蚀能互相认识、互相通信。
//
// 动作：
// - list 列出好友簿（含在线态/未读/最近消息预览）
// - candidates 列出局域网内可添加的候选对端（roster 中还不是好友的）
// - request 发起好友请求（uid，可选 note 附言）
// - accept 接受对方发来的请求（uid）
// - reject 拒绝对方发来的请求（uid）
// - block 拉黑（uid）
// - unblock 解除拉黑（uid）
// - remove 删除好友（uid）
// - update 更新备注/分组（uid + 备注/分组）
// - messages 读取与某好友的私聊记录（uid，可选 limit）
// - search 关键词搜索（keyword；可选 uid 限定某会话，可选 limit）
// - send 给好友发私聊消息（uid + text）
export class FriendManageTool {
  name = 'friend_manage'
  description = `操作局域网好友系统（L1）：与局域网内其他月蚀实例建点对点关系并私聊。action 见参数表。典型流程：candidates 看在线实例 → request 加好友 → 对方 accept 后 send。身份：UID-AIID=AI 身份（编号先看本机 AI 编号列表，每个 AI 编号独立、无固定主次），纯 UID=真人；另一端可能是 AI 代答（消息会标记是否 AI 生成）或机主本人，你 send 时以本机机主身份发出并标记由 AI 代答。所有动作以 uid 定位对端。记录可能很长：先 search 定位再按需读取，不要一次拉全量。`

  parameters = [
    {
      name: 'action',
      type: 'string' as const,
      description:
        'list / candidates / search / request / accept / reject / block / unblock / remove / update / messages / send',
      required: true
    },
    {
      name: 'uid',
      type: 'number' as const,
      description: '对端局域网账号 ID（search 可选，用于限定某会话；request/accept/reject/block/unblock/remove/update/messages/send 必填）',
      required: false
    },
    {
      name: 'keyword',
      type: 'string' as const,
      description: '搜索关键词（search 必填）：匹配好友昵称/备注/分组与私聊消息正文',
      required: false
    },
    {
      name: 'note',
      type: 'string' as const,
      description: '好友请求附言（request 可选）',
      required: false
    },
    {
      name: 'text',
      type: 'string' as const,
      description: '私聊消息正文（send 必填）',
      required: false
    },
    {
      name: 'limit',
      type: 'number' as const,
      description: '返回条数上限（messages/search 可选，默认 50，硬上限 200）',
      required: false
    },
    {
      name: '备注',
      type: 'string' as const,
      description: '本机备注（update 可选，展示优先于昵称）',
      required: false
    },
    {
      name: '分组',
      type: 'string' as const,
      description: '分组名（update 可选）',
      required: false
    }
  ]

  async execute(params: Record<string, unknown>, ctx?: ToolContext): Promise<ToolResult> {
    const friends = ctx?.getMultiInstance?.()?.getFriends()
    if (!friends) return { ok: false, error: '好友系统不可用（未初始化或未登录）' }

    const action = params.action as string | undefined
    const uid = typeof params.uid === 'number' ? params.uid : undefined

    if (action === 'list') {
      return { ok: true, data: { friends: friends.list() } }
    }

    if (action === 'candidates') {
      return { ok: true, data: { candidates: friends.candidates() } }
    }

    if (action === 'search') {
      const keyword = (params.keyword as string | undefined)?.trim()
      if (!keyword) return { ok: false, error: 'search 需要 keyword' }
      const limit = typeof params.limit === 'number' && params.limit > 0 ? params.limit : 50
      const res = friends.search(keyword, uid, limit)
      return {
        ok: true,
        data: {
          keyword,
          contacts: res.contacts,
          messages: res.messages,
          note: `命中联系人 ${res.contacts.length} 位、消息 ${res.messages.length} 条`
        }
      }
    }

    if (!uid) {
      return { ok: false, error: `${String(action)} 需要 uid` }
    }

    if (action === 'request') {
      const note = (params.note as string | undefined)?.trim()
      return toResult(friends.request(uid, note || undefined), `已向 UID${uid} 发起好友请求`)
    }

    if (action === 'accept') {
      return toResult(friends.accept(uid), `已接受 UID${uid} 的好友请求`)
    }

    if (action === 'reject') {
      return toResult(friends.reject(uid), `已拒绝 UID${uid} 的好友请求`)
    }

    if (action === 'block') {
      return toResult(friends.block(uid), `已拉黑 UID${uid}`)
    }

    if (action === 'unblock') {
      return toResult(friends.unblock(uid), `已解除拉黑 UID${uid}`)
    }

    if (action === 'remove') {
      return toResult(friends.remove(uid), `已删除好友 UID${uid}`)
    }

    if (action === 'update') {
      const patch: { 备注?: string; 分组?: string } = {}
      const remark = (params.备注 as string | undefined)?.trim()
      const group = (params.分组 as string | undefined)?.trim()
      if (remark !== undefined) patch.备注 = remark
      if (group !== undefined) patch.分组 = group
      if (Object.keys(patch).length === 0) return { ok: false, error: 'update 需要 备注 或 分组' }
      return toResult(friends.update(uid, patch), `已更新 UID${uid} 的资料`)
    }

    if (action === 'messages') {
      const limit = typeof params.limit === 'number' && params.limit > 0 ? params.limit : 50
      const all = friends.messages(uid)
      return { ok: true, data: { uid, total: all.length, messages: all.slice(-limit) } }
    }

    if (action === 'send') {
      const text = (params.text as string | undefined)?.trim()
      if (!text) return { ok: false, error: 'send 需要 text' }
      // 工具发言一律是 AI 发起，必须打 AI 标记，否则会被当成真人消息触发本机 AI 回复自己（自聊）
      const res = friends.sendMessage(uid, text, true)
      if (!res.ok) return { ok: false, error: res.error ?? '发送失败' }
      return { ok: true, data: { note: `已发送给 UID${uid}`, mode: res.mode } }
    }

    return {
      ok: false,
      error: `未知 action: ${String(action)}（支持 list/candidates/search/request/accept/reject/block/unblock/remove/update/messages/send）`
    }
  }
}

function toResult(
  res: { ok: boolean; error?: string },
  successNote: string
): ToolResult {
  if (!res.ok) return { ok: false, error: res.error ?? '操作失败' }
  return { ok: true, data: { note: successNote } }
}
