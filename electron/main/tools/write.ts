/**
 * 写文件工具：为什么存在——AI 创建/覆盖文件是核心能力，月蚀定位为本地 AI 助手，
 * 用户授权 AI 全盘读写项目/文档（主流程不注入 resolvePath 即不设工作区边界，见 base-tool.ts）；
 * 原子写（临时文件 + rename + 写后 sha256 校验）用于防止写一半文件损坏。
 * 作用：write 解析目标路径后经 writeFileSafe 原子写入，并返回行数变化统计。
 * 边界说明：eval 评测场景由 harness 注入 resolvePath 把相对路径限定到任务工作区；
 * 主流程下相对路径按进程 cwd 解析、绝对路径直通——这是产品设计，不是可绕过的工作区漏洞。
 */
import { existsSync, readFileSync } from 'fs'
import { dirname } from 'path'
import { mkdirSync } from 'fs'
import type { Tool, ToolResult, ToolContext } from './base-tool'
import { resolveToolPath } from './base-tool'
import { writeFileSafe, countLineDiff } from './edit-engine/file-operations'

export interface WriteParams {
  file_path: string
  content: string
}

export class WriteTool implements Tool<WriteParams> {
  name = 'Write'
  description = '写入文件（覆盖已存在文件，自动创建父目录）。参数：file_path（必填，绝对路径）/ content（必填，写入内容）。返回 { path, bytes, addedLines, removedLines }。原子写（临时文件+rename，防写一半崩盘）+ 行尾/BOM 保持 + 写后 sha256 验证。小范围修改用 Edit 更安全；完整重写或新建文件用本工具。'
  parameters = [
    { name: 'file_path', type: 'string' as const, description: '绝对路径', required: true },
    { name: 'content', type: 'string' as const, description: '写入内容', required: true }
  ]

  async execute(params: WriteParams, ctx?: ToolContext): Promise<ToolResult> {
    const filePath = resolveToolPath(params.file_path, ctx)
    try {
      let diff = { added: 0, removed: 0 }
      if (existsSync(filePath)) {
        const oldContent = readFileSync(filePath, 'utf-8')
        diff = countLineDiff(oldContent, params.content)
      }

      mkdirSync(dirname(filePath), { recursive: true })

      const res = writeFileSafe(filePath, params.content)
      if (!res.verified) {
        return { ok: false, error: '写入后验证失败（文件内容与预期不一致）' }
      }

      ctx?.handleAccessed?.(filePath)
      return {
        ok: true,
        data: {
          path: filePath,
          bytes: res.bytes,
          verified: true,
          addedLines: diff.added,
          removedLines: diff.removed
        }
      }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  }
}