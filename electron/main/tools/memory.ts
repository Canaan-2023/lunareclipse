/**
 * 记忆管理工具：为什么存在——raw_memory 与 memory 两层记忆需要统一的管理入口（浏览树/
 * 读取/归档/重命名），否则各层各写各的难以维护。
 * 作用：memory 工具按 action 分发浏览目录树、读取、新建、归档、重命名等动作。
 * 不删掉的理由：记忆链路（NNG/缓存/记忆/RAW/日记/日历）需要单一操作入口降低 AI 记忆负担，
 * 分散到各独立工具会导致调用约定不一致；本工具聚合浏览/读取/建记忆/建 NNG/归档/重命名于一处。
 */
import { existsSync, readFileSync, readdirSync, statSync, renameSync, mkdirSync } from 'fs'
import { basename, join, dirname, sep } from 'path'
import type { Tool, ToolResult, ToolContext } from './base-tool'
import { resolveToolPath } from './base-tool'
import { CreateMemoryTool } from './create-memory'
import { CreateNngTool } from './create-nng'
import { RenameRawMemoryTool } from './rename-raw-memory'

/**
 * memory 工具——记忆系统统一操作入口

 * 这是记忆系统的操作系统，不是查询工具。AI 进入这里，能在里面查找、建设、整理记忆系统。

 * 操作规范（流程在工具里，自由度满）：
 * - 建 NNG 前先找位置：用 nng_tree 扫树找合适的节点，找到了就归位，找不到才新建
 * - 读记忆先定位：知道节点路径直接 read，不知道就先 nng_tree 扫树找位置
 * - AI 上下文里有记录就直接定位，不用每次都从根开始扫
 * - 想干嘛干嘛：只想读取就 nng_tree + read，只想建记忆就 create_memory + create_nng，按需走对应步骤

 * 记忆系统结构：
 * - NNG：记忆的分类树（检索骨架），每个节点描述装什么、关联哪些记忆
 * - 记忆：提炼后的对话产物（normal/meta/high 三种类型），按日期组织
 * - 缓存：NNG 关联的记忆内容注入版，AI 对话时直接读缓存就能看到相关记忆内容
 * - RAW：原始对话流水，按日期组织
 * - 日记：每天一篇，从当天 RAW 提炼
 * - 日历：备忘/计划/日程条目
 */

type MemoryAction =
  | 'nng_tree'
  | 'read'
  | 'create_memory'
  | 'create_nng'
  | 'archive'
  | 'rename_raw_memory'

/** nng_tree 返回的目录树节点 */
interface MemoryTreeNode {
  name: string
  path: string
  children: MemoryTreeNode[]
  描述?: string
}

export interface MemoryToolParams {
  action: MemoryAction
  /** nng_tree：起点文件绝对路径，默认 NNG 根。不传就从根开始扫 */
  start_path?: string
  /** nng_tree：最大深度，默认不限 */
  max_depth?: number
  /** read：要读的文件绝对路径 */
  path?: string
  /** create_memory：记忆类型 normal/meta/high */
  type?: 'normal' | 'meta' | 'high'
  /** create_memory：用户原话（仅 normal 用；create-memory 校验只接受 string，数组会报错，故不声明数组） */
  用户原话?: string
  /** create_memory：AI 回复 */
  AI回复?: string
  /** create_memory：精炼内容 */
  精炼内容?: string
  /** create_memory：描述（命名范式：域词_主题词_状态词） */
  描述?: string
  /** create_memory：备注 */
  备注?: string
  /** create_memory：RAW 来源路径 */
  RAW来源?: string | string[]
  /** create_memory：时间戳（ISO） */
  时间戳?: string
  /** create_nng：节点名（语义短语，如 用户偏好、工程开发） */
  name?: string
  /** create_nng：节点类型 standard/meta/high */
  nng_type?: 'standard' | 'meta' | 'high'
  /** create_nng：节点描述（≤200 字，写清这个节点装什么） */
  描述_nng?: string
  /** create_nng：目标文件夹（父节点所在文件夹） */
  target_folder?: string
  /** create_nng：关联记忆 [{记忆路径, 描述}] */
  关联记忆?: Array<{ 记忆路径: string; 描述: string }>
  /** archive：要归档的 NNG 路径 */
  archive_path?: string
  /** rename_raw_memory：RAW 文件路径 */
  raw_path?: string
  /** rename_raw_memory：关键词 */
  raw_keyword?: string
}

export class MemoryTool implements Tool<MemoryToolParams> {
  name = 'memory'
  description =
    '记忆系统统一操作入口（查找/建设/整理记忆）。结构：NNG=记忆分类树（检索骨架）；记忆=提炼后的对话产物（normal/meta/high）；缓存=NNG 关联记忆的可直接读取内容；RAW=原始对话流水；日记=每日提炼；日历=备忘/计划。\n\n' +
    '操作规范：建 NNG 前先扫树找合适节点（找到归位，找不到才新建）；读记忆先定位（知道路径直接读，不知道先扫树）；上下文有记录就直接定位，不必每次从根扫。\n\n' +
    'action 按需传对应参数：nng_tree→start_path/max_depth；read→path；create_memory→type/描述/备注等；create_nng→nng_type/name/target_folder/关联记忆；archive→archive_path；rename_raw_memory→raw_path/raw_keyword。'

  parameters = [
    { name: 'action', type: 'string' as const, description: '操作类型：nng_tree / read / create_memory / create_nng / archive / rename_raw_memory', required: true },
    { name: 'start_path', type: 'string' as const, description: 'nng_tree：起点文件路径，默认从根开始', required: false },
    { name: 'max_depth', type: 'number' as const, description: 'nng_tree：最大深度，默认不限', required: false },
    { name: 'path', type: 'string' as const, description: 'read：要读的文件路径', required: false },
    { name: 'type', type: 'string' as const, description: 'create_memory：记忆类型 normal/meta/high', required: false },
    // create_memory 附加参数：为什么存在——CreateMemoryTool.execute 需要这些字段才能落盘，
    // schema 若不声明，AI 无法经 memory 工具传入，create_memory 调用必失败（转发层已有字段映射）。
    // 作用：把记忆正文的来源与加工信息（原话/回复/精炼/描述/备注/RAW/时间戳）传给内部建记忆工具。
    // 类型纪律：用户原话 只接受 string（create-memory 执行层硬校验）；RAW来源 按记忆类型区分
    // string（normal）/ string[]（high/meta），见下方该项描述。required 均标 false 是统一入口
    // 按 action 组合参数的惯例——create_memory 分支仍会强校验必填项（描述/备注/RAW来源），标 true
    // 会让 nng_tree 等其他 action 也被迫传无关字段，故由执行层兜底。
    { name: '用户原话', type: 'string' as const, description: 'create_memory（仅 normal）：≤500 字写用户原文，>500 字精炼核心诉求', required: false },
    { name: 'AI回复', type: 'string' as const, description: 'create_memory：AI 回复原文，可选', required: false },
    { name: '精炼内容', type: 'string' as const, description: 'create_memory：精炼后的记忆正文，可选', required: false },
    { name: '描述', type: 'string' as const, description: 'create_memory：记忆描述（命名范式：域词_主题词_状态词），必填', required: false },
    { name: '备注', type: 'string' as const, description: 'create_memory：补充备注，必填', required: false },
    { name: 'RAW来源', type: 'string' as const, description: 'create_memory：RAW 来源路径（normal=string 单条；high/meta=string[] 多条），必填', required: false },
    { name: '时间戳', type: 'string' as const, description: 'create_memory：ISO 时间戳，可选，默认当前时间', required: false },
    { name: 'nng_type', type: 'string' as const, description: 'create_nng：NNG 类型 standard/meta/high', required: false },
    { name: 'name', type: 'string' as const, description: 'create_nng：节点名（语义短语，≤20字）', required: false },
    // create_nng 附加参数：为什么存在——CreateNngTool.execute 需要 描述/关联记忆 才能建出可检索的节点，
    // schema 不声明则 AI 无法传参，建 NNG 分支会因缺 描述_nng/关联记忆 直接报错。
    // 作用：把节点描述与关联记忆列表传给内部建 NNG 工具（转发层已做 描述_nng→描述、target_folder→目标文件夹 映射）。
    { name: '描述_nng', type: 'string' as const, description: 'create_nng：节点描述（≤200 字，写清这个节点装什么），必填', required: false },
    { name: 'target_folder', type: 'string' as const, description: 'create_nng：目标文件夹路径（父节点所在文件夹），必填', required: false },
    { name: '关联记忆', type: 'array' as const, description: 'create_nng：关联记忆对象数组，每项 {记忆路径, 描述}，必填', required: false },
    { name: 'archive_path', type: 'string' as const, description: 'archive：要归档的 NNG 路径', required: false },
    { name: 'raw_path', type: 'string' as const, description: 'rename_raw_memory：RAW 文件路径', required: false },
    { name: 'raw_keyword', type: 'string' as const, description: 'rename_raw_memory：关键词', required: false }
  ]

  // 内部工具实例
  private createMemoryTool = new CreateMemoryTool()
  private createNngTool = new CreateNngTool()

  async execute(params: MemoryToolParams, ctx?: ToolContext): Promise<ToolResult> {
    if (!ctx?.paths) {
      return { ok: false, error: 'ToolContext.paths 未初始化' }
    }

    switch (params.action) {
      case 'nng_tree':
        return this.nngTree(params, ctx)
      case 'read':
        return this.read(params, ctx)
      case 'create_memory':
        return this.createMemory(params, ctx)
      case 'create_nng':
        return this.createNng(params, ctx)
      case 'archive':
        return this.archive(params, ctx)
      case 'rename_raw_memory':
        return this.renameRawMemory(params, ctx)
      default:
        return { ok: false, error: `未知 action: ${params.action}。支持：nng_tree / read / create_memory / create_nng / archive / rename_raw_memory` }
    }
  }

  /** 扫 NNG 树 */
  private nngTree(params: MemoryToolParams, ctx: ToolContext): ToolResult {
    if (!ctx?.paths) return { ok: false, error: 'paths 未初始化' }
    const startPath = (params.start_path || ctx.paths.nngRootJson).replace(/\\/g, '/')
    if (!existsSync(startPath)) {
      return { ok: false, error: `起点不存在: ${startPath}` }
    }
    const maxDepth = typeof params.max_depth === 'number' && params.max_depth >= 0
      ? params.max_depth
      : Number.MAX_SAFE_INTEGER

    const tree = this.buildTree(startPath, 0, maxDepth)
    return { ok: true, data: { tree, 起点: startPath } }
  }

  private buildTree(filePath: string, currentDepth: number, maxDepth: number): MemoryTreeNode {
    const fileName = basename(filePath)
    const node: MemoryTreeNode = { name: fileName, path: filePath, children: [] }
    if (currentDepth >= maxDepth) return node

    const siblingFolder = this.getSiblingFolder(filePath)
    if (!siblingFolder || !existsSync(siblingFolder)) return node

    const stat = statSync(siblingFolder)
    if (!stat.isDirectory()) return node

    const entries = readdirSync(siblingFolder, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('_nng.json')) {
        const childPath = join(siblingFolder, entry.name).replace(/\\/g, '/')
        let 描述 = ''
        try {
          const nngData = JSON.parse(readFileSync(childPath, 'utf-8'))
          描述 = nngData.描述 || ''
        } catch { /* ignore */ }
        node.children.push({
          ...this.buildTree(childPath, currentDepth + 1, maxDepth),
          描述
        })
      }
    }
    node.children.sort((a: MemoryTreeNode, b: MemoryTreeNode) => a.name.localeCompare(b.name))
    return node
  }

  private getSiblingFolder(filePath: string): string | null {
    const fileName = basename(filePath)
    if (fileName === 'root.json') {
      const dir = dirname(filePath)
      const rootFolder = join(dir, 'root')
      return existsSync(rootFolder) ? rootFolder : null
    }
    const baseName = fileName.replace(/_nng\.json$/, '')
    const dir = dirname(filePath)
    const siblingFolder = join(dir, baseName)
    return existsSync(siblingFolder) ? siblingFolder : null
  }

  /** 读文件 */
  private read(params: MemoryToolParams, ctx: ToolContext): ToolResult {
    if (!params.path) {
      return { ok: false, error: 'read action 需要传 path 参数' }
    }
    const filePath = resolveToolPath(params.path, ctx)

    if (!existsSync(filePath)) {
      return { ok: false, error: `文件不存在: ${filePath}` }
    }

    const stat = statSync(filePath)
    if (stat.isDirectory()) {
      const entries = readdirSync(filePath)
      return { ok: true, data: { path: filePath, type: 'directory', entries } }
    }

    const content = readFileSync(filePath, 'utf-8').replace(/^\uFEFF/, '')

    try {
      const json = JSON.parse(content)
      return { ok: true, data: { path: filePath, type: 'json', content: json } }
    } catch {
      return { ok: true, data: { path: filePath, type: 'text', content } }
    }
  }

  /** 建记忆 */
  private async createMemory(params: MemoryToolParams, ctx: ToolContext): Promise<ToolResult> {
    if (!params.type || !params.描述 || !params.备注 || !params.RAW来源) {
      return { ok: false, error: 'create_memory 需要 type/描述/备注/RAW来源' }
    }
    return this.createMemoryTool.execute({
      type: params.type,
      用户原话: params.用户原话,
      AI回复: params.AI回复,
      精炼内容: params.精炼内容,
      描述: params.描述,
      备注: params.备注,
      RAW来源: params.RAW来源,
      时间戳: params.时间戳
    }, ctx)
  }

  /** 建 NNG 节点 */
  private async createNng(params: MemoryToolParams, ctx: ToolContext): Promise<ToolResult> {
    if (!params.nng_type || !params.name || !params.描述_nng || !params.target_folder) {
      return { ok: false, error: 'create_nng 需要 nng_type/name/描述_nng/target_folder' }
    }
    if (!params.关联记忆 || params.关联记忆.length === 0) {
      return { ok: false, error: 'create_nng 需要 关联记忆（对象数组 [{记忆路径, 描述}]）' }
    }
    return this.createNngTool.execute({
      type: params.nng_type,
      name: params.name,
      描述: params.描述_nng,
      目标文件夹: params.target_folder,
      关联记忆: params.关联记忆 || []
    }, ctx)
  }

  /** 归档 NNG 节点（节点文件 + 同名文件夹的子节点一起归档，避免子节点成孤儿） */
  private archive(params: MemoryToolParams, _ctx: ToolContext): ToolResult {
    if (!params.archive_path) {
      return { ok: false, error: 'archive action 需要传 archive_path 参数' }
    }
    const srcPath = params.archive_path
    if (!existsSync(srcPath)) {
      return { ok: false, error: `文件不存在: ${srcPath}` }
    }
    // 归档到同文件夹下的 archive/ 子目录
    const dir = dirname(srcPath)
    const fileName = basename(srcPath)
    const archiveDir = join(dir, 'archive')
    if (!existsSync(archiveDir)) {
      mkdirSync(archiveDir, { recursive: true })
    }

    // 归档目标是文件夹（如直接传节点同名文件夹）→ 整个文件夹归档
    if (statSync(srcPath).isDirectory()) {
      let destDir = join(archiveDir, fileName)
      // 防自嵌套：归档目标恰为 archive 目录自身时，destDir = archiveDir/archive 落在源内部，
      // Windows rename 必然 EPERM（与 loader 迁移同源的坑，AI 传入 archive/ 本身时触发）
      if (destDir.startsWith(srcPath + sep)) {
        return { ok: false, error: `归档目标位于源目录内部（自嵌套），拒绝归档: ${srcPath}` }
      }
      if (existsSync(destDir)) destDir = `${destDir}_${Date.now()}`
      renameSync(srcPath, destDir)
      return { ok: true, data: { 归档: destDir, 原路径: srcPath } }
    }

    // 归档目标是节点文件（xxx_nng.json）：NNG 层级靠文件夹表达——
    // 该节点的子节点在同名文件夹 xxx/ 下。只移 json 会让子节点成孤儿，必须一并归档。
    const nodeName = fileName.endsWith('_nng.json') ? fileName.slice(0, -'_nng.json'.length) : ''

    // 先校验节点文件归档目标无冲突，再搬文件夹——否则文件夹已进 archive、文件却因
    // 冲突 return 错误，会留下"文件夹与节点文件分离"的半归档孤儿（先校验保证原子性）。
    const destPath = join(archiveDir, fileName)
    if (existsSync(destPath)) {
      return { ok: false, error: `归档目标已存在同名文件: ${destPath}（请先处理 archive/ 中的旧档）` }
    }

    const movedFolders: string[] = []
    if (nodeName) {
      const folderPath = join(dir, nodeName)
      if (existsSync(folderPath) && statSync(folderPath).isDirectory()) {
        let folderDest = join(archiveDir, nodeName)
        // 防自嵌套：节点名恰好等于 archive 时，folderPath 即 archive 目录自身，
        // folderDest 落在其内部 → Windows rename EPERM（与目录归档分支同源）
        if (folderDest.startsWith(folderPath + sep)) {
          return { ok: false, error: `归档目标位于源目录内部（自嵌套），拒绝归档: ${folderPath}` }
        }
        if (existsSync(folderDest)) folderDest = `${folderDest}_${Date.now()}`
        renameSync(folderPath, folderDest)
        movedFolders.push(folderDest)
      }
    }

    renameSync(srcPath, destPath)
    return {
      ok: true,
      data: {
        归档: destPath,
        原路径: srcPath,
        ...(movedFolders.length ? { 一并归档子节点文件夹: movedFolders } : {})
      }
    }
  }

  /** 重命名 RAW 记忆 */
  private async renameRawMemory(params: MemoryToolParams, ctx: ToolContext): Promise<ToolResult> {
    if (!params.raw_path || !params.raw_keyword) {
      return { ok: false, error: 'rename_raw_memory 需要 raw_path/raw_keyword' }
    }
    const tool = new RenameRawMemoryTool()
    return tool.execute({ 路径: params.raw_path, 关键词: params.raw_keyword }, ctx)
  }
}
