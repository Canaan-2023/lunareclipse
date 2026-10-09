/**
 * 局域网通信层（L0 底座）类型契约。
 * 只管"发现 + 直连 + 信封投递 + 离线补偿"，不承载业务语义；
 * 好友/群/新闻板块的消息体由各自模块放入 envelope.payload，type 唯一标识业务方向。
 */

/** 信封：任意两终端间端到端消息的统一载体（不经过主系统转发） */
export interface LanEnvelope {
  /** 消息唯一 ID（发送方生成，接收方按 id 幂等去重） */
  id: string
  /** 业务方向：'friend.message' | 'chat-room.message' | 'publish-board.article' …；内部握手用 'hello' / 'hello-ack' */
  type: string
  /** 发送方 UID（全局唯一，主系统统一发放） */
  from: number
  /** 接收方 UID；单播必填，广播场景由业务层自行约定（预留） */
  to: number
  /** 发送时间（epoch ms） */
  ts: number
  /** 业务负载（好友/群/新闻模块各自定义结构） */
  payload?: unknown
  /** 应答引用（hello-ack 回填 hello.id 用） */
  ackId?: string
}

/** 对端信息（roster-cache 条目 / peers 表共用） */
export interface LanPeer {
  uid: number
  用户名: string
  role: 'master' | 'satellite'
  /** 局域网可达地址；null 表示未知（未上报/未连接过） */
  lanIp: string | null
  /** 监听端口（默认 62003，被占自动回退后上报真实值） */
  lanPort: number
  /** 在线状态：最近一次心跳/连接确认 */
  online: boolean
  /** 最近一次确认在线时间（epoch ms）；null = 从未见过 */
  lastSeen: number | null
}

/** 握手身份声明（连接建立后立即交换，之后信封收发才被信任） */
export interface LanHello {
  uid: number
  用户名: string
  role: 'master' | 'satellite'
  lanIp: string | null
  lanPort: number
}

/** outbox 落盘条目（federation/outbox/{toUid}/{id}.json） */
export interface LanOutboxEntry {
  envelope: LanEnvelope
  /** 已尝试投递次数（递增退避，仅统计用） */
  attempts: number
  /** 入队时间（epoch ms） */
  enqueuedAt: number
  /** 最近一次失败原因（诊断用，非必需） */
  lastError?: string
}

/** 对端状态变化（LanService.onPeerStatus 回调给上层：好友在线/离线徽标） */
export interface LanPeerStatusEvent {
  peer: LanPeer
  /** 变化后的在线状态 */
  online: boolean
}

export const LAN_DEFAULT_PORT = 62003

/**
 * ws 消息载荷上限：单信封不超过 512MB。

 * 为什么存在：ws 库要求显式设定接收载荷上限，避免对端恶意/异常发送超大消息拖垮内存——
 * maxPayload 是内存保护阀，不能整体移除（不传时 ws 有更小的默认值，也会误伤大包）。

 * 为什么取 512MB 而不是原来的 4MB：局域网好友/社交传输不只是文字——图片、文件、长文、
 * 附档都走信封 payload；4MB 连一张高分辨率照片（5-15MB）都放不下，传输方会在上限处被
 * 直接断开，功能等于不可用。主系统对外 WS 已用 512MB（见 api/server-utils.ts 的
 * WS_MAX_PAYLOAD），局域网是本地千兆/百兆直连、同规格上限完全无压力且口径统一。
 * 512MB 仍是保守上限：单封信封 512MB 已远超本地社交单条消息合理体量，内存保护语义不减。
 */
export const LAN_MAX_PAYLOAD = 512 * 1024 * 1024

/**
 * AI 身份标识约定（全局域网统一）：`UID-AIID`，如 `1-1`。
 * - UID：身份归属的机主账号（正数，主系统统一发放）
 * - AIID：月蚀系统里的 AI 实体编号（1=月蚀主 AI，其余按 ai-registry.json 顺延），与
 * memory/U{uid}/AI{aiId}、sessions/U{uid}/AI{aiId} 等既有分层同一套编号
 * 真人身份不带 AIID 段（只有 `1`）。各社交线路（好友/聊天室/公示板）
 * 据此区分发言者是哪个 AI 还是人；AI 侧提示词也会被告知这条约定。
 */
export const MAIN_AI_ID = 1

/** 组装对外身份字符串：真人只有 uid（`1`），AI 为 `UID-AIID`（`1-2`） */
export function formatIdentity(uid: number, aiId?: number): string {
  return aiId === undefined ? String(uid) : `${uid}-${aiId}`
}

/** 解析身份字符串；非法返回 null。`1` → {uid:1}；`1-2` → {uid:1, aiId:2} */
export function parseIdentity(s: string): { uid: number; aiId?: number } | null {
  const m = /^(-?\d+)(?:-(\d+))?$/.exec(String(s).trim())
  if (!m) return null
  const uid = Number(m[1])
  if (!Number.isInteger(uid)) return null
  if (m[2] === undefined) return { uid }
  const aiId = Number(m[2])
  if (!Number.isInteger(aiId) || aiId <= 0) return null
  return { uid, aiId }
}

/** 是否为 AI 身份（带 AIID 段） */
export function isAiIdentity(s: string): boolean {
  return parseIdentity(s)?.aiId !== undefined
}