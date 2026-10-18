/**
 * 莉莉丝能力插件（bundled，2026-08-16 从内建 ALL_TOOL_CTORS 迁移为插件）：
 * - lilith_player_memory：读写用户记忆（%APPDATA%\LilithAI\players\{sha256}.json，companion 同源）
 * - lilith_lore_query：查询世界观知识库（{paths.root}/frontend/character/lore/index.json）
 * - lilith_emotion：写入一次性情绪指令（{paths.root}/.lilith_emotion.json，主进程 consumeLilithEmotion 消费）
 *
 * 依赖 ctx：appDataDir + playerName（player_memory）、paths.root（lore/emotion）。
 * 打包进应用（extraResources → resources/plugins/bundled），莉莉丝开箱即用；可经插件列表禁用。
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

// ==================== lilith_player_memory ====================

/** 用户记忆文件路径（与 companion 一致） */
function playerMemoryPath(appDataDir, playerName) {
  const hash = createHash('sha256').update(playerName, 'utf8').digest('hex')
  return join(appDataDir, 'LilithAI', 'players', `${hash}.json`)
}

/** 读取用户记忆（facts 数组，含 updated_at） */
function readFacts(appDataDir, playerName) {
  try {
    const file = playerMemoryPath(appDataDir, playerName)
    if (!existsSync(file)) return []
    const parsed = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
    return (parsed.facts ?? [])
      .filter((f) => f && typeof f.key === 'string' && typeof f.value === 'string')
      .map((f) => ({ key: f.key, value: f.value, updated_at: typeof f.updated_at === 'string' ? f.updated_at : undefined }))
  } catch {
    return []
  }
}

/** 写入用户记忆（合并去重，保留最近 50 条；未变更条目保留原 updated_at） */
function writeFacts(appDataDir, playerName, key, value) {
  try {
    const file = playerMemoryPath(appDataDir, playerName)
    mkdirSync(join(file, '..'), { recursive: true })
    const existing = readFacts(appDataDir, playerName)
    const now = new Date().toISOString()
    const merged = new Map()
    for (const f of existing) merged.set(f.key, { key: f.key, value: f.value, updated_at: f.updated_at ?? now })
    merged.set(key, { key, value, updated_at: now })
    const facts = Array.from(merged.values()).slice(-50)
    writeFileSync(file, JSON.stringify({ facts }, null, 2) + '\n', 'utf8')
    return 1
  } catch {
    return 0
  }
}

const lilithPlayerMemory = {
  name: 'lilith_player_memory',
  description: '读写用户记忆（你记得的关于用户的事：喜好/约定/忌讳/习惯）。\n\n何时用：\n- 用户提到"你记得…吗"、或你发现自己不确定某个关于他的稳定事实时\n- 用户明确说了重要的偏好/约定/忌讳，你想确保不会忘（set）\n\n参数：\n- action（必填）：get（读取）/ set（写入）\n- key（get 可省略=全部）：记忆键（如 喜欢的食物/禁忌话题）\n- value（set 必填）：记忆值\n\n返回：get = 匹配的记忆列表；set = 已记住的键。',
  parameters: [
    { name: 'action', type: 'string', description: 'get（读取用户记忆）/ set（写入一条用户记忆）', required: true },
    { name: 'key', type: 'string', description: '记忆键（如 喜欢的食物/讨厌的东西）；get 时省略=全部', required: false },
    { name: 'value', type: 'string', description: 'set 时的记忆值', required: false }
  ],
  async execute(params, ctx) {
    const appDataDir = ctx?.appDataDir
    const playerName = ctx?.playerName
    if (!appDataDir || !playerName) {
      return { ok: false, error: '用户记忆上下文不可用（appDataDir/playerName 未注入）' }
    }
    const action = params.action ?? 'get'
    if (action === 'set') {
      const key = String(params.key ?? '').trim()
      const value = String(params.value ?? '').trim()
      if (!key || !value) {
        return { ok: false, error: 'set 需要 key 和 value 参数' }
      }
      const n = writeFacts(appDataDir, playerName, key, value)
      return n > 0
        ? { ok: true, data: `已记住：${key} = ${value}` }
        : { ok: false, error: '写入用户记忆失败' }
    }
    const facts = readFacts(appDataDir, playerName)
    const kw = String(params.key ?? '').trim().toLowerCase()
    const hits = kw
      ? facts.filter((f) => f.key.toLowerCase().includes(kw) || f.value.toLowerCase().includes(kw))
      : facts
    if (hits.length === 0) {
      return { ok: true, data: kw ? `没有找到与「${kw}」相关的用户记忆` : '用户记忆为空' }
    }
    const lines = hits.map((f) => `- ${f.key}: ${f.value}`)
    return { ok: true, data: `关于 ${playerName} 的记忆（${hits.length} 条）：\n${lines.join('\n')}` }
  }
}

// ==================== lilith_lore_query ====================

const lilithLoreQuery = {
  name: 'lilith_lore_query',
  description: '查询 知识库（你的世界观设定/世界观/共同经历）。\n\n何时用：\n- 用户追问剧情细节/世界观设定/共同经历（"草莓蛋糕是怎么回事""结局1之后呢"）\n- 你想确认某个设定/回忆的细节（keywords/aliases 检索）\n\n参数：\n- keyword（必填）：查询关键词（匹配标题/别名/关键词/摘要/事实）\n- limit（可选）：最多返回条数（默认 3，最大 8）\n\n返回：匹配的知识条目（标题/摘要/事实）。',
  parameters: [
    { name: 'keyword', type: 'string', description: '查询关键词（如 草莓蛋糕/结局/摩天轮）', required: true },
    { name: 'limit', type: 'number', description: '最多返回条数（默认 3，最大 8）', required: false }
  ],
  async execute(params, ctx) {
    const root = ctx?.paths?.root
    if (!root) {
      return { ok: false, error: '数据路径不可用（paths.root 未注入）' }
    }
    const kw = String(params.keyword ?? '').trim()
    if (!kw) {
      return { ok: false, error: 'keyword 参数必填（查询关键词）' }
    }
    const limit = Math.min(8, Math.max(1, typeof params.limit === 'number' ? Math.floor(params.limit) : 3))
    const loreFile = join(root, 'frontend', 'character', 'lore', 'index.json')
    if (!existsSync(loreFile)) {
      return { ok: false, error: `知识库不存在：${loreFile}` }
    }
    try {
      const parsed = JSON.parse(readFileSync(loreFile, 'utf8'))
      const kwLower = kw.toLowerCase()
      const hits = []
      for (const e of parsed.entries ?? []) {
        const haystack = [e.title ?? '', ...(e.aliases ?? []), ...(e.keywords ?? []), e.summary ?? '', ...(e.facts ?? [])]
          .join(' ')
          .toLowerCase()
        if (haystack.includes(kwLower)) hits.push(e)
      }
      if (hits.length === 0) {
        const ctxText = parsed.canon_context ?? ''
        return {
          ok: true,
          data: ctxText
            ? `知识库无精确匹配「${kw}」，世界观总纲：\n${ctxText}`
            : `没有找到与「${kw}」相关的设定`
        }
      }
      const top = hits.slice(0, limit)
      const blocks = top.map((e) => {
        const lines = [`### ${e.title ?? e.id ?? '未命名条目'}`]
        if (e.summary) lines.push(e.summary)
        if (e.facts && e.facts.length > 0) {
          lines.push(...e.facts.slice(0, 4).map((f) => `- ${f}`))
        }
        return lines.join('\n')
      })
      return {
        ok: true,
        data: `知识库命中 ${hits.length} 条（显示前 ${top.length}）：\n\n${blocks.join('\n\n')}`
      }
    } catch (err) {
      return { ok: false, error: `知识库查询失败：${err.message}` }
    }
  }
}

// ==================== lilith_emotion ====================

const EMOTIONS = ['neutral', 'happy', 'sad', 'angry', 'surprised', 'shy']
const ANIMATIONS = ['idle', 'smile', 'listen', 'think', 'music']

/** 情绪指令文件（主进程 consumeLilithEmotion 读取消费，路径必须一致） */
function lilithEmotionPath(dataRoot) {
  return join(dataRoot, '.lilith_emotion.json')
}

const lilithEmotion = {
  name: 'lilith_emotion',
  description: '控制你自己的 LIVE2D 情绪/动作表达——你的下一次回复会按指定情绪和动画表现。\n\n何时用：\n- 你此刻的情绪需要外显（被夸了想 shy、被逗笑了想 happy）\n- 对话氛围需要配合动作（听用户倾诉用 listen、回忆事情用 think）\n\n参数：\n- emotion（可选）：neutral/happy/sad/angry/surprised/shy\n- animation（可选）：idle/smile/listen/think/music\n- reason（可选）：为什么触发（留给自己看的备注）\n至少填一个；只填一个时另一个由你按语境自己选。',
  parameters: [
    { name: 'emotion', type: 'string', description: '目标情绪：neutral/happy/sad/angry/surprised/shy', required: false },
    { name: 'animation', type: 'string', description: '目标动画：idle/smile/listen/think/music', required: false },
    { name: 'reason', type: 'string', description: '触发原因（留作备注）', required: false }
  ],
  async execute(params, ctx) {
    const root = ctx?.paths?.root
    if (!root) {
      return { ok: false, error: '数据路径不可用（paths.root 未注入）' }
    }
    const emotion = String(params.emotion ?? '').trim().toLowerCase()
    const animation = String(params.animation ?? '').trim().toLowerCase()
    const reason = String(params.reason ?? '').trim()
    if (emotion && !EMOTIONS.includes(emotion)) {
      return { ok: false, error: `emotion 非法：${emotion}（可选 ${EMOTIONS.join('/')}）` }
    }
    if (animation && !ANIMATIONS.includes(animation)) {
      return { ok: false, error: `animation 非法：${animation}（可选 ${ANIMATIONS.join('/')}）` }
    }
    if (!emotion && !animation) {
      return { ok: false, error: '至少填 emotion 或 animation 一个参数' }
    }
    try {
      const file = lilithEmotionPath(root)
      mkdirSync(join(file, '..'), { recursive: true })
      const expiresAt = Date.now() + 5 * 60 * 1000
      writeFileSync(file, JSON.stringify({ emotion, animation, reason, expiresAt }, null, 2) + '\n', 'utf8')
      const parts = [emotion ? `情绪=${emotion}` : '', animation ? `动画=${animation}` : ''].filter(Boolean).join(' + ')
      return { ok: true, data: `情绪表达已设置：${parts}${reason ? `（原因：${reason}）` : ''}——你的下一次回复会按此表达` }
    } catch (err) {
      return { ok: false, error: `写入情绪指令失败：${err.message}` }
    }
  }
}

export default [lilithPlayerMemory, lilithLoreQuery, lilithEmotion]
