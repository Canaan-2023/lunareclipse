/**
 * @category 核心
 * @summary 工具上下文（serverCtx）构造：把配置/用户/会话/加载器/裁决器聚合成 `ToolContext`，并挂动态 `paths` getter
 * @note 为什么存在：`serverCtx` 是注入链路与全部工具访问宿主状态的唯一门面（约 130 行对象字面量），
 * 只依赖外部注入的引用与模块级单例，不持有自己的状态；从宿主 `server.ts` 外移（ADR-02 第二轮），行为逐字节等价。
 * @note 不删理由：`paths` 的 `Object.defineProperty` 挂载点必须与 `spreadToolCtx`（跳过 paths 键）成对存在，
 * 两者分居不同文件会让「未登录不崩」这条不变量不可读——故 paths getter 与 serverCtx 同处本模块。
 */
import type { ConfigStore } from './config-store'
import type { SessionStore } from './session-store'
import type { UserStore } from '../models/user-store'
import { resolveScopePaths, type BaseDataPaths } from '../models/paths'
import type { AppConfig } from '@shared/types'
import { browserViewManager } from '../tools/browser-view-manager'
import { browserManager } from '../tools/browser-manager'
import { systemInput } from './system-input'
import { TeamManager, defaultTeamsRoot } from '../services/team-manager'
import { SubAgentManager } from '../sub-agent'
import { getCurrentToolCallId, type ToolExecutor } from './llm'
import { getAppAnchor } from '../utils/app-root'
import { estimateMessagesTokens } from '@shared/utils/token-estimate'
import type { ApprovalManager } from '../tools/sub-agent-engine/engine'
import type { SkillLoader } from '../skills/loader'
import type { HookManager } from '../hooks/hook-manager'
import type { CronScheduler } from '../cron/scheduler'
import type { McpClientManager } from '../mcp/client-manager'
import type { InternalSessionStore } from '../services/internal-session-store'
import type { ToolContext, SubAgentTask, ContextUsageSnapshot, ToolResult } from '../tools/base-tool'
import { spreadToolCtx } from './tool-ctx-safe'

export interface ServerCtxDeps {
  toolCtx: ToolContext
  configStore: ConfigStore
  sessionStore: SessionStore
  userStore: UserStore
  dataPaths: BaseDataPaths
  /** 会话 → 所属 AI 编号（多 AI P2；实现见 ./ai-scope） */
  resolveSessionAiId: (sessionId?: string) => number
  subAgentApproval: ApprovalManager
  mcpClientManager?: McpClientManager
  toolExecutorsRef: { current: ToolExecutor[] }
  subAgentManagerRef: { current: SubAgentManager<ToolExecutor> | null }
  skillLoader: SkillLoader
  hookManager: HookManager
  getCronScheduler: () => CronScheduler | null
  sharedInternalSessionStore?: InternalSessionStore
  /** 装配期快照的 scoped 根（`safePaths(toolCtx)`）；null = 未登录，team 目录不建 */
  toolPaths: BaseDataPaths | null
  lastInjectedEstimateRef: { current: number | null }
  /** 软预算（读当前模型窗口 × 比例）；宿主提供以便与 tokenBudget 口径单源 */
  getSoftBudget: () => number
}

/**
 * 构造主对话工具上下文。
 * 多 AI（P2）：主对话工具路径按「当前登录用户 + 会话所属 AI」动态解析（aiId 动态化）。
 * 工具读 ctx.paths.xxx 时自动落 memory/U{uid}/AI{aiId} 对应记忆域，实现双 AI 记忆/注入隔离。
 */
export function createServerCtx(deps: ServerCtxDeps): ToolContext {
  const {
    toolCtx,
    configStore,
    sessionStore,
    userStore,
    dataPaths,
    resolveSessionAiId,
    subAgentApproval,
    mcpClientManager,
    toolExecutorsRef,
    subAgentManagerRef,
    skillLoader,
    hookManager,
    getCronScheduler,
    sharedInternalSessionStore,
    toolPaths,
    lastInjectedEstimateRef,
    getSoftBudget
  } = deps

  const serverCtx: ToolContext = {
    ...spreadToolCtx(toolCtx),
    // 注入审批裁决器（run_command 等工具在无 requestPermission 的自动化通道读取）
    getSubAgentApproval: () => subAgentApproval,
    // 注入 MCP 客户端管理器（list_mcp_resources / read_mcp_resource 工具访问；
    // server 启动参数未装配 McpClientManager 时返回 null，工具 fail-closed 报错）
    getMcpClientManager: () => mcpClientManager ?? null,
    // 多 AI（P4）：create_ai 等工具经此解析"当前会话所属 AI 编号"（parentAiId 溯源/防递归守卫）
    getSessionAiId: resolveSessionAiId,
    // 批量执行器（batch_tools 子步骤通道）：经 toToolExecutor 包装的执行器集合执行——
    // 复用主链路同一条执行链（能力闸 + Hook + 脱敏），且 toolExecutorsRef 随工具策略热更新重建，
    // 闭包读 current 永远指向"当前生效"的工具集：用户刚关闭的工具不可能被 batch 绕过。
    // 返回解析回 ToolResult（executor.execute 返回的是 JSON 字符串）。
    executeSubTool: async (name, params) => {
      const executor = toolExecutorsRef.current.find((e) => e.name === name)
      if (!executor) return { ok: false, error: `批量子工具未注册或未启用: ${name}` }
      try {
        return JSON.parse(await executor.execute(params)) as ToolResult
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    },
    // 动态注入当前配置（联网开关、自定义搜索端点、治理开关等），用 getter 保证读到最新值
    // 改 getEffective：治理开关经 config_patch 写覆盖层（patch 文件），get 读不到 → hook 开关失效
    get config() {
      return configStore.getEffective() as unknown as Record<string, unknown>
    },
    // update_ai_name 等工具通过此回调修改 config 并持久化（update_abyss_md 改写文件，不走此回调）
    // updater 接收当前 config，返回更新后的 config（不可变更新）
    updateConfig: (updater) => {
      const current = configStore.get() as unknown as Record<string, unknown>
      const next = updater({ ...current })
      configStore.save(next as unknown as AppConfig)
    },
    // 注入 Skills 加载器（use_skill 工具通过此访问）
    skillLoader,
    // 注入 Hook 管理器（executeTool 通过此访问 Pre/PostToolUse）
    hookManager,
    // 注入 cron 调度器 getter（cron_manage 工具访问）
    getCronScheduler,
    // 注入内部会话存储 getter（internal_session 工具访问）：复用与 IPC 面板同一 store 实例，
    // 走 store 的写链串行化 + NNG 路径推导，避免工具裸写 JSON 与维护队列并发覆盖
    getInternalSessionStore: () => sharedInternalSessionStore ?? null,
    // 插件 tools.js 经此访问浏览器面板单例（browser_* 工具在 bundled/headless-browser 插件，plugin.json name='headless-browser'；容器上下文注入，供插件获取 BrowserView 管理器做面板级展示）
    getBrowserViewManager: () => browserViewManager,
    // 经此访问 Playwright 单例（browser_* 工具用；快照看页面+操作，不依赖截图）
    getBrowserManager: () => browserManager,
    // computer-use 插件：系统级电脑操控引擎（截屏/鼠标/键盘，Windows+PowerShell，零新增依赖）
    getSystemInput: () => systemInput,
    // 任务模式（Agent Teams）：TeamManager——团队目录 {root}/teams，纯文件通信
    teamManager: toolPaths ? new TeamManager(defaultTeamsRoot(toolPaths.root)) : undefined,
    // 委托给 SubAgentManager（并发 / 超时 / 子 agent 输出 / 工具过滤统一处理）
    launchSubAgent: async (
      tasks: SubAgentTask[],
      mode: 'serial' | 'parallel'
    ): Promise<string[]> => {
      if (!subAgentManagerRef.current) {
        throw new Error('SubAgentManager 未初始化（工具注册尚未完成）')
      }
      const options = tasks.map((t) => ({
        systemPrompt: t.prompt,
        userMessage: '开始执行子任务。',
        allowedTools: t.tools,
        disallowedTools: t.disallowedTools,
        maxTurns: t.maxTurns,
        timeoutMs: t.timeoutMs,
        // 任务模式（Agent Teams）：成员身份透传（team_* 工具经 AsyncLocalStorage 识别）
        teamContext: t.teamContext
      }))
      // 读 AsyncLocalStorage 中的当前深度：主对话=0，子 agent 内部=currentDepth+1
      const depth = SubAgentManager.getCurrentDepth()
      // 读当前工具调用 id（Agent 工具的 toolCallId），子 agent 事件据此挂到主对话卡片
      const parentToolCallId = getCurrentToolCallId() ?? undefined
      const results = await subAgentManagerRef.current.launchBatch(options, mode, depth, parentToolCallId)
      // SubagentStop Hook：子 agent 完成后执行，拿到每个子任务的完整输出
      if (hookManager.isLoaded()) {
        for (const r of results) {
          await hookManager.run('SubagentStop', {
            event: 'SubagentStop',
            subagentOutput: r.output,
            sessionId: serverCtx.sessionId ?? undefined,
            cwd: getAppAnchor()
          })
        }
      }
      return results.map((r) => {
        // 软超时托管：子 agent 转入后台时 output 为空，error 中已含托管诊断与 taskId，
        // 直接透传给 AI，AI 可据此 tool_watch 续期/查进度、tool_stop 主动停止。
        if (r.timedOut && r.managedTaskId) return r.error ?? ''
        return r.output
      })
    },
    // context_usage 工具：查询当前会话上下文用量
    getContextUsage: (): ContextUsageSnapshot | null => {
      const sid = serverCtx.sessionId ?? undefined
      if (!sid) {
        // 无会话时仍返回基础信息（无消息）
        const cfgNow = configStore.get()
        const budget =
          cfgNow.tokenBudget && cfgNow.tokenBudget > 0 ? cfgNow.tokenBudget : getSoftBudget()
        return {
          sessionId: null,
          messageCount: 0,
          conversationCount: 0,
          estimatedTokens: 0,
          effectiveBudget: budget,
          model: cfgNow.llm.model,
          remainingTokens: budget,
          usagePercent: 0
        }
      }
      const session = sessionStore.get(sid)
      if (!session) return null
      const convMsgs = session.messages.filter((m) => m.role !== 'system')
      const estimated = lastInjectedEstimateRef.current ?? estimateMessagesTokens(convMsgs)
      const cfgNow = configStore.get()
      const budget =
        cfgNow.tokenBudget && cfgNow.tokenBudget > 0 ? cfgNow.tokenBudget : getSoftBudget()
      const usagePercent = Math.min(100, Math.round((estimated / budget) * 100))
      return {
        sessionId: sid,
        messageCount: session.messages.length,
        conversationCount: convMsgs.length,
        estimatedTokens: estimated,
        effectiveBudget: budget,
        model: cfgNow.llm.model,
        remainingTokens: Math.max(0, budget - estimated),
        usagePercent
      }
    }
  }
  // 多 AI（P2）：主对话工具路径按「当前登录用户 + 会话所属 AI」动态解析（aiId 动态化）。
  // 注意：展开用 spreadToolCtx 跳过 paths（避免 getter 在展开期被求值抛错——未登录场景），
  // 此处 defineProperty 是 paths 唯一挂载点（动态 getter，登录后才可解析）。
  // sessions 同样走 scoped 作用域（{root}/sessions/U{uid}/AI{aiId}）：session-search 检索历史会话时应
  // 限定在当前用户当前 AI 的作用域内，避免跨账号/跨 AI 串扰隐私；曾强制覆盖为全局根 dataPaths.sessions，
  // 属于作用域定位错误（该"防回归"掩盖了 session-search 与分片存储形态脱节，已随扫描逻辑一并修复）。
  Object.defineProperty(serverCtx, 'paths', {
    get: () => {
      const u = userStore.getCurrentUser()
      if (!u) {
        throw new Error('[paths] 未登录态禁止解析工具作用域 paths：系统要求先登录')
      }
      const scoped = resolveScopePaths(dataPaths, {
        uid: u.UID,
        aiId: resolveSessionAiId(serverCtx.sessionId ?? undefined)
      })
      return scoped
    },
    enumerable: true,
    configurable: true
  })

  return serverCtx
}
