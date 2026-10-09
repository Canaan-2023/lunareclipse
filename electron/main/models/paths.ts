/**
 * 数据路径的唯一权威定义：月蚀系统所有文件位置集中在此处，
 * 避免各处硬编码路径导致按 uid/aiId 作用域分层改造后遗漏。
 * 提供路径接口（BaseDataPaths/DataPaths）、全局路径构造 buildDataPaths
 * 与作用域路径解析 resolveScopePaths（记忆/NNG/cache/sessions 的最终目录结构）。
 * 不删掉的理由：日记线/NNG 线/缓存镜像的目录约定（memory/U{uid}/AI{aiId}/raw_memory、
 * NNG/AI{aiId}/U{uid} ↔ cache/AI{aiId}/U{uid} 同构、diary/{年}/{月}/index.json）都以本模块为唯一真源，
 * 路径漂移会同时破坏写入与检索两侧，故所有文件位置只能在此定义。
 */
import { readdirSync, existsSync } from 'fs'
import { resolve, join, isAbsolute } from 'path'

/** 记忆作用域：用户 UID + AI 编号（月蚀=1、莉莉丝=2，ai-registry.json 可扩展） */
export interface MemoryScope {
  uid: number
  aiId: number
}

/** 全局（非作用域）数据路径：不按用户/AI 分层的基础设施路径 */
export interface BaseDataPaths {
  root: string
  /** 技能根目录（{root}/skills，按用户/AI 分层） */
  skills: string
  memory: string
  nng: string
  nngRoot: string
  nngRootJson: string
  cache: string
  cacheIndex: string
  cacheIndexJson: string
  /** 缓存注入根（{root}/cache/AI{aiId}/U{uid}/injection/，并入缓存根，不再散在顶层） */
  cacheInjectionRoot: string
  users: string
  usersJson: string
  /** AI 编号注册表（月蚀=1、莉莉丝=2，可扩展；记忆/RAW/NNG 只认编号） */
  aiRegistryJson: string
  /** 记忆工作流待处理批次根（{root}/workflows/pending，未完成批次.json / diary_pending.json 存此） */
  workflowPending: string
  sessions: string
  fileMonitor: string
  fileMonitorErrorLog: string
  fileMonitorCorrupted: string
  fileMonitorState: string
  /** 历史遗留：任务折叠层 detail 目录（折叠已移除，保留字段供兼容与 purge 白名单引用） */
  taskDetails: string
  /** L8 工作流引擎：根目录（templates + instances） */
  workflows: string
  /** L8 工作流引擎：模板目录（每个模板一个 JSON 文件） */
  workflowTemplates: string
  /** L8 工作流引擎：运行中实例目录（崩溃恢复用） */
  workflowInstances: string
/** 前端 AI 数据目录（{root}/frontend，character 角色定义等运行时数据；提示词唯一权威在 prompts/，不在此处） */
  frontend: string
  /** 模块系统根目录（用户数据，动态加载插件工具） */
  plugins: string
  /** 标准 Cron 定时任务配置目录 */
  cron: string
  /** 文件工坊执行器配置文件 */
  sandboxEnv: string
  /** AI 下载的运行时环境目录 */
  sandboxRuntimes: string
  /** ABYSS 根目录（{root}/ABYSS）：用户信息 USER.md 与 AI 自我认知 AI.md 独立存放，不混入记忆数据 */
  abyss: string
}

/** 作用域（scoped）数据路径：在 BaseDataPaths 上按 {root}/memory/U{uid}/AI{aiId} 等分层 */
export interface DataPaths extends BaseDataPaths {
  /** 记忆工作域根（{root}/memory/U{uid}/AI{aiId}） */
  memoryScope?: string
  /** 日历库（{root}/memory/U{uid}/AI{aiId}/calendar，收进记忆工作域） */
  calendar?: string
  /** 日记索引目录（{root}/memory/U{uid}/AI{aiId}/diary，按年月目录分层：diary/{年}/{月}/index.json） */
  diary?: string
  memoryNormal: string
  memoryMeta: string
  memoryHigh: string
  memoryCounter: string
  rawMemory: string
  rawMemoryCounter: string
  /** 一级节点目录（root.json 的同名文件夹，一级 _nng.json 直接放这里） */
  nngLevel1Dir: string
  /** 一级缓存目录（index.json 的同名文件夹，一级 _cache.json 直接放这里） */
  cacheLevel1Dir: string
/** 记忆工作流处理 raw_memory 的进度文档（scoped：{memoryScope}/raw_memory进度.json） */
  rawMemoryProgress: string
  /** 用户级个人信息文件（{root}/ABYSS/U{uid}/USER.md）：所有 AI 会话注入，个人中心编辑；AI 经 update_user_preference 写入 */
  userMd: string
  /** AI 级自我认知文件（{root}/ABYSS/U{uid}/AI{aiId}/AI.md）：update_abyss_md 工具写入，放 prompt 最后注入 */
  aiMd: string
}

export function buildDataPaths(dataDir: string): BaseDataPaths {
  const root = resolve(dataDir, 'abyssac_data')
return {
    root,
    memory: join(root, 'memory'),
nng: join(root, 'NNG'),
    // 重构：全局 NNG/cache 只是分类定位（watch 根），ROOT/一级节点在工作域内
    // （AI{aiId}/U{uid}/root.json + AI{aiId}/U{uid}/root/）；以下全局字段保留为 watch 根/索引
    nngRoot: join(root, 'NNG'),
    nngRootJson: join(root, 'NNG', 'root.json'),
    cache: join(root, 'cache'),
    cacheIndex: join(root, 'cache'),
    cacheIndexJson: join(root, 'cache', 'index.json'),
    cacheInjectionRoot: join(root, 'cache', 'injection'),
    users: join(root, 'users'),
    usersJson: join(root, 'users', 'users.json'),
    aiRegistryJson: join(root, 'ai-registry.json'),
workflowPending: join(root, 'workflows', 'pending'),
    sessions: join(root, 'sessions'),
    fileMonitor: join(root, '.file_monitor'),
    fileMonitorErrorLog: join(root, '.file_monitor', '错误日志.jsonl'),
    fileMonitorCorrupted: join(root, '.file_monitor', 'corrupted'),
    fileMonitorState: join(root, '.file_monitor', '监控器状态.json'),
    taskDetails: join(root, 'task_details'),
    workflows: join(root, 'workflows'),
    workflowTemplates: join(root, 'workflows', 'templates'),
    workflowInstances: join(root, 'workflows', 'instances'),
frontend: join(root, 'frontend'),
    plugins: join(root, 'plugins'),
    cron: join(root, 'cron'),
    skills: join(root, 'skills'), // 域根（{root}/skills，其下按 U{uid}/AI{aiId} 分层，真源见 scopedDomainPath）
    sandboxEnv: join(root, 'sandbox-env.json'),
    sandboxRuntimes: join(root, 'runtimes'),
    abyss: join(root, 'ABYSS')
  }
}

/**
 * 作用域路径解析（设计依据：此目录结构为各子系统间数据归属的单一事实来源——路径层级
 * 决定数据隔离粒度，改动需同时评估记忆/会话/NNG 三方落盘与迁移逻辑，故整块收敛于此）：
 * 记忆： {root}/memory/U{uid}/AI{aiId}/
 * raw_memory/年/月/日/ ← RAW 记忆（对话流水）
 * {normal,meta,high}/年/月/日/ ← 普通/元认知/高阶记忆（三档直挂工作域，不套 memory 层）
 * calendar/ diary/ ← 日历、日记索引（diary/{年}/{月}/index.json，与 raw_memory 同构分层）
 * U/AI 前缀区分：uid 全局唯一（主系统统一发放），主/分系统账号数据同存 memory/，不冲突
 * sessions：{root}/sessions/U{uid}/AI{aiId}/（用户与 AI 的对话记录，U/AI 字面前缀与 memory 同构）
 * NNG： {root}/NNG/AI{aiId}/U{uid}/（AIID 在前——NNG 是 AI 的认知资产，按 AI 归属再分用户）
 * root.json + root/{一级二级三级节点}/
 * cache： {root}/cache/AI{aiId}/U{uid}/（与 NNG 同构，AIID 在前）
 * index.json + index/{节点}/
 * injection/ ← 缓存注入（并入缓存根，不再散在顶层）
 * skills/skills_domains/config（getScopedPath 域）：{root}/{domain}/U{uid}/AI{aiId}/
 * （与 memory 同构的 U/AI 字面前缀——作用域自描述，与"顶层直放技能"区分，
 * 真源实现见 scopedDomainPath()；曾经是裸数字 {uid}/{aiId}，与 memory/NNG/cache
 * 的前缀约定不一致，已统一为 U{uid}/AI{aiId}）
 */
export function resolveScopePaths(base: BaseDataPaths, scope: MemoryScope): DataPaths {
  // 记忆工作域：{root}/memory/U{uid}/AI{aiId}（语义文件夹化 + U/AI 前缀）
  const memoryScope = join(base.memory, `U${scope.uid}`, `AI${scope.aiId}`)
  return {
    ...base,
    memoryScope,
    calendar: join(memoryScope, 'calendar'),
    diary: join(memoryScope, 'diary'),
    // ===== 记忆体系（三档直挂工作域：{uid}/{aiId}/{normal,meta,high}/） =====
    memory: memoryScope,
    memoryNormal: join(memoryScope, 'normal'),
    memoryMeta: join(memoryScope, 'meta'),
    memoryHigh: join(memoryScope, 'high'),
    memoryCounter: join(memoryScope, '计数器.json'),
rawMemory: join(memoryScope, 'raw_memory'),
    rawMemoryCounter: join(memoryScope, 'raw_memory', '序号.json'),
    rawMemoryProgress: join(memoryScope, 'raw_memory进度.json'),
    sessions: join(base.root, 'sessions', `U${scope.uid}`, `AI${scope.aiId}`),
// ===== NNG 体系（AIID 在前：{root}/NNG/AI{aiId}/U{uid}/，ROOT 在工作域内） =====
    nngRoot: join(base.nng, `AI${scope.aiId}`, `U${scope.uid}`),
    nngRootJson: join(base.nng, `AI${scope.aiId}`, `U${scope.uid}`, 'root.json'),
    nngLevel1Dir: join(base.nng, `AI${scope.aiId}`, `U${scope.uid}`, 'root'),
    // ===== cache 体系（与 NNG 同构，AIID 在前：{root}/cache/AI{aiId}/U{uid}/） =====
    cacheIndex: join(base.cache, `AI${scope.aiId}`, `U${scope.uid}`),
    cacheIndexJson: join(base.cache, `AI${scope.aiId}`, `U${scope.uid}`, 'index.json'),
    cacheLevel1Dir: join(base.cache, `AI${scope.aiId}`, `U${scope.uid}`, 'index'),
    cacheInjectionRoot: join(base.cache, `AI${scope.aiId}`, `U${scope.uid}`, 'injection'),
    // ===== ABYSS 体系（独立于记忆数据，用户信息与 AI 自我认知分开存放） =====
    // 用户级 USER.md：{root}/ABYSS/U{uid}/USER.md（所有 AI 会话注入，个人中心/update_user_preference 编辑）
    // AI 级 AI.md： {root}/ABYSS/U{uid}/AI{aiId}/AI.md（update_abyss_md 写入，scoped 覆盖全局）
    userMd: join(base.abyss, `U${scope.uid}`, 'USER.md'),
    aiMd: join(base.abyss, `U${scope.uid}`, `AI${scope.aiId}`, 'AI.md')
  }
}

/**
 * 技能/配置类工作域的唯一分层真源：{root}/{domain}/U{uid}/AI{aiId}/。
 * 为什么存在——skills / skills_domains / config 三个 getScopedPath 域本来各有各的
 * 拼接逻辑（曾写死 {root}/{domain}/{uid}/{aiId} 裸数字分层），与 memory/NNG/cache
 * 的 U/AI 字面前缀语义不一致，属历史欠账；本次统一收拢到本函数，与 memory
 * （U{uid}/AI{aiId}）、NNG/cache（AI{aiId}/U{uid}）同为 paths.ts 单一事实来源。
 * 为什么不删——scope 确需落盘分层：多用户/多 AI 的数据若不隔离会互相污染，
 * 而裸数字 {uid}/{aiId} 无法自描述"这是作用域目录"，U/AI 前缀是显式的语义标记；
 * path-context.ts 的 getScopedPath 一律转发到本函数，保证各域分层完全一致。
 */
export function scopedDomainPath(root: string, domain: string, uid: number, aiId: number): string {
  return join(root, domain, `U${uid}`, `AI${aiId}`)
}

/**
 * 从 RAW 路径解析作用域（{root}/memory/U{uid}/AI{aiId}/raw_memory/...）——工作流无登录态时推断用
 */
export function scopeFromRawPath(rawPath: string, base: BaseDataPaths): MemoryScope | null {
  const norm = rawPath.replace(/\\/g, '/')
  const rootNorm = base.root.replace(/\\/g, '/').replace(/\/$/, '')
  const prefix = `${rootNorm}/memory/`
  if (!norm.startsWith(prefix)) return null
  const rest = norm.slice(prefix.length)
  const parts = rest.split('/')
  if (parts.length < 3) return null
  const uidMatch = /^U(\d+)$/.exec(parts[0])
  const aiMatch = /^AI(\d+)$/.exec(parts[1])
  if (!uidMatch || !aiMatch) return null
  return { uid: Number(uidMatch[1]), aiId: Number(aiMatch[1]) }
}

/**
 * 列出所有已存在的记忆作用域（{root}/memory/U{uid}/AI{aiId}/raw_memory 存在的组合）。
 * 调度器遍历用：每个作用域独立进度、独立取批。主/分系统账号同存 memory/，统一可见。
 */
export function listExistingScopes(base: BaseDataPaths): MemoryScope[] {
  const scopes: MemoryScope[] = []
  const memoryRoot = join(base.root, 'memory')
  if (!existsSync(memoryRoot)) return scopes
  let uidDirs: string[] = []
  try {
    uidDirs = readdirSync(memoryRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^U\d+$/.test(e.name))
      .map((e) => e.name)
  } catch {
    return scopes
  }
  for (const uidStr of uidDirs) {
    const uidDir = join(memoryRoot, uidStr)
    let aiDirs: string[] = []
    try {
      aiDirs = readdirSync(uidDir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && /^AI\d+$/.test(e.name))
        .map((e) => e.name)
    } catch {
      continue
    }
    for (const aiStr of aiDirs) {
      const aiDir = join(uidDir, aiStr)
      if (existsSync(join(aiDir, 'raw_memory')) || existsSync(join(aiDir, 'normal'))) {
        scopes.push({ uid: Number(uidStr.slice(1)), aiId: Number(aiStr.slice(2)) })
      }
    }
  }
  return scopes.sort((a, b) => a.uid - b.uid || a.aiId - b.aiId)
}

export function toAbsolutePath(p: string): string {
  return resolve(p).replace(/\\/g, '/')
}

export function normalizePath(p: string): string {
  return p.replace(/\\/g, '/')
}

/**
 * @deprecated 不要用于 JSON 路径字段。全系统统一的路径写法是 normalizePath（正斜杠）——
 * memory-sync / cache-sync / create-nng / create-memory 均以此为约定。本函数产出的
 * 「反斜杠 + 大写盘符」与主流水线不一致，正是曾导致同一文件多种写法（去重/关联静默失效）的诱因。
 * 保留仅为兼容潜在外部引用，新代码一律用 normalizePath。
 */
export function toWindowsPath(p: string): string {
  const normalized = p.replace(/\\/g, '/').replace(/\/+/g, '/')
  const withUpperDrive = normalized.replace(/^([a-z]):/i, (m, d) => d.toUpperCase() + ':')
  return withUpperDrive.split('/').join('\\')
}

export function getMemoryTypeDir(paths: DataPaths, type: MemoryType): string {
  switch (type) {
    case 'normal':
      return paths.memoryNormal
    case 'meta':
      return paths.memoryMeta
    case 'high':
      return paths.memoryHigh
  }
}

export type MemoryType = 'normal' | 'meta' | 'high'
export type NngType = 'standard' | 'meta' | 'high'

export const MEMORY_TYPES: MemoryType[] = ['normal', 'meta', 'high']
export const NNG_TYPES: NngType[] = ['standard', 'meta', 'high']

/** config.json 中 dataDir 的可移植标记值（相对路径，运行时按锚点解析，不写死机器绝对路径） */
export const DATA_DIR_MARKER = './data'

/**
 * dataDir 解析（设计依据：config 不存机器绑定绝对路径，存相对标记 + 锚点推导，
 * 使工作域可整体搬迁而不触发路径漂移——相对标记是跨机器可移植性的前提）：
 * - 配置里是相对标记（默认 ./data）→ 按锚点（打包=exe 目录 / dev=app 目录）解析成绝对路径，配置不动
 * - 配置里是绝对路径 → 尊重用户自定义（老配置已写死的绝对路径不回写、不强制迁移）
 *
 * @returns {dir} 运行时实际使用的绝对路径
 * @returns {shouldMigrateToMarker} 是否应把 config.dataDir 归位为 ./data 可移植标记
 * （仅当配置值等于「锚点推导出的默认位置」时迁移——即早期版本自动回写的绝对路径，
 * 迁移后 config 恢复可移植，换机器/换目录不再漂移）
 */
export function resolveDataDir(raw: string | undefined, anchor: string): { dir: string; shouldMigrateToMarker: boolean } {
  const value = raw?.trim() || DATA_DIR_MARKER
  if (isAbsolute(value)) {
    const defaultDir = resolve(anchor, DATA_DIR_MARKER)
    // 绝对路径恰好等于锚点默认位置（早期版本自动写回）→ 迁移回可移植标记
    if (toAbsolutePath(value).toLowerCase() === toAbsolutePath(defaultDir).toLowerCase()) {
      return { dir: defaultDir, shouldMigrateToMarker: true }
    }
    // 用户自定义绝对路径 → 尊重，原样使用
    return { dir: resolve(value), shouldMigrateToMarker: false }
  }
  // 相对标记 → 按锚点解析
  return { dir: resolve(anchor, value), shouldMigrateToMarker: false }
}
