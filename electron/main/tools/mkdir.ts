/**
 * 创建目录工具：为什么存在——AI 组织工作区结构时需要预建目录，避免后续写入失败或路径缺失。
 * 作用：mkdir 创建目录（recursive 支持级联），返回已存在或新建状态。
 */
import { mkdirSync, existsSync } from 'fs'
import type { Tool, ToolResult, ToolContext } from './base-tool'
import { resolveToolPath } from './base-tool'

export interface MkdirParams {
  path: string
  recursive?: boolean
}

export class MkdirTool implements Tool<MkdirParams> {
  name = 'Mkdir'
  description = '创建目录。参数：path（必填，绝对路径）/ recursive（选填，自动创建父目录，默认 true）。返回 { path, created, alreadyExists }，已存在不报错返回 alreadyExists=true。'
  parameters = [
    { name: 'path', type: 'string' as const, description: '绝对路径', required: true },
    { name: 'recursive', type: 'boolean' as const, description: '是否递归创建', required: false, default: true }
  ]

  execute(params: MkdirParams, ctx?: ToolContext): Promise<ToolResult> {
    const dir = resolveToolPath(params.path, ctx)
    const recursive = params.recursive ?? true
    try {
      if (existsSync(dir)) {
        return Promise.resolve({ ok: true, data: { path: dir, created: false, alreadyExists: true } })
      }
      mkdirSync(dir, { recursive })
      return Promise.resolve({ ok: true, data: { path: dir, created: true, alreadyExists: false } })
    } catch (err) {
      return Promise.resolve({ ok: false, error: (err as Error).message })
    }
  }
}
