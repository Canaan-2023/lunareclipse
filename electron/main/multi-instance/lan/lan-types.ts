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
 * ws 消息载荷上限（ws 层硬阀，对信封帧与流帧统一生效）：单帧不超过 64MB。
 *
 * 为什么存在：ws 库要求显式设定接收载荷上限，避免对端恶意/异常发送超大消息拖垮内存——
 * maxPayload 是内存保护阀，不能整体移除。
 *
 * 为什么从 512MB 下调到 64MB（载荷分级）：
 * - 二进制文件不走信封——走 lan-stream 的 LMST 分块通道，单帧默认 1MB（LAN_STREAM_DEFAULT_CHUNK_SIZE），
 *   大文件由多帧承载，与 maxPayload 无关；
 * - 信封是 JSON 结构化载荷，实测仅承载 UTF-8 文本（技能市场的 collectLanFiles 显式排除含 NUL 的二进制），
 *   单条文本信封合理体量远小于 64MB；
 * - 原 512MB 使单个恶意帧即可让主进程内存尖峰，属分发阻断级 DoS 面（见 0.52.8 分发前审查 S1-A）。
 * 64MB 保留对异常大文本信封的余量，同时把单帧内存尖峰压到可控量级。
 */
export const LAN_MAX_PAYLOAD = 64 * 1024 * 1024

/**
 * 信封帧（JSON）软上限：单条信封不超过 32MB（低于 ws 层 64MB 硬阀，形成分级）。
 *
 * 为什么需要独立软阀：ws 的 maxPayload 对信封与流帧一视同仁，无法区分通道。
 * lan-server 在解析信封前按本阀判定：超限即告警并丢弃该条信封（不击穿连接），
 * 而流通道的 1MB 分块帧不受影响——这就是「载荷分级」：信封通道 32MB、流通道 1MB/帧、ws 硬阀 64MB。
 */
export const LAN_ENVELOPE_MAX_PAYLOAD = 32 * 1024 * 1024

/**
 * LAN 身份 uid 合法性判定：必须为正整数。
 *
 * 为什么存在：uid 是握手时对端自报的字段，此前无校验——攻击者声明 uid=0/负数可顶掉
 * 真实用户的连接（attach 以 uid 为键，后连入者顶掉旧连接），进而冒充任意 uid 收发
 * friend / chat-room / relay 等业务前缀的信封（分发前审查 S1-A）。所有以对端自报 uid 为键的
 * 登记点（hello / registerOutbound / attach）必须先过此校验。
 */
export function isValidLanUid(uid: unknown): uid is number {
  return typeof uid === 'number' && Number.isInteger(uid) && uid > 0
}

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

/**
 * 解析身份字符串；非法返回 null。`1` → {uid:1}；`1-2` → {uid:1, aiId:2}
 *
 * uid 段口径与 `isValidLanUid` **一致（必须为正整数）**：原正则 `/^(-?\d+)…/` 接受负 uid
 * （`-5` → `{uid:-5}`），与握手侧「uid 必须正整数」的判定相反——同一份身份串在两条链路上
 * 得到相反结论（复审轮 A1）。此处复用 `isValidLanUid`，把口径收敛到单点。
 */
export function parseIdentity(s: string): { uid: number; aiId?: number } | null {
  const m = /^(\d+)(?:-(\d+))?$/.exec(String(s).trim())
  if (!m) return null
  const uid = Number(m[1])
  if (!isValidLanUid(uid)) return null
  if (m[2] === undefined) return { uid }
  const aiId = Number(m[2])
  if (!Number.isInteger(aiId) || aiId <= 0) return null
  return { uid, aiId }
}

/** 是否为 AI 身份（带 AIID 段） */
export function isAiIdentity(s: string): boolean {
  return parseIdentity(s)?.aiId !== undefined
}