/**
 * skill 运行时配置层：用户对每个技能的开/关状态持久化在 .skills.json
 * （不写进 SKILL.md 本体，避免污染技能源文件），提供配置读写、
 * per-skill 启用切换与配置文件热重载监听。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, watch, type FSWatcher } from 'fs'
import { join, dirname } from 'path'
import { getScopedPath } from '../models/path-context'

/** per-skill 运行时配置 */
export interface SkillConfigEntry {
  /** 是否启用（false 时完全不加载，不进 L1 索引） */
  enabled: boolean
}

/** .skills.json 结构 */
export interface SkillsConfig {
  /** per-skill 配置（key 是 skill name） */
  skills: Record<string, SkillConfigEntry>
}

/** 默认配置（空，所有 skill 默认启用） */
const DEFAULT_CONFIG: SkillsConfig = { skills: {} }

/** 防抖定时器 */
let debounceTimer: NodeJS.Timeout | null = null
/** 配置变化回调 */
let changeCallback: (() => void) | null = null
/** 文件监听器 */
let configWatcher: FSWatcher | null = null

export function getDefaultSkillsConfigPath(): string {
  return join(getScopedPath('config'), '.skills.json')
}

/** 确保配置文件存在（首次启动创建空配置） */
export function ensureSkillsConfigExists(configPath: string): void {
  if (existsSync(configPath)) return
  try {
    mkdirSync(dirname(configPath), { recursive: true })
    writeFileSync(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf-8')
  } catch (err) {
    console.error('[skills-config] 创建默认配置失败:', err)
  }
}

/** 加载配置（文件不存在或解析失败时返回默认配置） */
export function loadSkillsConfig(configPath: string): SkillsConfig {
  if (!existsSync(configPath)) return { ...DEFAULT_CONFIG }
  try {
    const raw = readFileSync(configPath, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<SkillsConfig>
    return {
      skills: parsed.skills ?? {}
    }
  } catch (err) {
    console.error('[skills-config] 加载配置失败:', err)
    return { ...DEFAULT_CONFIG }
  }
}

/** 保存配置（写入前确保父目录存在：骨架可能尚未预建，如运行期新注册 AI 的作用域） */
export function saveSkillsConfig(configPath: string, config: SkillsConfig): void {
  try {
    mkdirSync(dirname(configPath), { recursive: true })
    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8')
  } catch (err) {
    console.error('[skills-config] 保存配置失败:', err)
  }
}

/** 更新单个 skill 的启用状态 */
export function setSkillEnabled(
  configPath: string,
  skillName: string,
  enabled: boolean
): SkillsConfig {
  const config = loadSkillsConfig(configPath)
  if (!config.skills[skillName]) {
    config.skills[skillName] = { enabled }
  } else {
    config.skills[skillName].enabled = enabled
  }
  saveSkillsConfig(configPath, config)
  return config
}

/** 获取单个 skill 的运行时配置（不存在时返回默认 enabled=true） */
export function getSkillRuntimeConfig(
  config: SkillsConfig,
  skillName: string
): SkillConfigEntry {
  return config.skills[skillName] ?? { enabled: true }
}

/** 删除 skill 的配置条目（删除 skill 文件后清理残留配置） */
export function removeSkillConfig(
  configPath: string,
  skillName: string
): SkillsConfig {
  const config = loadSkillsConfig(configPath)
  if (config.skills[skillName]) {
    delete config.skills[skillName]
    saveSkillsConfig(configPath, config)
  }
  return config
}

/** 监听配置文件变化（热重载） */
export function watchSkillsConfig(
  configPath: string,
  callback: () => void
): void {
  if (configWatcher) {
    try { configWatcher.close() } catch { /* ignore */ }
  }
  changeCallback = callback
  if (!existsSync(configPath)) return
  try {
    configWatcher = watch(configPath, () => {
      // 500ms 防抖，避免连续触发
      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => {
        console.log('[skills-config] 检测到配置变化，触发热重载')
        changeCallback?.()
      }, 500)
    })
  } catch (err) {
    console.error('[skills-config] 监听配置失败:', err)
  }
}

/** 停止监听 */
export function stopWatchingSkillsConfig(): void {
  if (debounceTimer) {
    clearTimeout(debounceTimer)
    debounceTimer = null
  }
  if (configWatcher) {
    try { configWatcher.close() } catch { /* ignore */ }
    configWatcher = null
  }
  changeCallback = null
}
