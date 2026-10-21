/**
 * @category 记忆
 * @summary RAW 记忆的**来源标记**：由会话 id 推导来源类别（纯函数）
 *
 * 为什么存在：用户要求「标记清楚来源，比如局域网的好友私聊，和群聊，这些都得标清，自主模式也要标清，
 * 只是简单的用户与他的会话也要标清」——AI 读 RAW 时必须一眼知道这段话从哪来。
 *
 * 不删理由：删掉即 RAW 全是「用户/AI」两段，分不清是私聊、群聊还是自主轮次，
 * 记忆工作流也无法按来源区分处理（§3.5 的「分开做」失去判据）。
 *
 * 为什么用**会话 id 前缀**而不是加参数：会话 id 本身就编码了来源（`lan-chat-room-*` 等），
 * 由前缀推导可以**零签名改动**接入（`server.ts` 在体量棘轮台账内，不得增行），且是纯函数可单测。
 */

export type RawSourceKind =
  /** 用户与 AI 的直接会话（含悬浮小窗、CLI） */
  | 'user-session'
  /** 局域网好友私聊 */
  | 'lan-friend'
  /** 局域网群聊 */
  | 'lan-group'
  /** 局域网公示板 */
  | 'lan-board'
  /** AI 与 AI 社交 */
  | 'ai-social'
  /** 自主模式（ROOM 规划/执行轮次） */
  | 'autonomous'
  /** 莉莉丝桌宠 */
  | 'lilith'
  /** 外部平台接入（飞书等） */
  | 'messaging'

/** 人类可读名（写进 RAW 头部，供 AI 与用户辨认）。 */
export const RAW_SOURCE_LABELS: Record<RawSourceKind, string> = {
  'user-session': '用户会话',
  'lan-friend': '局域网好友私聊',
  'lan-group': '局域网群聊',
  'lan-board': '局域网公示板',
  'ai-social': 'AI 社交',
  autonomous: '自主模式',
  lilith: '莉莉丝桌宠',
  messaging: '外部平台接入'
}

// ===== 自主域判据（ADR-25 支柱 3：判据用来源标记，不用路径猜）=====
// 自主域 = ROOM 数据（{root}/room/**）+ 自主内部会话（owner 前缀）+ 自主轮次 RAW（source === 'autonomous'）。
// 为什么集中在这里：来源标记的唯一真源在本文件，自主域判据必须与它同源，否则会出现两套判据打架
// （例如 RAW 头标 `autonomous`、清理侧却按路径猜）。**常量声明须在 PREFIX_MAP 之前**（后者初始化时引用它）。

/** 自主模式会话 id 前缀（ROOM 自主轮次；`sourceOfSession` 的映射表也用它，保证同源） */
export const AUTONOMOUS_OWNER_PREFIX = 'room-autonomous'

/** 该 owner 会话是否属自主域（内部会话/会话级清理据此排除） */
export function isAutonomousOwner(ownerSessionId: string | undefined | null): boolean {
  return (ownerSessionId ?? '').trim().startsWith(AUTONOMOUS_OWNER_PREFIX)
}

/** 该 RAW 来源是否属自主域 */
export function isAutonomousSource(source: RawSourceKind | undefined | null): boolean {
  return source === 'autonomous'
}

/** 会话 id 前缀 → 来源（顺序敏感：长前缀在前）。 */
const PREFIX_MAP: ReadonlyArray<[string, RawSourceKind]> = [
  ['lan-chat-room-', 'lan-group'],
  ['lan-direct-chat-', 'lan-friend'],
  ['lan-publish-board-', 'lan-board'],
  ['ai-social-', 'ai-social'],
  [AUTONOMOUS_OWNER_PREFIX, 'autonomous'],
  ['lilith', 'lilith'],
  ['messaging-', 'messaging'],
  ['msg-', 'messaging']
]

/**
 * 由会话 id 推导来源。未知/空 → `user-session`（用户直接会话是默认场景，不是「兜底写错 AI」那种危险默认）。
 */
export function sourceOfSession(sessionId: string | undefined | null): RawSourceKind {
  const id = (sessionId ?? '').trim()
  if (!id) return 'user-session'
  for (const [prefix, kind] of PREFIX_MAP) {
    if (id.startsWith(prefix)) return kind
  }
  return 'user-session'
}

/** RAW 头部的来源行（无来源时不输出，保持老文件格式兼容）。 */
export function sourceHeaderLine(source: RawSourceKind | undefined): string | null {
  if (!source) return null
  return `- 来源：${source}（${RAW_SOURCE_LABELS[source]}）`
}
