/**
 * 技能库巡检工具：为什么存在——技能会随时间过时或冗余（缺 frontmatter、长期未用），
 * 需要定期整理归档以保持技能库健康可用。
 * 作用：curator 扫描技能库，校验 SKILL.md 有效性并将失活技能归档到 .archive。
 */
import { existsSync, mkdirSync, renameSync, readdirSync, statSync } from 'fs'
import { join, dirname } from 'path'
import type { AnyTool, ToolResult, ToolContext } from './base-tool'
import type { SkillLoader } from '../skills/loader'
import { getUserSkillsDir } from '../skills/loader'

/**
 * curator 工具：技能库生命周期维护

 * 技能库生命周期维护（stale 检测→归档）：
 * - 跟踪 use_count/last_activity，闲置技能标记 stale → 归档（不删除）。
 * 只动 agent 创建的技能，内置/市场技能不动。
 * - 月蚀版：SkillLoader 已有使用统计（.skills-usage.json：useCount/lastUsedAt），
 * 本工具提供三个动作：
 * - status：列出技能 + 使用次数 + 最后使用时间 + 闲置天数
 * - archive：把超过 N 天未使用的技能移到 .archive/ 目录（不删除，可恢复）
 * - restore：把 .archive/ 中的技能移回 skills 目录

 * 边界（保守原则）：
 * - 只归档 user/project 来源的技能，builtin（随应用分发）不归档
 * - 归档是"移出活动区"不是删除——AI 可随时移回
 * - archive 默认 dry-run（先看会动谁，确认后再真正归档）
 */

const STALE_DAYS_DEFAULT = 30
/** 归档目录名（位于用户技能目录下，loader 扫描时以 . 开头自然跳过） */
const ARCHIVE_DIR = '.archive'

interface CuratorParams {
  /** 动作：status=查看统计 / archive=归档闲置技能 / restore=恢复已归档技能 */
  action: 'status' | 'archive' | 'restore'
  /** 归档阈值天数（默认 30；archive 动作用） */
  days?: number
  /** 要恢复的技能名（restore 动作用；不填则列出可恢复的已归档技能） */
  skillName?: string
  /** 真正执行归档/恢复（默认 false = dry-run 只预览） */
  apply?: boolean
}

function daysSince(ts: number | null): number | null {
  if (!ts) return null
  return Math.floor((Date.now() - ts) / 86400000)
}

export class CuratorTool implements AnyTool {
  name = 'curator'
  description = `技能库生命周期维护。动作：status=列出技能使用统计（次数/最后使用/闲置天数）；archive=把超过 N 天未使用的技能移到 .archive 目录（默认只预览不执行，apply=true 才真正归档；只归档用户/领域级技能，内置技能不动）；restore=把 .archive 中的技能移回 skills 目录（默认只预览不执行，apply=true 才真正恢复；不传 skillName 列出可恢复列表）。参数：action（必填）、days（归档阈值，默认 30）、skillName（恢复指定技能）、apply（默认 false）。`
  parameters = [
    { name: 'action', type: 'string' as const, description: 'status | archive | restore', required: true },
    { name: 'days', type: 'number' as const, description: '归档阈值天数（默认 30）', required: false },
    { name: 'skillName', type: 'string' as const, description: '要恢复的技能名（restore 动作用；不填则列出可恢复技能）', required: false },
    { name: 'apply', type: 'boolean' as const, description: 'archive/restore 动作真正执行（默认 false = 只预览不执行）', required: false }
  ]

  async execute(params: Record<string, unknown>, ctx?: ToolContext): Promise<ToolResult> {
    const p = params as unknown as CuratorParams
    const loader = ctx?.skillLoader
    if (!loader) {
      return { ok: false, error: 'Skills 加载器未初始化' }
    }
    const action = p.action ?? 'status'
    if (!['status', 'archive', 'restore'].includes(action)) {
      return { ok: false, error: `未知动作: ${action}（支持 status/archive/restore）` }
    }
    const days = Math.max(p.days ?? STALE_DAYS_DEFAULT, 1)
    const apply = !!p.apply

    if (action === 'status') return this.status(loader)
    if (action === 'restore') return this.restore(loader, p.skillName, apply)
    return this.archive(loader, days, apply)
  }

  /** status：全量技能使用统计 */
  private status(loader: SkillLoader): ToolResult {
    const statuses = loader.getStatuses()
    const lines = statuses.map((s) => {
      const last = s.lastUsedAt ? new Date(s.lastUsedAt).toISOString().slice(0, 16) : '从未使用'
      const idle = daysSince(s.lastUsedAt)
      const idleStr = idle === null ? '—' : `${idle} 天`
      const src = s.source === 'user' ? '用户' : '项目'
      return `- ${s.name} [${src}] 用 ${s.useCount} 次 / 最后 ${last} / 闲置 ${idleStr}${s.enabled ? '' : '（已禁用）'}`
    })
    if (lines.length === 0) return { ok: true, data: { message: '技能库为空' } }
    return {
      ok: true,
      data: {
        count: statuses.length,
        skills: lines,
        hint: '需要归档闲置技能用 curator(action="archive", days=N, apply=true)；先不带 apply 预览。'
      }
    }
  }

  /** archive：闲置技能移到 .archive（dry-run 默认） */
  private archive(loader: SkillLoader, days: number, apply: boolean): ToolResult {
    const statuses = loader.getStatuses()
    const candidates = statuses.filter((s) => {
      // 用户/领域级均可归档
      if (!s.lastUsedAt) return true // 从未使用 = 候选
      return daysSince(s.lastUsedAt)! >= days
    })

    if (candidates.length === 0) {
      return { ok: true, data: { message: `没有闲置超过 ${days} 天的用户/领域级技能，无需归档` } }
    }

    const lines = candidates.map((s) => {
      const idle = s.lastUsedAt ? `${daysSince(s.lastUsedAt)} 天` : '从未使用'
      return `- ${s.name}（${s.source}，闲置 ${idle}，用 ${s.useCount} 次）`
    })

    if (!apply) {
      return {
        ok: true,
        data: {
          dryRun: true,
          message: `以下 ${candidates.length} 个技能闲置超过 ${days} 天（dry-run 预览，未实际归档）：\n${lines.join('\n')}\n\n确认归档请加 apply=true。归档是移入 .archive 目录，不是删除，可随时移回。`
        }
      }
    }

    // 真正归档：按 dirPath 移动整个技能目录
    const moved: string[] = []
    const failed: string[] = []
    for (const s of candidates) {
      try {
        const meta = loader.findMetadata(s.name)
        if (!meta) {
          failed.push(`${s.name}（找不到元数据）`)
          continue
        }
        const srcDir = meta.dirPath
        if (!existsSync(srcDir)) {
          failed.push(`${s.name}（目录不存在: ${srcDir}）`)
          continue
        }
        const archiveDir = join(dirname(srcDir), ARCHIVE_DIR)
        mkdirSync(archiveDir, { recursive: true })
        const dest = join(archiveDir, s.name)
        if (existsSync(dest)) {
          failed.push(`${s.name}（.archive 已有同名目录）`)
          continue
        }
        renameSync(srcDir, dest)
        moved.push(s.name)
      } catch (err) {
        failed.push(`${s.name}（${(err as Error).message}）`)
      }
    }

    if (moved.length > 0) {
      loader.load() // 热重载：让技能索引反映归档
    }

    const parts: string[] = []
    if (moved.length > 0) parts.push(`已归档 ${moved.length} 个：${moved.join('、')}`)
    if (failed.length > 0) parts.push(`失败 ${failed.length} 个：${failed.join('、')}`)
    parts.push('归档 = 移入 .archive 目录，未删除。需要恢复时把目录移回原位置即可。')
    return { ok: failed.length === 0, data: { message: parts.join('\n') } }
  }

  /** restore：把 .archive 中的技能移回 skills 目录 */
  private restore(loader: SkillLoader, skillName: string | undefined, apply: boolean): ToolResult {
    const archiveDirs = this.findArchiveDirs(loader)

    if (archiveDirs.length === 0) {
      return { ok: true, data: { message: '没有 .archive 目录（无已归档技能可恢复）' } }
    }

    if (!skillName || skillName.includes('/') || skillName.includes('\\') || skillName.includes('..')) {
      return { ok: false, error: 'skillName 必须是不含路径分隔符或 .. 的纯名称' }
    }

    if (!skillName) {
      const archived: string[] = []
      for (const dir of archiveDirs) {
        try {
          for (const entry of readdirSync(dir)) {
            const entryPath = join(dir, entry)
            try {
              if (statSync(entryPath).isDirectory()) {
                archived.push(`${entry}（位于 ${dir}）`)
              }
            } catch { /* skip unreadable entries */ }
          }
        } catch { /* skip unreadable archive dirs */ }
      }
      if (archived.length === 0) {
        return { ok: true, data: { message: '.archive 目录中没有已归档技能' } }
      }
      return {
        ok: true,
        data: {
          archived,
          hint: '恢复用 curator(action="restore", skillName="技能名", apply=true)'
        }
      }
    }

    for (const archiveDir of archiveDirs) {
      const archivedPath = join(archiveDir, skillName)
      if (!existsSync(archivedPath)) continue

      const skillsDir = dirname(archiveDir)
      const dest = join(skillsDir, skillName)

      if (existsSync(dest)) {
        return { ok: false, error: `技能 ${skillName} 已存在于活动目录: ${dest}（可能已恢复过或有同名技能）` }
      }

      if (!apply) {
        return {
          ok: true,
          data: {
            dryRun: true,
            message: `将恢复 ${skillName}：从 ${archivedPath} 移回 ${dest}\n确认恢复请加 apply=true。`
          }
        }
      }

      try {
        renameSync(archivedPath, dest)
        loader.load()
        return { ok: true, data: { message: `已恢复技能 ${skillName}：从 ${archivedPath} 移回 ${dest}` } }
      } catch (err) {
        return { ok: false, error: `恢复 ${skillName} 失败: ${(err as Error).message}` }
      }
    }

    return { ok: false, error: `在 .archive 目录中找不到已归档技能: ${skillName}` }
  }

  /** 扫描所有技能根目录下的 .archive 目录 */
  private findArchiveDirs(loader: SkillLoader): string[] {
    const skillsRoots = new Set<string>()
    for (const meta of loader.listMetadata()) {
      skillsRoots.add(dirname(meta.dirPath))
    }
    skillsRoots.add(getUserSkillsDir())

    const archiveDirs: string[] = []
    for (const root of skillsRoots) {
      const archiveDir = join(root, ARCHIVE_DIR)
      if (existsSync(archiveDir)) {
        archiveDirs.push(archiveDir)
      }
    }
    return archiveDirs
  }
}