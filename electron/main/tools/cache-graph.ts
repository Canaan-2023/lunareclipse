/**
 * 缓存文件系统镜像工具：为什么存在——AI 需要了解 cache/ 目录层级以定位/清理缓存，
 * 而逐文件读内容开销大且没必要；按结构扫描即可；缓存节点多时同样需要从任意位置缩小视图。
 * 作用：cache_graph 以指定缓存文件（index.json 或 *_cache.json）或文件夹为起点向下扫描文件系统，
 * 返回树形结构（不读 JSON 内容）；文件夹起点时该目录内 *_cache.json 文件为点、同名文件夹为线往下展开。
 * 不删掉的理由：缓存是 NNG 的镜像（同构、含记忆路径），AI 检索时需按结构定位缓存节点；
 * 本工具是缓存结构查询的唯一轻量入口，与按内容检索的工具互补。
 */
import { existsSync, statSync, readdirSync } from 'fs'
import { dirname, basename, join } from 'path'
import type { Tool, ToolResult, ToolContext } from './base-tool'

export interface CacheGraphParams {
  start_path?: string
  最大深度?: number
}

export interface GraphNode {
  name: string
  path: string
  type: 'file' | 'root'
  children: GraphNode[]
}

export class CacheGraphTool implements Tool<CacheGraphParams> {
  name = 'cache_graph'
  description =
    '查看 Cache 文件系统镜像：以指定缓存文件（index.json / *_cache.json）或文件夹为起点生成树形图（只扫结构，不读 JSON 内容）。参数：start_path（选填，默认 cache/AI{aiId}/U{uid}/index.json；系统管理的 cache/injection/ 目录不在默认树内，显式指定其内文件才涉及）/ 最大深度（选填，起点为 0，默认不限）。返回 { tree: {name, path, type, children}, 最大深度, 起点 }。看结构层级用本工具，读内容用 Read。'
  parameters = [
    { name: 'start_path', type: 'string' as const, description: '起点文件或文件夹绝对路径，默认 cache/AI{aiId}/U{uid}/index.json', required: false },
    { name: '最大深度', type: 'number' as const, description: '最大深度，起点为 0，下级为 1，默认不限', required: false }
  ]

  execute(params: CacheGraphParams, ctx?: ToolContext): Promise<ToolResult> {
    if (!ctx?.paths) {
      return Promise.resolve({ ok: false, error: 'ToolContext.paths 未初始化' })
    }
    const startPath = (params.start_path || ctx.paths.cacheIndexJson).replace(/\\/g, '/')
    if (!existsSync(startPath)) {
      return Promise.resolve({ ok: false, error: `起点不存在: ${startPath}` })
    }
    const maxDepth = typeof params.最大深度 === 'number' && params.最大深度 >= 0 ? params.最大深度 : Number.MAX_SAFE_INTEGER

    try {
      const tree = this.buildTree(startPath, 0, maxDepth)
      const actualDepth = this.measureDepth(tree)
      return Promise.resolve({
        ok: true,
        data: { tree, 最大深度: actualDepth, 起点: startPath }
      })
    } catch (err) {
      return Promise.resolve({ ok: false, error: (err as Error).message })
    }
  }

  private buildTree(filePath: string, currentDepth: number, maxDepth: number): GraphNode {
    const fileName = basename(filePath)
    // 目录起点分支：AI 传文件夹=以该文件夹为根展示其下缓存树，解决缓存节点多时
    // 从 index.json 全量下钻难以定位的问题；目录本身作为根节点（type='root'），
    // 其下 *_cache.json 文件为点、同名文件夹为线。不可删：没有它 start_path 传目录会
    // 落入 getSiblingFolder 的 null 分支，返回只有单节点无 children 的空树（已修缺陷）。
    if (this.isDirectory(filePath)) {
      const node: GraphNode = {
        name: fileName,
        path: filePath,
        type: 'root',
        children: []
      }
      if (currentDepth >= maxDepth) {
        return node
      }
      node.children = this.scanFolder(filePath, currentDepth + 1, maxDepth)
      return node
    }
    const node: GraphNode = {
      name: fileName,
      path: filePath,
      type: fileName === 'index.json' ? 'root' : 'file',
      children: []
    }
    if (currentDepth >= maxDepth) {
      return node
    }
    const siblingFolder = this.getSiblingFolder(filePath)
    if (!siblingFolder || !existsSync(siblingFolder)) {
      return node
    }
    if (!this.isDirectory(siblingFolder)) {
      return node
    }
    node.children = this.scanFolder(siblingFolder, currentDepth + 1, maxDepth)
    return node
  }

  /** 扫描文件夹内所有 *_cache.json 文件为子节点（文件为点），每个子节点继续经同名文件夹下钻（文件夹为线） */
  private scanFolder(folder: string, childDepth: number, maxDepth: number): GraphNode[] {
    const children: GraphNode[] = []
    const entries = readdirSync(folder, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('_cache.json')) {
        const childPath = join(folder, entry.name).replace(/\\/g, '/')
        children.push(this.buildTree(childPath, childDepth, maxDepth))
      }
    }
    children.sort((a, b) => a.name.localeCompare(b.name))
    return children
  }

  /** 判断路径是否为存在的目录（getSiblingFolder 结果可能不存在或指向文件，返回前统一核验类型） */
  private isDirectory(p: string): boolean {
    return existsSync(p) && statSync(p).isDirectory()
  }

  private getSiblingFolder(filePath: string): string | null {
    const fileName = basename(filePath)
    if (fileName === 'index.json') {
      const dir = dirname(filePath)
      return join(dir, 'index').replace(/\\/g, '/')
    }
    if (fileName.endsWith('_cache.json')) {
      const baseName = fileName.replace(/_cache\.json$/, '')
      const dir = dirname(filePath)
      return join(dir, baseName).replace(/\\/g, '/')
    }
    return null
  }

  private measureDepth(node: GraphNode): number {
    if (node.children.length === 0) {
      return 0
    }
    let max = 0
    for (const child of node.children) {
      const d = this.measureDepth(child)
      if (d > max) {
        max = d
      }
    }
    return max + 1
  }
}
