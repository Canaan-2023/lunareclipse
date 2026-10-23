/**
 * 配置树（配置覆盖层，阶段 5 配置树）

 * 层级（优先级从低到高，后合并覆盖先）：
 * 1. 核心配置：config.json（AI 不可写，protect 拦截）
 * 2. profile 层：abyssac_data/profiles/<name>.json（具名配置组装，活跃 profile 合并）
 * 3. bundle 层：abyssac_data/bundles/<name>.json（组合包，config 段合并 + plugins 声明）
 * 4. patch 文件层：abyssac_data/patch/*.json（AI 可写，按文件名序合并）
 * 5. 插件 config.patch.json（经内核注册表登记，启用合并/停用移除）

 * 另有 cordis.patch overlay：abyssac_data/cordis.patch.json（map：插件 id → 配置片段），
 * 在 cordis-mounter 挂载 Cordis 模块时按 id 深合并进模块 config（patch 语义：
 * 只覆盖声明键、不整体替换模块默认值；月蚀用 JSON 同构表达）。

 * 合并语义：对象深合并（嵌套递归），数组/标量整体替换（不 merge 数组）。
 * 读取入口：ConfigStore.getEffective()（核心 + profile + bundle + patch + 插件的合并结果）。
 * 为什么存在：核心配置 AI 不可写且需按环境/用户/插件分层覆盖，配置树让低优先级层可安全叠加局部配置而不触碰受保护核心。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'

/** patch 文件目录名（相对 dataRoot） */
export const PATCH_DIR = 'patch'
/** profile 目录名（相对 dataRoot） */
export const PROFILES_DIR = 'profiles'
/** bundle 目录名（相对 dataRoot） */
export const BUNDLES_DIR = 'bundles'
/** 活跃 profile / bundle 标记文件名（内容为选中名，无文件 = 未激活） */
export const ACTIVE_PROFILE_FILE = '.active-profile'
export const ACTIVE_BUNDLE_FILE = '.active-bundle'
/** cordis.patch overlay 文件（相对 dataRoot） */
export const CORDIS_PATCH_FILE = 'cordis.patch.json'

/** 深合并：对象递归合并，数组/标量整体替换 */
export function deepMerge<T>(base: T, patch: unknown): T {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    return patch as T
  }
  if (base === null || typeof base !== 'object' || Array.isArray(base)) {
    return patch as T
  }
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    out[k] = deepMerge(out[k], v)
  }
  return out as T
}

/**
 * **补丁层不得覆盖的安全键**（结构性防线）。
 *
 * 为什么存在（0.52.88 代码审查 P0）：patch 层是 AI 可写的（`config_patch` 工具，
 * `defaultEnabled: true`）。此前 `mergeConfigLayers` 对任意键深合并，于是 AI 可以写
 * `{"securityGrants":{"grants":{"t1.collector":…}},"collector":{"enabled":true}}`，
 * 让 `getEffective()` 把「授予」与「用户开关」一起注入——`collect-environment` /
 * `lan-control` 读的正是 `ctx.config`（= getEffective），**两层闸门同时变绿**，
 * 而权限面板读核心配置仍显示「未授予」。这等于绕过 `t0.bypass-approval`。
 *
 * 口径：这些键**只认核心配置**（用户 IPC / 设置页写入）。补丁层出现即丢弃；
 * `writePatchFile` 对显式写入直接拒绝并报错（不静默）。
 */
export const PROTECTED_CONFIG_KEYS = [
  'securityGrants',
  'collector',
  'permissionGreenlight',
  'commandPolicy',
  'toolPermissionOverrides'
] as const

const PROTECTED_KEY_SET: ReadonlySet<string> = new Set(PROTECTED_CONFIG_KEYS)

/** 去掉补丁里的受保护键（返回被丢弃的键名，便于调用方告警/审计） */
export function stripProtectedConfigKeys(patch: Record<string, unknown>): {
  patch: Record<string, unknown>
  blocked: string[]
} {
  const out: Record<string, unknown> = {}
  const blocked: string[] = []
  for (const [k, v] of Object.entries(patch)) {
    if (PROTECTED_KEY_SET.has(k)) blocked.push(k)
    else out[k] = v
  }
  return { patch: out, blocked }
}

/** 写入前校验：补丁里出现受保护键 → 直接拒绝（错误信息要能让人知道为什么） */
export function assertNoProtectedConfigKeys(patch: Record<string, unknown>): void {
  const blocked = Object.keys(patch).filter((k) => PROTECTED_KEY_SET.has(k))
  if (blocked.length > 0) {
    throw new Error(
      `补丁不得覆盖安全键：${blocked.join(', ')}（授予只能经用户 IPC，采集/命令策略只能在设置页修改）`
    )
  }
}

/** 合并多层 patch（顺序应用，后覆盖先；受保护键在合并前丢弃，防手写补丁绕过） */
export function mergeConfigLayers<T>(core: T, patches: Array<Record<string, unknown>>): T {
  let merged = core
  for (const patch of patches) {
    const clean = stripProtectedConfigKeys(patch)
    if (clean.blocked.length > 0) {
      console.warn(`[config] 已忽略补丁中的安全键：${clean.blocked.join(', ')}`)
    }
    merged = deepMerge(merged, clean.patch)
  }
  return merged
}

/** 读 patch 目录全部文件（按文件名排序），解析失败跳过 */
export function readPatchFiles(dataRoot: string): Array<Record<string, unknown>> {
  const dir = join(dataRoot, PATCH_DIR)
  if (!existsSync(dir)) return []
  const patches: Array<Record<string, unknown>> = []
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.json')).sort()) {
    try {
      const raw = JSON.parse(readFileSync(join(dir, name), 'utf-8')) as unknown
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        patches.push(raw as Record<string, unknown>)
      }
    } catch {
      // 损坏 patch 文件跳过不报错（防一个坏文件拖垮全部配置加载）
    }
  }
  return patches
}

/** 写 patch 文件（写后回读校验，防写坏；安全键直接拒绝） */
export function writePatchFile(dataRoot: string, name: string, patch: Record<string, unknown>): string {
  assertNoProtectedConfigKeys(patch)
  const dir = join(dataRoot, PATCH_DIR)
  mkdirSync(dir, { recursive: true })
  const safeName = name.replace(/[^\w.-]/g, '_').replace(/\.json$/i, '') + '.json'
  const filePath = join(dir, safeName)
  writeFileSync(filePath, JSON.stringify(patch, null, 2), 'utf-8')
  // 回读校验：写入后可读且为合法对象（防写坏）
  const back = JSON.parse(readFileSync(filePath, 'utf-8')) as unknown
  if (!back || typeof back !== 'object' || Array.isArray(back)) {
    throw new Error('patch 写入校验失败')
  }
  return filePath
}

/** 删除 patch 文件 */
export function deletePatchFile(dataRoot: string, name: string): boolean {
  const dir = join(dataRoot, PATCH_DIR)
  const safeName = name.replace(/[^\w.-]/g, '_').replace(/\.json$/i, '') + '.json'
  const filePath = join(dir, safeName)
  if (!existsSync(filePath)) return false
  rmSync(filePath, { force: true })
  return true
}

/** 辅助：读 dir 下全部 .json 文件（名 → 内容），目录不存在返回空数组 */
function readJsonDir(dataRoot: string, dirName: string): Array<{ name: string; content: Record<string, unknown> }> {
  const dir = join(dataRoot, dirName)
  if (!existsSync(dir)) return []
  const out: Array<{ name: string; content: Record<string, unknown> }> = []
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.json')).sort()) {
    try {
      const raw = JSON.parse(readFileSync(join(dir, name), 'utf-8')) as unknown
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        out.push({ name: name.replace(/\.json$/i, ''), content: raw as Record<string, unknown> })
      }
    } catch {
      // 损坏文件跳过不报错（防一个坏文件拖垮全部配置加载）
    }
  }
  return out
}

/** 列出 profile 文件（名 → 原始内容，未解析 config/extends——用于面板展示） */
export function listProfileFiles(dataRoot: string): Array<{ name: string; content: Record<string, unknown> }> {
  return readJsonDir(dataRoot, PROFILES_DIR)
}

/** 列出 bundle 文件（名 → 原始内容，未解析 plugins/config——用于面板展示） */
export function listBundleFiles(dataRoot: string): Array<{ name: string; content: Record<string, unknown> }> {
  return readJsonDir(dataRoot, BUNDLES_DIR)
}

/** 写 profile 文件（整体覆盖，回读校验） */
export function writeProfileFile(dataRoot: string, name: string, content: Record<string, unknown>): string {
  const dir = join(dataRoot, PROFILES_DIR)
  mkdirSync(dir, { recursive: true })
  const safeName = name.replace(/[^\w.-]/g, '_') + '.json'
  const filePath = join(dir, safeName)
  writeFileSync(filePath, JSON.stringify(content, null, 2), 'utf-8')
  const back = JSON.parse(readFileSync(filePath, 'utf-8')) as unknown
  if (!back || typeof back !== 'object' || Array.isArray(back)) {
    throw new Error('profile 写入校验失败')
  }
  return filePath
}

/** 删除 profile 文件（激活中的 profile 删除后自动解除激活） */
export function deleteProfileFile(dataRoot: string, name: string): boolean {
  const dir = join(dataRoot, PROFILES_DIR)
  const safeName = name.replace(/[^\w.-]/g, '_') + '.json'
  const filePath = join(dir, safeName)
  if (!existsSync(filePath)) return false
  rmSync(filePath, { force: true })
  if (readActiveProfile(dataRoot) === name) writeActiveProfile(dataRoot, null)
  return true
}

/** 写 bundle 文件（整体覆盖，回读校验） */
export function writeBundleFile(dataRoot: string, name: string, content: Record<string, unknown>): string {
  const dir = join(dataRoot, BUNDLES_DIR)
  mkdirSync(dir, { recursive: true })
  const safeName = name.replace(/[^\w.-]/g, '_') + '.json'
  const filePath = join(dir, safeName)
  writeFileSync(filePath, JSON.stringify(content, null, 2), 'utf-8')
  const back = JSON.parse(readFileSync(filePath, 'utf-8')) as unknown
  if (!back || typeof back !== 'object' || Array.isArray(back)) {
    throw new Error('bundle 写入校验失败')
  }
  return filePath
}

/** 删除 bundle 文件（激活中的 bundle 删除后自动解除激活） */
export function deleteBundleFile(dataRoot: string, name: string): boolean {
  const dir = join(dataRoot, BUNDLES_DIR)
  const safeName = name.replace(/[^\w.-]/g, '_') + '.json'
  const filePath = join(dir, safeName)
  if (!existsSync(filePath)) return false
  rmSync(filePath, { force: true })
  if (readActiveBundle(dataRoot) === name) writeActiveBundle(dataRoot, null)
  return true
}

/** 列出 patch 文件（名 → 内容；name 为完整文件名含 .json，保持历史契约） */
export function listPatchFiles(dataRoot: string): Array<{ name: string; content: Record<string, unknown> }> {
  const dir = join(dataRoot, PATCH_DIR)
  if (!existsSync(dir)) return []
  const out: Array<{ name: string; content: Record<string, unknown> }> = []
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.json')).sort()) {
    try {
      const raw = JSON.parse(readFileSync(join(dir, name), 'utf-8')) as unknown
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        out.push({ name, content: raw as Record<string, unknown> })
      }
    } catch {
      // 损坏文件跳过不报错（防一个坏文件拖垮全部配置加载）
    }
  }
  return out
}

// ─── profile 层（具名配置组装） ─────────────────────────────────────────────

/** 单个 profile 文件的结构（配置组装声明） */
export interface ProfileDecl {
  /** profile 名（文件名） */
  name: string
  /** 继承的 profile 名（先合并父 profile，再合并本 profile；环检测） */
  extends?: string[]
  /** 配置片段（AppConfig 同构局部覆盖，合并进配置读取链） */
  config?: Record<string, unknown>
  /** 可选说明 */
  description?: string
}

/** 读活跃 profile 名（无 .active-profile 文件返回 null） */
export function readActiveProfile(dataRoot: string): string | null {
  const file = join(dataRoot, ACTIVE_PROFILE_FILE)
  if (!existsSync(file)) return null
  const raw = readFileSync(file, 'utf-8').trim()
  return raw.length > 0 ? raw : null
}

/** 写活跃 profile 名（传 null 表示清除激活） */
export function writeActiveProfile(dataRoot: string, name: string | null): void {
  const file = join(dataRoot, ACTIVE_PROFILE_FILE)
  if (name === null || name === '') {
    if (existsSync(file)) rmSync(file, { force: true })
    return
  }
  mkdirSync(dataRoot, { recursive: true })
  writeFileSync(file, name, 'utf-8')
}

/** 列出全部 profile 名（按文件名排序） */
export function listProfiles(dataRoot: string): string[] {
  const dir = join(dataRoot, PROFILES_DIR)
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter((n) => n.endsWith('.json')).map((n) => n.replace(/\.json$/i, '')).sort()
}

/** 读单个 profile 声明（不存在返回 null；损坏跳过 config 并返回空 config） */
export function readProfile(dataRoot: string, name: string): ProfileDecl | null {
  const file = join(dataRoot, PROFILES_DIR, `${name.replace(/[^\w.-]/g, '_')}.json`)
  if (!existsSync(file)) return null
  try {
    const raw = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const decl: ProfileDecl = { name }
    if (Array.isArray(raw.extends)) {
      decl.extends = raw.extends.filter((e): e is string => typeof e === 'string')
    }
    if (raw.config && typeof raw.config === 'object' && !Array.isArray(raw.config)) {
      decl.config = raw.config as Record<string, unknown>
    }
    if (typeof raw.description === 'string') decl.description = raw.description
    return decl
  } catch {
    return null
  }
}

/**
 * 解析 profile 的完整有效配置片段（按继承顺序合并：父在前子在后，后覆盖先）。
 * 环检测：出现环时跳过环上的后继合并（防死循环），仅合并无环部分。
 */
export function resolveProfileConfig(dataRoot: string, name: string): Record<string, unknown> {
  const merged: Record<string, unknown> = {}
  const visiting = new Set<string>()
  const visit = (n: string, stack: string[]): void => {
    if (visiting.has(n)) return
    visiting.add(n)
    const decl = readProfile(dataRoot, n)
    if (decl) {
      for (const parent of decl.extends ?? []) {
        if (stack.includes(parent)) continue // 环：跳过父链，防死循环
        visit(parent, [...stack, n])
      }
      if (decl.config) {
        Object.assign(merged, decl.config)
      }
    }
    visiting.delete(n)
  }
  visit(name, [])
  return merged
}

/**
 * 读全部 profile 层有效配置片段（聚合为单个 patch）。
 * - 活跃 profile 存在时合并其 config（含继承链）；
 * - 无活跃 profile 时返回一个既是基线的空对象（不污染配置链）。
 */
export function readActiveProfileConfig(dataRoot: string): Record<string, unknown> {
  const active = readActiveProfile(dataRoot)
  if (!active) return {}
  return resolveProfileConfig(dataRoot, active)
}

// ─── bundle 层（组合包） ────────────────────────────────────────────────────

/** 单个 bundle 文件的结构（组合包声明） */
export interface BundleDecl {
  /** bundle 名（文件名） */
  name: string
  /** 组合包包含的插件 id 列表（插件目录名） */
  plugins: string[]
  /** 组合包的配置片段（合并进配置读取链，优先级高于 profile、低于 patch 文件） */
  config?: Record<string, unknown>
  /** 可选说明 */
  description?: string
}

/** 读活跃 bundle 名（无 .active-bundle 文件返回 null） */
export function readActiveBundle(dataRoot: string): string | null {
  const file = join(dataRoot, ACTIVE_BUNDLE_FILE)
  if (!existsSync(file)) return null
  const raw = readFileSync(file, 'utf-8').trim()
  return raw.length > 0 ? raw : null
}

/** 写活跃 bundle 名（传 null 表示清除激活） */
export function writeActiveBundle(dataRoot: string, name: string | null): void {
  const file = join(dataRoot, ACTIVE_BUNDLE_FILE)
  if (name === null || name === '') {
    if (existsSync(file)) rmSync(file, { force: true })
    return
  }
  mkdirSync(dataRoot, { recursive: true })
  writeFileSync(file, name, 'utf-8')
}

/** 列出全部 bundle 名（按文件名排序） */
export function listBundles(dataRoot: string): string[] {
  const dir = join(dataRoot, BUNDLES_DIR)
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter((n) => n.endsWith('.json')).map((n) => n.replace(/\.json$/i, '')).sort()
}

/** 读单个 bundle 声明（不存在返回 null） */
export function readBundle(dataRoot: string, name: string): BundleDecl | null {
  const file = join(dataRoot, BUNDLES_DIR, `${name.replace(/[^\w.-]/g, '_')}.json`)
  if (!existsSync(file)) return null
  try {
    const raw = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const decl: BundleDecl = { name, plugins: [] }
    if (Array.isArray(raw.plugins)) {
      decl.plugins = raw.plugins.filter((p): p is string => typeof p === 'string')
    }
    if (raw.config && typeof raw.config === 'object' && !Array.isArray(raw.config)) {
      decl.config = raw.config as Record<string, unknown>
    }
    if (typeof raw.description === 'string') decl.description = raw.description
    return decl
  } catch {
    return null
  }
}

/** 读活跃 bundle 的配置片段（无活跃 bundle 或 bundle 无 config 时返回空对象） */
export function readActiveBundleConfig(dataRoot: string): Record<string, unknown> {
  const active = readActiveBundle(dataRoot)
  if (!active) return {}
  const decl = readBundle(dataRoot, active)
  return decl?.config ?? {}
}

/** 读活跃 bundle 的插件 id 列表（无活跃 bundle 返回空数组） */
export function readActiveBundlePlugins(dataRoot: string): string[] {
  const active = readActiveBundle(dataRoot)
  if (!active) return []
  const decl = readBundle(dataRoot, active)
  return decl?.plugins ?? []
}

/**
 * 组装配置树覆盖层（低 → 高：base → profile → bundle → patch 文件）。
 * 供 ConfigStore.setPatchProvider / cordis-runtime 使用；
 * 该纯函数自身以数组返回各层配置片段，调用方按顺序 mergeConfigLayers。
 */
export function buildConfigTreeLayers(
  dataRoot: string
): Array<{ source: 'profile' | 'bundle' | 'patch'; name: string; content: Record<string, unknown> }> {
  const layers: Array<{ source: 'profile' | 'bundle' | 'patch'; name: string; content: Record<string, unknown> }> = []
  const profileCfg = readActiveProfileConfig(dataRoot)
  if (Object.keys(profileCfg).length > 0) {
    layers.push({ source: 'profile', name: readActiveProfile(dataRoot) ?? '', content: profileCfg })
  }
  const bundleCfg = readActiveBundleConfig(dataRoot)
  if (Object.keys(bundleCfg).length > 0) {
    layers.push({ source: 'bundle', name: readActiveBundle(dataRoot) ?? '', content: bundleCfg })
  }
  for (const f of listPatchFiles(dataRoot)) {
    layers.push({ source: 'patch', name: f.name, content: f.content })
  }
  return layers
}

// ─── cordis.patch overlay（按插件 id patch Cordis 模块 config） ────────────

/**
 * 读 cordis.patch overlay：abyssac_data/cordis.patch.json
 * 结构：{ "<插件id/目录名>": { ...配置片段 } }。
 * 在 cordis-mounter 挂载模块时按 id 深合并进模块 config（patch 语义：只覆盖声明键）。
 * 无文件或损坏返回空 map（不中断加载）。
 */
export function readCordisPatchOverlay(dataRoot: string): Record<string, Record<string, unknown>> {
  const file = join(dataRoot, CORDIS_PATCH_FILE)
  if (!existsSync(file)) return {}
  try {
    const raw = JSON.parse(readFileSync(file, 'utf-8')) as unknown
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
    const out: Record<string, Record<string, unknown>> = {}
    for (const [id, cfg] of Object.entries(raw as Record<string, unknown>)) {
      if (cfg && typeof cfg === 'object' && !Array.isArray(cfg)) {
        out[id] = cfg as Record<string, unknown>
      }
    }
    return out
  } catch {
    return {}
  }
}

/**
 * 写 cordis.patch overlay（整体替换）。dataRoot 为空时返回 false（不写）。
 * 回读校验防写坏。
 */
export function writeCordisPatchOverlay(dataRoot: string, overlay: Record<string, Record<string, unknown>>): boolean {
  if (dataRoot === '') return false
  const file = join(dataRoot, CORDIS_PATCH_FILE)
  mkdirSync(dataRoot, { recursive: true })
  writeFileSync(file, JSON.stringify(overlay, null, 2), 'utf-8')
  const back = JSON.parse(readFileSync(file, 'utf-8')) as unknown
  if (!back || typeof back !== 'object' || Array.isArray(back)) {
    throw new Error('cordis.patch 写入校验失败')
  }
  return true
}
