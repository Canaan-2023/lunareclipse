/**
 * NNG（认知图谱节点）数据模型层：与 memory.ts 对应的 NNG 对象唯一构造点。
 * 提供 NNG 类型、命名/路径构造、层级计算与父节点查找；
 * 所有路径统一按正斜杠规范化，保证去重、上下级关联与记忆反向引用一致有效。
 * 不删掉的理由：NNG 是检索骨架（一级索引 root.json 与节点文件、同名文件夹层级、archive 归档区
 * 都以本模型的路径/命名契约为准），模型漂移会让图导航与索引回填同时失真。
 */
import { join, dirname, basename } from 'path'
import { normalizePath, type NngType } from './paths'

export interface NngMemoryRef {
  记忆路径: string
  描述: string
}

/** NNG 描述长度硬上限（设计依据：描述 >200 字即信息过载，提示该拆子节点分层；
 * 硬上限防止单节点描述膨胀撑爆注入预算，见 resolveNodeContext 截断逻辑） */
export const MAX_NNG_DESC_LENGTH = 200

export interface NngArchiveRecord {
  归档时间: string
  归档路径: string
  归档原因: string
}

export interface NNG {
  自身路径: string
  描述: string
  关联记忆: NngMemoryRef[]
  上级NNG: string[]
  下级NNG: string[]
  归档记录: NngArchiveRecord[]
}

export interface CreateNngParams {
  type: NngType
  name: string
  目标文件夹: string
  描述: string
  关联记忆: NngMemoryRef[]
  上级NNG?: string[]
  下级NNG?: string[]
}

export function getNngPrefix(type: NngType): string {
  switch (type) {
    case 'standard':
      return ''
    case 'meta':
      return 'meta_'
    case 'high':
      return 'high_'
  }
}

/**
 * 计算 NNG 层级：基准 = 一级节点目录（root.json 的同名文件夹 root/）。
 * 一级节点目录内 = 1，其下子文件夹逐级 +1。
 * @param targetFolder 目标文件夹（_nng.json 所在目录）
 * @param level1Dir 一级节点目录（NNG/AI{aiId}/U{uid}/root）
 */
export function calcNngLevel(targetFolder: string, level1Dir: string): number {
  const t = targetFolder.replace(/\\/g, '/').replace(/\/$/, '')
  const r = level1Dir.replace(/\\/g, '/').replace(/\/$/, '')
  if (!t.startsWith(r)) {
    return 1
  }
  const rest = t.slice(r.length).replace(/^\/+/, '')
  if (rest.length === 0) {
    return 1
  }
  return rest.split('/').filter(Boolean).length + 1
}

export function buildNngFileName(level: number, type: NngType, name: string): string {
  const prefix = getNngPrefix(type)
  const safeName = name.replace(/[\\/:*?"<>|]/g, '_')
  // 层级号不写进文件名（旧版 {level}{prefix}{name}_nng.json → AI 看不懂 11用户偏好）；
  // 层级关系靠文件夹结构表达（一级在 root/，二级在 root/父节点同名文件夹/），
  // 文件名只留类型前缀 + 语义名，AI 一看就懂装什么。
  return `${prefix}${safeName}_nng.json`
}

export function buildNngPath(targetFolder: string, level: number, type: NngType, name: string): string {
  const fileName = buildNngFileName(level, type, name)
  return join(targetFolder, fileName).replace(/\\/g, '/')
}

export function buildNngSiblingFolder(targetFolder: string, level: number, type: NngType, name: string): string {
  const baseName = buildNngFileName(level, type, name).replace(/_nng\.json$/, '')
  return join(targetFolder, baseName).replace(/\\/g, '/')
}

export function getNngNameFromPath(nngPath: string): string {
  const fileName = basename(nngPath)
  return fileName.replace(/_nng\.json$/, '')
}

/**
 * 找父 NNG：基准 = 一级节点目录（root/）。
 * 一级节点（所在目录 === level1Dir）无父 NNG（父是 root.json 索引，调用方特殊处理）→ null。
 * @param nngPath NNG 文件绝对路径
 * @param level1Dir 一级节点目录（NNG/AI{aiId}/U{uid}/root）
 */
export function findParentNngPath(nngPath: string, level1Dir: string): string | null {
  const dir = dirname(nngPath).replace(/\\/g, '/')
  const r = level1Dir.replace(/\\/g, '/').replace(/\/$/, '')
  if (dir === r) {
    return null
  }
  if (!dir.startsWith(r + '/')) {
    return null
  }
  const segs = dir.split('/')
  const folderName = segs[segs.length - 1]
  const parentDir = segs.slice(0, -1).join('/')
  return `${parentDir}/${folderName}_nng.json`
}

/**
 * 构造 NNG 对象。所有路径字段统一经 normalizePath 规范化（正斜杠）——JSON 里路径是
 * 字面量比较，`d:\a` 与 `d:/a` 若不统一，去重、上级/下级关联、记忆反向引用都会静默失效。
 * 正斜杠是全系统既有约定（memory-sync/cache-sync 均用 normalizePath）。这里是 NNG 对象的
 * 唯一构造点，规范化收敛在此，避免各处零散调用漏点。
 */
export function buildNngObject(params: CreateNngParams, absPath: string): NNG {
  return {
    自身路径: normalizePath(absPath),
    描述: params.描述,
    关联记忆: params.关联记忆.map((r) => ({ 记忆路径: normalizePath(r.记忆路径), 描述: r.描述 })),
    上级NNG: (params.上级NNG ?? []).map(normalizePath),
    下级NNG: (params.下级NNG ?? []).map(normalizePath),
    归档记录: []
  }
}
