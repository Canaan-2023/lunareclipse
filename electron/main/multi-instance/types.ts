/**
 * 主分系统数据契约（单版本双角色：standalone=单机现状 / master=主月蚀 / satellite=分月蚀）
 * 为什么存在：主从多开需要一份双角色共享的接入/账号/同步契约，单版本双角色可避免两侧实现各自定义类型而分叉。
 */
export type InstanceRole = 'standalone' | 'master' | 'satellite'

/** 主系统接入配置（仅 role=master 时存在；joinCode 为分系统注册准入凭证） */
export interface MasterJoinConfig {
  joinCode: string
}

/** 实例角色配置（abyssac_data/instance.json；satellite 模式持接入信息与令牌） */
export interface InstanceConfig {
  role: InstanceRole
  master?: {
    baseUrl: string
    instanceId: string
    accessToken: string
    /** 注册准入凭证（setPendingSatellite 时暂存，注册成功后保留不影响使用） */
    joinCode?: string
  }
  join?: MasterJoinConfig
}

/** 会话用户（UID 由主系统统一分配，卫星本地仅缓存此三元组，不持有密码哈希） */
export interface AuthUser {
  UID: number
  用户名: string
  /** 显示昵称（个人中心可改；缺省回退用户名展示） */
  昵称?: string
  /** 头像标识（emoji 或 img:avatars/... 本地图片引用） */
  头像?: string
}

export interface AuthResult {
  ok: boolean
  user?: AuthUser
  error?: string
}

/** 注册意图：local=本机账号（现状/单机）/ createMaster=本机建主系统 / joinSatellite=接入主系统注册为分系统 */
export type RegisterIntent = 'local' | 'createMaster' | 'joinSatellite'

/** 主系统持的分系统注册记录（分系统账号本体在 users.json；本表只管主分维度） */
export interface SatelliteRecord {
  instanceId: string
  uid: number
  用户名: string
  status: 'active' | 'disabled'
  createdAt: string
  lastSyncAt: string | null
  lastSeq: number
  tokenHash: string
  tokenExp: number
  /** 局域网直连地址（分系统每次启动上报；null = 未上报/未知） */
  lanIp?: string | null
  /** 直连监听端口（默认 62003，被占回退后上报真实值） */
  lanPort?: number | null
  /** 最近一次确认在线时间（epoch ms）；null = 从未上报在线 */
  lastSeen?: number | null
}

export type OpType = 'upsert' | 'delete'

/**
 * oplog 条目（信封；key 一律为相对 dataRoot 的正斜杠路径）。
 * 数据面路由：upsert 一律为 staged——实体字节不经 HTTP JSON body，统一由 lan-stream 分块面
 * （块 sha256 + 停滞判定 + 整体 sha256 终校验）先行推送到主系统 sync_staging，applyPush 落镜像
 * 前按 size/hash 校验一致；delete 无实体字节，只随元数据内联。谓：分块是常态而非兜底，
 * 不设体积/格式阈值，任意字节统一走同一可靠通道（无内联/降级两级分流）。
 */
export interface OpEntry {
  instanceId: string
  uid: number
  aiId: number
  op: OpType
  key: string
  /** 实体字节数：upsert 条目携带（staged 语义），供 applyPush 校验暂存字节与原文件一致 */
  size?: number
  /** 外置实体标记：upsert 一律为 true，实体在 sync_staging/{uid}/{instanceId}/{key}，
   * applyPush 落镜像前按 size/hash 校验一致（hash 与原文件字节 sha256 相同，见 oplog-capture） */
  staged?: boolean
  hash?: string
  seq: number
  ts: string
}

export interface SyncPushRequest {
  instanceId: string
  entries: OpEntry[]
}

export interface SyncPushResult {
  ok: boolean
  ackedSeq: number
  error?: string
}

/** 分系统异常上报（数据大面积丢失等；主系统仅展示提醒、不回灌） */
export interface AnomalyReport {
  instanceId: string
  uid: number
  type: string
  message: string
  ts: string
}

export interface RosterItem {
  uid: number
  用户名: string
  role: 'master' | 'satellite'
  status: 'active' | 'disabled'
  /** 局域网直连地址与在线态（roster 供终端直连发现用；master 行来自主系统本机、satellite 行来自分系统上报） */
  lanIp?: string | null
  lanPort?: number | null
  online?: boolean
  lastSeen?: number | null
}

/** 存档元信息（backup/U{uid}/{date}/ 快照，含 memory 与 NNG 两域完整镜像） */
export interface ArchiveInfo {
  instanceId: string
  date: string
  entryCount: number
  createdAt: string
}