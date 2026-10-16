/**
 * @category 工具
 * @summary 技能系统：技能加载、校验、领域与市场
 *
 * 技能子系统对外统一导出入口：把加载器、配置层、类型与校验错误
 * 汇总暴露给主进程其他模块与 IPC，避免各调用方直接依赖内部文件。
 */
export { SkillLoader, getDomainSkillsDir, getUserSkillsDir, parseSkillFile } from './loader'
export {
  getDefaultSkillsConfigPath,
  loadSkillsConfig,
  saveSkillsConfig,
  setSkillEnabled,
  ensureSkillsConfigExists,
  watchSkillsConfig,
  stopWatchingSkillsConfig
} from './skill-config'
export type {
  Skill,
  SkillMetadata,
  SkillFrontmatter,
  SkillSource,
  SkillContext,
  SkillRuntimeConfig,
  SkillRuntimeStatus,
  SkillsLoadResult
} from './types'
export { SkillValidationError } from './types'
// SkillsConfig / SkillConfigEntry 定义在 skill-config.ts（运行时配置层，非类型层）
export type { SkillsConfig, SkillConfigEntry } from './skill-config'
