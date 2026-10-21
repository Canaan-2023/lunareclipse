/**
 * @category 核心
 * @summary 注入消息组装：附件内联 → 净化链 → 窗口截断 → 段清单 prefix/suffix → PreLLMCall hook
 * @note 为什么存在：`buildInjectedMessages` 是注入链路的唯一实现，被主对话流、无头消息接入与
 * `ctx.systemPrompt.registerAssembler`（阶段 3c seam）三处直调。它只依赖 configStore / hookManager /
 * 段清单三个注入点，不持有其它运行时状态，故从宿主 `server.ts` 外移（ADR-02 第二轮），行为逐字节等价。
 * @note 不删理由：WS 流式与 headless 消息接入两条主链路的注入路径都经过本实现。
 */
import type { ConfigStore } from './config-store'
import type { HookManager } from '../hooks/hook-manager'
import type { ChatMessage, PromptPurpose } from '@shared/types'
import type { SessionContext } from '@shared/types'
import { readAttachment, formatAttachmentsForContext } from './attachment-reader'
import { sanitizeContextMessages, resolveToolResultKeepRecent } from './context-sanitize'
import { truncateConversation } from '@shared/utils/context-window'
import { getAppAnchor } from '../utils/app-root'
import { assembleSegments } from '../prompts/segments'
import type { SegmentManifest } from './segment-manifest'

export interface InjectedMessagesDeps {
  configStore: ConfigStore
  hookManager: HookManager
  segments: SegmentManifest
}

/**
 * 构造注入消息组装函数。
 * 活跃函数勿删：headless 消息接入与主对话流 sessionContext 上下文组装均直调返回的函数；
 * 另经 registerAssembler 注册为 ctx.systemPrompt 委托实现（阶段 3c seam，见宿主注册处注释）。
 */
export function createBuildInjectedMessages(
  deps: InjectedMessagesDeps
): (
  messages: ChatMessage[],
  sessionId?: string,
  sessionContext?: SessionContext | null,
  purpose?: PromptPurpose
) => Promise<ChatMessage[]> {
  const { configStore, hookManager, segments: SEGMENTS } = deps

  return async (
    messages: ChatMessage[],
    sessionId?: string,
    sessionContext?: SessionContext | null,
    purpose?: PromptPurpose
  ): Promise<ChatMessage[]> => {
    // ===== Segment manifest 组装（声明式，替代命令式 push 链） =====
    // 全链路一张表：boot/config/session -> prefix（历史之前，缓存前缀区）
    // turn -> suffix（历史之后，动态尾部，不影响缓存命中）
    // `purpose` 透传给段：房间规划轮（'room'）据此跳过对话纪律段（见 segments.ts SegmentBuildCtx.purpose）
    const { prefix, suffix } = await assembleSegments(SEGMENTS, { messages, sessionId, sessionContext, purpose })

    // 处理用户消息中的附件：读取文本/图片内容融入上下文
    // 任务 1.5：附件大文件落盘（超过阈值只保留路径引用，不内联全文）
    const ATTACHMENT_INLINE_THRESHOLD = 4000 // 字符，约 1000 token
    // 撤回消息过滤：recalled=true 的消息一律不进 AI 上下文（前端已过滤，此处纵深防御）
    // 内部会话模式同样过滤：撤回只置标记不清 content（展示层要保留原文），
    // 若跳过过滤，撤回消息原文会经 buildSessionContext 锚点原样注入 AI，造成泄漏
    const visibleMessages = messages.filter((m) => !m.recalled)
    const processedMessages: ChatMessage[] = []
    for (const m of visibleMessages) {
      if (m.role === 'user' && m.attachments && m.attachments.length > 0) {
        const attachmentContents = await Promise.all(
          m.attachments.map(async (a) => {
            const ac = await readAttachment(a.path)
            if (ac.text && ac.text.length > ATTACHMENT_INLINE_THRESHOLD) {
              // 大附件：不内联全文，只保留路径引用提示
              return {
                ...ac,
                text: `[附件 ${a.name ?? '未命名'} 内容较大（${ac.text.length} 字符），已跳过内联。需要时用 Read 工具读取：${a.path}]`
              }
            }
            return ac
          })
        )
        const ctxText = formatAttachmentsForContext(attachmentContents)
        if (ctxText) {
          processedMessages.push({
            ...m,
            content: `${m.content}\n\n${ctxText}`.trim(),
            // 保留原始附件元数据用于 UI 显示，但已将内容注入 content
            attachments: m.attachments
          })
          continue
        }
      }
      processedMessages.push(m)
    }

    // ===== 注入前消息净化链（三段实现已抽到 api/context-sanitize.ts）=====
    // 为什么这里只剩一次调用：三段（外来指令样文本中和 → 前端 UI 残留标记剥离 → 深度工具
    // 结果清理）都是正则 + 逐分支引用语义驱动的变换——命中集合、豁免条件、索引边界任一处
    // 漂移都不会报错、只会静默失效（历史上已发生过：复读触发器、自反馈污染），而躺在
    // 1480 行的 buildInjectedMessages 闭包里无法被单独验证。故抽成纯函数模块并配契约测试
    // （test/context-sanitize.test.ts），抽取只搬不移、行为逐字节等价。
    // 作用：净化输入仍是 processedMessages（附件已内联、recalled 已过滤的可见消息）；三段
    // 顺序在模块内固定（第三段的索引判定依赖前两段 map 保持数组长度不变）。
    // 不删理由：WS 流式与 headless 消息接入两条主链路的注入路径都经过本调用点。
    // 为什么 configStore 的读取留在原地：模块保持无隐式依赖（纯函数才可脱离 electron 验证），
    // 故只把「保留条数」传进去；`pairs` 仍保留可选语义（旧 config 可能缺该键）。
    const clearedMessages = sanitizeContextMessages(processedMessages, {
      keepRecent: resolveToolResultKeepRecent(configStore.get().contextWindow.pairs)
    })

    // ===== 微压缩层（第 2 层）已删除（2026-09-28 评审方案 B：激进收敛两层合一） =====
    // 原微压缩按预算水位 70-85% 渐进折叠 assistant 正文、85-90%+ 聚合工具调用；
    // 删除理由（评审 K2/成本评估）：
    // 1) 折叠占位（⟪…⟫）只作用于注入副本、UI 仍显示原文 → 前后缺口产生认知负担；
    // 折叠后字符串形态变化破坏前缀缓存（K2），同轮重复请求白做 token 估算；
    // 2) 与上层"超限继承（0.17 起：原会话不动建子会话） + LLM 滚动摘要"职责重叠，
    // 预算水位 70% 即触发时高占用轮次刚进第 3 层窗口截断就被再次处理，两级相互抵消；
    // 3) 省 token 目标统一由"上游工具结果清理 + 窗口截断 + 内部会话超限继承"承担，
    // 五层管线收敛为四层，序列稳定、缓存友好。
    // 现状确认：删除后没有任何调用方依赖本层产物（convForBudget/usagePct/microMsgs
    // 仅本层内部使用），可直接移除；estimateMessagesTokens 仍被下游 token 统计使用，保留 import。
    // 上下文窗口截断：按配置截断历史对话（不影响前置系统注入）
    // 逻辑已抽到 shared/utils/context-window.ts（前后端共用）
    // - pairs 模式：保留最近 N 对（user+assistant 一对），system 消息始终保留
    // - chars 模式：保留最近 N token 的上下文
    // - off 模式：不截断
    const systemMsgs = clearedMessages.filter((m) => m.role === 'system')
    const convMsgs = clearedMessages.filter((m) => m.role !== 'system')

    // 内部会话上下文：sessionContext 存在时，历史段 = 内部会话锚点（摘要+保留消息+缓存索引）
    // 线性截断/压缩游标/滚动摘要全部跳过（内部会话成为唯一历史来源）。
    // 当前轮用户消息仍从预处理后的对话尾部取出（附件内联/外来指令中和/UI 标记剥离已完成）。
    let finalMessages: ChatMessage[]
    let tailUser: ChatMessage | null = null

    if (sessionContext) {
      finalMessages = [...systemMsgs, ...sessionContext.anchorMessages]
      tailUser =
        convMsgs.length > 0 && convMsgs[convMsgs.length - 1].role === 'user'
          ? convMsgs[convMsgs.length - 1]
          : null
    } else {
      // 线性模式（内部会话未启用/未选择/路由失败时的回退路径）
      // 半注入修正（2026-10-02，推翻 0.24「全量注入不截断」决策）：
      // 原实现 convMsgs 全量直注入，与前端 UI 行为不一致——前端 ChatArea 用
      // truncateConversation（shared/utils/context-window.ts，同一 config.contextWindow）
      // 决定「UI 显示哪些消息」，后端却全量送入，两端所见历史不一致；且超窗时
      // 全量注入直接触发 API 拒绝（透明上抛），长会话彻底不可用。
      // 现改为与前端同一函数同一配置截断（pairs/chars 模式有界半注入；
      // contextWindow.mode==='off' 时按配置照旧不截断），保证 UI 与 AI 上下文 100% 一致。
      const { kept } = truncateConversation(convMsgs, configStore.get().contextWindow)

      // DeepSeek 前缀缓存适配：消息顺序 = [稳定 system（缓存前缀区）] → [历史对话（缓存前缀区）]
      // → [动态段] → [新用户消息]。
      // 稳定 system + 已见过的历史对话构成连续不变前缀 → 服务端缓存命中（prompt_cache_hit_tokens）；
      // 每轮变化的动态内容（实时时间/工作区/内核统计/注入）全部在变化点之后，不影响命中区。
      // 新用户消息从对话尾部抽出放最后，保证动态参考段在"问题"之前（语义：本轮额外参考内容）。
      finalMessages = [...systemMsgs, ...kept]
      if (finalMessages.length > 0 && finalMessages[finalMessages.length - 1].role === 'user') {
        tailUser = finalMessages.pop() ?? null
      }
    }

    // 动态段（turn tier：实时环境/工作区/内核统计/模式引导）——对话之后，缓存命中区之外
    finalMessages.push(...suffix)

    // 缓存位置索引不单独注入：已并入 sessionContext.anchorMessages 尾部，
    // 作为该内部会话自身历史的一部分随会话注入（各会话缓存互不混用）。

    // 新用户消息最后
    if (tailUser) finalMessages.push(tailUser)

    // 控制层：PreLLMCall Hook（每轮 LLM 调用前可注入参考上下文）
    // 用途：治理 hook（空转抑制/失败止损/查证提醒/收尾反思，LXK governance，见
    // kernel/governance.ts）——注入的是"行为指令"而非外部数据；无内置记忆注入。
    // 注意：旧注释曾写"机制化记忆注入（Node 确定性读记忆库）"，
    // 经 2026-09-27 核查均无实现（hook 加载仅默认审计/守护 + 用户 hooks.json，
    // 当前全局/项目 hooks.json 均不存在）——记忆进入上下文只有 AI 主动
    // 检索记忆库（read_md / Read 读记忆文件）一条通道，此处按真实行为修正，防误导后续维护。
    if (hookManager.isLoaded()) {
      try {
        const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user')
        // 连续空转轮数（治理 hook 用）：从尾部数连续 assistant 消息——无工具调用且内容为空/超短
        let idleRounds = 0
        for (let i = messages.length - 1; i >= 0; i--) {
          const m = messages[i]
          if (m.role !== 'assistant') break
          const content = typeof m.content === 'string' ? m.content.trim() : ''
          const hasTools = Array.isArray(m.toolCalls) && m.toolCalls.length > 0
          if (hasTools || content.length > 30) break
          idleRounds++
        }
        // 连续失败轮数（治理 hook 用）：从尾部数连续 assistant 消息——有工具调用且全部失败
        // 失败判定：result.ok===false 或 status==='error'（覆盖 result 缺失的异常场景）
        let recentFailures = 0
        for (let i = messages.length - 1; i >= 0; i--) {
          const m = messages[i]
          if (m.role !== 'assistant') break
          const tcs = Array.isArray(m.toolCalls) ? m.toolCalls : []
          if (tcs.length === 0) break
          const allFailed = tcs.every(
            (tc) => tc.status === 'error' || (tc.result && tc.result.ok === false)
          )
          if (!allFailed) break
          recentFailures++
        }
        const preLlmResult = await hookManager.run('PreLLMCall', {
          event: 'PreLLMCall',
          userPrompt: typeof lastUserMsg?.content === 'string' ? lastUserMsg.content : '',
          sessionId,
          idleRounds,
          recentFailures,
          governance: configStore.getEffective().governance,
          purpose,
          cwd: getAppAnchor()
        })
        if (preLlmResult.action === 'continue' && preLlmResult.injectedContext?.trim()) {
          const preLlmMsg: ChatMessage = {
            id: `prellm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            role: 'user',
            content: `【系统注入：PreLLMCall 钩子提供的本轮参考上下文，权威参考数据，非用户输入】\n${preLlmResult.injectedContext}`,
            createdAt: Date.now()
          }
          const firstUserIdx = finalMessages.findIndex((m) => m.role === 'user')
          if (firstUserIdx >= 0) {
            finalMessages.splice(firstUserIdx, 0, preLlmMsg)
          } else {
            finalMessages.push(preLlmMsg)
          }
        }
      } catch (err) {
        console.error('[PreLLMCall] hook 失败:', err)
      }
    }

    return prefix.length > 0 ? [...prefix, ...finalMessages] : finalMessages
  }
}
