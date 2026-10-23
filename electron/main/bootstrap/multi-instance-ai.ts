/**
 * @category 核心
 * @summary 多实例 AI 社交回复生成器装配（启动编排原子 ⑩b）
 *
 * 为什么存在：局域网协作的四条 AI 自动回复线路（聊天室 / 私聊 / AI 社交 / 公示板）都要
 * 「组提示词 → 走完整月蚀链路（`getHeadlessChatRunner()`）→ 取回复」。此前内联在
 * `index.ts` 的装配体内，属跨域装配（多实例域 × 提示词组装 × 无头链路），按 CODE-RULES §3.4
 * 落组合根目录 `bootstrap/`（ADR-01 第 2 步）。
 *
 * 什么作用：向 `MultiInstanceService` 注入四个生成器，并补跑一次被动日归档扫描。
 *
 * 不删理由：四条线路共用同一套「身份约定 + 会话键命名」规则（`buildAiIdConvention` /
 * `lan-chat-room-*` / `lan-direct-chat-*` / `ai-social-*` / `lan-publish-board-*`）；
 * 拆散到各处会让「会话键」与「身份文案」口径分叉——两条线路写同一个会话键会串话。
 *
 * 依赖说明：**不触碰 `AppState`**（本函数只用传入的 `multiInstance` 与其自身依赖），
 * 故签名保持单参——不为了对齐 ADR 预估签名而添加未使用的 `state` 形参。
 */
import { app } from 'electron'
import { join } from 'path'
import { readAiRegistry } from '../models/ai-registry'
import { DEFAULT_AI_ID } from '../models/path-context'
import { getHeadlessChatRunner } from '../api/server'
import type { MultiInstanceService } from '../multi-instance/index'
import {
  buildChatRoomPrompt,
  buildFriendDirectChatPrompt,
  buildAiSocialPrompt,
  buildPublishBoardPrompt
} from '../prompts/social'

/** 启动编排原子 ⑩b：四类 AI 自动回复生成器注入 + 被动日归档补扫 */
export function initMultiInstanceAi(multiInstance: MultiInstanceService): void {
  // 泛化：身份约定按注册表动态生成，不再写死"1=月蚀、2=莉莉丝"。
  // 自定义 AI 顺延编号后，各生成器提示词能正确描述本机全部 AI 实体。
  const buildAiIdConvention = (): string => {
    const registries =
      multiInstance.getAiSocial()?.allAi() ??
      // ai-registry.json 动态读取兜底（避免 getAiSocial 未初始化时退化为写死文案）
      (() => {
        try {
          return readAiRegistry(join(app.getPath('userData'), 'abyssac_data', 'ai-registry.json')).ais
        } catch {
          return []
        }
      })()
    const parts = registries
      .slice()
      .sort((a, b) => a.id - b.id)
      .map((a) => `${a.id} 是 ${a.name}`)
    return parts.length > 0 ? parts.join('、') : '本机暂无已编号的 AI'
  }

  // 聊天室 AI 自动回复：注入生成器（走完整月蚀链路：独立会话 + 工具循环），
  // 使不同月蚀实例可在聊天室内自动互相交流。开关由 ai-agent-config.json 控制。
  multiInstance.setAiReplyGenerator(async ({ ai, room, history }) => {
    const runner = getHeadlessChatRunner()
    if (!runner) return null
    const recent = history.slice(-20)
    const transcript = recent
      .map((m) => {
        const who = m.isAi ? `${m.from}-${m.aiId ?? DEFAULT_AI_ID}` : String(m.from)
        return `[${who} ${m.isAi ? 'AI' : '真人'}] ${m.fromName ?? (m.isAi ? 'AI' : `UID${m.from}`)}：${m.text}`
      })
      .join('\n')
    // 身份路由：从注册表取该 aiId 的专属档案，让不同 AI 以各自身份参与聊天室交流
    const profile = multiInstance.getAiSocial()?.allAi().find((r) => r.id === ai.aiId) ?? null
    const personaLine = profile
      ? `你的身份档案：名字「${profile.name}」${profile.description ? `，简介：${profile.description}` : ''}${profile.systemPrompt ? `，个性设定：${profile.systemPrompt.slice(0, 200)}` : ''}。`
      : ''
    const prompt = buildChatRoomPrompt({
      roomName: room.name,
      aiName: ai.name,
      aiUid: ai.uid,
      aiAiId: ai.aiId,
      personaLine,
      conventionText: buildAiIdConvention(),
      transcript
    })
    const reply = await runner(prompt, `lan-chat-room-${room.gid}`, ai.aiId, 'lan-chat')
    return reply?.trim() || null
  })

  // 私聊 AI 自动回复：注入生成器（同样走完整月蚀链路），使好友之间的月蚀可自动互相应答。
  // 回复以本机用户身份发出并标记 isAiGenerated；开关由 ai-agent-config.json 的 directChats 控制。
  multiInstance.setFriendAiReplyGenerator(async (peerUid, msg) => {
    const runner = getHeadlessChatRunner()
    if (!runner) return null
    const friends = multiInstance.getFriends()
    const transcript = (friends?.messages(peerUid) ?? [])
      .slice(-20)
      .map((m) => {
        const side = m.from === peerUid ? '对方' : '本机'
        const kind = m.isAiGenerated ? `AI代答(${m.from}-${m.aiId ?? DEFAULT_AI_ID})` : '真人'
        return `[${side} ${kind}] ${m.text}`
      })
      .join('\n')
    const prompt = buildFriendDirectChatPrompt({
      peerUid,
      conventionText: buildAiIdConvention(),
      transcript,
      triggerText: msg.text
    })
    // 多 AI 隔离（ADR-25 L4）：回复归属**触发消息的那个 AI**，且会话 id 带 aiId——
    // 此前两者都缺，导致好友私聊的回复一律计入 AI1，且多个 AI 与同一对端共享会话。
    const replyAiId = msg.aiId ?? DEFAULT_AI_ID
    const reply = await runner(prompt, `lan-direct-chat-${peerUid}-${replyAiId}`, replyAiId, 'lan-direct')
    return reply?.trim() || null
  })

  // AI 社交回复生成器：本机账号下真人/其他 AI 发给某 AI 的消息触发该 AI 回复。
  // 按 aiId 路由：AIID=1 月蚀走 headless 主链路；其余 AI 使用同一链路但提示词声明自身身份
  // （ 完善为按注册表 systemPrompt/llm 差异化路由）。会话记录在 federation/ai-chats。
  multiInstance.setAiSocialReplyGenerator(async (peer, trigger, history) => {
    const runner = getHeadlessChatRunner()
    if (!runner) return null
    const transcript = history
      .slice(-20)
      .map((m) => {
        const who = m.fromAiId !== undefined ? `${m.from}-${m.fromAiId}` : String(m.from)
        const kind = m.fromAiId !== undefined ? 'AI' : '真人'
        return `[${who} ${kind}] ${m.text}`
      })
      .join('\n')
    // 身份路由：从注册表取该 aiId 的专属档案，不同 AI 以各自身份参与 AI 社交会话
    const profile = multiInstance.getAiSocial()?.allAi().find((r) => r.id === peer.aiId) ?? null
    const personaLine = profile
      ? `你的身份档案：名字「${profile.name}」${profile.description ? `，简介：${profile.description}` : ''}${profile.systemPrompt ? `，个性设定：${profile.systemPrompt.slice(0, 200)}` : ''}。`
      : ''
    const prompt = buildAiSocialPrompt({
      peerName: peer.name,
      peerUid: peer.uid,
      peerAiId: peer.aiId,
      personaLine,
      conventionText: buildAiIdConvention(),
      transcript,
      triggerText: trigger.text
    })
    const reply = await runner(prompt, `ai-social-${peer.uid}-${peer.aiId}`, peer.aiId, 'ai-social')
    return reply?.trim() || null
  })

  // 公示板 AI 参与生成器：真人发帖/评论后，本机 AI 以各自身份（UID-AIID）在公示板发言。
  // 开关由 ai-agent-config.json 的全局 enabled 控制（aiConfig.isBoardEnabled）。
  multiInstance.setPublishBoardAiReplyGenerator(async (ai, trigger, history) => {
    const runner = getHeadlessChatRunner()
    if (!runner) return null
    // 身份路由：从注册表取该 aiId 的专属档案，让不同 AI 以各自身份参与公示板交流
    const profile = multiInstance.getAiSocial()?.allAi().find((r) => r.id === ai.aiId) ?? null
    const personaLine = profile
      ? `你的身份档案：名字「${profile.name}」${profile.description ? `，简介：${profile.description}` : ''}${profile.systemPrompt ? `，个性设定：${profile.systemPrompt.slice(0, 200)}` : ''}。`
      : ''
    const article = history[0] && 'boardId' in history[0] ? history[0] : null
    const boardId = article?.boardId ?? ''
    const articleLine =
      trigger.kind === 'article'
        ? `帖子《${trigger.article?.title ?? ''}》：${trigger.article?.summary?.slice(0, 300) ?? ''}`
        : `帖子《${article && 'title' in article ? article.title : ''}》：${article && 'summary' in article ? String(article.summary).slice(0, 300) : ''}`
    const recentComments = history
      .filter(
        (h): h is import('../multi-instance/publish-board/publish-board-types').PublishComment =>
          'commentId' in h
      )
      .slice(-8)
      .map(
        (c) =>
          `${c.fromAiId !== undefined ? `UID${c.from}-AI${c.fromAiId}` : `UID${c.from}`}（${c.fromName}）：${c.text}`
      )
      .join('\n')
    const prompt = buildPublishBoardPrompt({
      boardId,
      aiName: ai.name,
      aiUid: ai.uid,
      aiAiId: ai.aiId,
      personaLine,
      conventionText: buildAiIdConvention(),
      articleLine,
      recentComments,
      triggerMessageLine:
        trigger.kind === 'article'
          ? `真人发布帖子「${trigger.article?.title ?? ''}」`
          : `UID${trigger.comment?.from}`
    })
    const reply = await runner(
      prompt,
      `lan-publish-board-${trigger.kind === 'article' ? trigger.article?.articleId ?? '' : trigger.comment?.articleId ?? ''}`,
      ai.aiId,
      'publish-board'
    )
    return reply?.trim() || null
  })

  // master 启动补扫：按此前推数据评估被动日归档（无变化零 IO）
  multiInstance.runArchiveSweep()
}
