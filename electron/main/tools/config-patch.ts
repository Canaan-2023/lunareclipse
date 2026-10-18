/**
 * 配置补丁工具：为什么存在——内核配置的修改需要可回滚、可审计，直接改配置文件容易出错；
 * 通过补丁文件分层覆盖是安全的路径。
 * 作用：config_patch 封装 kernel config-layer 的 list/write/delete 补丁操作，供 AI 增改配置覆盖。
 */
import type { ToolContext, ToolResult } from './base-tool'
import { kernelRegistry } from '../kernel'
import {
  listPatchFiles,
  writePatchFile,
  deletePatchFile,
  PATCH_DIR
} from '../kernel/config-layer'

/**
 * config_patch 工具：AI 调整配置的正规通道（配置覆盖层）

 * 铁律：AI 不手改核心 config.json（protect 拦截 + 本工具引导），
 * 一切配置调整写 abyssac_data/patch/*.json 覆盖层（可整体删除恢复）。
 * 覆盖层优先级：核心配置 < patch 文件（按文件名序）< 插件 config.patch。
 *
 * 动作：
 * - list 列出 patch 文件与插件配置覆盖，并展示生效合并的关键路径
 * - write 写/覆盖一个 patch 文件（写后回读校验，防写坏）
 * - delete 删除一个 patch 文件（恢复核心配置）
 */
export class ConfigPatchTool {
  name = 'config_patch'
  description = `调整应用配置（以覆盖文件方式生效，不直接改动核心配置文件）。操作 abyssac_data/${PATCH_DIR}/ 下的覆盖文件，删除覆盖即恢复默认，安全可逆。

用法：action=list 列出全部覆盖 / write 写入覆盖（name=覆盖文件名不含 .json；patch=局部 JSON 配置片段，如 {"frontendToolPolicy":{"tools":{"web_search":{"enabled":true}}}}）/ delete 删除覆盖（name 必填）。

约束：patch 必须为 JSON 对象，写入后自动校验，失败报错不留坏文件；覆盖只影响工具开关/模型连接等配置项，字符类设置（persona/角色名）用对应专用工具；删除前先 list 确认文件名。`
  parameters = [
    {
      name: 'action',
      type: 'string' as const,
      description: 'list / write / delete',
      required: true
    },
    {
      name: 'name',
      type: 'string' as const,
      description: 'patch 文件名（不含 .json，write/delete 必填）',
      required: false
    },
    {
      name: 'patch',
      type: 'object' as const,
      description: '配置片段（JSON 对象，write 必填）',
      required: false
    }
  ]

  async execute(params: Record<string, unknown>, ctx?: ToolContext): Promise<ToolResult> {
    const action = params.action as string | undefined
    const name = params.name as string | undefined
    const patch = params.patch as Record<string, unknown> | undefined
    const dataRoot = ctx?.paths?.root

    if (!dataRoot) {
      return { ok: false, error: '无法访问数据目录（ctx.paths.root 缺失）' }
    }

    if (action === 'list') {
      const files = listPatchFiles(dataRoot)
      const pluginPatches = kernelRegistry.get<Record<string, unknown>>('configPatch')
      return {
        ok: true,
        data: {
          dir: `${dataRoot}/${PATCH_DIR}/`,
          patchFiles: files,
          pluginPatches: pluginPatches.map((p) => ({ plugin: p })),
          tip: 'write 用 { action: "write", name: "010-xxx", patch: {...} }；delete 用 { action: "delete", name: "010-xxx" }'
        }
      }
    }

    if (action === 'write') {
      if (!name) return { ok: false, error: 'write 需要 name 参数（patch 文件名，不含 .json）' }
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
        return { ok: false, error: 'write 需要 patch 参数（JSON 对象，AppConfig 局部覆盖）' }
      }
      try {
        const filePath = writePatchFile(dataRoot, name, patch)
        return { ok: true, data: { filePath, note: '已写入覆盖层，配置读取点即时生效（工具策略等）' } }
      } catch (err) {
        return { ok: false, error: `写入失败（已回读校验拦截）: ${(err as Error).message}` }
      }
    }

    if (action === 'delete') {
      if (!name) return { ok: false, error: 'delete 需要 name 参数（patch 文件名，不含 .json）' }
      const ok = deletePatchFile(dataRoot, name)
      return ok
        ? { ok: true, data: { note: `已删除覆盖 ${name}.json，对应配置恢复核心值` } }
        : { ok: false, error: `未找到覆盖文件 ${name}.json` }
    }

    return { ok: false, error: `未知 action: ${String(action)}（支持 list/write/delete）` }
  }
}
