/**
 * @category API
 * @summary 会话模式（aiMode=chat）输出硬约束：JSON envelope 解析、语言检测、规范化与提示词
 *
 * 会话模式把「回复跟随人设，携带情绪/动画等结构化字段」作为硬约束，
 * AI 输出必须能解析成标准 JSON envelope 并按语言强校验，否则 UI 无法消费——
 *
 * 从 server.ts 抽出（原为 startApiServer 内的闭包函数）。除 enforceChatOutput 需要
 * 注入 LLM 客户端外，其余均为纯函数。
 */
import type { LLMClient, ApiMessage } from './llm'
// 会话模式/任务模式提示词与输出长度上限统一集中管理（prompts/chat-mode.ts），
// 本文件只保留信封解析/语言检测/规范化逻辑；re-export 保持旧 import 面兼容（server.ts 等）
import { CHAT_MAX_CHARS, chatModePrompt, TASK_LEAD_PROMPT } from '../prompts/chat-mode'

export { CHAT_MAX_CHARS, chatModePrompt, TASK_LEAD_PROMPT }
export const CHAT_FALLBACK_TEXT = '嗯，我在呢~ 刚才这句没接好，你再说一遍好吗？'
export const ALLOWED_CHAT_EMOTIONS = new Set(['neutral', 'happy', 'sad', 'angry', 'surprised', 'shy'])
export const ALLOWED_CHAT_ANIMATIONS = new Set(['idle', 'smile', 'listen', 'think', 'music'])

// 照抄 MOD parseModelEnvelope：JSON 直接解析 → markdown fence 提取 → 尾部元数据行，三层容错
export function parseChatEnvelope(rawText: string): {
  text: string
  emotion?: string
  animation?: string
} {
  const text = String(rawText || '').trim()
  try {
    const value = JSON.parse(text)
    if (value && typeof value === 'object') {
      return {
        text: String(value.text ?? ''),
        emotion: value.emotion,
        animation: value.animation
      }
    }
  } catch {
    // 继续尝试 fence 提取
  }
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
  if (fenced) {
    try {
      const value = JSON.parse(fenced[1])
      if (value && typeof value === 'object') {
        return {
          text: String(value.text ?? ''),
          emotion: value.emotion,
          animation: value.animation
        }
      }
    } catch {
      // 保留原始文本
    }
  }
  return { text }
}

// 照抄 MOD replyMatchesLocale（zh 分支）：脚本计数判断回复是否匹配中文
export function replyMatchesZh(value: string): boolean {
  const text = String(value || '').trim()
  if (!text) return false
  const han = (text.match(/\p{Script=Han}/gu) || []).length
  const kana = (text.match(/[\p{Script=Hiragana}\p{Script=Katakana}]/gu) || []).length
  const latin = (text.match(/\p{Script=Latin}/gu) || []).length
  const japaneseDominant = kana >= 3 && kana >= han * 1.5
  const englishDominant = latin >= 12 && latin >= han * 3
  return !japaneseDominant && !englishDominant
}

// 照抄 MOD fitReplyText：超长按句子边界截断，找不到边界补省略号
export function fitChatText(value: string, maxChars: number): string {
  const text = String(value || '').trim()
  const characters = Array.from(text)
  if (characters.length <= maxChars) return text
  const candidate = characters.slice(0, maxChars).join('')
  let boundary = -1
  for (const match of candidate.matchAll(/[。！？!?…]+[”’」』】）)]*/g)) {
    boundary = match.index + match[0].length
  }
  if (boundary >= Math.floor(maxChars * 0.55)) {
    return candidate.slice(0, boundary).trim()
  }
  return (
    characters
      .slice(0, Math.max(1, maxChars - 1))
      .join('')
      .replace(/[，、；：,;:\s]+$/u, '') + '……'
  )
}

// 照抄 MOD normalizeResponse：envelope 白名单归位 + 剥括号动作 + 长度截断
export function normalizeChatEnvelope(
  envelope: { text: string; emotion?: string; animation?: string },
  rawText: string,
  maxChars: number
): { text: string; emotion: string; animation: string } {
  const raw = String(envelope.text || rawText || '')
  // 1. markdown 重符号 → 纯文本
  let t = raw
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+[.、)]\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
  // 表格行整行剔除（先于剥竖线执行：行首尾都是 | 才是真表格，口语竖线不误伤）
  t = t
    .split('\n')
    .map((line) => {
      const trimmed = line.trim()
      if ((trimmed.startsWith('|') && trimmed.endsWith('|')) || /^\|[-:\s|]+\|$/.test(trimmed))
        return ''
      return line
    })
    .join('\n')
    .replace(/^\s*\|?[\s:|-]+\|?\s*$/gm, '')
    .replace(/^\s*\|/gm, '')
    .replace(/\|\s*$/gm, '')
  // 2. 括号动作剥离
  t = stripStageActions(t)
  if (!t.trim()) return { text: CHAT_FALLBACK_TEXT, emotion: 'neutral', animation: 'idle' }
  // 3. 长度截断
  const text = fitChatText(t, maxChars)
  // 4. emotion/animation 白名单归位
  const emotion = ALLOWED_CHAT_EMOTIONS.has(envelope.emotion ?? '') ? envelope.emotion! : 'neutral'
  const animation = ALLOWED_CHAT_ANIMATIONS.has(envelope.animation ?? '')
    ? envelope.animation!
    : 'idle'
  return { text: text.replace(/\n{3,}/g, '\n\n').trim(), emotion, animation }
}

// 会话模式完整强制链路：原始输出 → envelope 解析 → 语言检测 → 不符重试（chatWithTools）→ 再不符 fallback → 规范化
// 照抄 MOD generateReply 的强制流程（parseModelEnvelope → replyMatchesLocale → 重试 → fallbackResponse → normalizeResponse）
// 返回完整 {text, emotion, animation}——emotion/animation 用于前端角色表情/动画展示
export async function enforceChatOutput(
  llm: LLMClient,
  raw: string,
  retryMessages: ApiMessage[],
  model?: string
): Promise<{ text: string; emotion: string; animation: string }> {
  if (!raw) return { text: CHAT_FALLBACK_TEXT, emotion: 'neutral', animation: 'idle' }
  // 第一轮解析
  let envelope = parseChatEnvelope(raw)
  let effectiveText = envelope.text || raw
  let currentRaw = raw
  // 语言检测：不符 → 重试一次（追加 correction 消息）→ 再不符 fallback
  if (!replyMatchesZh(effectiveText)) {
    console.warn('[server] 会话模式语言不符，重试一次')
    try {
      const correction =
        '请用中文重新回答，只返回 JSON：{"text":"...","emotion":"...","animation":"..."}'
      const retryPayload = [
        ...retryMessages,
        { role: 'assistant' as const, content: currentRaw },
        { role: 'user' as const, content: correction }
      ]
      const retry = await llm.chatWithTools(retryPayload, [], model, { temperature: 0.7 })
      const retryRaw = retry.content ?? ''
      envelope = parseChatEnvelope(retryRaw)
      currentRaw = retryRaw
      effectiveText = envelope.text || retryRaw
      if (!replyMatchesZh(effectiveText)) {
        console.warn('[server] 会话模式语言不符持续，使用兜底文案')
        return { text: CHAT_FALLBACK_TEXT, emotion: 'neutral', animation: 'idle' }
      }
    } catch (retryErr) {
      console.error('[server] 会话模式重试失败，使用兜底文案:', retryErr)
      return { text: CHAT_FALLBACK_TEXT, emotion: 'neutral', animation: 'idle' }
    }
  }
  const normalized = normalizeChatEnvelope(envelope, currentRaw, CHAT_MAX_CHARS)
  return normalized
}

// 会话模式提示词：强制 JSON envelope 输出（gate 时注入；文案定义在 prompts/chat-mode.ts）

// 任务模式（Agent Teams）Team Lead 提示词： 注入，月蚀 = Lead 的角色 + 协作流程（文案定义在 prompts/chat-mode.ts）

// 括号内容是否为动作/神态描写（保守匹配，避免误删正常括号内容）
export function looksLikeStageAction(content: string): boolean {
  return /(笑|叹|歪|眨|皱|挑眉|点头|摇头|低头|抬头|侧头|偏头|耸肩|沉默|顿了顿|脸红|鼓腮|撇嘴|吐舌|捂|扶额|托腮|抱|拍|摸|牵|靠|凑|退后|转身|伸手|摆手|看向|望向|盯着|露出|眼神|目光|表情|语气|轻声|小声|悄悄|压低|微笑|smiles?|laughs?|nods?|shakes?\s*head|sighs?|blushes?|hugs?|touches?|looks?\s*at|whispers?)/iu.test(
    String(content || '')
  )
}

// 剥离括号动作/神态（参考 MOD stripParentheticalActions，保守版）
export function stripStageActions(text: string): string {
  let t = String(text || '')
  for (let pass = 0; pass < 3; pass += 1) {
    const filtered = t.replace(
      /(^|[\s，。！？!?；;：:…])[(（]([^()）\r\n]{1,60})[)）]\s*/gu,
      (match, prefix, content: string) => (looksLikeStageAction(content) ? prefix : match)
    )
    if (filtered === t) break
    t = filtered
  }
  return t.replace(/^[\s，。；;]+/u, '').trim()
}