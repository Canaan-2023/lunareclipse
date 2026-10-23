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
 * 授权范围的输入上限（**主进程与渲染进程同一口径**）。
 * 为什么放在目录旁：范围是白名单而不是正文；没有上限时，一次误粘贴就能把几十万条写进
 * `AppConfig` 与 `audit.jsonl`（SRE / 代码评审 P1）。前端只做提示，主进程必须**实际执行**。
 */
export const GRANT_SCOPE_ENTRY_MAX = 200
export const GRANT_SCOPE_MAX_ENTRIES = 200

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
    description: '采集环境状态、桌面等交给 AI（采哪几类由设置里的用户层开关决定；本授予决定 AI 能否采）',
    usage: '授予后：AI 可在你打开的用户层开关范围内采集；每次采集仍过同一检查点并留审计。未授予时你发消息仍能到达 AI。'
  },
  {
    key: 't1.executor-high-risk',
    tier: 'T1',
    title: '执行器高风险动作',
    description: '写文件、执行命令、操作设备、调用外部服务（ROOM 自主执行器）',
    usage: '授予后：ROOM 执行器可直接做这些事，不再逐次询问；每一步仍走同一检查点并留审计。'
  },
  {
    key: 't1.authorized-target-ops',
    tier: 'T1',
    title: '对已授权目标的探测/利用',
    description: '在用户填写的授权范围内执行探测/利用（目标清单 + 有效期）',
    scoped: true,
    scopeField: 'targets',
    usage: '授予后：只对你圈定的目标做探测/利用；范围外一律拒绝。',
    scopeHint: '填 IP / 主机名 / URL（也可以填路径）。每行一项；AI 会按这些地址自己去找，不在这里的一律拒绝。',
    scopeExamples: ['127.0.0.1', '192.168.1.10', 'https://example.com'],
    scopeSource: 'hosts'
  },
  {
    key: 't1.data-destructive',
    tier: 'T1',
    title: '数据删除/移动/覆盖',
    description: '对用户自己的数据做删除、移动、覆盖',
    usage: '授予后：AI 可删除 / 移动 / 覆盖你的数据，**不可撤销**。不确定就先别给。'
  },
  {
    key: 't1.migrate',
    tier: 'T1',
    title: '跨节点迁移/接续/复制自身',
    description: '在用户可见可编辑可撤回的授权节点白名单内迁移/接续/复制',
    scoped: true,
    scopeField: 'nodes',
    usage: '授予后：AI 可在白名单节点之间迁移 / 接续 / 复制自身；白名单外的节点一律拒绝。',
    scopeHint: '从下面的局域网节点里勾选（也可以手动填节点 UID 或地址）。没开局域网时列表为空，仍可手填。',
    scopeExamples: ['1', '2'],
    scopeSource: 'lan-nodes'
  },
  {
    key: 't1.declared-egress',
    tier: 'T1',
    title: '向已声明端点传输数据',
    description: '向用户已声明的端点传输数据（含 LAN 内节点互传）',
    scoped: true,
    scopeField: 'endpoints',
    usage: '授予后：AI 可把数据发往你声明过的端点（含局域网互传）；其它地址一律拒绝。',
    scopeHint: '填接收数据的地址：URL / IP:端口 / 共享路径均可，每行一项。',
    scopeExamples: ['https://example.com/webhook', 'http://192.168.1.10:8080', '\\\\NAS\\inbox'],
    scopeSource: 'endpoints'
  },
  {
    key: 't1.credentials',
    tier: 'T1',
    title: '使用用户提供的凭据',
    description: '使用用户主动提供的凭据访问外部服务',
    usage: '授予后：AI 可用你主动提供的凭据访问外部服务；凭据本身不在这里填写。'
  },
  {
    key: 't1.tool-zone-enable',
    tier: 'T1',
    title: '工具区产物启用',
    description: '把 AI 自造工具投入执行器使用',
    usage: '授予后：工具区里被启用的 AI 自造工具可进入执行器；每一步仍会过门控。'
  },
  {
    key: 't1.relay-forward',
    tier: 'T1',
    title: '替他人中转',
    description: '路由层每跳转发授权（替他人中转数据）',
    usage: '授予后：本节点可替局域网里的其他节点中转数据（每跳都留痕）。'
  },
  {
    key: 't1.telemetry-off',
    tier: 'T1',
    title: '降低/关闭自身遥测',
    description: '仅本机范围内的自身遥测开关',
    usage: '授予后：AI 可在本机范围内调低/关闭自身遥测；不影响权限审计落盘。'
  },
  {
    key: 't1.model-config',
    tier: 'T1',
    title: '修改模型池/成本上限/钉死模型',
    description: '模型配置的「改配置」属授予项；AI 只能在池内选择',
    usage: '授予后：AI 可修改模型池 / 成本上限 / 钉死模型；不授予时它只能在既有池内选。'
  },
  {
    key: 't1.lan-control',
    tier: 'T1',
    title: '局域网启停',
    description: '开启/关闭局域网监听；开启会扩大网络暴露面（用户与 AI 都可操作，AI 需先获授予）',
    usage: '授予后：AI 可开启/关闭局域网监听。开启会扩大网络暴露面——不需要时请撤回。'
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
