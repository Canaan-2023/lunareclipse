/**
 * @category 安全
 * @summary 三层权限层能力分级目录（唯一真源）：T0 硬禁止 ×6 / T1 显式授予 ×12 / T2 默认开 ×8
 *
 * 为什么存在：交接单 §0 的分层授权要求「默认关、显式授予、逐项、可撤回、全量审计」，并明确
 * 「T0 的能力不注册为工具/接口」「唯一 policy 检查点」。分级目录是这条要求的**数据单源**——
 * 裁决层（policy-gate）、用户授予 IPC、审计、以及各能力调用方（执行器/路由/迁移/采集/改配置）
 * 都只认这里的 key，任何一处新增/改名只改本文件，避免同一分级在多处各写一份而漂移。
 *
 * 不删理由：删掉即 T0/T1/T2 的分级语义退回散落在各调用方的硬编码判断，无法保证
 * 「T0 不可授予」「T1 逐项可撤回」这类全局不变量，也无法对 §0 逐条做负向/双向测试。
 *
 * 维护纪律：新增能力只改本文件；T0 条目的 key 一旦发布不得复用给其它语义（审计可回溯）。
 */
import type { CapabilityDef } from '../types/permission'

/**
 * T0 硬禁止：不可由任何配置/同意开启，不注册为工具/接口，不提供开关。
 * 六条对应交接单 §0 T0-1~6；保留「同意无法覆盖」的最小集。
 */
export const T0_CAPABILITIES: readonly CapabilityDef[] = [
  {
    key: 't0.unauthorized-offensive',
    tier: 'T0',
    title: '对非授权第三方的攻击/入侵',
    description: '扫描、利用、爆破、横向移动、权限提升（对已授权目标的操作不在此列，见 T1 授权目标）'
  },
  {
    key: 't0.covert-evasion',
    tier: 'T0',
    title: '隐蔽规避',
    description: '关闭/绕过系统审计与安全软件、隐藏进程/文件/网络痕迹、安装持久化后门'
  },
  {
    key: 't0.harm-others',
    tier: 'T0',
    title: '伤及他人的数据或可用性',
    description: '勒索、加密他人数据、拒绝服务/流量攻击'
  },
  {
    key: 't0.impersonation',
    tier: 'T0',
    title: '伪造他人身份或消息来源',
    description: '冒充他人身份、伪造消息来源'
  },
  {
    key: 't0.undeclared-egress',
    tier: 'T0',
    title: '向未声明第三方端点外泄用户数据',
    description: '把用户数据发往用户未声明的端点（已声明端点传输属 T1）'
  },
  {
    key: 't0.bypass-approval',
    tier: 'T0',
    title: '绕过审批机制本身',
    description: '含 AI 自行授予自己权限；任何试图改写授予表/关闭本层的行为'
  }
]

/**
 * T1 显式授予：默认关；用户逐项授予后自动放行（不必逐次审批），可撤回、可带范围、全量审计。
 * 十二条对应交接单 §0 T1-1~11 + `t1.lan-control`（2026-10-18 用户裁决「局域网启停用户和 AI 都能操作」）。
 * scoped=true 的三项要求动作携带范围且越界即拒。
 */
export const T1_CAPABILITIES: readonly CapabilityDef[] = [
  {
    key: 't1.collector',
    tier: 'T1',
    title: '采集环境状态/桌面',
    description: '采集环境状态、桌面等交给 AI（范围可配、用户可见）'
  },
  {
    key: 't1.executor-high-risk',
    tier: 'T1',
    title: '执行器高风险动作',
    description: '写文件、执行命令、操作设备、调用外部服务（ROOM 自主执行器）'
  },
  {
    key: 't1.authorized-target-ops',
    tier: 'T1',
    title: '对已授权目标的探测/利用',
    description: '在用户填写的授权范围内执行探测/利用（目标清单 + 有效期）',
    scoped: true
  },
  {
    key: 't1.data-destructive',
    tier: 'T1',
    title: '数据删除/移动/覆盖',
    description: '对用户自己的数据做删除、移动、覆盖'
  },
  {
    key: 't1.migrate',
    tier: 'T1',
    title: '跨节点迁移/接续/复制自身',
    description: '在用户可见可编辑可撤回的授权节点白名单内迁移/接续/复制',
    scoped: true
  },
  {
    key: 't1.declared-egress',
    tier: 'T1',
    title: '向已声明端点传输数据',
    description: '向用户已声明的端点传输数据（含 LAN 内节点互传）',
    scoped: true
  },
  {
    key: 't1.credentials',
    tier: 'T1',
    title: '使用用户提供的凭据',
    description: '使用用户主动提供的凭据访问外部服务'
  },
  {
    key: 't1.tool-zone-enable',
    tier: 'T1',
    title: '工具区产物启用',
    description: '把 AI 自造工具投入执行器使用'
  },
  {
    key: 't1.relay-forward',
    tier: 'T1',
    title: '替他人中转',
    description: '路由层每跳转发授权（替他人中转数据）'
  },
  {
    key: 't1.telemetry-off',
    tier: 'T1',
    title: '降低/关闭自身遥测',
    description: '仅本机范围内的自身遥测开关'
  },
  {
    key: 't1.model-config',
    tier: 'T1',
    title: '修改模型池/成本上限/钉死模型',
    description: '模型配置的「改配置」属授予项；AI 只能在池内选择'
  },
  {
    key: 't1.lan-control',
    tier: 'T1',
    title: '局域网启停',
    description: '开启/关闭局域网监听；开启会扩大网络暴露面（用户与 AI 都可操作，AI 需先获授予）'
  }
]

/**
 * T2 默认开：低风险，无需授予。
 * 对应交接单 §0 T2（只读环境元数据、规划、记忆检索、拓扑/地图可视化、只读工具、日志与审计读取、
 * 池内按策略选择模型）。
 */
export const T2_CAPABILITIES: readonly CapabilityDef[] = [
  { key: 't2.read-env', tier: 'T2', title: '只读环境元数据', description: '读取环境元数据（不触碰桌面/用户数据）' },
  { key: 't2.plan', tier: 'T2', title: '规划', description: '制定/调整计划' },
  { key: 't2.memory-retrieval', tier: 'T2', title: '记忆检索', description: '检索记忆系统' },
  { key: 't2.topology-view', tier: 'T2', title: '拓扑/地图可视化', description: '查看节点拓扑与局域网地图' },
  { key: 't2.readonly-tools', tier: 'T2', title: '只读工具', description: '调用只读工具' },
  { key: 't2.audit-read', tier: 'T2', title: '日志与审计读取', description: '读取日志与审计记录' },
  { key: 't2.model-select-in-pool', tier: 'T2', title: '池内按策略选择模型', description: '在用户配置的模型池内按策略选择模型' },
  {
    key: 't2.room-avatar',
    tier: 'T2',
    title: '绘制自身像素形象/房间',
    description: 'AI 声明式重画自己的像素房间与形象（受限尺寸/调色板的纯数据，无外部资源；见 shared/room/avatar-spec）'
  }
]

/** 全量分级目录（T0 → T1 → T2 顺序，供 UI 分组展示与测试遍历）。 */
export const ALL_CAPABILITIES: readonly CapabilityDef[] = [
  ...T0_CAPABILITIES,
  ...T1_CAPABILITIES,
  ...T2_CAPABILITIES
]

/** key → 定义（O(1) 裁决查表）。 */
export const CAPABILITY_BY_KEY: ReadonlyMap<string, CapabilityDef> = new Map(
  ALL_CAPABILITIES.map((c) => [c.key, c])
)

/** 按 key 取能力定义；未登记返回 undefined（裁决层据此 fail-closed）。 */
export function resolveCapability(key: string): CapabilityDef | undefined {
  return CAPABILITY_BY_KEY.get(key)
}

/**
 * 该能力是否可被用户授予。
 * 只有 T1 可授予——T0 永不可授予（§0「T0 不提供关掉即放行的开关」），
 * T2 默认开无需授予。授予 IPC 与裁决层共用本判定，保证两侧口径一致。
 */
export function isGrantable(key: string): boolean {
  return resolveCapability(key)?.tier === 'T1'
}
