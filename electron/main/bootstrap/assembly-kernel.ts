/**
 * @category 核心
 * @summary 启动装配原子 ⑥⑦⑧⑨：内核扩展（MCP/插件/Cordis）、hooks 与技能、工作流引擎、内部会话存储
 *
 * 为什么存在：这四类此前平铺在 `index.ts`（约 310 行），属「内核域装配」——把 Cordis 插件、
 * MCP 客户端、hooks/skills、工作流引擎与内部会话存储接到启动链上。抽成独立模块后，
 * 入口只保留编排，内核装配的改动不再触碰窗口/用户域/退出链代码（ADR-01 第 3 步）。
 *
 * 什么作用：导出四个 `initXxx`，由 `service-assembly.ts` 按序调用；`state` 与 `deps` 显式传入。
 *
 * 不删理由：删掉即这 310 行退回 `index.ts`，入口重新同时承担编排与内核域装配两种职责。
 *
 * 顺序约束（迁移后仍必须按此调用）：`initKernelExtensions` → `initHooksSkills` →
 * `initWorkflowEngine` → `initInternalSessionStore`；其中 `initHooksSkills` 产出的
 * `memoryWorkflowSkillLoader` 是 `initWorkflowEngine` 的入参，不可换序。
 */
import type { AppState } from './app-state'
import type { BootstrapDeps } from './deps'
import { join } from 'path'
import { existsSync } from 'fs'
import { resolveBundledAsset } from '../utils/app-root'
import { DEFAULT_AI_ID } from '../models/path-context'
import { LLMClient } from '../api/llm'
import { ToolResultDistiller, DEFAULT_DISTILL_CONFIG } from '../services/tool-result-distiller'
import { InternalSessionStore, createAiScopedSessionRoots, purgeLegacyAutonomousTrees } from '../services/internal-session-store'
import { initDataDirectory } from '../models/data-init'
import { resolveScopePaths } from '../models/paths'
import type { BaseDataPaths, MemoryScope } from '../models/paths'
import { createToolRegistry } from '../tools'
import type { ToolContext } from '../tools'
import { registerBuiltinToolsMeta } from '../tools'
import { createRegistrar, kernelRegistry } from '../kernel'
import { McpClientManager } from '../mcp/client-manager'
import { loadMcpConfig, watchMcpConfig, ensureMcpConfigExists } from '../mcp/config-loader'
import { PluginLoader, getDomainPluginsDir } from '../plugins'
import { mountCordisPlugins } from '../plugins/cordis-mounter'
import { SkillMarket } from '../skills/market'
import { mergeWorkflowToolPolicies } from '@shared/tools/registry'
import { sendToRenderer } from '../services/renderer-bridge'
import { HookManager } from '../hooks'
import { loadAllHooks, watchHooksConfig } from '../hooks'
import { SkillLoader, getDomainSkillsDir } from '../skills/loader'
import { getDefaultSkillsConfigPath } from '../skills/skill-config'
import { WorkflowManager } from '../workflow/manager'
import { createWorkflowEventBridge } from '../ipc/handlers/workflow'
import { dynamicWorkflowPool } from '../performance/dynamic-pool'
import { resolveLlmConfig, syncMcpToolMetas } from '../startup-helpers'

/** 启动编排原子 ⑥：MCP 客户端 + 插件/Cordis 挂载 + 内置工具登记 + 治理机制 */
export async function initKernelExtensions(state: AppState, deps: BootstrapDeps) {
  const { rootCtx } = deps
  // MCP 客户端管理器初始化
  // 加载 .mcp.json 配置，连接所有已启用的 MCP server，注册工具元数据到 shared registry
  if (rootCtx.featurePlugins.isEnabled('mcp')) {
    try {
      ensureMcpConfigExists()
      // 阶段 4：经 ctx.mcp 统一构造点（与 server.ts 内引用共享同一实例）
      state.mcpClientManager = rootCtx.mcp.init()
      const mcpConfig = loadMcpConfig()
      // 连接所有已启用的 server（allSettled 不阻塞：单个失败不影响其他）
      const connectPromises = Object.values(mcpConfig.mcpServers)
        .filter((c) => c.enabled)
        .map((c) => state.mcpClientManager!.connectServer(c))
      await Promise.allSettled(connectPromises)
      // 同步 MCP 工具元数据到 shared registry（buildToolDescription 会动态读取）
      syncMcpToolMetas(state.mcpClientManager)
      // 监听 .mcp.json 变化（热重载：增删 server 后工具列表自动更新）
      watchMcpConfig(async (newConfig) => {
        if (!state.mcpClientManager) return
        await state.mcpClientManager.reloadFromConfig(newConfig)
        syncMcpToolMetas(state.mcpClientManager)
      })
    } catch (err) {
      console.error('[MCP] 初始化失败:', err)
    }
  } else {
    console.warn('[MCP] mcp 功能已禁用，MCP 客户端跳过（工具池不再含 MCP 工具）')
  }

  // 模块系统初始化
  // 扫描 abyssac_data/plugins/，动态加载插件工具进统一工具池（与 MCP 同机制）
  let pluginLoader: PluginLoader | null = null
  try {
    // 内置插件层（bundled）：开发走源码目录，打包走 resources/plugins/bundled
    // （electron-builder extraResources 已把 electron/main/plugins/bundled → plugins/bundled）
    // 形状统一由 utils/app-root 的 resolveBundledAsset 提供（ADR-10 第 3 步）
    const bundledPluginsRoot = resolveBundledAsset('plugins/bundled', { onMissing: 'dev' })
    pluginLoader = new PluginLoader(
      getDomainPluginsDir,
      () => (existsSync(bundledPluginsRoot) ? bundledPluginsRoot : null)
    )
    await pluginLoader.reload()
    console.log(
      `[plugins] 已加载 ${pluginLoader.list().length} 个插件，${pluginLoader.getTools().length} 个工具`
    )
  } catch (err) {
    console.error('[plugins] 初始化失败:', err)
  }

  // Cordis 模块挂载（阶段 5a）：把声明 cordis.entry 的插件挂载进 rootCtx
  // 沙箱按需注入在此发生：声明 deps: ['sandbox:exec'] 的模块拿到沙箱服务
  // detachCordis 在模块级声明（line 104），onBeforeQuit 可访问
  if (pluginLoader) {
    try {
      state.detachCordis = await mountCordisPlugins(rootCtx, pluginLoader)
      console.log(`[cordis-mounter] Cordis 模块挂载完成`)
    } catch (err) {
      console.error('[cordis-mounter] 挂载失败:', err)
    }
  }

  // 内置工具登记（LXK 自我检视）：kernel_inspect 能看到完整工具面
  try {
    registerBuiltinToolsMeta()
  } catch (err) {
    console.error('[kernel] 内置工具登记失败:', err)
  }

  // 治理机制（LXK governance）：空转抑制/查证提醒/收尾反思/失败止损——确定性 hook，不靠 AI 自觉。
  // 可经 config 覆盖层关闭（governance.idleSuppression 等 = false，config_patch 工具操作）。
  // 阶段 4：统一入口改为 rootCtx.governance.installAll（原逐个 install 调用收敛为一次性安装）
  if (rootCtx.featurePlugins.isEnabled('governance')) {
    try {
      const { reg: govReg } = createRegistrar(kernelRegistry, { kind: 'builtin' })
      rootCtx.governance.installAll(govReg)
      console.log('[kernel] 治理机制已启用：空转抑制/查证提醒/收尾反思/失败止损/运行时评论家')
    } catch (err) {
      console.error('[kernel] 治理机制初始化失败:', err)
    }
  } else {
    console.warn('[kernel] governance 功能已禁用，治理机制未安装')
  }
  return { mcpClientManager: state.mcpClientManager, pluginLoader, detachCordis: state.detachCordis }
}

/** 启动编排原子 ⑦：Hook 管理器 + Skill 加载器 + Skill 市场 */
export function initHooksSkills(dataPaths: BaseDataPaths) {
  // 记忆工作流共享 HookManager（与前端 AI 共用同一套 hooks 配置）
  // 加载 AppConfig.hooks + 内置 defaults.ts，监听热重载
  const workflowHookManager = new HookManager()
  try {
    const workflowHookConfigs = loadAllHooks()
    workflowHookManager.loadHooks(workflowHookConfigs)
    watchHooksConfig(() => {
      const newHooks = loadAllHooks()
      workflowHookManager.loadHooks(newHooks)
      console.log(`[hooks] 记忆工作流 hooks 热重载，加载 ${newHooks.length} 个 hook`)
    })
  } catch (err) {
    // hooks 配置损坏/监听失败属非核心初始化，降级不中断启动
    console.error('[hooks] Hook 配置加载或监听失败，降级为无 hooks:', err)
  }

  // 知识层：记忆工作流共享 SkillLoader（与前端 AI 共用同一套 Skills）
  // 领域级目录 getter 修复：原实现指向 global 父目录永远扫不到领域级 skill，
  // 统一用 loader 的 getDomainSkillsDir（领域级 skills 目录）
  // configPath 传函数引用延迟求值：若在构造时固化字符串，路径会锁死，
  // 登录后 load() 无法按 U{uid}/AI{aiId} 前缀分层解析——配置错位（技能安装不显示的根因同源）。
  // 系统强制登录后才可用：load()/startWatching() 只在登录成功回调（onAuthSuccess）中
  // 统一驱动（见 initIpcLayer），未登录态不调用、无可访问的未登录路径。
  const workflowSkillLoader = new SkillLoader(getDomainSkillsDir, () => getDefaultSkillsConfigPath())
  // SKILL 变动 → 前端自动刷新：磁盘热重载（SKILL.md/.skills.json 变化、市场安装/更新/卸载、
  // AI 工具经 IPC 安装等任何写盘动作）完成后广播 'skills:changed'，渲染侧订阅后重拉列表/市场。
  // 切换 AI 会话不触发本回调（无磁盘变动），由前端会话切换逻辑（chatSlice.selectSession 等）另行刷新。
  // sendToRenderer 的发送函数在窗口创建时注入（setRendererBridge）；桥未就绪时静默跳过，
  // 面板打开时 init 兜底拉取最新列表。
  workflowSkillLoader.setChangeCallback(() => {
    try {
      sendToRenderer('skills:changed', {})
    } catch {
      /* 渲染桥未就绪时忽略：面板打开时 init 兜底拉取最新列表 */
    }
  })

  // Skill 市场
  // 数据在 {userData}/skill-market/，市场来源安装到用户级 skills（workflowSkillLoader 共享用户级目录）
  // 内置市场仓库（electron/main/skills/market-repo → resources/skills/market-repo）：
  // 开发走源码目录，打包走 resources/skills/market-repo（electron-builder extraResources 已配置）；
  // 传给 SkillMarket 后首次启动自动注册为内置 dir 源，用户开箱即见 10 个可分发技能。
  // 留存理由：与 bundled 插件同款双路径探测，避免打包后找不到仓库导致空市场。
  let skillMarket: SkillMarket | null = null
  try {
    // 内置技能市场仓库：形状统一由 utils/app-root 的 resolveBundledAsset 提供（ADR-10 第 3 步）
    const builtinMarketRepo = resolveBundledAsset('skills/market-repo', { onMissing: 'dev' })
    skillMarket = new SkillMarket(
      join(dataPaths.root, 'skill-market'),
      workflowSkillLoader,
      undefined,
      existsSync(builtinMarketRepo) ? builtinMarketRepo : undefined
    )
  } catch (err) {
    console.error('[skill-market] 初始化失败:', err)
  }
  // 市场内容变更（上传/下架/局域网收端）→ 与 loader 同一广播事件 'skills:changed'：
  // 上传落点已并入内置仓库（loader 监听目录之外），没有这层接线则已打开的市场视图收不到刷新，
  // 表现为「列表里上传成功，市场列表却不更新」。前端 MarketTab 订阅 skillsChangedAt 后重载。
  skillMarket?.setChangeCallback(() => {
    try {
      sendToRenderer('skills:changed', {})
    } catch {
      /* 渲染桥未就绪时忽略：面板打开时 init 兜底拉取最新列表 */
    }
  })
  return { workflowHookManager, workflowSkillLoader, skillMarket }
}

/** 启动编排原子 ⑧：工作流引擎（独立 LLM/上下文/工具池/桥接/蒸馏器）+ 工具池重建订阅 */
export function resolveWorkflowScope(
  explicit: MemoryScope | null,
  currentUser: { UID: number } | null | undefined
): MemoryScope | null {
  // 工作流 paths 的作用域单一真源（ADR-25 L6）：
  // - 调度器处理某 (uid, aiId) 批次前会显式 setWorkflowScope → 用它（记忆/日记工作流）；
  // - 用户从前端 / AI 工具直接触发的工作流从不 setWorkflowScope → 用**当前登录用户的默认作用域**
  //   （uid + 月蚀），而不是回落裸 BaseDataPaths（缺 rawMemory/memoryNormal 等 scoped 字段，
  //   工具读到 undefined 会静默写错位置——L6 的隐患本体）；
  // - 未登录（无用户可推导）→ 返回 null，调用方抛错（显式失败）。
  if (explicit) return explicit
  return currentUser ? { uid: currentUser.UID, aiId: DEFAULT_AI_ID } : null
}

export function initWorkflowEngine(state: AppState, deps: BootstrapDeps, opts: {
  dataPaths: ReturnType<typeof initDataDirectory>
  mcpClientManager: McpClientManager | null
  pluginLoader: PluginLoader | null
  workflowSkillLoader: SkillLoader
}) {
  const { configStore, rootCtx } = deps
  const { dataPaths, mcpClientManager, pluginLoader, workflowSkillLoader } = opts
  let workflowManager: WorkflowManager | null = null
  // L8 工作流引擎：WorkflowManager 初始化
  //
  //
  // 依赖说明：
  // - LLMClient：独立实例（与 server.ts 内部的 llmClient 分离，避免 stream 抢占）
  // 记忆工作流用后端 LLM（config.workflowLlm），
  // 不再跟随前端 AI 的 config.llm。用 updateConfig 跟随 configStore.workflowLlm 变化（保持引用有效）
  // - ToolRegistry：独立实例，复用 baseCtx 但不注入 hookManager（工作流有自己的 HOOK 系统）
  // - SkillLoader：复用 workflowSkillLoader（与前端 AI 共用同一套 Skills）
  // - McpClientManager：复用 mcpClientManager（MCP 工具走现有路径）
  // - emit：事件桥接器，通过 webContents.send 推到前端
  const workflowLlmClient = new LLMClient(resolveLlmConfig(configStore.get().workflowLlm, configStore.get().llm))
configStore.subscribe((newConfig, oldConfig) => {
    // followMain：比较 resolve 后的生效值——workflowLlm.followMain 时前端 llm 变化也要触发更新
    const newCfg = resolveLlmConfig(newConfig.workflowLlm, newConfig.llm)
    const oldCfg = resolveLlmConfig(oldConfig.workflowLlm, oldConfig.llm)
    if (JSON.stringify(newCfg) !== JSON.stringify(oldCfg)) {
      workflowLlmClient.updateConfig(newCfg)
      console.log('[workflow] LLMClient 配置已更新（后端记忆工作流 LLM）')
    }
  })
  // 工作流专用工具结果蒸馏器：独立于 server.ts 的 distiller（server 用 llmClientRef.current，
  // 工作流用 workflowLlmClient——复用 server 实例会与主会话 LLM 抢占且带回环风险）。
  // 与 server.ts 同构：失败重试一次仍失败保留原文；配置跟随 toolResultDistill。
  const workflowDistiller = new ToolResultDistiller(
    () => workflowLlmClient,
    () => ({ ...DEFAULT_DISTILL_CONFIG, ...(configStore.get().toolResultDistill ?? {}) })
  )
  // 工作流 LLM 节点蒸馏回调工厂：语义与 server.ts makeDistillCallbacks 一致——
  // 工作流节点（记忆流水线/日记生成等无人值守自动化）也用同一蒸馏器。
  const workflowDistillCallbacks = (): {
    distillToolResult?: (toolName: string, toolCallId: string, result: string, intent?: string) => Promise<string | undefined>
    distillIntentTurnPairs?: number
  } => {
    // 与 server.ts makeDistillCallbacks 同一合并形态：用户配置优先、缺省回退单源默认
    const distillCfg = { ...DEFAULT_DISTILL_CONFIG, ...(configStore.get().toolResultDistill ?? {}) }
    return {
      distillToolResult: async (toolName: string, _toolCallId: string, result: string, intent?: string) =>
        (await workflowDistiller.distill(toolName, result, intent)) ?? undefined,
      distillIntentTurnPairs: distillCfg.intentTurnPairs
    }
  }
  // L8 修复：工作流工具池缺 user 上下文，导致记忆流水线 create_memory 被拒
  // （create-memory.ts 要求 normal 类型记忆必须有 ctx.user，实例 sessionId=null 时 user 丢失）
  // 参考 supervisor.ts 的 Object.defineProperty getter 写法：user 动态从 userStore 取，
  // 避免 {...baseCtx} 展开时把 getter 固化成静态值（getCurrentUser 可能为 null）
  // 分层改造：paths 动态 getter——工作流处理某个 (uid, aiId) 的 RAW 时，
  // 调度器设置 currentWorkflowScope，工具自动落对应作用域（不依赖登录态）。
  const workflowCtx: ToolContext = {
    skillLoader: workflowSkillLoader
  }
  Object.defineProperty(workflowCtx, 'user', {
    get: () => state.userStore?.getCurrentUser() ?? undefined,
    enumerable: true,
    configurable: true
  })
  Object.defineProperty(workflowCtx, 'paths', {
    get: () => {
      const explicit = state.currentWorkflowScope
      const scope = resolveWorkflowScope(explicit, state.userStore?.getCurrentUser())
      if (!scope) {
        throw new Error(
          'workflowCtx.paths 无可用作用域：未登录且未 setWorkflowScope(scope)——请先设定作用域再跑工作流'
        )
      }
      if (!explicit) console.debug(`[wf-scope-diag] paths getter: 无显式 scope → 用当前用户默认作用域 U${scope.uid}/AI${scope.aiId}`)
      return resolveScopePaths(dataPaths, scope)
    },
    enumerable: true,
    configurable: true
  })
  const workflowToolRegistry = createToolRegistry(
    workflowCtx,
    // 工作流执行记忆处理任务，需要记忆工作流工具集（create_memory/create_nng 等标记为 agents:['dmn']，
    // 该 agent 标记为历史契约保留，语义即"记忆工作流专属"）
    // 不传 agent 会默认推断为 'frontend'，导致记忆工作流专属工具被过滤掉
    // toolsPolicy 传全部记忆工作流默认策略的并集：否则 DeleteFile 等 defaultEnabled=false 的
    // 高风险工具被 isToolEnabled 回退逻辑过滤，工作流 LLM 节点报"未注册"且工具不可用
    {
      agent: 'dmn',
      mcpClientManager: mcpClientManager ?? undefined,
      toolsPolicy: mergeWorkflowToolPolicies(),
      pluginTools: pluginLoader?.getTools() ?? [],
      // 传入生效配置：visible 条件（如 image_gen 需 imageGen.enabled、素材生成工作流的
      // video_gen/audio_gen 需 generation.*.enabled）不传 config 时恒判 false，工具被整池滤掉
      config: configStore.getEffective()
    }
  )
const workflowEmit = createWorkflowEventBridge(() => state.mainWindow)
  try {
    if (rootCtx.featurePlugins.isEnabled('workflow')) {
      workflowManager = rootCtx.workflow.init({
        paths: dataPaths,
        llmClient: workflowLlmClient,
        toolRegistry: workflowToolRegistry,
        skillLoader: workflowSkillLoader,
        mcpClientManager: mcpClientManager ?? undefined,
        emit: workflowEmit,
        // 工作流 LLM 节点（记忆流水线/日记等无人值守自动化）与主会话一视同仁：
        // 工具结果先蒸馏再进上下文（失败保原文），按工具名挂消息来源护栏
        makeDistillCallbacks: workflowDistillCallbacks,
        // 动态性能优化：工作流实例级并发闸门——上限随当前设备参数/负载实时变化
        concurrencyGate: dynamicWorkflowPool
      })
      // 崩溃恢复：扫描 paused/running 实例，恢复执行
      void workflowManager.recoverInstances()
      console.log('[workflow] WorkflowManager 已初始化')
    } else {
      console.warn('[workflow] workflow 功能已禁用，工作流引擎跳过（记忆流水线/WF 节点不可用）')
    }
  } catch (err) {
    console.error('[workflow] WorkflowManager 初始化失败:', err)
  }

  // 生成模态配置变更 → 原地重建工作流工具池：
  // createToolRegistry 的 visible 条件在创建时一次性求值（config 快照），
  // 用户在设置页开/关 imageGen、generation.* 后若不重建，工作流（素材生成模板）
  // 仍拿旧快照判定工具不可见。WorkflowManager 持有 registry 对象引用，
  // 清空并重填同一个 tools Map 即可让后续 filter/executeTool 读到新集合。
  configStore.subscribe((newConfig, oldConfig) => {
    const genChanged =
      JSON.stringify(oldConfig.imageGen) !== JSON.stringify(newConfig.imageGen) ||
      JSON.stringify(oldConfig.generation) !== JSON.stringify(newConfig.generation)
    if (!genChanged) return
    const fresh = createToolRegistry(workflowCtx, {
      agent: 'dmn',
      mcpClientManager: mcpClientManager ?? undefined,
      toolsPolicy: mergeWorkflowToolPolicies(),
      pluginTools: pluginLoader?.getTools() ?? [],
      config: newConfig
    })
    workflowToolRegistry.tools.clear()
    for (const [id, t] of fresh.tools) {
      workflowToolRegistry.tools.set(id, t)
    }
    console.log('[workflow] 工具池已重建（生成配置变更）')
  })
  return { workflowManager }
}

/** 启动编排原子 ⑨：内部会话存储（旧块树清理已随 M2 删除面移除：
 * *.blocks.json 由 session-store 加载层防御性跳过，不再需要启动期物理清扫） */
export function initInternalSessionStore(deps: BootstrapDeps) {
  const { sessionStore } = deps
  // 共享内部会话存储：server（AI 两写）和 IPC handler（前端内部会话面板）使用同一实例，
  // 单实例内 writeChains 串行化统一，避免跨实例并发写盘竞争。
  // AI 隔离（ADR-25 L5）：内部会话根按 owner 会话**所属 AI** 解析
  // （`sessions/U{uid}/AI{aiId}/{ownerSessionId}/ai`），不再所有 AI 共用 AI1 目录。
  const { getRoot, getLegacyRoot } = createAiScopedSessionRoots(sessionStore)
  // 0.53.18：一次性清空**旧自主房间树**（自主模式改为继承承载会话的树；用户裁决「直接清空」）。
  // 扫 `sessions/` 下所有 U*/AI*，不只当前作用域——房间可能在不同 AI 下跑过。
  const purged = purgeLegacyAutonomousTrees(sessionStore.getDir())
  if (purged.length > 0) {
    console.log(`[internal-session] 已清空旧自主房间树 ${purged.length} 处（0.53.18 起自主模式继承承载会话的树）`)
  }
  return new InternalSessionStore(getRoot, getLegacyRoot)
}
