/**
 * 模块自省工具：为什么存在——AI 需要按模块维度理解自身架构（清单/状态/维护规则），
 * 是 kernel_introspect 在模块层视角的补充。
 * 作用：module_inspect 列出模块定义、状态与维护指南，支持类别过滤与详情查看。
 */
import type { ToolContext, ToolResult } from './base-tool'
import { MODULE_DEFS } from '../monitor/module-registry'
import type { ModuleDef } from '../monitor/module-registry'
import { MAINTENANCE_GUIDES, type MaintenanceCategory } from '../monitor/maintenance-guides'

/**
 * module_inspect：模块自省工具——AI 查看自身架构模块的清单、状态、详情、维护规则。
 *
 * - action=overview：全部模块清单 + 运行时状态（紧凑版）
 * - action=detail：指定模块详情（功能/关键文件/状态 + 对应维护规则）
 * - action=maintain：指定类别的维护规则（module/plugin/skill/hook/config/health）
 */
export class ModuleInspectTool {
  name = 'module_inspect'
  description = `查看自身架构模块。action=overview 返回全部模块清单+运行时状态（标红/标绿）；action=detail 按 id 返回模块功能/关键文件/状态+维护规则；action=maintain 返回指定类别的维护指导（module/plugin/skill/hook/config/health）。全量系统构造（模块/插件清单与文件路径）由启动自动生成，见 kernel 段系统构造指引（system-catalog）。动手改模块前先 detail 查清楚。`
  parameters = [
    { name: 'action', type: 'string' as const, description: 'overview（默认）/ detail / maintain', required: false },
    { name: 'id', type: 'string' as const, description: '模块 ID（detail 模式必填，如 tools / main / health-check）', required: false },
    { name: 'category', type: 'string' as const, description: '维护类别（maintain 模式：module/plugin/skill/hook/config/health）', required: false }
  ]

  async execute(params: Record<string, unknown>, ctx?: ToolContext): Promise<ToolResult> {
    const action = String(params.action ?? 'overview').trim()

    if (action === 'maintain') {
      const cat = String(params.category ?? 'module').trim() as MaintenanceCategory
      if (!(cat in MAINTENANCE_GUIDES)) {
        return { ok: false, error: `未知维护类别：${cat}。可选：${Object.keys(MAINTENANCE_GUIDES).join(' / ')}` }
      }
      return { ok: true, data: { category: cat, guide: MAINTENANCE_GUIDES[cat] } }
    }

    if (action === 'detail') {
      const id = String(params.id ?? '').trim()
      if (!id) return { ok: false, error: 'detail 模式需要 id 参数（如 tools / main / health-check）' }
      const def = MODULE_DEFS.find((m) => m.id === id)
      if (!def) {
        const ids = MODULE_DEFS.map((m) => m.id).join(', ')
        return { ok: false, error: `未知模块 id：${id}。可用 id：${ids}` }
      }
      const status = ctx?.getModuleRegistry?.()?.getSnapshot().find((s) => s.id === id)
      const maintCat = mapCategoryToGuide(def.category)
      return {
        ok: true,
        data: {
          id: def.id,
          name: def.name,
          category: def.category,
          description: def.description,
          keyFiles: def.keyFiles,
          ok: status?.ok ?? null,
          error: status?.error ?? '',
          updatedAt: status?.updatedAt ?? null,
          maintenanceGuide: MAINTENANCE_GUIDES[maintCat]
        }
      }
    }

    // overview
    const snapshot = ctx?.getModuleRegistry?.()?.getSnapshot() ?? MODULE_DEFS.map((m) => ({ ...m, ok: null, error: '', updatedAt: null }))
    const compact = snapshot.map((m) => ({
      id: m.id,
      name: m.name,
      category: m.category,
      ok: m.ok,
      error: m.error || undefined
    }))
    const failing = compact.filter((m) => m.ok === false)
    return {
      ok: true,
      data: {
        total: compact.length,
        failing: failing.length,
        failingIds: failing.map((m) => m.id),
        modules: compact
      }
    }
  }
}

function mapCategoryToGuide(cat: ModuleDef['category']): MaintenanceCategory {
  switch (cat) {
    case '核心':
    case '工具':
    case '渲染':
    case '基础设施':
      return 'module'
    case '记忆系统':
      return 'module'
    case '监控':
      return 'health'
    default:
      return 'module'
  }
}
