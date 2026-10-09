/**
 * NNG 知识图文件系统镜像工具：为什么存在——AI 需要看清自身 NNG 知识网络的层级结构
 * （节点=文件、边=同名文件夹），而不必逐个读文件内容；NNG 数量大时全量下钻不可行，
 * 必须能从任意的文件或文件夹起点按需缩小视图。
 * 作用：nng_graph 以指定 NNG 文件（root.json 或 *_nng.json）或任意文件夹为起点扫描文件系统，
 * 返回树形结构（不读 JSON 内容）；文件夹起点时该目录内 *_nng.json 文件为点、同名文件夹为线往下展开。
 * 不删掉的理由：nng_graph 是知识图谱可视化/结构查询的唯一轻量入口（不解析 JSON），
 * 与按内容检索的 search 类工具互补，保留它避免 AI 为看结构而读入大量 NNG 内容。
 */
import { existsSync, statSync, readdirSync } from 'fs'
import { dirname, basename, join } from 'path'
import type { Tool, ToolResult, ToolContext } from './base-tool'

export interface NngGraphParams {
  start_path?: string
  最大深度?: number
}

export interface GraphNode {
  name: string
  path: string
  type: 'file' | 'root'
  children: GraphNode[]
}

export class NngGraphTool implements Tool<NngGraphParams> {
  name = 'nng_graph'
  description =
    '查看 NNG 文件系统镜像：以指定 NNG 文件（root.json / *_nng.json）或文件夹为起点生成树形图（只扫结构，不读 JSON 内容）。参数：start_path（选填，默认 NNG/AI{aiId}/U{uid}/root.json；传文件夹=以该文件夹为根展示其下 NNG 树）/ 最大深度（选填，起点为 0，默认不限）。返回 { tree: {name, path, type, children}, 最大深度, 起点 }。看结构层级用本工具，读内容用 Read。'
  parameters = [
    { name: 'start_path', type: 'string' as const, description: '起点文件或文件夹绝对路径，默认 NNG/AI{aiId}/U{uid}/root.json', required: false },
    { name: '最大深度', type: 'number' as const, description: '最大深度，起点为 0，下级为 1，默认不限', required: false }
  ]

  execute(params: NngGraphParams, ctx?: ToolContext): Promise<ToolResult> {
    if (!ctx?.paths) {
      return Promise.resolve({ ok: false, error: 'ToolContext.paths 未初始化' })
    }
    const startPath = (params.start_path || ctx.paths.nngRootJson).replace(/\\/g, '/')
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
    // 目录起点分支：AI 传文件夹=以该文件夹为根展示其下 NNG 树，解决 NNG 数量多时
    // 从 root.json 全量下钻难以定位的问题；目录本身作为根节点（type='root'），
    // 其下 *_nng.json 文件为点、同名文件夹为线。不可删：没有它 start_path 传目录会
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
      type: fileName === 'root.json' ? 'root' : 'file',
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

  /** 扫描文件夹内所有 *_nng.json 文件为子节点（文件为点），每个子节点继续经同名文件夹下钻（文件夹为线） */
  private scanFolder(folder: string, childDepth: number, maxDepth: number): GraphNode[] {
    const children: GraphNode[] = []
    const entries = readdirSync(folder, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('_nng.json')) {
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
    if (fileName === 'root.json') {
      const dir = dirname(filePath)
      return join(dir, 'root').replace(/\\/g, '/')
    }
    if (fileName.endsWith('_nng.json')) {
      const baseName = fileName.replace(/_nng\.json$/, '')
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
