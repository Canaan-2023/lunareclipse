/**
 * @category 核心
 * @summary 提示词段清单装配：`migratePersonaToAiMd`（persona → AI.md 一次性迁移）+ `createSegments`（声明式段清单 deps 收口）
 * @note 为什么存在：这段是 `startApiServer` 里最长的「纯装配」块——只把既有子系统（配置/用户/AI 注册表/
 * 提示词文件/工作区/地理/定时器/工具池）聚合成 `createSegmentManifest` 的 deps，不持有运行时状态。
 * 抽出的目的是让宿主 `server.ts` 只做编排（ADR-02 第二轮外移），行为逐字节等价。
 * @note 不删理由：段清单是注入链路的唯一真源，装配口径散回宿主会让「哪段注入什么」重新不可读。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import type { ConfigStore } from './config-store'
import type { UserStore } from '../models/user-store'
import { resolveScopePaths, type BaseDataPaths } from '../models/paths'
import { readAiRegistry, findAiById } from '../models/ai-registry'
import { AiManager } from '../services/ai-manager'
import type { ActivationManager } from './activation-manager'
import type { GeoLocationService } from '../services/geo-location'
import type { CronScheduler } from '../cron/scheduler'
import type { McpClientManager } from '../mcp/client-manager'
import type { SkillLoader } from '../skills/loader'
import type { ToolContext } from '../tools/base-tool'
import type { ToolRegistry } from '../tools'
import { DEFAULT_AI_ID } from '@shared/types'
import { createSegmentManifest } from '../prompts/segments'
import { readUserMdContent, readAiMdContent } from '../prompts/abyss-md'
import { loadLore, retrieveLore, formatLoreContext } from '../services/lilith-adapter'
import { buildSelfAwarenessSection } from '../kernel/introspection'
import { getWorkspaceContext } from '../services/workspace-state'
import { getDefaultWorkspaceConfigPath, getActiveWorkspace } from '../services/workspace-config'
import { listTopicPrompts } from '../prompts/loader'
import { buildLifecycleInjection } from './restart-pending'
import { buildToolDescription } from './tool-bridge'
import { chatModePrompt, TASK_LEAD_PROMPT } from './chat-envelope'
import { safePaths } from './tool-ctx-safe'

/** 段清单类型（生产签名派生，避免重复声明） */
export type SegmentManifest = ReturnType<typeof createSegmentManifest>

export interface SegmentManifestDeps {
  configStore: ConfigStore
  userStore: UserStore
  dataPaths: BaseDataPaths
  /** 会话 → 所属 AI 编号（多 AI P2；实现见 ./ai-scope） */
  resolveSessionAiId: (sessionId?: string) => number
  SHARED_PROMPTS: string
  FRONTEND_AI_PROMPT: string
  toolCtx: ToolContext
  activationManager: ActivationManager
  activationContentRef: { current: string | null }
  geoService: GeoLocationService | null
  cronSchedulerRef: CronScheduler | null
  mcpClientManager?: McpClientManager
  skillLoader: SkillLoader
  toolRegistry: ToolRegistry
}

/**
 * 一次性迁移：旧版 persona 注入链废弃后，若 scoped AI.md（当前用户 + AI1 的 ABYSS 自我认知）为空且
 * config.persona 非空，把 persona 内容作为初始自我认知写入 ABYSS/U{uid}/AI1/AI.md（用户已有一的身份不重复，
 * 由身份卡承担）。AI.md 是 AI 自维护文件（update_abyss_md 写入，放 prompt 最后注入），只迁移一次，不覆盖已有内容。
 * 无登录用户时跳过（旧全局文件数据已由 data-init 一次性迁移进 ABYSS）。
 */
export function migratePersonaToAiMd(deps: Pick<SegmentManifestDeps, 'configStore' | 'userStore' | 'dataPaths'>): void {
  const { configStore, userStore, dataPaths } = deps
  try {
    const currentUser = userStore.getCurrentUser()
    if (currentUser) {
      const aiMdPath = resolveScopePaths(dataPaths, { uid: currentUser.UID, aiId: DEFAULT_AI_ID }).aiMd
      const existing = existsSync(aiMdPath) ? readFileSync(aiMdPath, 'utf-8') : ''
      const persona = configStore.get().persona
      if (!existing.trim() && persona?.trim()) {
        // 剥离 "# 身份" 段（身份卡已由代码动态生成，不与用户已有一的身份重复）
        const body = persona
          .replace(/^#\s*身份[^\n]*\n+/, '')
          .replace(/\{aiName\}/g, configStore.get().aiName || '月蚀')
          .trim()
        if (body) {
          mkdirSync(join(aiMdPath, '..'), { recursive: true })
          writeFileSync(aiMdPath, body + '\n', 'utf-8')
        }
      }
    }
  } catch (err) {
    console.error('[server] persona → AI.md 一次性迁移失败:', err)
  }
}

/**
 * 创建声明式提示词段清单（SEGMENTS）。
 * 依赖注入：所有 segment build 函数需要的外部对象一次性传入，build 函数通过闭包捕获 deps，运行时按需调用。
 */
export function createSegments(deps: SegmentManifestDeps): SegmentManifest {
  const {
    configStore,
    userStore,
    dataPaths,
    resolveSessionAiId,
    SHARED_PROMPTS,
    FRONTEND_AI_PROMPT,
    toolCtx,
    activationManager,
    activationContentRef,
    geoService,
    cronSchedulerRef,
    mcpClientManager,
    skillLoader,
    toolRegistry
  } = deps

  return createSegmentManifest({
    getConfig: () => configStore.get(),
    getCurrentUser: () => userStore.getCurrentUser(),
    // 多 AI（P2）：按会话 aiId 查 registry（旧会话/未设置回退 1 + 配置名）；注册表异常时身份卡退化为只有名字
    getAiIdentity: (sessionId?: string) => {
      const cfg = configStore.get()
      const aiId = resolveSessionAiId(sessionId)
      let aiName = cfg.aiName || '月蚀'
      let agent: string | undefined
      try {
        const record = findAiById(readAiRegistry(dataPaths.aiRegistryJson), aiId)
        if (record?.name) aiName = record.name
        agent = record?.agent
      } catch {
        // 注册表异常时身份卡退化为只有名字
      }
      return { aiId, aiName, agent }
    },
    // 多 AI 社交黑话闭环：主会话注入本机 AI 编号→名字清单（chat-room/friend/publish 工具
    // description 要求 AI「编号先看本机 AI 编号列表」）。与 initMultiInstanceAi 的
    // buildAiIdConvention 同一数据源（ai-registry.json）、同格式（按 id 升序、`id 是 name`），
    // 空表返回空串；identity 段据此只在实际存在编号 AI 时追加黑话行，避免单 AI 用户被噪音污染。
    getAiIdConventionLine: () => {
      try {
        const ais = readAiRegistry(dataPaths.aiRegistryJson).ais
        const parts = ais
          .slice()
          .sort((a, b) => a.id - b.id)
          .map((a) => `${a.id} 是 ${a.name}`)
        return parts.length > 0 ? parts.join('、') : ''
      } catch {
        return ''
      }
    },
    // 多 AI（P2）：sys_prompt 按会话 aiId 读提示词副本（ai-prompts/AI{aiId}/system.md），
    // 副本非空用副本，空/缺返回 null → segments 层回退内置 frontendPrompt。
    // 为什么每次 new AiManager（而不是建单例/缓存）：
    // AiManager 无状态、构造仅收路径，readPrompt 每次直读文件——这是有意的：
    // 用户编辑提示词（update-ai 工具/设置面板）后下一轮必须立刻生效，任何缓存
    // 都会引入"编辑了但没生效"的陈旧状态；文件读一次的成本远低于缓存一致性成本。
    getSysPrompt: (sessionId?: string) =>
      new AiManager({
        registryPath: dataPaths.aiRegistryJson,
        aiPromptsRoot: join(dataPaths.frontend, 'ai-prompts'),
        // 莉莉丝单一来源：普通会话提示词基底派生自同一份 character/lilith.json（桌宠同源）
        lilithCharacterPath: join(dataPaths.frontend, 'character', 'lilith.json')
      }).readPrompt(resolveSessionAiId(sessionId)),
    // shared 层按 AI 文件粒度注入：有 AI 副本 shared/* → 合并文本；无 → 回退 boot 常量
    getSharedPrompts: (sessionId?: string) =>
      new AiManager({
        registryPath: dataPaths.aiRegistryJson,
        aiPromptsRoot: join(dataPaths.frontend, 'ai-prompts'),
        lilithCharacterPath: join(dataPaths.frontend, 'character', 'lilith.json')
      }).readSharedPrompt(resolveSessionAiId(sessionId)) ?? SHARED_PROMPTS,
    frontendPrompt: FRONTEND_AI_PROMPT,
    sharedPrompts: SHARED_PROMPTS,
    getActiveWorkspace,
    getDefaultWorkspaceConfigPath,
    getWorkspaceContext,
    buildSelfAwarenessSection,
    // ABYSS 体系：用户信息 USER.md 与 AI 自我认知 AI.md 分开注入（旧版合并式 md 段已废弃）。
    // - readUserMd：读用户级 USER.md（ABYSS/U{uid}/USER.md，所有 AI 会话可见）
    // - readAiMd： 读 AI 级 AI.md（ABYSS/U{uid}/AI{aiId}/AI.md，按会话 aiId 定位）
    // 各段全空返回 null（不注入该段）；旧全局 md 兜底已废弃（data-init 一次性迁移进 ABYSS 后删除）。
    readUserMd: () => {
      const u = userStore.getCurrentUser()
      if (!u) return null
      return readUserMdContent(dataPaths, u.UID)
    },
    readAiMd: (sessionId?: string) => {
      const u = userStore.getCurrentUser()
      if (!u) return null
      return readAiMdContent(dataPaths, u.UID, resolveSessionAiId(sessionId))
    },
    // 普通会话莉莉丝 lore 检索注入：与桌宠 generateLilithReply 同一份 lore 索引/检索/格式化；
    // 无 lore 文件或无命中返回 null（不注入）。魔术路径与桌宠 lilith-endpoints 的同源路径保持一致。
    buildLoreContext: (message: string) => {
      const root = safePaths(toolCtx)?.root
      if (!root) return null
      const lore = loadLore(join(root, 'frontend', 'character', 'lore', 'index.json'))
      const text = formatLoreContext(retrieveLore(message, lore)).trim()
      return text || null
    },
    buildToolDescription: (policy, mcp, cfg) =>
      buildToolDescription(policy, mcp as McpClientManager | undefined, cfg),
    mcpClientManager,
    skillLoader,
    listTopicPrompts,
    toolCtx,
    activationManager,
    onActivationConsumed: (content) => {
      activationContentRef.current = content
    },
    buildLifecycleInjection,
    geoService: geoService ?? null,
    cronSchedulerRef: cronSchedulerRef ?? null,
    chatModePrompt: (aiName: string) => chatModePrompt(aiName),
    get taskLeadPrompt() {
      return TASK_LEAD_PROMPT
    },
    get toolNames() {
      return new Set(toolRegistry.tools.keys())
    },
    // 中继运行时信息（relay_cfg 段注入前提）：取多实例门面的中继服务——协作模式（master/satellite）
    // 装配后返回实际下载位置/保留天数；standalone 无对端（getRelay() 为 null）返回 null，
    // relay_cfg 段随之不注入，AI 不会虚构中继能力。downloadDir/retentionDays 与装配层
    // （multi-instance/index.ts getDownloadDir/getRetentionDays）同源，无漂移。
    getRelayInfo: () => {
      const relay = toolCtx.getMultiInstance?.()?.getRelay()
      return relay ? relay.getInfo() : null
    }
  })
}
