/**
 * Segment Manifest — 声明式提示词段清单

 * 替代 buildInjectedMessages 中散落的 stableMsgs.push / volatileMsgs.push 命令式注入链路。
 * 全链路一张表可审计：每段 id / tier / role / build 一目了然。

 * 四层 Tier（按变化频率分层，替代 stable/volatile 二分法）：
 * - boot: 启动常量（进程生命周期内不变：sys_prompt / shared_prompts / output_discipline）
 * - config: 配置变更时变（frontendToolPolicy 切换时变：tools）
 * - session: 工作区/会话切换时变（ai_workspace / kernel / skills_idx）
 * - turn: 每轮可能变（geo_env / sys_state / workspace / activation / lifecycle / mode_branch）

 * 组装位置（基于 tier 自动推导）：
 * - prefix (boot/config/session): 历史对话之前 → 缓存前缀区（DeepSeek prompt cache 命中）
 * - suffix (turn): 历史对话之后 → 动态尾部（不影响缓存前缀命中）
 */

import type { ChatMessage, AppConfig, CurrentUser, WorkspaceItem, FrontendToolPolicy, SessionContext } from '@shared/types'
import type { TopicPromptEntry } from '../prompts/loader'
import type { SkillMetadata, SkillSource } from '../skills/types'
import type { BaseDataPaths } from '../models/paths'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
// 系统级输出纪律段文案：与 sys_prompt 副本解耦、恒注入（见 OUTPUT_DISCIPLINE_PROMPT 注释）
import { getDomainSkillsDir } from '../skills/loader'
import { OUTPUT_DISCIPLINE_PROMPT } from '@shared/utils/output-discipline'
// 编码模式纪律文案：组装与文案分离（见 coding-discipline.ts 注释）
import { CODING_DISCIPLINE_PROMPT } from './coding-discipline'

// ===== 核心类型 =====

/** 四层变化频率 */
export type Tier = 'boot' | 'config' | 'session' | 'turn'

/** 每轮调用时的上下文（per-call 变化数据） */
export interface SegmentBuildCtx {
  messages: ChatMessage[]
  sessionId?: string
  sessionContext?: SessionContext | null
}

/** Segment build 函数返回值：null 表示该段本轮不注入 */
export type SegmentBuildResult = ChatMessage | null

/**
 * agent 特化策略（段级声明）。
 * 为什么存在：此前特化 agent（如 lilith）的注入/剥离判断散落各 segment 的 build 内部
 * （shared_prompts/kernel/mode_branch 各写 return null，lore_ctx 反向判断），
 * 每加一个特化 agent 就要在所有段里插入分支，清单可审计性差。
 * 作用：segment 通过 agentPolicy 声明本段对哪些 agent 跳过（skipFor）或仅注入（onlyFor），
 * 由 createSegmentManifest 统一包装 build 实现过滤。
 * 不删理由：manifest 是注入链的单一可审计入口，特化策略收敛在此处；
 *   过滤结果被 test/p2-aiid-segments.test.ts 的 T5/T6 用例锁定。
 */
export interface AgentPolicy {
  /** 对这些 agent 的会话跳过本段（不注入） */
  skipFor?: string[]
  /** 仅对这些 agent 的会话注入本段；不设置表示所有 agent 均可注入 */
  onlyFor?: string[]
}

/** 声明式 segment 定义 */
export interface Segment {
  /** 段唯一标识（合并段用合并后的 id） */
  id: string
  /** 变化频率分层 */
  tier: Tier
  /** 注入消息角色（均为 system） */
  role: 'system'
  /** agent 特化策略（可选）：声明后由 manifest 统一包装过滤，build 内部不再写 agent 分支 */
  agentPolicy?: AgentPolicy
  /** 构建：接收 per-call 上下文，返回消息或 null（不注入） */
  build: (ctx: SegmentBuildCtx) => SegmentBuildResult | Promise<SegmentBuildResult>
}

/** 组装结果 */
export interface AssemblyResult {
  /** 前缀段（boot/config/session tier，历史对话之前） */
  prefix: ChatMessage[]
  /** 尾部段（turn tier，历史对话之后） */
  suffix: ChatMessage[]
}

// ===== 依赖注入接口（结构化类型——只声明实际使用的方法） =====

export interface SegmentDeps {
  // Config & user
  getConfig: () => AppConfig
  getCurrentUser: () => CurrentUser | null
  // 动态身份：按会话所属 AI（ai-registry.json 查 id + 记录 name；未指定回退 1/月蚀）
  // 多 AI（P2）：sessionId → 会话 aiId → registry id；旧会话/无 aiId 回退 1
  getAiIdentity: (sessionId?: string) => { aiId: number | null; aiName: string; agent?: string }
  // 系统提示词：按会话所属 AI 读提示词副本（ai-prompts/AI{aiId}/system.md）；null = 回退内置
  getSysPrompt: (sessionId?: string) => string | null
  // Prompt constants (boot)
  frontendPrompt: string
  sharedPrompts: string
  // shared 层按 AI 文件粒度注入：返回该 AI 合并后的 shared 层；未提供/返回 null 时
  // 回退 sharedPrompts 常量（无副本 AI 与历史行为一致）
  getSharedPrompts?: (sessionId?: string) => string | null
  // Workspace
  getActiveWorkspace: (path: string) => WorkspaceItem | null
  getDefaultWorkspaceConfigPath: () => string
  getWorkspaceContext: () => string | null
// Kernel
  buildSelfAwarenessSection: (dataRoot: string) => string | null
  // ABYSS：用户级 USER.md（所有 AI 会话共享）与 AI 级 AI.md（按会话 aiId）分开注入
  readUserMd: (sessionId?: string) => string | null
  readAiMd: (sessionId?: string) => string | null
  // 莉莉丝 lore 检索注入：按本轮用户消息返回格式化后的档次上下文（无命中返回 null）；
  // 实现侧复用 lilith-adapter 的 loadLore/retrieveLore/formatLoreContext（与桌宠同源）。
  buildLoreContext?: (message: string) => string | null
  // Tools
  buildToolDescription: (policy: FrontendToolPolicy, mcp: unknown, cfg: { webSearchEnabled?: boolean }) => string
  mcpClientManager: unknown
  // Skills
  skillLoader: {
    listAutoInvocableBySource: (source: SkillSource, toolNames?: string[]) => SkillMetadata[]
    getDomainGroups: () => Array<{ domain: string; count: number }>
  }
listTopicPrompts: (dir?: string) => TopicPromptEntry[]
  toolCtx: { paths?: BaseDataPaths }
  // 中继异步传输运行时信息（可选）：由装配层注入「RelayService 是否真实装配」及实际下载位置/保留天数。
  // 为什么存在：relay_cfg 段（config tier）的注入前提是协作模式（master/satellite）下中继服务已装配；
  // standalone 单机无对端、中继未装配时返回 null → 该段不注入，避免 AI 把「并不存在的中继能力」
  // 当作用户可用的功能来回答（虚构能力）。downloadDir/retentionDays 直接取自服务运行时
  // getInfo()——与多实例装配层同源，配置变更后随 config tier 刷新，提示词落盘位置不会漂移。
  getRelayInfo?: () => { isHub: boolean; downloadDir: string; retentionDays: number } | null
  // External events (cron, health checks — NOT continuous activation)
  activationManager: { consumeEvents: (sessionId?: string) => string | null }
  onActivationConsumed: (content: string | null) => void
  // Lifecycle
  buildLifecycleInjection: (dir: string) => string | null
  // Environment
  geoService: { buildInjection: () => string } | null
  cronSchedulerRef: { listJobs: () => Array<{ enabled?: boolean }> } | null
  // Mode prompts
  chatModePrompt: (aiName: string) => string
  taskLeadPrompt: string
  // Tool registry (for skills_idx)
  toolNames: Set<string>
}

// ===== 组装函数 =====

/**
 * 按 tier 自动分组组装所有 segment。
 * boot/config/session → prefix（历史对话之前）
 * turn → suffix（历史对话之后）
 */
export async function assembleSegments(
  segments: Segment[],
  ctx: SegmentBuildCtx
): Promise<AssemblyResult> {
  const prefix: ChatMessage[] = []
  const suffix: ChatMessage[] = []

  for (const seg of segments) {
    const msg = await seg.build(ctx)
    if (!msg) continue
    if (seg.tier === 'turn') {
      suffix.push(msg)
    } else {
      prefix.push(msg)
    }
  }

  return { prefix, suffix }
}

// ===== Segment Manifest 工厂 =====

/**
 * 创建 segment manifest 数组。
 * 接收所有依赖（server.ts 初始化时传入），返回声明式 SEGMENTS 数组。

* 段顺序（即注入顺序）：
 * [prefix] identity → sys_prompt → shared_prompts → output_discipline → tools → ai_workspace → kernel → skills_idx
 * [suffix] env_context → system_events → mode_branch → lore_ctx → user_md → ai_md

 * 段合并映射：
 * - geo_env + sys_state + workspace → env_context (turn)
 * - act_ + lifecycle → system_events (turn)
 * - chat_mode / task_mode / coding_discipline → mode_branch (turn)
 */
export function createSegmentManifest(deps: SegmentDeps): Segment[] {
  // agent 特化策略统一包装：Segment.agentPolicy（skipFor/onlyFor）声明式生效。
  // 为什么这样做：历史实现把特化 agent（lilith）的判断散落在各 segment 的 build 内部
  // （shared/kernel/mode_branch 各写一行 if return null，lore_ctx 相反），新增特化 agent
  // 时容易漏改或误伤其他段；声明式 agentPolicy 让"本段对哪些 agent 生效"在段定义上一目了然，
  // 过滤逻辑收敛在 assemble 前的统一包装点，新增 agent 只改段声明不动 build。
  // 不删理由：agent 特化是注入链的横切关注点，收敛到此处避免逐段散落分支；
  //   行为由 test/p2-aiid-segments.test.ts 的 T5/T6 用例锁定（lilith 剥离/非 lilith 保留）。
  const applyAgentPolicy = (seg: Segment): Segment => {
    if (!seg.agentPolicy) return seg
    return {
      ...seg,
      build: (ctx: SegmentBuildCtx): SegmentBuildResult | Promise<SegmentBuildResult> => {
        const agent = deps.getAiIdentity(ctx.sessionId).agent
        const policy = seg.agentPolicy
        if (policy?.skipFor?.includes(agent as string)) return null
        if (policy?.onlyFor && !policy.onlyFor.includes(agent as string)) return null
        return seg.build(ctx)
      }
    }
  }
  const segments: Segment[] = [
    // ===== boot tier（启动常量）=====

// identity: 代码动态组装的一行身份卡（AIID/AI名/UID/用户名），AI 不维护
    {
      id: 'identity',
      tier: 'boot',
      role: 'system',
      build: (ctx) => {
        const { aiId, aiName } = deps.getAiIdentity(ctx.sessionId)
        const user = deps.getCurrentUser()
        const userName = user?.用户名 ?? '用户'
        const uidPart = user?.UID != null ? `（UID=${user.UID}）` : ''
        const aiIdPart = aiId != null ? `（AIID=${aiId}）` : ''
        const content = `你是「${aiName}」${aiIdPart}，正在与用户「${userName}」${uidPart}对话。`
        return {
          id: `identity_${Date.now()}`,
          role: 'system',
          content,
          createdAt: Date.now()
        }
      }
    },

// sys_prompt: 按会话所属 AI 读提示词副本（ai-prompts/AI{aiId}/system.md），空/缺回退内置 frontendPrompt。
// 为什么这样回退（为什么留下这份回退）：
// - 副本是"用户可编辑的运行时权威"——注册表 systemPrompt 只是编辑面板快照，真正给模型看的
// 只能有一个文本；读文件副本（而非注册表字段），使提示词独立成文件、可 diff、可回滚。
// - 无副本/空副本时回退内置模板（prompts/frontend/*），保证出厂可用与"还原默认"语义：
// 删除副本即还原，而不是留下一个空提示词把模型禁言。
// - getSysPrompt 返回 null 是显式信号（缺副本），?"回退内置"只此一处判断，分层职责单一。
    {
      id: 'sys_prompt',
      tier: 'boot',
      role: 'system',
      build: (ctx) => {
        // 多 AI（P2）：副本非空用副本（用户可编辑），null/空回退内置模板
        const prompt = deps.getSysPrompt(ctx.sessionId) ?? deps.frontendPrompt
        if (!prompt) return null
        return {
          id: `sys_prompt_${Date.now()}`,
          role: 'system',
          content: prompt,
          createdAt: Date.now()
        }
      }
    },

    // shared_prompts: 通用层（shared/），按会话 AI 文件粒度注入；
    // 无 AI 副本（getSharedPrompts 返回 null）→ 回退 boot 常量（历史行为）
    // agentPolicy.skipFor=['lilith']：莉莉丝走独立提示词体系，不注入月蚀 shared 通用机制
    {
      id: 'shared_prompts',
      tier: 'boot',
      role: 'system',
      agentPolicy: { skipFor: ['lilith'] },
      build: (ctx) => {
        const shared = deps.getSharedPrompts?.(ctx.sessionId) ?? deps.sharedPrompts
        if (!shared) return null
        return {
          id: `shared_prompts_${Date.now()}`,
          role: 'system',
          content: shared,
          createdAt: Date.now()
        }
      }
    },

    // output_discipline: 系统级输出纪律（boot tier 硬注入）。
    // 为什么存在：sys_prompt 段优先读 AI 级提示词副本（存在时内置提示词整体被覆盖），
    // 且提示词对模型只是软约束——"思考不进上下文、正文留给下一轮"若只靠
    // 提示词的章程文本，自定义副本的 AI 与不遵守软约束的模型都会漏网。
    // 作用：以独立段恒注入系统级输出纪律（前置规划章程、思考过程产物、正文留给下一轮、
    // 禁止思考块进正文），不受 sys_prompt 副本覆盖影响；正文侧另有 stripThinkingLeak
    // 机制兜底（正文落盘前剥离显式思考块，见 shared/utils/output-discipline.ts）。
    // 不删理由：用户强制要求从机制层面约束模型输出，本段是提示词层的强制底线；
    // 同时与 OUTPUT_DISCIPLINE_PROMPT 内容被回归测试锁定（不依赖副本即注入）。
    {
      id: 'output_discipline',
      tier: 'boot',
      role: 'system',
      build: (_ctx) => {
        // chat 会话模式豁免：mode_branch 在 turn 层注入的 chatModePrompt（JSON envelope
        // 硬约束）优先级更高；本段文案自身也声明了适用边界，双保险不冲突
        // _ctx 前缀满足 no-unused-vars 约定：本段内容恒为常量，不依赖当前会话状态
        return {
          id: `output_discipline_${Date.now()}`,
          role: 'system',
          content: OUTPUT_DISCIPLINE_PROMPT,
          createdAt: Date.now()
        }
      }
    },

    // ===== config tier（配置变更时变）=====

    // tools: 动态工具描述（按 frontendToolPolicy 过滤启用工具）
    {
      id: 'tools',
      tier: 'config',
      role: 'system',
      build: () => {
        const cfg = deps.getConfig()
        return {
          id: `tools_${Date.now()}`,
          role: 'system',
          content: deps.buildToolDescription(cfg.frontendToolPolicy, deps.mcpClientManager, cfg),
          createdAt: Date.now()
        }
      }
    },

    // relay_cfg: 中继异步传输感知段（config tier——配置变更时随注入更新）。
    // 为什么存在：用户会问"XX 给我发的文件在哪/怎么取"，AI 需要知道中继下载位置与保留策略
    // 才能用事实回答，而不是凭空猜路径。正面的语言表达：告诉 AI 文件名会出现的位置、
    // 保留期限与撤回后果；不写过期的免责声明句式，也不泄漏 entries.json 等实现细节。
    // 注入前提：deps.getRelayInfo() 返回非 null（RelayService 实际装配，协作模式）；
    // standalone 单机无中继 → 不注入，AI 不会声称存在不存在的异步传输能力。
    {
      id: 'relay_cfg',
      tier: 'config',
      role: 'system',
      build: () => {
        const info = deps.getRelayInfo?.()
        if (!info) return null // 中继未装配（standalone/服务未启动）→ 不注入（避免虚构能力）
        const lines = [
          '## 中继异步传输（L1.5 大云盘）',
          `- 同一局域网的主/分系统之间可异步传文件/文件夹：发送方上传到主系统中继暂存，接收方确认后下载到本机「${info.downloadDir}」。`,
          `- 上传与下载相互独立：发送方不用等接收方在线，接收方确认取件时文件已在中继端。`,
          `- 无人确认的暂存文件保留 ${info.retentionDays} 天，超期由主系统自动清理；发送方在该期限内可随时撤回。`,
          `- 当用户在 LAN 协作场景下询问"文件在哪/收到没有"时，用本段事实回答；中继文件同样位于数据目录内，路径可感知。`
        ]
        return {
          id: `relay_cfg_${Date.now()}`,
          role: 'system',
          content: lines.join('\n'),
          createdAt: Date.now()
        }
      }
    },

    // ===== session tier（工作区/会话切换时变）=====

    // ai_workspace: 当前激活工作区路径
    {
      id: 'ai_workspace',
      tier: 'session',
      role: 'system',
      build: () => {
        const activeWorkspace = deps.getActiveWorkspace(deps.getDefaultWorkspaceConfigPath())
        if (!activeWorkspace) return null
        return {
          id: `ai_workspace_${Date.now()}`,
          role: 'system',
          content: `## AI 工作区\n${activeWorkspace.name}（${activeWorkspace.path}）`,
          createdAt: Date.now()
        }
      }
    },

// kernel: 自我认知段（AI 知道自己能改什么/不能改什么，代码拼装无数量统计）
    // agentPolicy.skipFor=['lilith']：莉莉丝不注入月蚀自我认知段（由 AI.md 与 lilith.json 派生承载）
    {
      id: 'kernel',
      tier: 'session',
      role: 'system',
      agentPolicy: { skipFor: ['lilith'] },
      build: (_ctx) => {
        // 构建为确定性纯函数（静态文案 + registry 读取，无时间戳注入），
        // 输出天然字节稳定，直接注入即可进入 DeepSeek 前缀缓存命中区。
        let content: string | null
        try {
          content = deps.buildSelfAwarenessSection(deps.toolCtx.paths?.root ?? '')
        } catch {
          content = null
        }
        if (!content) return null
        return {
          id: `kernel_self_awareness_${Date.now()}`,
          role: 'system',
          content,
          createdAt: Date.now()
        }
      }
    },

    // skills_idx: 技能注入（渐进式披露两层）
    {
      id: 'skills_idx',
      tier: 'session',
      role: 'system',
      build: () => {
        const userSkills = deps.skillLoader.listAutoInvocableBySource('user' as SkillSource, Array.from(deps.toolNames))
        const topics = deps.listTopicPrompts()
        const domainGroups = deps.skillLoader.getDomainGroups()
        if (userSkills.length === 0 && topics.length === 0 && domainGroups.length === 0) return null
        const lines: string[] = ['<available_resources>']
        if (userSkills.length > 0) {
          lines.push('用户级技能（渐进式披露——use_skill(skill_name=...) 加载全文；技能目录绝对路径已给出，可直接 Read/Grep/Glob 访问目录内子文档与资源）：')
          for (const s of userSkills) {
            lines.push(`- ${s.name}：${(s.description || '').replace(/\s+/g, ' ').slice(0, 120)}（路径：${s.dirPath}）`)
          }
        }
        if (domainGroups.length > 0) {
          lines.push('')
          lines.push('领域级技能（文件夹路径即领域，数量与层级不限，如 design/web；领域根目录及检索入口见下，按需用 Grep/Glob 检索定位 SKILL.md，再用 use_skill(skill_name=...) 加载）：')
          for (const d of domainGroups) {
            lines.push(`- 领域 ${d.domain}（${d.count} 个技能，路径：${join(getDomainSkillsDir(), d.domain)}）`)
          }
        }
        if (topics.length > 0) {
          lines.push('')
          lines.push(`按需提示词块（${topics.length} 个，read_md(file_path=...) 读取全文）：`)
          for (const t of topics) {
            lines.push(`- ${t.name}：${t.summary}（read_md(file_path="${t.path}")）`)
          }
        }
        lines.push('</available_resources>')
        return {
          id: `skills_idx_${Date.now()}`,
          role: 'system',
          content: lines.join('\n'),
          createdAt: Date.now()
        }
      }
    },

    // ===== turn tier（每轮可能变，注入到历史对话之后）=====

    // env_context: geo_env + sys_state + workspace 合并
    {
      id: 'env_context',
      tier: 'turn',
      role: 'system',
      build: () => {
        const parts: string[] = []

        // geo_env: 当前环境（日期级时间 + 地区定位）
        try {
          if (deps.geoService) {
            parts.push(`## 当前环境\n${deps.geoService.buildInjection()}`)
          }
        } catch (err) {
          console.error('[geo] 注入失败:', err)
        }

// sys_state: 系统运行时状态（记忆工作流/DMN/定时任务开关）
        try {
          // 行缓冲：先收集各状态行、有内容时才整体注入，避免多次 push 产生多条 system 消息（10-03 重建时此声明缺失致 typecheck 失败）
          const stateLines: string[] = []
          const monitorConfigDir = deps.toolCtx.paths ? join(deps.toolCtx.paths.root, '.dmn_monitor') : null
          if (monitorConfigDir && existsSync(join(monitorConfigDir, 'config.json'))) {
            const monitorCfg = JSON.parse(readFileSync(join(monitorConfigDir, 'config.json'), 'utf-8'))
            const mw = monitorCfg?.memoryWorkflow
            if (mw?.enabled) stateLines.push(`- 记忆工作流：开启`)
          }
          if (deps.cronSchedulerRef) {
            const jobs = deps.cronSchedulerRef.listJobs()
            const enabled = jobs.filter((j) => j.enabled !== false)
            if (enabled.length > 0) stateLines.push(`- 定时任务：${enabled.length} 个启用`)
          }
          if (stateLines.length > 0) {
            parts.push(`## 系统运行时状态\n${stateLines.join('\n')}`)
          }
        } catch (err) {
          console.error('[sys-state] 注入失败:', err)
        }

        // generation_cap: 内容生成能力（多模态；仅当对应 provider 配置后提示，避免 AI 空想能力）
        try {
          const cfg = deps.getConfig()
          const genLines: string[] = []
          if (cfg?.imageGen?.enabled) genLines.push('- 图片生成：image_gen（文生图）')
          if (cfg?.generation?.video?.enabled) genLines.push('- 视频生成：video_gen（文生视频）')
          if (cfg?.generation?.audio?.enabled) genLines.push('- 音频生成：audio_gen（文生音频/音乐）')
          genLines.push('- 文稿/素材归档：create_document（md/txt，即时可用）')
          if (genLines.length > 0) {
            parts.push(
              `## 内容生成能力\n${genLines.join('\n')}\n生成产物统一存于 generated/U{uid}/AI{aiId}/{分类}/{年}/{月}/{日}/，分类为 image / video / audio / document。`
            )
          }
        } catch (err) {
          console.error('[gen-capability] 注入失败:', err)
        }

        // workspace: 浏览器面板当前页面 + 文件预览当前文件
        const workspaceCtx = deps.getWorkspaceContext()
        if (workspaceCtx) {
          parts.push(workspaceCtx)
        }

        if (parts.length === 0) return null
        return {
          id: `env_context_${Date.now()}`,
          role: 'system',
          content: parts.join('\n\n'),
          createdAt: Date.now()
        }
      }
    },

    // system_events: external events + lifecycle
    {
      id: 'system_events',
      tier: 'turn',
      role: 'system',
      build: (ctx) => {
        const parts: string[] = []

        // External events: cron, health checks, timers (NOT continuous activation)
        const activationContent = deps.activationManager.consumeEvents(ctx.sessionId)
        deps.onActivationConsumed(activationContent)
        const hasInjectedSysMsg = ctx.messages.some(
          (m) =>
            typeof m.content === 'string' &&
            m.content.includes('【系统注入：本条为系统激活消息') &&
            (m.role === 'user' || m.role === 'system')
        )
        if (activationContent && !hasInjectedSysMsg) {
          parts.push(
            `【系统注入：本条为系统激活消息，非用户真实发言，请优先响应并明确其来源】\n${activationContent}`
          )
        }

        // lifecycle: 系统生命周期注入（启动/关闭时间戳）
        try {
          if (deps.toolCtx.paths) {
            const lifecycleText = deps.buildLifecycleInjection(join(deps.toolCtx.paths.root, '.activation'))
            if (lifecycleText) {
              parts.push(lifecycleText)
            }
          }
        } catch (err) {
          console.error('[lifecycle] 注入失败:', err)
        }

        if (parts.length === 0) return null
        return {
          id: `system_events_${Date.now()}`,
          role: 'system',
          content: parts.join('\n\n'),
          createdAt: Date.now()
        }
      }
    },

    // mode_branch: chat / task / coding 模式分支合并（移到结尾强区，靠近用户消息）
    // agentPolicy.skipFor=['lilith']：莉莉丝不注入月蚀模式分支纪律，对话规范由派生提示词「输出要求」段承载
    {
      id: 'mode_branch',
      tier: 'turn',
      role: 'system',
      agentPolicy: { skipFor: ['lilith'] },
      build: (_ctx) => {
        const cfg = deps.getConfig()
        if (cfg.aiMode === 'chat') {
          return {
            id: `chat_mode_${Date.now()}`,
            role: 'system',
            content: deps.chatModePrompt(cfg.aiName),
            createdAt: Date.now()
          }
        }
        if (cfg.aiMode === 'task') {
          return {
            id: `task_mode_${Date.now()}`,
            role: 'system',
            content: deps.taskLeadPrompt,
            createdAt: Date.now()
          }
        }
// coding mode (default)：文案见 coding-discipline.ts（组装与文案分离）
        return {
          id: `coding_discipline_${Date.now()}`,
          role: 'system',
          content: CODING_DISCIPLINE_PROMPT,
          createdAt: Date.now()
        }
      }
    },

    // lore_ctx: 普通会话莉莉丝的 lore 检索注入——复用桌宠同一份 lore 索引/检索/格式化，
    // 仅对 agent==='lilith' 的会话按本轮最近一条用户消息检索；无命中或非莉莉丝不注入。
    // agentPolicy.onlyFor=['lilith']：仅 lilith 会话注入本段，其余 agent 由 manifest 统一过滤
    {
      id: 'lore_ctx',
      tier: 'turn',
      role: 'system',
      agentPolicy: { onlyFor: ['lilith'] },
      build: (ctx) => {
        const lastUser = [...ctx.messages].reverse().find((m) => m.role === 'user')
        const text =
          lastUser && typeof lastUser.content === 'string'
            ? (deps.buildLoreContext?.(lastUser.content) ?? null)
            : null
        if (!text) return null
        return {
          id: `lore_ctx_${Date.now()}`,
          role: 'system',
          content: text,
          createdAt: Date.now()
        }
      }
    },

    // ABYSS 体系拆分注入（旧版单一 md 段已废弃）：
    // user_md —— 用户级 USER.md（ABYSS/U{uid}/USER.md，所有 AI 会话共享；个人中心/update_user_preference 编辑）
    // ai_md —— AI 级自我认知 AI.md（ABYSS/U{uid}/AI{aiId}/AI.md，update_abyss_md 写入）
    // 放最后注入，严格说不算系统提示词（类似调用 skill 的东西），仅在文件非空时注入。
    {
      id: 'user_md',
      tier: 'turn',
      role: 'system',
      build: (ctx) => {
        const content = deps.readUserMd(ctx.sessionId)?.trim()
        if (!content) return null
        return {
          id: `user_md_${Date.now()}`,
          role: 'system',
          content,
          createdAt: Date.now()
        }
      }
    },
    {
      id: 'ai_md',
      tier: 'turn',
      role: 'system',
      build: (ctx) => {
        const content = deps.readAiMd(ctx.sessionId)?.trim()
        if (!content) return null
        return {
          id: `ai_md_${Date.now()}`,
          role: 'system',
          content,
          createdAt: Date.now()
        }
      }
    }
  ]
  return segments.map(applyAgentPolicy)
}
