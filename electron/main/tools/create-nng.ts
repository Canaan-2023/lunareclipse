/**
 * 创建 NNG 笔记工具：为什么存在——AI 需要把知识沉淀为 NNG 图节点并按层级组织，
 * 形成可跨会话检索的知识网络。
 * 作用：create_nng 构建 NNG 对象并写入 NNG 目录（含层级计算与姊妹文件夹规划）。
 * 不删掉的理由：create_nng 是知识图谱写入链路的唯一入口，nng 列表/图/记忆反向关联都依赖它落盘。
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'fs'
import { dirname } from 'path'
import type { Tool, ToolResult, ToolContext } from './base-tool'
import {
  buildNngObject,
  buildNngPath,
  buildNngSiblingFolder,
  calcNngLevel,
  findParentNngPath,
  getNngNameFromPath,
  MAX_NNG_DESC_LENGTH,
  type CreateNngParams,
  type NNG,
  type NngMemoryRef
} from '../models/nng'
import { upsertNngRootEntry } from '../models/index-files'
import { nowIso } from '../models/memory'
import { normalizePath, type NngType } from '../models/paths'

export interface CreateNngToolParams {
  type: NngType
  name: string
  目标文件夹: string
  描述: string
  关联记忆: NngMemoryRef[]
  上级NNG?: string[]
  下级NNG?: string[]
}

export class CreateNngTool implements Tool<CreateNngToolParams> {
  name = 'create_nng'
  description =
'创建 NNG 文件（路径/层级序号/上下级关联由工具自动生成，AI 不拼路径），返回 { path } 新 NNG 文件绝对路径。type 必填：standard=普通 NNG / meta=元认知 NNG（自动加 meta_ 前缀） / high=高阶整合 NNG（自动加 high_ 前缀）。name=节点名（不含 _nng 后缀、层级序号、type 前缀）。目标文件夹：一级填当前 AI+用户 工作域一级节点目录 NNG/AI{aiId}/U{uid}/root（即 nng_graph 返回的 root）；二级及以下填父 NNG 所在文件夹。描述=NNG 角色定位（主题+范围+关键词）；关联记忆=对象数组 [{记忆路径, 描述}]。上级NNG/下级NNG 选填：仅跨文件夹场景填，同名文件夹场景自动识别不填。'
  parameters = [
    { name: 'type', type: 'string' as const, description: 'NNG 类型：standard / meta / high', required: true },
    { name: 'name', type: 'string' as const, description: 'NNG 名称（不含 _nng 后缀、层级序号、type 前缀）', required: true },
    { name: '目标文件夹', type: 'string' as const, description: '在哪个文件夹下创建。一级填当前作用域 NNG 一级节点目录（NNG/AI{aiId}/U{uid}/root，即 nng_graph 返回的 root）；二级及以下填父节点同名文件夹路径', required: true },
    { name: '描述', type: 'string' as const, description: 'NNG 自身的描述（角色定位，自洽可读，≤200 字，超限拒绝）', required: true },
    { name: '关联记忆', type: 'array' as const, description: '关联记忆对象数组，每项 {记忆路径, 描述}', required: true },
    { name: '上级NNG', type: 'array' as const, description: '跨文件夹的上级 NNG 路径数组（同名文件夹场景自动识别，不填）', required: false },
    { name: '下级NNG', type: 'array' as const, description: '跨文件夹的下级 NNG 路径数组（同名文件夹场景自动识别，不填）', required: false }
  ]

  execute(params: CreateNngToolParams, ctx?: ToolContext): Promise<ToolResult> {
    if (!ctx?.paths) {
      return Promise.resolve({ ok: false, error: 'ToolContext.paths 未初始化' })
    }
    const validTypes: NngType[] = ['standard', 'meta', 'high']
    if (!validTypes.includes(params.type)) {
      return Promise.resolve({ ok: false, error: `type 必须是 ${validTypes.join(' / ')}` })
    }
    if (!params.name || params.name.trim().length === 0) {
      return Promise.resolve({ ok: false, error: 'name 不能为空' })
    }
    if (!params.描述 || params.描述.trim().length === 0) {
      return Promise.resolve({ ok: false, error: '描述 不能为空' })
    }
    if (params.描述.trim().length > MAX_NNG_DESC_LENGTH) {
      return Promise.resolve({
        ok: false,
        error: `描述 超过 ${MAX_NNG_DESC_LENGTH} 字上限（当前 ${params.描述.trim().length} 字）：精简描述，或拆子节点分层收纳（描述写不下 = 该建子节点了）`
      })
    }
    if (!params.关联记忆 || params.关联记忆.length === 0) {
      return Promise.resolve({ ok: false, error: '关联记忆 不能为空' })
    }
    for (const ref of params.关联记忆) {
      if (!ref.记忆路径 || !ref.描述) {
        return Promise.resolve({ ok: false, error: '关联记忆 每项必须含 记忆路径 和 描述' })
      }
    }

    const targetFolder = params.目标文件夹.replace(/\\/g, '/').replace(/\/$/, '')
// 一级基准 = 一级节点目录（NNG/AI{aiId}/U{uid}/root）
    const nngLevel1Dir = ctx.paths.nngLevel1Dir.replace(/\\/g, '/').replace(/\/$/, '')
    if (!targetFolder.startsWith(nngLevel1Dir)) {
      return Promise.resolve({ ok: false, error: `目标文件夹必须在 NNG/AI{aiId}/U{uid}/root 下: ${targetFolder}` })
    }

    const level = calcNngLevel(targetFolder, nngLevel1Dir)

    // 所有层级同名查重：在哪个文件夹建节点，就查那个文件夹里有没有同名
    const existingInFolder = existsSync(targetFolder)
      ? readdirSync(targetFolder, { withFileTypes: true })
          .filter((e) => e.isFile() && e.name.endsWith('_nng.json'))
          .map((e) => e.name.replace(/_nng\.json$/, ''))
      : []
    const newName = params.name.replace(/[\\/:*?"<>|]/g, '_')
    if (existingInFolder.includes(newName)) {
      return Promise.resolve({
        ok: false,
        error: `本文件夹下已存在同名节点 "${newName}"，请归位（Read 该节点 → Edit 追加到它），不要重复建。\n当前文件夹已有节点：${existingInFolder.join('、')}`
      })
    }

    // buildNngPath 与 targetFolder 均已归一为正斜杠，absPath 天然是全系统统一的写法；
    // 下游 updateParentNng / upsertNngRootEntry / syncMemoryAssocNNG 复用即保持一致
    const absPath = normalizePath(buildNngPath(targetFolder, level, params.type, params.name))
    if (existsSync(absPath)) {
      return Promise.resolve({ ok: false, error: `NNG 文件已存在: ${absPath}` })
    }

    const siblingFolder = buildNngSiblingFolder(targetFolder, level, params.type, params.name)
    const parentNngPath = findParentNngPath(absPath, nngLevel1Dir)
    const isLevel1 = level === 1

    const createParams: CreateNngParams = {
      type: params.type,
      name: params.name,
      目标文件夹: targetFolder,
      描述: params.描述,
      关联记忆: params.关联记忆,
      // 一级节点父 = root.json 索引（ROOT 节点）；二级及以上父 = 同名文件夹上级 NNG
      // 路径字段规范化（正斜杠）统一在 buildNngObject 完成，此处只传原始值
      上级NNG: parentNngPath
        ? [parentNngPath]
        : isLevel1
          ? [ctx.paths.nngRootJson]
          : (params.上级NNG ?? []),
      下级NNG: params.下级NNG
    }
    const nngObj = buildNngObject(createParams, absPath)

    try {
      mkdirSync(dirname(absPath), { recursive: true })
      if (!existsSync(siblingFolder)) {
        mkdirSync(siblingFolder, { recursive: true })
      }
      writeFileSync(absPath, JSON.stringify(nngObj, null, 2), 'utf-8')

      if (parentNngPath && existsSync(parentNngPath)) {
        this.updateParentNng(parentNngPath, absPath)
      }

      if (isLevel1) {
        const name = getNngNameFromPath(absPath)
        upsertNngRootEntry(ctx.paths.nngRootJson, {
          name,
          path: absPath,
          描述: params.描述,
          last_modified: nowIso()
        })
      }

      for (const ref of params.关联记忆) {
        this.syncMemoryAssocNNG(ref.记忆路径, absPath)
      }

      ctx.handleAccessed?.(absPath)
      return Promise.resolve({ ok: true, data: { path: absPath } })
    } catch (err) {
      return Promise.resolve({ ok: false, error: (err as Error).message })
    }
  }

  private updateParentNng(parentNngPath: string, childPath: string): void {
    try {
      const raw = readFileSync(parentNngPath, 'utf-8')
      const parent = JSON.parse(raw) as NNG
      if (!parent.下级NNG) {
        parent.下级NNG = []
      }
      if (!parent.下级NNG.includes(childPath)) {
        parent.下级NNG.push(childPath)
      }
      writeFileSync(parentNngPath, JSON.stringify(parent, null, 2), 'utf-8')
    } catch (err) {
      // 父 NNG 关联更新失败不阻断创建（NNG 文件已写入），但记录日志便于排查双向链接断裂
      console.error(`[create_nng] 更新父 NNG 下级关联失败 (${parentNngPath} → ${childPath}):`, err)
    }
  }

  private syncMemoryAssocNNG(memoryPath: string, nngPath: string): void {
    if (!existsSync(memoryPath)) {
      return
    }
    try {
      const raw = readFileSync(memoryPath, 'utf-8')
      const mem = JSON.parse(raw) as { 关联NNG?: string[] }
      if (!mem.关联NNG) {
        mem.关联NNG = []
      }
      if (!mem.关联NNG.includes(nngPath)) {
        mem.关联NNG.push(nngPath)
        writeFileSync(memoryPath, JSON.stringify(mem, null, 2), 'utf-8')
      }
    } catch (err) {
      // 记忆反向关联更新失败不阻断创建，但记录日志便于排查双向链接断裂
      console.error(`[create_nng] 更新记忆关联 NNG 失败 (${memoryPath} → ${nngPath}):`, err)
    }
  }
}
