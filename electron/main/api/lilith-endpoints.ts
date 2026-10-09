/**
 * @category 莉莉丝链路
 * @summary 莉莉丝会话面板（companion 代理）端点：generateLilithReply + lilithRequest + 路由注册。

 * 莉莉丝是独立于月蚀的 companion 角色，其人设注入、记忆读取、工具策略
 * 与主对话链路不同，需要单独一组端点承载，而不是混进主对话流——

 * 从 server.ts 拆分而成（职责单一化）：莉莉丝对话生成、companion 代理转发、MOD 桥接。
 * 所有闭包依赖经 registerLilithEndpoints(deps) 参数化注入，避免文件级共享可变状态。
 * 返回 generateLilithReply 供消息接入（MessagingService.onLilithChat）复用。
 */
import express from 'express'
import http from 'http'
import { app as electronApp } from 'electron'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import type { ConfigStore } from './config-store'
import type { UserStore } from '../models/user-store'
import { resolveScopePaths, type BaseDataPaths, type DataPaths } from '../models/paths'
import { readUserMdContent, readAiMdContent } from '../prompts/abyss-md'
// 莉莉丝两段式提示词统一集中管理（prompts/lilith.ts）：endpoints 侧只传运行时数据
import { buildLilithEndpointsPrefix, buildLilithEndpointsSuffix, buildLilithEmotionDirective, buildLilithMemoryBlock } from '../prompts/lilith'
import type { ToolContext } from '../tools/base-tool'
import type { LLMClient, ApiMessage } from './llm'
import type { LLMConfig } from '@shared/types'
import type { ToolRegistryOptions, ToolRegistry } from '../tools'
import {
  getLilithTools,
  mergeLilithToolPolicy,
  buildLilithToolPolicy
} from '@shared/tools/registry'
import { consumeLilithEmotion, clearLilithEmotion } from '../tools/lilith-emotion'
import { getGlobalTimerRegistry } from '../monitor/timer-registry'
import { RawMemoryWriter } from '../services/raw-memory-writer'
import type { LightChat } from '../services/session-utils'
import type { GeoLocationService } from '../services/geo-location'
import {
  buildLilithPersona,
  isSystemInjectedText,
  loadLore,
  retrieveLore,
  formatLoreContext,
  readPlayerMemory,
  applyMemoryUpdates,
  parseLilithReply
} from '../services/lilith-adapter'
import {
  LILITH_RUNTIME_PATH,
  activeLilithSessionFile,
  readLilithCompanionSession,
  appendLilithCompanionMessages,
  clearLilithCompanionSession,
  readLilithCharacterFile,
  lilithEnabled,
  toLilithToolDef
} from './lilith-session'
import {
  LILITH_RECENT_KEEP,
  resolveLilithInternalState,
  buildLilithSummaryAnchor,
  buildLilithCacheIndexAnchor,
  maintainLilithInternalSession,
  lilithPlayerMemoryPath,
  lilithLoreIndexPath
} from '../services/lilith-internal-session'
import type { PluginLoader } from '../plugins'

/** 莉莉丝端点注册所需的闭包依赖（server.ts 侧注入，避免跨文件共享可变状态） */
export interface LilithEndpointsDeps {
  /** Express 应用实例（端点挂载点） */
  app: express.Express
  configStore: ConfigStore
  userStore: UserStore
  toolCtx: ToolContext
  dataPaths: BaseDataPaths
  /** 地理位置服务（可能为 null，调用侧按缺省处理） */
  geoService: GeoLocationService | null
  /** 无头对话链路（系统注入/健康检查转发月蚀大脑） */
  runHeadlessChat: (text: string, sessionId: string) => Promise<string>
  /** llmClient 可变引用（server.ts 持有 let，经 get/set 读写，含懒重建） */
  llmRef: { get(): LLMClient; set(client: LLMClient): void }
  makeLlmClient: (cfg: LLMConfig) => LLMClient
  makeToolRegistry: (c?: ToolContext, o?: ToolRegistryOptions) => ToolRegistry
  pluginLoader?: PluginLoader
  rawMemoryWriter: RawMemoryWriter | null
  /** 内部会话轻量 LLM 通道（莉莉丝内部会话摘要/缓存维护用） */
  internalLlmChat: LightChat
  /** 系统注入消息专用会话 ID（与月蚀主链路同一常量） */
  systemInjectedSessionId: string
}

/** generateLilithReply 返回结构（LilithPanel 期望的 ui 字段） */
export interface LilithReply {
  text: string
  emotion: string
  animation: string
}

/**
 * 注册莉莉丝会话面板端点并返回 generateLilithReply（供消息接入复用）。
 * 端点：/api/lilith/status | history | clear | message，以及 MOD 桥接 /chat/completions。
 */
export function registerLilithEndpoints(deps: LilithEndpointsDeps): {
  generateLilithReply: (message: string, playerName: string) => Promise<LilithReply>
} {
  const { app, configStore, userStore, toolCtx, dataPaths, geoService } = deps

  // 莉莉丝共享会话 ID：companion fetchLunarSharedHistory 通过 {base_url}/api/lilith/history
  // 拉取"莉莉丝的月蚀会话历史"（唯一上下文），与 MOD 桥接 /chat/completions 写入的会话一致。

  // 莉莉丝工具池
  // 每次生成回复时按 config.lilith.toolPolicy 构建（registry + policy 白名单机制，与前端 AI/DMN 同一套）
  // 用户改配置立即生效，无需重启。默认白名单 = 记忆/情绪/浏览器类（memory/lilith_player_memory/lilith_lore_query/lilith_emotion/browser_*）。
  // 注：工具执行用 createToolRegistry 的适配（自带 ctx）；ReadMdTool 参数类型与 AnyTool 不兼容，执行时 args 断言。
  async function generateLilithReply(
    message: string,
    playerName: string
  ): Promise<{ text: string; emotion: string; animation: string }> {
    // 系统注入拦截-转发（置于模块化门禁之前）：健康检查/激活事件等系统注入文本不得进入
    // 莉莉丝链路（不调莉莉丝 LLM、不写莉莉丝会话/记忆——否则污染莉莉丝上下文与玩家长期记忆）。
    // 但这不等于吞掉消息：转发给月蚀大脑（完整工具链，能真正响应健康检查/系统事件），
    // 月蚀处理结果原样返回调用方——消息真正被处理，且回复可见；莉莉丝停用时同样生效。
    if (isSystemInjectedText(message)) {
      console.log(`[lilith] 系统注入/健康检查消息不发送给莉莉丝，转发月蚀处理: ${message.slice(0, 60)}`)
      try {
        const forwarded = await deps.runHeadlessChat(message, deps.systemInjectedSessionId)
        return { text: forwarded, emotion: 'idle', animation: 'idle' }
      } catch (err) {
        // 转发失败也必须暴露，不让调用方拿到无意义占位
        console.error('[lilith] 系统注入消息转发月蚀失败:', (err as Error).message)
        return {
          text: `（系统消息已转交月蚀处理，但执行失败：${(err as Error).message}）`,
          emotion: 'idle',
          animation: 'idle'
        }
      }
    }
    // 模块化门禁：莉莉丝停用时直接返回占位（不调 LLM、不写会话）
    if (!lilithEnabled(configStore)) {
      return { text: '（莉莉丝已停用）', emotion: 'idle', animation: 'idle' }
    }
    // 上下文来源：companion sessions 文件（莉莉丝自己的上下文，唯一真相源）
    const history = readLilithCompanionSession().map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content
    }))

    // 莉莉丝内部会话状态（派生管理层）：摘要锚点 + 缓存索引。
    // companion sessions 仍是唯一真相源——内部状态只存摘要/游标/缓存位置，不复制消息正文。
    // 会话切换检测：LilithMod 清空/重开会话 → 新哈希文件 → 内部状态自动重置（新会话从零开始）。
    const activeLilithFile = activeLilithSessionFile()
    const { state: lilithInternal } = resolveLilithInternalState(activeLilithFile)
    // 历史段装配：摘要锚点（长会话覆盖早期消息）→ 最近 RECENT_KEEP 条原文 → 缓存索引（固定知识位置）
    // 短会话无摘要 → 锚点省略，纯原文注入（零回归）；与月蚀 anchorMessages 结构同构
    const lilithSummaryAnchor = buildLilithSummaryAnchor(lilithInternal)
    const lilithCacheAnchor = buildLilithCacheIndexAnchor(lilithInternal)

    // 非流式调用月蚀 LLM（不带工具，纯对话）
    let llmClient = deps.llmRef.get()
    if (!llmClient.isReady()) {
      llmClient = deps.makeLlmClient(configStore.get().llm)
      deps.llmRef.set(llmClient)
    }
    const dataRoot = toolCtx.paths?.root ?? join(electronApp.getPath('userData'), 'data')
    const character = readLilithCharacterFile(dataRoot)
    const persona = buildLilithPersona(character)
    // ABYSS 体系注入（与普通会话同源同格式，见 prompts/abyss-md.ts）：用户资料卡 USER.md + 莉莉丝自我认知 AI.md。
    // 桌宠链路固定绑定 AI 编号 2（莉莉丝）——与 lilithCtx.paths 的 aiId=2 分层一致；
    // 未登录或无文件时不注入，保持陪伴会话轻量。
    const abyssUser = userStore.getCurrentUser()
    const userMdBlock = abyssUser ? readUserMdContent(dataPaths, abyssUser.UID) : null
    const aiMdBlock = abyssUser ? readAiMdContent(dataPaths, abyssUser.UID, 2) : null
    const lore = loadLore(join(dataRoot, 'frontend', 'character', 'lore', 'index.json'))
    const loreHits = retrieveLore(message, lore)
    const loreContext = formatLoreContext(loreHits)
    const playerMemory = readPlayerMemory(join(electronApp.getPath('appData')), playerName)
    const memoryBlock = buildLilithMemoryBlock(playerName, playerMemory)
    // 当前环境注入（实时时间 + 地区）—— 用户需求：莉莉丝同样感知时间/地区（与前端 AI 同步）
    const envText = geoService?.buildInjection() ?? ''
    // 玩家塑造的莉莉丝人设
    const userPersona = (configStore.get().lilith?.persona ?? '')
      .replace(/\{playerName\}/g, playerName)
      .trim()
    // 莉莉丝模式——character=角色白名单工具；agent=全工具+深度思考+更长循环，输出风格不变
    const lilithMode = configStore.get().lilith?.mode ?? 'character'
    // 情绪指令（lilith_emotion 工具：月蚀 AI 主动控制莉莉丝情绪——一次性消费）
    let emotionDirective = ''
    try {
      if (toolCtx.paths) {
        const directive = consumeLilithEmotion(toolCtx.paths.root)
        if (directive && (directive.emotion || directive.animation)) {
          const parts = [
            directive.emotion ? `emotion=${directive.emotion}` : '',
            directive.animation ? `animation=${directive.animation}` : ''
          ]
            .filter(Boolean)
            .join(' / ')
          emotionDirective = buildLilithEmotionDirective(parts, directive.reason)
          clearLilithEmotion(toolCtx.paths.root)
        }
      }
    } catch (err) {
      console.error('[lilith] 情绪指令消费失败:', (err as Error).message)
    }
    // 两段式提示词（与月蚀 prefix/suffix 同构）：
    // - prefixPrompt（历史之前，稳定段）：人设/玩家塑造/原作总纲/工具引导/输出协议——会话内基本不变，进入前缀缓存区
    // - suffixPrompt（历史之后、本轮问题之前，动态段）：实时环境/情绪指令/检索命中的 lore/玩家长期记忆——每轮按需更新，贴近问题
    const prefixPrompt = buildLilithEndpointsPrefix({
      userPersona,
      persona,
      userMdBlock,
      aiMdBlock,
      canonContext: lore.canon_context,
      lilithMode,
      playerName
    })
    const suffixPrompt = buildLilithEndpointsSuffix({
      envText,
      emotionDirective,
      loreContext,
      memoryBlock
    })
    const recent = history.slice(-LILITH_RECENT_KEEP).map((m) => ({
      role: (m.role === 'assistant' ? 'assistant' : 'user') as 'user' | 'assistant',
      content: m.content
    }))
    // 莉莉丝工具池：按模式构建（双模式）
    // - character：mergeLilithToolPolicy（默认白名单 记忆+浏览器 + 用户设置页覆盖）——角色模式
    // - agent：莉莉丝全量工具（buildLilithToolPolicy(getLilithTools)——前端全量 + 莉莉丝专属记忆工具， 边界隔离）
    // 每次读最新配置（用户设置页改动立即生效；生效配置含覆盖层 patch，）
    const lilithPolicy =
      lilithMode === 'agent'
        ? buildLilithToolPolicy(getLilithTools().map((t) => t.id))
        : mergeLilithToolPolicy(configStore.getEffective().lilith?.toolPolicy)
    // agent='lilith'（边界隔离）：莉莉丝看到 前端工具 + 莉莉丝专属工具；
    // 月蚀（frontend）看不到 lilith_player_memory/lilith_lore_query（agents ['lilith'] 已隔离）
    // 分层：莉莉丝 = AI 编号 2，paths 用 defineProperty 动态解析（字面量会固化 getter）
    // 工具读 ctx.paths.xxx 时按当前登录用户 + aiId=2 自动落对应记忆域
    // lilith_player_memory 需要 appDataDir/playerName，否则工具拿不到会报错
    const lilithCtx: ToolContext = {
      appDataDir: toolCtx.appDataDir ?? electronApp.getPath('appData'),
      playerName
    }
    Object.defineProperty(lilithCtx, 'paths', {
      get: () => {
        const u = userStore.getCurrentUser()
        if (!u) {
          throw new Error('[lilith] 未登录态禁止解析莉莉丝工具作用域 paths：系统要求先登录')
        }
        return resolveScopePaths(dataPaths, { uid: u.UID, aiId: 2 })
      },
      enumerable: true,
      configurable: true
    })
    const lilithRegistry = deps.makeToolRegistry(lilithCtx, {
      toolsPolicy: lilithPolicy,
      agent: 'lilith',
      // 莉莉丝工具池并入插件工具（lilith_* 在 bundled/lilith 插件中）
      pluginTools: deps.pluginLoader?.getTools() ?? []
    })
    const lilithTools = Array.from(lilithRegistry.tools.values())
    const lilithToolDefs = lilithTools.map((t) => toLilithToolDef(t))
    // 工具执行：registry 适配器自带 ctx（paths 已注入），工具类 execute 直接可用
    const lilithToolPool = new Map(lilithTools.map((t) => [t.name, t]))
    // 缓存索引采集收集器（本轮工具命中的固定知识位置；回复写回后随内部状态落盘）
    const pendingLilithCacheLocations: string[] = []
    // 工具循环（≤3 轮）：莉莉丝可调用记忆工具，tool_calls 结果回填后继续生成
    // 两段式装配（与月蚀同构，前缀缓存区适配）：
    // [prefix system] → [历史对话] → [suffix system] → [本轮用户消息]
    // 稳定人设段放历史前（前缀缓存命中区）；动态上下文段放历史后、问题前（变化点之后，不影响缓存命中）
    const lilithMessages: ApiMessage[] = [
      ...(prefixPrompt ? [{ role: 'system' as const, content: prefixPrompt }] : []),
      ...(lilithSummaryAnchor ? [lilithSummaryAnchor as ApiMessage] : []),
      ...recent,
      ...(lilithCacheAnchor ? [lilithCacheAnchor as ApiMessage] : []),
      ...(suffixPrompt ? [{ role: 'system' as const, content: suffixPrompt }] : []),
      { role: 'user', content: message }
    ]
    let raw = ''
    // 工具循环：character=5 轮（记忆/浏览器场景够用）；agent=8 轮（全工具干活，多步任务）
    const maxToolRounds = lilithMode === 'agent' ? 8 : 5
    for (let round = 0; round < maxToolRounds; round++) {
      // agent 模式深度思考（high）：后台推理全开，输出风格由「输出要求」段约束不变
      const result = await llmClient.chatWithTools(lilithMessages, lilithToolDefs, undefined, {
        temperature: 0.7,
        ...(lilithMode === 'agent' ? { reasoningEffort: 'high' as const } : {})
      })
      if (result.toolCalls.length === 0) {
        raw = result.content ?? ''
        break
      }
      lilithMessages.push({
        role: 'assistant',
        content: result.content ?? null,
        tool_calls: result.toolCalls
      })
      for (const tc of result.toolCalls) {
        let toolResult: unknown
        // 超时标记与取消信号必须声明在 try/catch 之外：catch 是独立块级作用域，
        // 无法访问 try 内声明的 let/const（TS2304），且超时诊断要在 catch 中按 timedOut 覆盖。
        const LILITH_TOOL_TIMEOUT_MS = 30000
        let timedOut = false
        const toolAbort = new AbortController()
        try {
          const args = JSON.parse(tc.function.arguments || '{}')
          const tool = lilithToolPool.get(tc.function.name)
          // 莉莉丝工具循环没有外层兜底（月蚀的 streamWithTools 有 30s Promise.race），
          // 某工具内部挂起（浏览器极端场景/子进程卡死/Agent 子 agent 长跑）会永久阻塞
          // generateLilithReply → ♥ 窗口超时提示但主进程 LLM 单实例被拖住，整个月蚀卡死。
          // 对齐 streamWithTools：30s 超时，超时后继续循环（结果标记失败，AI 可感知）。
          let timeoutTimer: ReturnType<typeof setTimeout> | null = null
          // 超时取消信号：与外墙 streamWithTools 30s 保护对齐（llm.ts toolAbort）——
          // 超时不只 reject 外层等待，还向工具注入 signal.abort（工具如 run_command 会
          // 据此终止子进程树），避免「外层已判超时、工具仍在后台空跑占资源」。
          try {
            toolResult = tool
              ? await Promise.race([
                  tool.execute(
                    args as never,
                    {
                      // 分层：动态 paths（莉莉丝 = aiId 2，落 {uid}/2/）
                      paths: (lilithCtx as { paths?: unknown }).paths as DataPaths | undefined,
                      appDataDir: electronApp.getPath('appData'),
                      playerName,
                      signal: toolAbort.signal
                    } as ToolContext
                  ),
                  new Promise<unknown>((_, reject) => {
                    timeoutTimer = setTimeout(() => {
                      timedOut = true
                      try { toolAbort.abort() } catch { /* ignore */ }
                      reject(new Error('TOOL_TIMEOUT'))
                    }, LILITH_TOOL_TIMEOUT_MS)
                  })
                ])
              : { ok: false, error: `未知工具 ${tc.function.name}` }
          } finally {
            if (timeoutTimer) clearTimeout(timeoutTimer)
          }
        } catch (err) {
          // 超时诊断统一在 catch 外按 timedOut 覆盖，保证「超时≠失败终局」的可行动建议
          // 不被工具自身先抛的「已取消」错误吞掉（与外墙 llm.ts 超时诊断同款口径）。
          if (timedOut) {
            toolResult = {
              ok: false,
              error: `工具「${tc.function.name}」执行超时（阈值 ${LILITH_TOOL_TIMEOUT_MS}ms，已向工具发送取消信号）`,
              suggestion:
                '超时不等于失败终局：判断原因是工具本身耗时长、卡死，还是等待外部响应（网络/子进程）。' +
                '长任务请拆成可分段的小步骤或换一种实现，不要原样重试同一调用。'
            }
          } else {
            toolResult = { ok: false, error: (err as Error).message }
          }
        }
        // 缓存索引采集：记忆/知识库工具命中后记录固定知识位置（随后注入【记忆缓存位置】锚点）
        // lilith_player_memory → 玩家记忆文件（appDataDir/playerName 双参数，工具同源算法）
        // lilith_lore_query → lore 索引文件（dataRoot/frontend/character/lore/index.json，工具同源路径）
        if (toolResult && typeof toolResult === 'object' && (toolResult as { ok?: boolean }).ok) {
          if (tc.function.name === 'lilith_player_memory') {
            pendingLilithCacheLocations.push(
              lilithPlayerMemoryPath(electronApp.getPath('appData'), playerName)
            )
          } else if (tc.function.name === 'lilith_lore_query') {
            pendingLilithCacheLocations.push(lilithLoreIndexPath(dataRoot))
          }
        }
        lilithMessages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: JSON.stringify(toolResult)
        })
      }
    }
    const parsedReply = parseLilithReply(raw)
    const reply = parsedReply.text
    // 排错日志：模式/工具轮数/raw 长度——空回复时定位根因（LLM 空 content vs 工具循环耗尽）
    console.log(
      `[lilith] 回复生成: mode=${lilithMode} rounds=${maxToolRounds} raw=${raw.length}字 text=${reply.length}字 emotion=${parsedReply.emotion} animation=${parsedReply.animation}`
    )

    // memory_updates 提取（对话中沉淀玩家偏好）
    const memoryUpdates: Array<{ key: string; value: string }> = []
    const memoryRe = /\[memory:\s*([^=]+?)=([^\]]+)\]/g
    let mm: RegExpExecArray | null
    while ((mm = memoryRe.exec(raw)) !== null) {
      const key = mm[1].trim()
      const value = mm[2].trim()
      if (key && value) memoryUpdates.push({ key, value })
    }
    if (memoryUpdates.length > 0) {
      applyMemoryUpdates(join(electronApp.getPath('appData')), playerName, memoryUpdates)
    }

    // 写回莉莉丝自己的上下文（companion sessions 文件——游戏内黑框会话，唯一真相源）
    // 注意：只追加到文件，不经过 sessionStore——否则月蚀另建 lilith_chat 会话
    // 会导致"两个莉莉丝"（普通会话列表出现月蚀名的莉莉丝）。
    // user+assistant 合并为一次原子写（经串行队列），防并发请求覆盖丢失
    await appendLilithCompanionMessages([
      { role: 'user', content: message },
      { role: 'assistant', content: reply }
    ])

    // 莉莉丝内部会话增量维护（异步 500ms，不阻塞回复；与月蚀摘要维护同构）
    // 重新读真相源（含本轮）→ 游标后增量摘要 → 缓存位置落盘 → 状态原子写。
    // 摘要失败自动保持旧摘要/旧游标（派生层故障不影响回复与 companion 真相源）。
    // 摘要 LLM 用内部会话专属隔离实例（summaryLlmClient），不与主对话抢占。
    // 收编 timerRegistry（原裸 setTimeout）：全局定时器统一登记/停止，close 时随 stopAll 清理。
    getGlobalTimerRegistry().setTimeout(
      () => {
        maintainLilithInternalSession({
          chat: deps.internalLlmChat,
          // 维护时刻再取活跃文件：500ms 内游戏侧可能已切换会话（新哈希文件）
          activeFile: activeLilithSessionFile(),
          history: readLilithCompanionSession().map((m) => ({
            role: m.role,
            content: m.content
          })),
          pendingCacheLocations: pendingLilithCacheLocations
        }).catch((err) => {
          console.error('[lilith] 内部会话维护失败:', (err as Error).message)
        })
      },
      500,
      'lilith.internal-session-maintain'
    )

    // raw memory：莉莉丝对话进入记忆归档管线（月蚀记忆系统）
    // 分层：莉莉丝 = AI 编号 2，落 {uid}/2/raw_memory/（与月蚀独立统计）
    if (!deps.rawMemoryWriter) {
      console.error(
        '[lilith] raw memory write skipped: rawMemoryWriter 未初始化（dataPaths 为 null？）'
      )
    } else {
      const currentUser = userStore.getCurrentUser()
      deps.rawMemoryWriter.write(
        message,
        reply,
        [],
        new Date().toISOString(),
        currentUser ? `${currentUser.用户名}，UID=${currentUser.UID}` : undefined,
        '莉莉丝',
        currentUser ? { uid: currentUser.UID, aiId: 2 } : undefined
      )
    }

    return { text: reply, emotion: parsedReply.emotion, animation: parsedReply.animation }
  }

  const lilithRequest = (
    method: string,
    apiPath: string,
    body?: unknown
  ): Promise<{ status: number; json: Record<string, unknown> }> =>
    new Promise((resolve, reject) => {
      const rt = JSON.parse(readFileSync(LILITH_RUNTIME_PATH, 'utf8')) as {
        port?: number
        token?: string
      }
      if (!rt?.port) {
        reject(new Error('Lilith companion 未运行（先启动游戏+MOD）'))
        return
      }
      const payload = body === undefined ? undefined : JSON.stringify(body)
      const req = http.request(
        {
          host: '127.0.0.1',
          port: rt.port,
          path: apiPath,
          method,
          headers: {
            ...(rt.token ? { Authorization: `Bearer ${rt.token}` } : {}),
            ...(payload
              ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
              : {})
          }
        },
        (res) => {
          let raw = ''
          res.on('data', (chunk) => {
            raw += chunk
          })
          res.on('end', () => {
            try {
              resolve({ status: res.statusCode ?? 502, json: JSON.parse(raw || '{}') })
            } catch {
              resolve({ status: res.statusCode ?? 502, json: { raw } })
            }
          })
        }
      )
      req.on('error', reject)
      if (payload) req.write(payload)
      req.end()
      // 修复：无超时 → companion 假活（TCP 半开/事件循环卡死）时 Promise 永不 resolve
      // /api/lilith/status 每 3s 轮询无限堆积 pending 请求（连接/内存泄漏）。
      // 照抄 index.ts companion reload 的同款写法（3s 无响应按失败处理）。
      req.setTimeout(3000, () => req.destroy(new Error('lilith companion 响应超时（3s）')))
    })

  // 莉莉丝连接状态：月蚀大脑就绪即算"已连接"（♥ 窗口发消息走月蚀内部，不依赖 companion）。
  // companion/游戏状态作为附加信息（游戏内对话同步需要 companion 在跑）。
  // 修正：之前依赖 runtime.json 存在才报 running——游戏没启动时 ♥ 窗口
  // 显示"未连接"，但莉莉丝上下文（companion sessions 文件）和月蚀大脑都在，应照常可用。
  app.get('/api/lilith/status', async (_req, res) => {
    try {
      // 模块化：停用时返回 enabled:false（前端据此隐藏/提示）
      if (!lilithEnabled(configStore)) {
        res.json({
          running: false,
          enabled: false,
          brain_ready: false,
          companion_running: false,
          companion_status: { running: false },
          reason: '莉莉丝已停用（config.lilith.enabled=false）'
        })
        return
      }
      // 月蚀大脑就绪（LLM 配置了 = ♥ 窗口可用）
      const brainReady =
        deps.llmRef.get().isReady() || Boolean(configStore.get().llm?.model)
      // companion 状态（游戏内对话同步需要它）；索引签名承接 /health 响应的附加字段
      let companion: { running: boolean; [k: string]: unknown } = { running: false }
      let gamePid: number | undefined
      try {
        if (existsSync(LILITH_RUNTIME_PATH)) {
          const rt = JSON.parse(readFileSync(LILITH_RUNTIME_PATH, 'utf8')) as {
            port?: number
            token?: string
            game_pid?: number
          }
          if (rt?.port) {
            gamePid = rt.game_pid
            try {
              const h = await lilithRequest('GET', '/health')
              companion = { running: true, ...h.json, token_ok: Boolean(rt.token) }
            } catch {
              companion = { running: false }
            }
          }
        }
      } catch {
        /* runtime 读取失败不算大脑故障 */
      }
      res.json({
        running: brainReady, // ♥ 窗口是否可用（月蚀大脑）
        brain_ready: brainReady,
        companion_running: companion.running,
        companion_status: companion, // 保留完整 companion 详情（token_ok/mock_mode 等）
        game_pid: gamePid
      })
    } catch {
      res.json({ running: false, reason: '月蚀后端异常' })
    }
  })

  // 莉莉丝共享历史：返回莉莉丝自己的上下文（companion sessions 文件——游戏内黑框会话）。
  // 架构修正：不再读 lilith_chat（月蚀另建会话导致"两个莉莉丝不同步"）
  // 直接读 companion 的 sessions/{sha256('lilith')}.json —— ♥ 窗口与游戏内是同一份文件。
  app.get('/api/lilith/history', async (_req, res) => {
    try {
      const all = readLilithCompanionSession()
      const messages = all.slice(-200).map((m) => ({ role: m.role, content: m.content }))
      res.json({ messages, total: all.length, truncated: all.length > 200 })
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  // 清空莉莉丝会话（模块化：独立清空入口，不再靠切换用户/删文件）
  app.post('/api/lilith/clear', async (_req, res) => {
    try {
      await clearLilithCompanionSession()
      res.json({ ok: true, cleared: true })
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  // ♥ 置顶窗口发消息：直接走月蚀大脑（与 /chat/completions 同一逻辑），写入
  // companion sessions 文件（莉莉丝自己的上下文）——不转发 companion 的 message 端点
  // 否则 companion 会写一次 sessions + 调月蚀再写一次 = 同一轮写两次。
  app.post('/api/lilith/message', async (req, res) => {
    try {
      const message = String(req.body?.message ?? '').trim()
      if (!message) return res.status(400).json({ error: 'empty message' })
      const reply = await generateLilithReply(message, 'Player')
      // 返回格式对齐 LilithPanel 期望：{ text, ui: { emotion, animation } }
      res.json({
        protocol_version: 1,
        status: 'ok',
        text: reply.text,
        ui: { emotion: reply.emotion, animation: reply.animation }
      })
    } catch (err) {
      res.status(502).json({ error: (err as Error).message })
    }
  })

  // ===== 莉莉丝 MOD 桥接端点 =====
  // MOD（companion wire_api=chat_completions）请求 {base_url}/chat/completions
  // 桥接到月蚀：莉莉丝的对话写入 companion sessions 文件（莉莉丝自己的上下文，唯一真相源）
  // → 游戏内黑框、♥ 置顶窗口读的是同一份文件 → 完全同步。
  // 架构修正：
  // 1. 必须用莉莉丝人设（不能注入月蚀主 AI 的月蚀 persona——否则游戏内莉莉丝用月蚀的人格说话）
  // 2. 必须写 companion sessions 文件（不能写 lilith_chat——否则"两个莉莉丝"两份文件不同步）
  app.post('/chat/completions', async (req, res) => {
    try {
      const body = req.body ?? {}
      const reqMessages: Array<{ role?: string; content?: string }> = Array.isArray(body.messages)
        ? body.messages
        : []
      // 取请求里最后一条 user 消息作为用户输入（MOD 会带自己的 system/history，忽略，统一用月蚀上下文）
      const lastUser = [...reqMessages].reverse().find((m) => m.role === 'user')
      const userText = typeof lastUser?.content === 'string' ? lastUser.content.trim() : ''
      if (!userText) {
        return res
          .status(400)
          .json({ error: { message: 'empty user message', type: 'invalid_request_error' } })
      }

      // 莉莉丝大脑：人设 + lore + 玩家记忆 + companion sessions 历史 → 写回同一文件
      const reply = await generateLilithReply(userText, 'Player')

      // OpenAI 格式返回（MOD 期望的标准响应）
      res.json({
        id: `chatcmpl_${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: typeof body.model === 'string' ? body.model : '',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: reply.text },
            finish_reason: 'stop'
          }
        ]
      })
    } catch (err) {
      console.error('[server] /chat/completions bridge error:', err)
      res.status(500).json({ error: { message: (err as Error).message, type: 'server_error' } })
    }
  })

  return { generateLilithReply }
}