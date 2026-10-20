/**
 * 三层权限层（T0/T1/T2）共享类型。
 * 为什么存在：产品对外分发时作者对「产品能做什么」负法律责任，需要一套可执行、可测试、可审计的
 * 能力边界；类型必须双端（主进程裁决 + 渲染进程授予界面）共享同一契约，避免字段漂移。
 * 作用：定义分级枚举、能力定义、授予与范围、裁决请求/结论、审计条目。
 *
 * 分层语义（不可互换）：
 * - T0 硬禁止：任何配置/同意都不能开启，不注册为工具，无「关掉即放行」开关；
 * - T1 显式授予：默认关，用户逐项授予后放行，可撤回、带范围（越界即拒）；
 * - T2 默认开：低风险只读/规划/记忆检索类，无需授予。
 */

/** 能力分级。'unknown' 只出现在裁决结论里（未登记能力），不是可配置的分级。 */
export type PermissionTier = 'T0' | 'T1' | 'T2'

/**
 * 能力定义（分级目录的条目形状）。
 * key 是稳定标识（`t0.*` / `t1.*` / `t2.*`），授予表、审计、IPC 一律以 key 为准；
 * title/description 只用于展示与审计可读性。
 */
export interface CapabilityDef {
  /** 稳定标识，如 `t1.executor-high-risk` */
  key: string
  tier: PermissionTier
  /** 展示名（中文） */
  title: string
  /** 一句话说明「这个能力让 AI 做什么」 */
  description: string
  /**
   * true = 该能力要求「动作携带授权范围且落在授予范围内」，越界即拒。
   * 用于 T1-3（授权目标）/ T1-5（节点白名单）/ T1-6（已声明端点）这三类
   * 「范围本身就是授权内容」的能力。
   */
  scoped?: boolean
  /**
   * scoped 能力**该填哪个范围字段**（`targets` / `nodes` / `endpoints`）。
   * 为什么放进目录：授予界面与授予校验都需要知道「这项能力该圈什么」，把它写进目录 = 单一真源；
   * 若在 UI 里另建一张 key→字段的映射表，目录一改就漂移（本仓反复记录过这类失效模式）。
   * 非 scoped 能力不带此字段。
   */
  scopeField?: 'targets' | 'nodes' | 'endpoints'
  /**
   * 授予后会发生什么（一句话，给不熟悉分层的用户）。可选：没有就不显示。
   * 为什么放在目录而不是 UI：权限面的每一句解释都改变「用户以为自己授予了什么」，
   * 与能力定义必须同一处维护，避免两处措辞漂移。
   */
  usage?: string
  /** scoped 能力：**范围怎么填**（比通用 hint 更具体，直接告诉用户这一项该写什么） */
  scopeHint?: string
  /** scoped 能力：示例值（UI 做成可点选的提示，降低「不知道填啥」的门槛） */
  scopeExamples?: readonly string[]
  /**
   * scoped 能力：范围的**候选来源**（UI 据此列出真实可选项，而不是让用户凭空填）。
   * - `lan-nodes`：从当前局域网拓扑里勾选节点（t1.migrate 的节点白名单）；
   * - `hosts` / `endpoints`：没有可靠的自动枚举，UI 只给示例 + 手填（IP / 域名 / URL / 路径）。
   */
  scopeSource?: 'lan-nodes' | 'hosts' | 'endpoints'
}

/**
 * 授权范围：用户授予某项能力时圈定的允许集合。
 * 三个字段按能力语义取用（targets=授权目标 / nodes=授权节点 / endpoints=已声明端点）；
 * 动作携带的 scope 必须是授予 scope 的子集，否则越界拒绝。
 */
export interface GrantScope {
  /** 已授权目标清单（T1-3：探测/利用的合法目标） */
  targets?: string[]
  /** 已授权节点白名单（T1-5：跨节点迁移/接续/复制自身） */
  nodes?: string[]
  /** 已声明端点（T1-6：允许向其传输数据的端点） */
  endpoints?: string[]
}

/** 单条授予记录（T1 逐项）。 */
export interface SecurityGrant {
  /** 被授予的能力 key（必须是 T1 且可授予） */
  key: string
  /** 授予时间（epoch ms） */
  grantedAt: number
  /** 授权范围（scoped 能力必填；缺省 = 未圈定，scoped 能力下动作会被拒） */
  scope?: GrantScope
  /** 可选有效期（epoch ms）；到期后裁决按 t1_expired 拒绝 */
  expiresAt?: number
  /** 用户备注 */
  note?: string
}

/**
 * 告知义务确认记录（用户 2026-10-19 裁决：「还得有一份权限授予，所造成的损失，用户需自行承担的
 * 协议，做到告知义务」）。
 *
 * 为什么必须落盘而不是只放前端状态：确认是「用户已被告知并接受风险」的**凭据**——
 * 授予表可以据此回溯「这次授予发生在哪一版条款之下」。版本号来自 `shared/security/notice.ts`
 * 的 `SECURITY_NOTICE_VERSION`；条款文字一改即版本 +1，老确认自动失效（要求重新确认）。
 */
export interface SecurityNoticeAck {
  /** 确认时刻（epoch ms） */
  at: number
  /** 用户当时看到的条款版本（`SECURITY_NOTICE_VERSION`） */
  version: number
}

/**
 * 授予表（持久化在 AppConfig.securityGrants）。
 * 只存放 T1 的授予；T0 不可授予、T2 无需授予，故都不出现在此表。
 */
export interface SecurityGrants {
  grants: Record<string, SecurityGrant>
  /**
   * 告知义务确认（可选：老配置没有该字段 = 从未确认）。
   * **未确认（或确认版本落后）时授予被拒**——门在 `ipc/handlers/security.ts`，
   * 判定用 `needsAcknowledgement`（纯函数，双端同一份）。
   */
  acknowledged?: SecurityNoticeAck
}

/** 裁决请求：每个受控动作在动作入口构造一次，交给唯一检查点。 */
export interface PolicyRequest {
  /** 能力 key（取自 shared/security/tiers.ts 目录） */
  capability: string
  /** 动作标识（工具名 / 路由转发 / 迁移 / 采集 / 配置项），用于审计与提示 */
  action: string
  /**
   * 发起方。**只用于审计，不参与放行判定**——放行只看授予表，
   * 因此 AI 自决无法自我放宽（§0 T0-6 的结构性落实）。
   */
  actor: 'user' | 'ai'
  /** 本次动作声明的授权范围（scoped 能力必填） */
  scope?: GrantScope
}

/** 裁决结论码。'allowed' 为放行，其余均为拒绝原因。 */
export type PolicyDenyCode =
  | 'allowed'
  | 'unknown_capability'
  | 't0_denied'
  | 't1_not_granted'
  | 't1_expired'
  | 't1_out_of_scope'
  /** 用户层开关关闭（采集器总开关 / 桌面开关）——不是授予问题，也要留痕 */
  | 'collector_switch_off'

/** 裁决结论。 */
export interface PolicyDecision {
  allowed: boolean
  tier: PermissionTier | 'unknown'
  code: PolicyDenyCode
  /** 人可读原因（进审计、可回传调用方） */
  reason: string
  /** T1 未授予/过期/越界时给用户的授予指引（正面声明：授予哪个键、在哪授予） */
  grantHint?: string
  /** 本次裁决的审计 id（与审计条目一一对应） */
  auditId: string
}

/** 审计条目（append-only，JSONL 一行一条）。 */
export interface AuditEntry {
  id: string
  /** 时间戳（epoch ms） */
  ts: number
  capability: string
  action: string
  actor: 'user' | 'ai'
  tier: PermissionTier | 'unknown'
  decision: 'allow' | 'deny'
  code: PolicyDenyCode
  reason: string
  /** 本次动作携带的范围（便于回溯「在什么范围内被允许/被拒」） */
  scope?: GrantScope
}

/** 审计落点：接收条目并落盘/入内存。抛错不得影响裁决（调用方须吞异常）。 */
export type AuditSink = (entry: AuditEntry) => void
