/**
 * 定时任务管理工具：为什么存在——AI 需要自主安排"到点做事"（复盘/日报/监控），
 * 把调度诉求落入进程内定时器而不是依赖用户手动执行。
 * 作用：cron_manage 提供 list / upsert / delete 三种动作管理 cron/scheduler 的定时任务。
 */
import type { ToolContext, ToolResult } from './base-tool'

// cron_manage 工具：AI 自主调度（定时任务管理）
//
// 动作：
// - list 列出全部定时任务（id/schedule/prompt/enabled）
// - upsert 新增或更新任务（同 id 覆盖；schedule 三种格式）
// - delete 删除任务
// - toggle 启用/停用
//
// schedule 支持三种格式：
// - 间隔型："30m" / "2h" / "every 6h" / "every 30m"
// - cron 型："分 时 日 月 周"（5 段，"0 9 * * 1-5"=工作日9点、"0 */6 * * *"=每6小时整点）
// - 一次性：ISO 8601 时间戳（触发后自动禁用）
//
// 典型用途：定期复盘（读决策日志提炼经验）、定期维护（技能归档）、周期汇报。
// 任务到点会通过激活机制唤醒 AI 执行（prompt 文本作为指令注入）。
export class CronManageTool {
  name = 'cron_manage'
  description = `管理定时任务（cron）。动作：list=列出全部任务；upsert=新增/更新（id/schedule/prompt/enabled，同 id 覆盖）；delete=删除；toggle=启用/停用。
schedule 三种格式：间隔型 "every 6h"/"30m"/"2h"；cron 5 段 "0 9 * * 1-5"=工作日9点、"0 */6 * * *"=每6小时；ISO 时间戳=一次性。
到点任务会唤醒 AI 执行。先 list 看现有任务再 upsert，避免重复建。`
  parameters = [
    {
      name: 'action',
      type: 'string' as const,
      description: 'list / upsert / delete / toggle',
      required: true
    },
    {
      name: 'id',
      type: 'string' as const,
      description: '任务 id（kebab-case，upsert/delete/toggle 必填）',
      required: false
    },
    {
      name: 'schedule',
      type: 'string' as const,
      description: '调度表达式（upsert 必填）：间隔型 every 6h/30m/2h，或 cron 5 段 "0 9 * * 1-5"，或 ISO 时间戳',
      required: false
    },
    {
      name: 'prompt',
      type: 'string' as const,
      description: '任务指令文本（到点会作为你的任务消息出现，upsert 必填）',
      required: false
    },
    {
      name: 'enabled',
      type: 'boolean' as const,
      description: '是否启用（默认 true）',
      required: false
    }
  ]

  async execute(params: Record<string, unknown>, ctx?: ToolContext): Promise<ToolResult> {
    const scheduler = ctx?.getCronScheduler?.()
    if (!scheduler) return { ok: false, error: '定时任务调度器不可用（未初始化）' }
    const action = params.action as string | undefined
    const id = params.id as string | undefined

    if (action === 'list') {
      return { ok: true, data: { jobs: scheduler.listJobs() } }
    }

    if (action === 'upsert') {
      if (!id?.trim()) return { ok: false, error: 'upsert 需要 id' }
      const schedule = params.schedule as string | undefined
      const prompt = params.prompt as string | undefined
      if (!schedule?.trim()) return { ok: false, error: 'upsert 需要 schedule（间隔型/cron 5 段/ISO 三选一）' }
      if (!prompt?.trim()) return { ok: false, error: 'upsert 需要 prompt（任务指令文本）' }
      const result = scheduler.upsertJob({
        id: id.trim(),
        schedule: schedule.trim(),
        prompt: prompt.trim(),
        enabled: params.enabled === undefined ? true : params.enabled === true
      })
      if (!result.ok) return { ok: false, error: result.error ?? '写入失败' }
      return { ok: true, data: { note: `任务 ${id} 已保存（${schedule}）` } }
    }

    if (action === 'delete') {
      if (!id?.trim()) return { ok: false, error: 'delete 需要 id' }
      scheduler.deleteJob(id.trim())
      return { ok: true, data: { note: `任务 ${id} 已删除` } }
    }

    if (action === 'toggle') {
      if (!id?.trim()) return { ok: false, error: 'toggle 需要 id' }
      const enabled = params.enabled === true
      scheduler.toggleJob(id.trim(), enabled)
      return { ok: true, data: { note: `任务 ${id} ${enabled ? '已启用' : '已停用'}` } }
    }

    return { ok: false, error: `未知 action: ${String(action)}（支持 list/upsert/delete/toggle）` }
  }
}
