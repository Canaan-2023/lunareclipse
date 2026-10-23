/**
 * @category 工具
 * @summary 局域网启停工具（AI 侧）：查询状态 / 开启 / 关闭局域网
 *
 * 为什么存在：用户裁决「局域网启停**用户和 AI 都能操作**」——AI 侧必须有工具入口，
 * 且该入口**必须先过 `t1.lan-control` 授予裁决**（ADR-11 唯一 policy 检查点），否则
 * 「AI 不能给自己授权」这条边界会在「改网络暴露面」这个高危动作上破口。
 *
 * 不删理由：删掉即 AI 无法按用户要求开关局域网；或退化成绕过权限层直接改配置。
 *
 * 生效方式：工具只写 `config.lan.enabled`；真正的起停由 `bootstrap/assembly-ipc.ts` 的
 * 配置变更订阅落地（与用户路径同一处）——工具拿不到 `userStore`，不在工具内直连启停。
 */
import type { AnyTool, ToolParameter, ToolResult, ToolContext } from './base-tool'
import type { AuditSink, SecurityGrants } from '@shared/types/permission'
import { EMPTY_GRANTS, evaluatePolicy } from './security-engine/policy-gate'
import { createFileAuditSink, defaultAuditFilePath } from './security-engine/audit-log'

export class LanControlTool implements AnyTool {
  /**
   * @param audit 审计落点；缺省写锚点派生的 JSONL。测试注入 no-op，避免单测写仓库 `data/`（R-T2）。
   */
  constructor(private readonly audit?: AuditSink) {}

  name = 'lan_control'
  description =
    '管理局域网协作开关。action=status 查看当前状态（是否开启、角色、已知节点数）；' +
    'action=enable 开启局域网（会扩大网络暴露面）；action=disable 关闭局域网。' +
    '开启/关闭属 T1 显式授予能力（键 t1.lan-control）：未获用户授予时会被拒绝，并返回如何授予的提示。'
  parameters: ToolParameter[] = [
    {
      name: 'action',
      type: 'string',
      description: '操作：status（查询）/ enable（开启）/ disable（关闭）',
      required: true
    }
  ]

  async execute(params: Record<string, unknown>, ctx?: ToolContext): Promise<ToolResult> {
    const mi = ctx?.getMultiInstance?.()
    if (!mi) return { ok: false, error: '多实例服务不可用（未初始化）' }

    const action = String(params.action ?? 'status').trim().toLowerCase()
    if (action === 'status') {
      const stack = mi.getRoutingStack()
      return {
        ok: true,
        data: {
          running: stack != null,
          role: mi.getRole(),
          nodeCount: stack ? stack.routing.getGraph().nodes.size : 0
        }
      }
    }
    if (action !== 'enable' && action !== 'disable') {
      return { ok: false, error: `未知 action「${action}」：可选 status / enable / disable` }
    }

    // 每跳授权（ADR-11 唯一检查点）：AI 操作局域网启停须先获 t1.lan-control 授予
    const grants = (ctx?.config as { securityGrants?: SecurityGrants } | undefined)?.securityGrants ?? EMPTY_GRANTS
    const audit: AuditSink = this.audit ?? createFileAuditSink(defaultAuditFilePath())
    const decision = evaluatePolicy(
      { capability: 't1.lan-control', action: `lan.${action}`, actor: 'ai' },
      { getGrants: () => grants, now: () => Date.now(), audit }
    )
    if (!decision.allowed) {
      const hint = decision.grantHint ? `；${decision.grantHint}` : ''
      return { ok: false, error: `${decision.reason}${hint}` }
    }

    const enabled = action === 'enable'
    if (!ctx?.updateConfig) return { ok: false, error: '配置写入通道不可用（当前环境未注入 updateConfig）' }
    ctx.updateConfig((cfg) => ({
      ...cfg,
      lan: { ...((cfg.lan as Record<string, unknown> | undefined) ?? {}), enabled }
    }))
    return {
      ok: true,
      data: {
        requested: enabled ? 'enable' : 'disable',
        note: '配置已更新，局域网将按新配置起停（由配置变更订阅落地）'
      }
    }
  }
}
