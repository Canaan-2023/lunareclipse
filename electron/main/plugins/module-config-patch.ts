/**
 * 插件 config.patch.json 模块加载器

 * 插件需要按需调整系统配置（如关闭某能力、调整模型参数）而不修改核心配置，
 * 故以 AppConfig 同构的局部覆盖叠加、启用时合并进配置读取链——

 * 协议：config.patch.json = AppConfig 同构的局部覆盖对象。
 * 启用插件时合并进配置读取链（优先级：核心配置 < patch 层 < 插件），
 * 停用/卸载插件时移除该覆盖（可逆）。

 * 合并消费在配置读取链（config-store）实现，这里只负责注册与回滚句柄。
 */
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { kernelRegistry } from '../kernel'
import type { ExtensionHandle } from '../kernel'

/** 加载 config.patch.json（不存在则跳过；失败收集进 errors） */
export function loadConfigPatchModule(
  dirPath: string,
  pluginName: string,
  errors: string[]
): ExtensionHandle[] {
  const patchFile = join(dirPath, 'config.patch.json')
  if (!existsSync(patchFile)) return []
  try {
    const raw = JSON.parse(readFileSync(patchFile, 'utf-8')) as unknown
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      errors.push('config.patch.json 必须是 JSON 对象')
      return []
    }
    return [kernelRegistry.register('configPatch', { kind: 'plugin', pluginName }, raw)]
  } catch (err) {
    errors.push(`config.patch.json 加载失败: ${(err as Error).message}`)
    return []
  }
}
