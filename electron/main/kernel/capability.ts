/**
 * 声明式能力拦截（CapabilityGuard）——内核，对齐 Cordis interception

 * 把「空间可组合」的细粒度授权实现为 interception：能力/风险元数据挂在工具/组件上，
 * 提供方（运行时）在调用时按其 meta 决定是否放行；**拦截元数据可运行时增减、不触发 reload**。
 * 月蚀落地为：
 * - 工具 meta 增 `caps`（声明所需能力，见 shared/tools/registry.ts ToolMeta）
 * - 全局 CapabilityGuard 在工具执行前按 config.capabilityPolicy 做「结构化、声明式」的统一闸，
 * 替代/补充逐个手写散落 hook；策略存 config（getEffective 实时读=运行时可改、不触发插件 reload）

 * 目标对比：这不是新保护区。默认（未配置 policy 或 enabled=false）**全放行**，
 * 不改变既定边界「AI 可直接写任何文件」（该边界是工作域自治前提，见 WORKSPACE.md）。
 * 它提供的是**可选开启**的声明式能力控制（agents 归属/riskLevel 已控，这里补 cap 级拦截）。
 */
import type { ToolMeta } from '../../../shared/tools/registry'

/** 声明式能力策略（存 config.capabilityPolicy，getEffective 实时读） */
export interface CapabilityPolicy {
  /** 总开关：false/缺省=不启用，全部放行（向后兼容）。true=启用声明式拦截 */
  enabled?: boolean
  /** 显式禁用的工具名（精确匹配） */
  denyTools?: string[]
  /** 禁用的能力标签（工具 caps 含任一即拦）；空=不按 cap 拦 */
  denyCaps?: string[]
  /** 可选：白名单模式——设置后，未声明任何允许能力且声明了 requireCaps 里没有的 cap 的工具会被拦（高级用法） */
  allowCaps?: string[]
  /** 高风险工具拦截：true 时 riskLevel='high' 的工具默认拒绝，需在 allowHighRiskTools 中显式允许 */
  denyHighRisk?: boolean
  /** 高风险工具白名单（denyHighRisk=true 时，此列表中的工具不受 high 风险拦截） */
  allowHighRiskTools?: string[]
}

/** 能力检查结果 */
export interface CapabilityDecision {
  allowed: boolean
  /** 拦截原因（allowed=false 时给出可读说明） */
  reason?: string
}

/** 读取并解析 config 里的 capabilityPolicy（宽松，容忍缺省/半结构） */
export function readCapabilityPolicy(config?: unknown): CapabilityPolicy {
  if (!config) return {}
  const p = (config as { capabilityPolicy?: unknown }).capabilityPolicy
  if (!p || typeof p !== 'object') return {}
  const obj = p as Record<string, unknown>
  return {
    enabled: obj.enabled === true,
    denyTools: Array.isArray(obj.denyTools) ? obj.denyTools.filter((x) => typeof x === 'string') : undefined,
    denyCaps: Array.isArray(obj.denyCaps) ? obj.denyCaps.filter((x) => typeof x === 'string') : undefined,
    allowCaps: Array.isArray(obj.allowCaps) ? obj.allowCaps.filter((x) => typeof x === 'string') : undefined,
    denyHighRisk: obj.denyHighRisk === true ? true : undefined,
    allowHighRiskTools: Array.isArray(obj.allowHighRiskTools) ? obj.allowHighRiskTools.filter((x) => typeof x === 'string') : undefined
  }
}

/**
 * 统一能力闸：在工具执行前调用。
 * @param toolName 工具名
 * @param meta 工具元数据（取 caps/riskLevel 用；可空——MCP/未注册时不拦）
 * @param config 当前生效配置（读 capabilityPolicy）
 * @param effective 覆盖读（默认内部 readCapabilityPolicy(config)）
 */
export function checkCapability(
  toolName: string,
  meta: Pick<ToolMeta, 'caps' | 'riskLevel'> | undefined,
  config?: unknown,
  effective?: CapabilityPolicy
): CapabilityDecision {
  const policy = effective ?? readCapabilityPolicy(config)
  if (!policy.enabled) return { allowed: true } // 默认/未开启：全放行

  // 1) 显式禁用工具
  if (policy.denyTools?.includes(toolName)) {
    return { allowed: false, reason: `工具 "${toolName}" 被声明式能力策略显式禁用` }
  }

  // 2) 高风险工具拦截：denyHighRisk 开启时，riskLevel='high' 的工具默认拒绝
  // 除非在 allowHighRiskTools 白名单中显式允许
  const riskLevel = meta?.riskLevel
  if (policy.denyHighRisk && riskLevel === 'high' && !policy.allowHighRiskTools?.includes(toolName)) {
    return {
      allowed: false,
      reason: `工具 "${toolName}" 为高风险工具（riskLevel=high），需在 allowHighRiskTools 中显式允许`
    }
  }

  // 3) 按能力标签：工具 caps 含任一被禁 cap → 拦
  const caps = meta?.caps ?? []
  if (policy.denyCaps && policy.denyCaps.length > 0) {
    const hit = caps.find((c) => policy.denyCaps!.includes(c))
    if (hit) {
      return { allowed: false, reason: `工具 "${toolName}" 需要被禁的能力 "${hit}"` }
    }
  }

  // 4) 白名单模式：工具声明了 caps 但全部不在 allowCaps 中 → 拦
  // 未声明 caps 的工具不参与 cap 系统 → 保守放行（不误伤 MCP/外部工具）
  if (policy.allowCaps && policy.allowCaps.length > 0) {
    if (caps.length > 0 && !caps.some((c) => policy.allowCaps!.includes(c))) {
      return {
        allowed: false,
        reason: `工具 "${toolName}" 声明的能力 [${caps.join(', ')}] 不在允许清单 [${policy.allowCaps.join(', ')}] 内`
      }
    }
  }

  return { allowed: true }
}
