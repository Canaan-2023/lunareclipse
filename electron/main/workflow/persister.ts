/**
 * L8 工作流引擎：实例状态持久化 + 模板管理



 * 职责：
 * - 实例状态存盘：每次节点状态变化/上下文更新都同步写磁盘（崩溃恢复用）
 * - 实例完成后归档（移到 archive/ 目录，保留最近 50 个，超出清理最旧）
 * - 模板增删改查（CRUD）+ 导入导出 + 内存缓存（减少磁盘 IO）

 * 原子写：所有 save 操作先写 .tmp 再 rename，避免进程崩溃留下半截损坏文件

 * 不做的事：
 * - 不操心 raw_memory（由 RawMemoryWriter 在 stream 结束时自动写）
 */
import { basename, join, dirname } from 'path'
import { randomBytes } from 'crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync, renameSync, statSync } from 'fs'
import type { BaseDataPaths } from '../models/paths'
import type { WorkflowTemplate, WorkflowInstance, WorkflowMode, LlmConfig } from '@shared/workflow/types'

/**
 * 生成唯一 ID（用于模板和实例）。

 * 为什么存在：模板/实例/节点都需要能在进程重启后仍保持稳定的磁盘身份，
 * 只用自增序号会被「删除后重建」重号、跨目录并存的模板也会撞号，因此需要
 * 时间 + 随机两部分组成的字符串 ID。
 * 作用：拼接「前缀 + 36 进制时间戳 + 36 进制随机段」，保证同一秒内多次调用
 * 也不重号。修复（评审 m9）：随机段从 Math.random 升级为 crypto 强随机，
 * 弱随机在 Windows/多实例同秒创建时存在碰撞风险，强随机从源头排除。
 */
export function generateId(prefix: string): string {
  const ts = Date.now().toString(36)
  const rand = randomBytes(5).toString('hex')
  return `${prefix}_${ts}_${rand}`
}

/**
 * 原子写文件：先写 .tmp，再 rename 到目标路径

 * 保证进程崩溃时不损坏已有文件：
 * - 写 .tmp 阶段崩溃：原文件完好，.tmp 残留（下次写覆盖）
 * - rename 阶段崩溃：rename 是原子操作（POSIX）或接近原子（Windows 先 unlink 再 rename）

 * Windows 兼容：renameSync 在目标已存在时会失败，先 unlink 目标再 rename
 */
function atomicWrite(filePath: string, content: string): void {
  const tmp = `${filePath}.tmp`
  writeFileSync(tmp, content, 'utf-8')
  try {
    renameSync(tmp, filePath)
  } catch {
    // Windows：目标已存在时 rename 失败，先删目标再 rename
    try {
      unlinkSync(filePath)
    } catch {
      // 目标可能不存在（首次写入），忽略
    }
    renameSync(tmp, filePath)
  }
}

/**
 * 安全删除文件（不存在不报错）
 */
function safeUnlink(filePath: string): boolean {
  if (!existsSync(filePath)) return false
  try {
    unlinkSync(filePath)
    return true
  } catch {
    return false
  }
}

/**
 * 工作流模板存储（带内存缓存）

 * 文件结构：{paths.workflowTemplates}/{templateId}.json

 * 内存缓存策略：
 * - load 时先查缓存，未命中再读磁盘并回填
 * - save 时同步更新缓存
 * - delete 时从缓存移除
 * - list 时直接读磁盘（保证看到外部修改，且 list 不是高频操作）
 */
export class WorkflowTemplateStore {
  constructor(private paths: BaseDataPaths) {}

  /** 内存缓存：id → template */
  private cache = new Map<string, WorkflowTemplate>()

  private filePath(id: string): string {
    return join(this.paths.workflowTemplates, `${id}.json`)
  }

/**
   * 保存（新增或覆盖），原子写 + 更新缓存。

   * 提示词存储规范（去 JSON 化，MD 为唯一真源）：
   * - 每个 llm 节点提示词正文外置为 workflows/prompts/{模板id}/{节点id}.md（用户直接编辑即生效），
   * config.promptFile 存绝对路径引用；磁盘 JSON 模板副本**不再内嵌 prompt 正文**（仅保留 promptFile）。
   * - 防漂移：MD 旁记录 .src 指纹（上次同步的内置 prompt 内容）。save() 时：
   * - MD 不存在（无副本）→ 用当前 prompt 内容生成 MD + .src（= 内置模板生效，无副本时兜底）
   * - MD 与内置一致（未编辑）→ 仅刷新 .src 指纹
   * - MD 有指纹且未被编辑、内置已更新 → 自动覆盖 MD 为最新内置（内置同步生效，解决漂移）
   * - MD 被用户编辑（与指纹不一致）→ 保留 MD + console.warn（有副本就用副本，不覆盖用户修改）
   * - 历史数据（无 .src）：MD == 旧 JSON 副本内嵌 prompt → 旧内置落地 → 覆盖为新内置并建指纹；
   * MD != 旧 JSON prompt → 视为用户编辑保留 + warn（不覆盖、不建指纹）
   * - 运行期回退链：promptFile(MD) 优先 → config.prompt（内存内置/旧数据）→ 都无则 llm-handler 明确报错。
   * - 导出（exportToJson）时回填 prompt 正文，保证导出 JSON 自包含可移植；导入后 save() 重新外置 MD。
   */
  save(template: WorkflowTemplate): void {
    if (!existsSync(this.paths.workflowTemplates)) {
      mkdirSync(this.paths.workflowTemplates, { recursive: true })
    }
    // 工作副本（不 mutate 调用方/内置常量对象，缓存亦基于副本）
    const work = structuredClone(template) as WorkflowTemplate
    // 读取磁盘旧 JSON（历史迁移参照：mdContent == prevPrompt 判定"旧内置落地未编辑"）
    let prevJson: WorkflowTemplate | null = null
    const fp = this.filePath(template.id)
    try {
      if (existsSync(fp)) {
        prevJson = JSON.parse(readFileSync(fp, 'utf-8')) as WorkflowTemplate
      }
    } catch {
      prevJson = null // 旧 JSON 损坏时不参与迁移判定
    }
    const prevPromptOf = (nodeId: string): string | undefined => {
      const prevNode = prevJson?.nodes?.find((n) => n.id === nodeId)
      const prevCfg = prevNode?.config as LlmConfig | undefined
      return typeof prevCfg?.prompt === 'string' && prevCfg.prompt.length > 0 ? prevCfg.prompt : undefined
    }
    // 提示词外置 + 防漂移同步（llm 节点 prompt → MD 文件 + promptFile 引用 + .src 指纹）
    try {
      const promptsDir = join(this.paths.workflows, 'prompts')
      for (const node of work.nodes) {
        if (node.type === 'llm') {
          const cfg = node.config as LlmConfig
          if (cfg && typeof cfg.prompt === 'string' && cfg.prompt.length > 0) {
            // 节点 id 防御性校验：id 将被拼入提示词目录路径，非白名单字符一律跳过外置
            // （为什么存在：save() 可能被编辑器或导入调用方以任意 node.id 触发，若 id 含
            // ../ 等片段可导致提示词写入 prompts 目录之外；为什么贴在这里：导入入口已校验，
            // 这里是第二道防线，保证写入路径一定落在 prompts 目录内）
            if (!/^[A-Za-z0-9_-]{1,64}$/.test(node.id)) {
              console.warn(`[workflow] 模板 ${work.id} 节点 ${node.id} 的 id 非法，跳过提示词外置`)
              continue
            }
            const rel = `${work.id}/${node.id}.md`
            const mdPath = join(promptsDir, rel)
            const srcPath = `${mdPath}.src`
            mkdirSync(dirname(mdPath), { recursive: true })

            if (!existsSync(mdPath)) {
              // 无外置副本 → 生成 MD（以当前 prompt 为源）+ 建指纹（无副本时用内置模板）
              atomicWrite(mdPath, cfg.prompt)
              atomicWrite(srcPath, cfg.prompt)
              console.log(`[workflow] 生成提示词副本: ${basename(mdPath)}`)
            } else {
              const mdContent = readFileSync(mdPath, 'utf-8')
              const srcContent = existsSync(srcPath) ? readFileSync(srcPath, 'utf-8') : undefined
              if (mdContent === cfg.prompt) {
                // MD 与内置一致（用户改回默认 / 从未编辑）→ 刷新指纹即可
                if (srcContent !== cfg.prompt) atomicWrite(srcPath, cfg.prompt)
              } else if (srcContent !== undefined && srcContent === mdContent) {
                // 有指纹且 MD == 指纹（未被编辑），内置已更新 → 自动覆盖为新内置，解决漂移
                atomicWrite(mdPath, cfg.prompt)
                atomicWrite(srcPath, cfg.prompt)
                console.log(`[workflow] 内置模板提示词更新已同步到外置 MD（${work.id}/${node.id}）`)
              } else if (srcContent !== undefined && srcContent !== mdContent) {
                // MD 有指纹但与指纹不一致 → 用户编辑过 → 保留用户版本
                console.warn(
                  `[workflow] 模板 ${work.id} 节点 ${node.id} 的提示词 MD 已被用户编辑，保留用户版本（编辑 ${mdPath} 生效）`
                )
              } else {
                // 无指纹（历史数据迁移）：用旧 JSON 副本内嵌 prompt 判定
                const prevPrompt = prevPromptOf(node.id)
                if (prevPrompt !== undefined && mdContent === prevPrompt) {
                  // MD == 旧内置落地（未编辑）→ 同步为新内置 + 建指纹
                  atomicWrite(mdPath, cfg.prompt)
                  atomicWrite(srcPath, cfg.prompt)
                  console.log(`[workflow] 历史提示词副本已对齐内置（${work.id}/${node.id}）`)
                } else {
                  // 无法判定 → 视为用户编辑保留 + warn（不覆盖、不建指纹）
                  console.warn(
                    `[workflow] 模板 ${work.id} 节点 ${node.id} 的提示词 MD 存在但无法判定来源，保留现有内容（编辑 ${mdPath} 生效）`
                  )
                }
              }
            }
            cfg.promptFile = mdPath
          }
        }
      }
    } catch (err) {
      console.warn(`[workflow] 提示词外置失败（回退内嵌 prompt）: ${(err as Error).message}`)
    }
    // 去 JSON 化：磁盘 JSON 副本剔除 llm 节点 prompt 正文（仅保留 promptFile 引用）
    const diskTemplate = structuredClone(work) as WorkflowTemplate
    for (const node of diskTemplate.nodes) {
      if (node.type === 'llm') {
        const cfg = node.config as LlmConfig
        if (cfg && typeof cfg.prompt === 'string') {
          delete cfg.prompt
        }
      }
    }
    atomicWrite(fp, JSON.stringify(diskTemplate, null, 2))
    this.cache.set(template.id, work)
  }

  /** 读取单个（优先内存缓存） */
  load(id: string): WorkflowTemplate | null {
    const cached = this.cache.get(id)
    if (cached) return cached

    const fp = this.filePath(id)
    if (!existsSync(fp)) return null
    try {
      const template = JSON.parse(readFileSync(fp, 'utf-8')) as WorkflowTemplate
      this.cache.set(id, template)
      return template
    } catch {
      return null
    }
  }

  /** 删除，同步移除缓存 */
  delete(id: string): boolean {
    const deleted = safeUnlink(this.filePath(id))
    this.cache.delete(id)
    return deleted
  }

  /** 列出所有模板（直接读磁盘，不依赖缓存，保证看到外部修改） */
  list(): WorkflowTemplate[] {
    if (!existsSync(this.paths.workflowTemplates)) return []
    const templates: WorkflowTemplate[] = []
    try {
      const files = readdirSync(this.paths.workflowTemplates).filter((f) => f.endsWith('.json'))
      for (const f of files) {
        const fp = join(this.paths.workflowTemplates, f)
        try {
          templates.push(JSON.parse(readFileSync(fp, 'utf-8')) as WorkflowTemplate)
        } catch {
          // 跳过损坏文件
        }
      }
    } catch {
      // 目录读取失败返回空
    }
    // 回填缓存
    for (const t of templates) {
      if (!this.cache.has(t.id)) this.cache.set(t.id, t)
    }
    return templates
  }

  /** 按模式/标签过滤 */
  listFiltered(mode?: WorkflowMode, tag?: string): WorkflowTemplate[] {
    return this.list().filter((t) => {
      if (mode && t.mode !== mode) return false
      if (tag && !(t.tags ?? []).includes(tag)) return false
      return true
    })
  }

/**
   * 导出为 JSON 字符串（完整模板定义，自包含）

   * 磁盘 JSON 副本不内嵌 prompt（去 JSON 化），但导出必须自包含可移植：
   * 对仅持有 promptFile 引用的 llm 节点，从对应 MD 文件回填 prompt 正文；
   * MD 缺失/读取失败则保留 promptFile（若 prompt 也缺失，导入方 save() 时会生成新 MD）。
   */
  exportToJson(id: string): string | null {
    const t = this.load(id)
    if (!t) return null
    const exportCopy = structuredClone(t) as WorkflowTemplate
    for (const node of exportCopy.nodes) {
      if (node.type === 'llm') {
        const cfg = node.config as LlmConfig
        if (cfg && !cfg.prompt && cfg.promptFile) {
          try {
            if (existsSync(cfg.promptFile)) {
              const fileContent = readFileSync(cfg.promptFile, 'utf-8')
              if (fileContent.trim().length > 0) cfg.prompt = fileContent
            }
          } catch {
            // MD 读取失败：保留 promptFile 引用，导出仍可导入（save 时重建 MD）
          }
        }
      }
    }
    return JSON.stringify(exportCopy, null, 2)
  }

/** 从 JSON 字符串导入（生成新 ID 避免冲突） */
  importFromJson(jsonStr: string, newName?: string): WorkflowTemplate {
    let parsed: WorkflowTemplate
    try {
      parsed = JSON.parse(jsonStr) as WorkflowTemplate
    } catch (err) {
      throw new Error(`JSON 格式无效：${(err as Error).message}`, { cause: err })
    }
    // 校验结构
    if (!parsed.nodes || !parsed.edges || !parsed.mode) {
      throw new Error('工作流 JSON 结构无效：缺少 nodes/edges/mode')
    }
    // 节点 id 白名单校验：节点 id 会被拼进磁盘路径（save 时 {work.id}/{node.id}.md），
    // 不校验则导入恶意模板后路径穿越可读写任意目录（评审 c-段：node.id 来自模板无格式校验）。
    // 作用：限定节点 id 只能由字母数字与 _ - 组成，把「文件系统路径段」与「内容字段」隔离。
    for (const node of parsed.nodes) {
      if (typeof node.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(node.id)) {
        throw new Error(`工作流 JSON 结构无效：节点 id 必须为字母/数字/_/-（1-64 字符），收到: ${String(node?.id).slice(0, 40)}`)
      }
    }
    // 生成新 ID，避免冲突
    const newId = generateId('wf')
    const imported: WorkflowTemplate = {
      ...parsed,
      id: newId,
      name: newName ?? `${parsed.name}（导入）`,
      source: 'imported',
      createdAt: Date.now(),
      updatedAt: Date.now()
    }
    this.save(imported)
    return imported
  }
}

/** 归档保留数量上限 */
const MAX_ARCHIVED_INSTANCES = 50

/**
 * 工作流实例存储

 * 文件结构：
 * {paths.workflowInstances}/{instanceId}.json 活跃实例
 * {paths.workflowInstances}/archive/{instanceId}.json 已完成归档

 * 生命周期：
 * - 创建实例时 save
 * - 每次节点状态变化时 save（崩溃恢复用，原子写）
 * - 实例完成/失败/取消时 archive（移到 archive/ 目录，保留最近 50 个）
 */
export class WorkflowInstanceStore {
  constructor(private paths: BaseDataPaths) {}

  private filePath(id: string): string {
    return join(this.paths.workflowInstances, `${id}.json`)
  }

  private archivePath(id: string): string {
    return join(this.paths.workflowInstances, 'archive', `${id}.json`)
  }

  private get archiveDir(): string {
    return join(this.paths.workflowInstances, 'archive')
  }

  /** 保存实例状态（原子写） */
  save(instance: WorkflowInstance): void {
    if (!existsSync(this.paths.workflowInstances)) {
      mkdirSync(this.paths.workflowInstances, { recursive: true })
    }
    atomicWrite(this.filePath(instance.id), JSON.stringify(instance, null, 2))
  }

  /** 读取单个 */
  load(id: string): WorkflowInstance | null {
    const fp = this.filePath(id)
    if (existsSync(fp)) {
      try {
        return JSON.parse(readFileSync(fp, 'utf-8')) as WorkflowInstance
      } catch {
        return null
      }
    }
    // 回退：查归档目录（实例可能已完成归档，但调用方仍需获取其状态，
    // 例如记忆流水线崩溃恢复时判断"实例已完成但完成事件丢失"）
    const ap = this.archivePath(id)
    if (existsSync(ap)) {
      try {
        return JSON.parse(readFileSync(ap, 'utf-8')) as WorkflowInstance
      } catch {
        return null
      }
    }
    return null
  }

  /**
   * 归档实例（替代直接删除）

   * 将活跃实例文件移到 archive/ 目录，保留最近 MAX_ARCHIVED_INSTANCES 个，
   * 超出时按修改时间清理最旧的。

   * 使用场景：实例完成/失败/取消后调用。
   * 归档而非直接删除的原因：
   * - 调试时可查看最近完成的实例状态
   * - 崩溃恢复诊断（区分"已归档"和"丢失"）
   * - 用户可能想回看执行历史（未来前端可加归档列表）
   */
  archive(instance: WorkflowInstance): void {
    const src = this.filePath(instance.id)
    if (!existsSync(src)) return

    if (!existsSync(this.archiveDir)) {
      mkdirSync(this.archiveDir, { recursive: true })
    }
    const dst = this.archivePath(instance.id)
    try {
      // rename 是原子操作（同分区），直接移动而非复制
      renameSync(src, dst)
    } catch {
      // 跨分区或目标已存在时降级为复制+删除
      try {
        writeFileSync(dst, readFileSync(src, 'utf-8'), 'utf-8')
        safeUnlink(src)
      } catch {
        // 归档失败时至少删除活跃文件，避免下次启动误恢复
        safeUnlink(src)
      }
    }

    // 清理超出上限的归档
    this.pruneArchives()
  }

  /** 清理归档目录中超出上限的最旧文件 */
  private pruneArchives(): void {
    if (!existsSync(this.archiveDir)) return
    try {
      const files = readdirSync(this.archiveDir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => {
          const fp = join(this.archiveDir, f)
          try {
            return { name: f, path: fp, mtime: statSync(fp).mtimeMs }
          } catch {
            return { name: f, path: fp, mtime: 0 }
          }
        })
        .sort((a, b) => b.mtime - a.mtime) // 新→旧

      if (files.length <= MAX_ARCHIVED_INSTANCES) return

      for (const file of files.slice(MAX_ARCHIVED_INSTANCES)) {
        safeUnlink(file.path)
      }
    } catch {
      // 清理失败不影响主流程
    }
  }

  /** 删除（仅在归档不可行时使用，如实例文件损坏） */
  delete(id: string): boolean {
    return safeUnlink(this.filePath(id))
  }

  /** 列出所有活跃实例（status=running/paused） */
  listActive(): WorkflowInstance[] {
    if (!existsSync(this.paths.workflowInstances)) return []
    const instances: WorkflowInstance[] = []
    try {
      const files = readdirSync(this.paths.workflowInstances).filter((f) => f.endsWith('.json'))
      for (const f of files) {
        const fp = join(this.paths.workflowInstances, f)
        try {
          const inst = JSON.parse(readFileSync(fp, 'utf-8')) as WorkflowInstance
          if (inst.status === 'running' || inst.status === 'paused') {
            instances.push(inst)
          }
        } catch {
          // 跳过损坏文件
        }
      }
    } catch {
      // 目录读取失败返回空
    }
    return instances
  }
}
