import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import http from 'http'
import { mkdtempSync, writeFileSync, rmSync, readFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { LilithAdapter, buildLilithPersona, parseLilithReply, LILITH_SESSION_ID, loadLore, retrieveLore, formatLoreContext, readPlayerMemory, applyMemoryUpdates, playerMemoryPath } from '../electron/main/services/lilith-adapter'
import { __setLilithInternalStateFileForTest } from '../electron/main/services/lilith-internal-session'
import { SessionStore } from '../electron/main/api/session-store'
import type { ChatMessage } from '@shared/types'

// 从项目位置自动定位 lore 文件（test/ 往上一层 = app/，不硬编码绝对路径）
const LORE_PATH = join(resolve(__dirname, '..'), 'data', 'abyssac_data', 'frontend', 'character', 'lore', 'index.json')

/**
 * 莉莉丝协议适配器测试：
 * - 协议面（/health、/v1/session/{id}/message、history、/v1/control）对齐 companion server.js
 * - LilithMod.dll 只认协议不认进程——协议正确性 = 月蚀能直接注入莉莉丝
 */

/** HTTP 测试替身的响应体类型（协议字段按需声明，断言处原样访问） */
interface TestApiJson {
  ok?: boolean
  protocol_version?: number
  character_id?: string
  provider_configured?: boolean
  mock_mode?: boolean
  status?: string
  text?: string
  ui?: { emotion?: string; animation?: string; duration_ms?: number }
  messages?: Array<{ role: string; content: string }>
  reloaded?: boolean
  raw?: string
}

/** 内存会话存储桩（不落盘） */
function makeSessionStore() {
  const sessions = new Map<string, { id: string; messages: ChatMessage[] }>()
  return {
    getOrCreate: (id: string) => {
      if (!sessions.has(id)) sessions.set(id, { id, messages: [] })
      return sessions.get(id)!
    },
    get: (id: string) => sessions.get(id) ?? null,
    saveMessages: (id: string, messages: ChatMessage[]) => {
      sessions.set(id, { id, messages })
    },
    delete: (id: string) => {
      sessions.delete(id)
    },
    flush: () => {}
  } as unknown as SessionStore
}

describe('LilithAdapter 协议面', () => {
  let adapter: LilithAdapter
  let store: SessionStore
  let port: number
  let token: string
  let dataRoot: string
  let appDataDir: string
  let adapterLlm: { isReady: () => boolean }
  let tmp: string

  beforeEach(async () => {
    // 临时目录（dataRoot 用于人设读取；appDataDir 用于 runtime.json 写入）
    tmp = mkdtempSync(join(tmpdir(), 'lilith-adapter-'))
    dataRoot = join(tmp, 'data')
    appDataDir = join(tmp, 'appdata')

    store = makeSessionStore()
    adapterLlm = { isReady: () => true }
    adapter = new LilithAdapter({
      port: 0, // 动态端口避免测试冲突
      dataRoot,
      appDataDir,
      sessionStore: store,
      getLlmClient: () => adapterLlm as never,
      generateReply: async ({ message, playerName, history }) => {
        // 模拟 LLM：echo 玩家名 + 消息 + 情感/动画标记
        void history
        return {
          text: `莉莉丝对${playerName}说：${message}\n[emotion: happy] [animation: smile]`,
          emotion: 'happy',
          animation: 'smile'
        }
      }
    })
    port = await adapter.start()
    // 从 runtime.json 读 token（协议需要）
    const rt = JSON.parse(readFileSync(join(appDataDir, 'LilithAI', 'runtime.json'), 'utf8'))
    token = rt.token
  })

  afterEach(async () => {
    await adapter.stop()
    rmSync(tmp, { recursive: true, force: true })
  })

  function request(
    method: string,
    path: string,
    body?: unknown,
    authToken?: string
  ): Promise<{ status: number; json: TestApiJson }> {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body)
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path,
          method,
          headers: {
            ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
            ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {})
          }
        },
        (res) => {
          let raw = ''
          res.on('data', (c) => { raw += c })
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
    })
  }

  it('/health 无需认证，返回 companion 格式', async () => {
    const r = await request('GET', '/health')
    expect(r.status).toBe(200)
    expect(r.json.ok).toBe(true)
    expect(r.json.protocol_version).toBe(1)
    expect(r.json.character_id).toBe('lilith')
    expect(r.json.provider_configured).toBe(true)
    expect(r.json.mock_mode).toBe(false)
  })

  it('除 /health 外都需要 Bearer token（401）', async () => {
    const noAuth = await request('POST', '/v1/session/lilith/message', { message: 'hi' })
    expect(noAuth.status).toBe(401)
    const badToken = await request('POST', '/v1/session/lilith/message', { message: 'hi' }, 'wrong-token')
    expect(badToken.status).toBe(401)
  })

  it('message 端点：认证 + 返回 { text, ui:{emotion,animation} } + 写回会话', async () => {
    const r = await request('POST', '/v1/session/lilith/message', {
      message: '你好，莉莉丝',
      player: { name: 'Player' },
      mode: 'in_character'
    }, token)
    expect(r.status).toBe(200)
    expect(r.json.status).toBe('ok')
    expect(r.json.text).toContain('莉莉丝对Player说')
    expect(r.json.ui!.emotion).toBe('happy')
    expect(r.json.ui!.animation).toBe('smile')
    expect(typeof r.json.ui!.duration_ms).toBe('number')
    // 会话写回
    const session = store.get(LILITH_SESSION_ID)
    expect(session?.messages.length).toBe(2)
    expect(session?.messages[0].role).toBe('user')
    expect(session?.messages[1].role).toBe('assistant')
  })

  it('history 端点：返回会话历史（含 role/content 过滤）', async () => {
    // 先发一条消息，再拉历史
    await request('POST', '/v1/session/lilith/message', { message: '第一条' }, token)
    const r = await request('GET', '/v1/session/lilith/history', undefined, token)
    expect(r.status).toBe(200)
    expect(Array.isArray(r.json.messages)).toBe(true)
    expect(r.json.messages!.length).toBe(2)
    expect(r.json.messages![0].role).toBe('user')
    expect(r.json.messages![0].content).toBe('第一条')
    expect(r.json.messages![1].role).toBe('assistant')
  })

  it('history 端点：空会话返回空数组', async () => {
    // 未发过任何消息时，history 返回空数组而非未定义
    const r = await request('GET', '/v1/session/lilith/history', undefined, token)
    expect(r.status).toBe(200)
    expect(Array.isArray(r.json.messages)).toBe(true)
    expect(r.json.messages!.length).toBe(0)
  })

  it('control reset：清空 lilith_chat 会话', async () => {
    await request('POST', '/v1/session/lilith/message', { message: '待清空的测试消息' }, token)
    expect(store.get(LILITH_SESSION_ID)?.messages.length).toBe(2)
    const r = await request('POST', '/v1/control', { action: 'reset_session', session_id: LILITH_SESSION_ID }, token)
    expect(r.status).toBe(200)
    expect(r.json.ok).toBe(true)
    // reset 语义 = 会话被删除（下次 message 时 getOrCreate 重建空会话）
    expect(store.get(LILITH_SESSION_ID)).toBeNull()
  })

  it('control reload：返回 ok（协议兼容）', async () => {
    const r = await request('POST', '/v1/control', { action: 'reload' }, token)
    expect(r.status).toBe(200)
    expect(r.json.ok).toBe(true)
    expect(r.json.reloaded).toBe(true)
  })

  it('message 空消息 → 400', async () => {
    const r = await request('POST', '/v1/session/lilith/message', { message: '   ' }, token)
    expect(r.status).toBe(400)
  })

  it('message 超长（>2000 字符）→ 400', async () => {
    const r = await request('POST', '/v1/session/lilith/message', { message: '长'.repeat(2001) }, token)
    expect(r.status).toBe(400)
  })

  it('message 系统注入/激活事件 → 拦截：不调 LLM、不写会话，返回明确占位', async () => {
    const injected =
      '【系统注入：本条为系统激活消息，非用户真实发言，请优先响应并明确其来源】\n' +
      '【激活事件】以下事件需要你自主判断是否响应：\n' +
      '[external] 【外部事件】【健康检查】工作区代码自检发现 test 失败'
    const r = await request('POST', '/v1/session/lilith/message', { message: injected }, token)
    expect(r.status).toBe(200)
    expect(r.json.status).toBe('ok')
    // 未配置 onSystemInjected 时返回明确占位（不静默吞掉，让调用方知道消息未进莉莉丝）
    expect(r.json.text).toContain('系统消息已拦截')
    // 会话未被写入（系统消息不得污染莉莉丝上下文/记忆）
    const session = store.get(LILITH_SESSION_ID)
    expect(session?.messages.length ?? 0).toBe(0)
  })

  it('message 系统注入 + onSystemInjected → 转交月蚀处理并原样返回（不吞），不写莉莉丝会话', async () => {
    // 覆盖配置了转发回调的场景：必须把消息交给回调（月蚀），返回其回复而非占位
    const forwarded: string[] = []
    const adapter2 = new LilithAdapter({
      port: 0,
      dataRoot,
      appDataDir,
      sessionStore: store,
      getLlmClient: () => adapterLlm as never,
      onSystemInjected: async (message) => {
        forwarded.push(message)
        return `（月蚀处理结果）已定位并修复 test 失败`
      }
    })
    const p2 = await adapter2.start()
    const rt2 = JSON.parse(readFileSync(join(appDataDir, 'LilithAI', 'runtime.json'), 'utf8'))
    try {
      const injected = '【系统注入：本条为系统激活消息，非用户真实发言】\n【健康检查】test 全量 0 test'
      const r = await new Promise<{ status: number; json: TestApiJson }>((resolve, reject) => {
        const payload = JSON.stringify({ message: injected })
        const req = http.request(
          {
            host: '127.0.0.1',
            port: p2,
            path: '/v1/session/lilith/message',
            method: 'POST',
            headers: {
              Authorization: `Bearer ${rt2.token}`,
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(payload)
            }
          },
          (res) => {
            let raw = ''
            res.on('data', (c) => { raw += c })
            res.on('end', () => resolve({ status: res.statusCode ?? 502, json: JSON.parse(raw || '{}') }))
          }
        )
        req.on('error', reject)
        req.write(payload)
        req.end()
      })
      expect(r.status).toBe(200)
      expect(r.json.status).toBe('ok')
      // 消息真正到达转交目标（月蚀），返回月蚀处理回复——不吞
      expect(forwarded).toHaveLength(1)
      expect(forwarded[0]).toBe(injected)
      expect(r.json.text).toContain('月蚀处理结果')
      // 莉莉丝会话仍未被写入
      const session = store.get(LILITH_SESSION_ID)
      expect(session?.messages.length ?? 0).toBe(0)
    } finally {
      await adapter2.stop()
    }
  })

  it('未知路径 → 404', async () => {
    const r = await request('GET', '/v1/unknown', undefined, token)
    expect(r.status).toBe(404)
  })

  it('runtime.json 写入正确格式（LilithMod 读它找端口+token）', () => {
    const rt = JSON.parse(readFileSync(join(appDataDir, 'LilithAI', 'runtime.json'), 'utf8'))
    expect(rt.protocol_version).toBe(1)
    expect(typeof rt.pid).toBe('number')
    expect(rt.host).toBe('127.0.0.1')
    expect(rt.port).toBe(port)
    expect(typeof rt.token).toBe('string')
    expect(rt.token.length).toBeGreaterThanOrEqual(32)
  })
})

describe('buildLilithPersona', () => {
  it('null 人设 → 默认人设', () => {
    const p = buildLilithPersona(null)
    expect(p).toContain('莉莉丝')
  })

  it('完整人设 → 注入身份/共同经历/语气/格式约束', () => {
    const character = {
      canon: {
        identity: ['莉莉丝是一个 tulpa'],
        shared_lore: ['玩家是莉莉丝的宿主'],
        relationship: ['关系亲近']
      },
      voice: {
        traits: ['温柔、好奇'],
        cadence: ['日常语气自然'],
        avoid: ['不要自称 AI']
      }
    }
    const p = buildLilithPersona(character)
    expect(p).toContain('tulpa')
    expect(p).toContain('宿主')
    expect(p).toContain('温柔')
    expect(p).toContain('[emotion:')
    expect(p).toContain('[animation:')
    expect(p).toContain('happy / sad')
  })
})

describe('parseLilithReply', () => {
  it('解析情感/动画标记并剥离', () => {
    const r = parseLilithReply('你好呀，宿主\n[emotion: happy] [animation: smile]')
    expect(r.text).toBe('你好呀，宿主')
    expect(r.emotion).toBe('happy')
    expect(r.animation).toBe('smile')
  })

  it('无标记 → 默认 neutral/idle', () => {
    const r = parseLilithReply('随便说点什么')
    expect(r.text).toBe('随便说点什么')
    expect(r.emotion).toBe('neutral')
    expect(r.animation).toBe('idle')
  })

  it('非法枚举 → 回退默认', () => {
    const r = parseLilithReply('测试\n[emotion: furious] [animation: dance]')
    expect(r.emotion).toBe('neutral')
    expect(r.animation).toBe('idle')
  })

  it('大小写不敏感', () => {
    const r = parseLilithReply('测试\n[EMOTION: HAPPY] [ANIMATION: THINK]')
    expect(r.emotion).toBe('happy')
    expect(r.animation).toBe('think')
  })

  it('memory 标记剥离（不污染正文）', () => {
    const r = parseLilithReply('好的，记住了\n[emotion: happy] [animation: smile]\n[memory: 喜欢的食物=草莓蛋糕]')
    expect(r.text).not.toContain('memory')
    expect(r.emotion).toBe('happy')
  })
})

describe('Lore 知识库（莉莉丝原作记忆）', () => {
  /** 构造独立 lore 数据（与真实索引解耦：测试数据自包含，改真实 lore 文件不挂测试） */
  function makeFakeLore() {
    return {
      canon_context: '测试世界：月蚀大陆。',
      entries: [
        {
          id: 'strawberry-cake',
          title: '草莓蛋糕',
          aliases: ['草莓蛋糕', '蛋糕'],
          keywords: ['蛋糕', '奶油'],
          summary: '玩家与莉莉丝第一次一起做的甜品',
          facts: ['玩家选了草莓口味'],
          priority: 2
        },
        {
          id: 'silver-forest',
          title: '银葱之森',
          aliases: ['银葱森林', '森林'],
          keywords: ['树林', '精灵'],
          summary: '莉莉丝小时候长大的地方',
          facts: ['有一棵银色的大树'],
          priority: 1
        },
        {
          id: 'frostmourne',
          title: '霜之哀伤',
          aliases: ['霜之哀伤', '哀伤之剑'],
          keywords: ['剑', '冰'],
          summary: '剧情关键物品',
          facts: ['只有特定场合会被提起'],
          priority: 0
        }
      ]
    }
  }

  it('loadLore：加载真实 lore 文件（非空）', () => {
    const lore = loadLore(LORE_PATH)
    expect(lore.entries.length).toBeGreaterThan(0)
    expect(lore.canon_context.length).toBeGreaterThan(0)
  })

  it('loadLore：损坏的 JSON / 非 JSON 内容按空库处理，不抛错', () => {
    // T8 code-review 补测：普通会话/桌宠每次都在提示词组装路径上调用 loadLore，
    // 索引文件损坏必须降级为空库而不是中断对话。
    const tmpLore = join(mkdtempSync(join(tmpdir(), 'lilith-lore-')), 'index.json')
    writeFileSync(tmpLore, '{ this is not valid json !!', 'utf-8')
    expect(() => loadLore(tmpLore)).not.toThrow()
    const lore = loadLore(tmpLore)
    expect(lore.entries).toEqual([])
    expect(lore.canon_context).toBe('')
    rmSync(join(tmpLore, '..'), { recursive: true, force: true })
  })

  it('loadLore：索引文件不存在按空库处理，不抛错', () => {
    const missing = join(mkdtempSync(join(tmpdir(), 'lilith-lore-')), 'no-such.json')
    expect(() => loadLore(missing)).not.toThrow()
    const lore = loadLore(missing)
    expect(lore.entries).toEqual([])
    expect(lore.canon_context).toBe('')
    rmSync(join(missing, '..'), { recursive: true, force: true })
  })

  it('retrieveLore：命中关键词的条目被召回（含 aliases 命中）', () => {
    const lore = makeFakeLore()
    const hits = retrieveLore('莉莉丝，你还记得第一次一起做草莓蛋糕的事吗？', lore)
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.find((h) => h.id === 'strawberry-cake')).toBeTruthy()
    expect(hits.find((h) => h.id === 'frostmourne')).toBeUndefined()
  })

  it('retrieveLore：消息命中多个条目时按得分降序并截断（maxEntries）', () => {
    const lore = makeFakeLore()
    // “草莓蛋糕”同时命中 cake 的 aliases(完整包含) + title(反向包含) → 得分最高排最前
    const hits = retrieveLore('草莓蛋糕和银葱之森，还有霜之哀伤', lore)
    expect(hits.length).toBe(3)
    expect(hits[0].id).toBe('strawberry-cake')
    // 截断
    const capped = retrieveLore('草莓蛋糕和银葱之森，还有霜之哀伤', lore, 2)
    expect(capped.length).toBe(2)
    expect(capped[0].id).toBe('strawberry-cake')
  })

  it('retrieveLore：无关消息不命中（不强行塞知识库）', () => {
    const lore = makeFakeLore()
    const hits = retrieveLore('今天下午去超市买点东西', lore)
    expect(hits.length).toBe(0)
  })

  it('retrieveLore：空消息/空库返回空数组', () => {
    const lore = makeFakeLore()
    expect(retrieveLore('', lore)).toEqual([])
    expect(retrieveLore('   ', lore)).toEqual([])
    expect(retrieveLore('草莓蛋糕', { canon_context: '', entries: [] })).toEqual([])
  })

  it('formatLoreContext：格式化注入文本（标题 + 摘要 + facts 列表）', () => {
    const lore = makeFakeLore()
    const [hit] = retrieveLore('草莓蛋糕', lore)
    const ctx = formatLoreContext([hit])
    expect(ctx).toContain('原作记忆')
    expect(ctx).toContain('草莓蛋糕')
    expect(ctx).toContain('玩家与莉莉丝第一次一起做的甜品')
    expect(ctx).toContain('玩家选了草莓口味')
  })

  it('formatLoreContext：无命中返回空串（不注入空段落）', () => {
    expect(formatLoreContext([])).toBe('')
  })
})

describe('玩家长期记忆（跨会话沉淀）', () => {
  let tmp: string
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'lilith-mem-'))
  })
  afterEach(() => {
    try { rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  it('applyMemoryUpdates：写入玩家事实，readPlayerMemory 读回', () => {
    const appDataDir = join(tmp, 'appdata')
    const saved = applyMemoryUpdates(appDataDir, 'Player', [
      { key: '喜欢的食物', value: '草莓蛋糕' },
      { key: '重要日子', value: '初遇纪念日' }
    ])
    expect(saved).toBe(2)
    const facts = readPlayerMemory(appDataDir, 'Player')
    expect(facts.length).toBe(2)
    expect(facts.some((f) => f.key === '喜欢的食物' && f.value === '草莓蛋糕')).toBe(true)
  })

  it('applyMemoryUpdates：无效更新被忽略', () => {
    const appDataDir = join(tmp, 'appdata')
    const saved = applyMemoryUpdates(appDataDir, 'Player', [
      { key: '', value: 'x' },
      { key: 'ok', value: 'valid' }
    ])
    expect(saved).toBe(1)
    const facts = readPlayerMemory(appDataDir, 'Player')
    expect(facts.length).toBe(1)
    expect(facts[0].key).toBe('ok')
  })

  it('applyMemoryUpdates：同 key 覆盖旧值', () => {
    const appDataDir = join(tmp, 'appdata')
    applyMemoryUpdates(appDataDir, 'Player', [{ key: '喜欢的食物', value: '草莓蛋糕' }])
    applyMemoryUpdates(appDataDir, 'Player', [{ key: '喜欢的食物', value: '巧克力蛋糕' }])
    const facts = readPlayerMemory(appDataDir, 'Player')
    expect(facts.length).toBe(1)
    expect(facts[0].value).toBe('巧克力蛋糕')
  })
})

describe('defaultGenerateReply 两段式装配（与主链路 generateLilithReply 同构）', () => {
  let tmp: string
  let dataRoot: string
  let appDataDir: string
  let store: SessionStore
  let capturedMessages: Array<{ role: string; content: string }> = []

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'lilith-two-phase-'))
    dataRoot = join(tmp, 'data')
    appDataDir = join(tmp, 'appdata')
    // 状态文件隔离到临时目录（防止测试写入真实用户 APPDATA）
    __setLilithInternalStateFileForTest(join(tmp, 'lilith-internal.json'))
    // 预置 lore 知识库（canon_context + 一条可命中的 entry）
    const loreDir = join(dataRoot, 'frontend', 'character', 'lore')
    mkdirSync(loreDir, { recursive: true })
    writeFileSync(join(loreDir, 'index.json'), JSON.stringify({
      canon_context: '银葱之森是莉莉丝与玩家共同守护的世界。',
      entries: [
        {
          id: 'strawberry-cake',
          title: '草莓蛋糕',
          keywords: ['草莓蛋糕', '蛋糕'],
          summary: '玩家与莉莉丝第一次一起做的甜品',
          facts: ['玩家选了草莓口味', '莉莉丝学会了打发奶油']
        }
      ]
    }))
    // 预置玩家长期记忆
    mkdirSync(join(appDataDir, 'LilithAI', 'players'), { recursive: true })
    writeFileSync(playerMemoryPath(appDataDir, 'Player'), JSON.stringify({
      facts: [{ key: '喜欢的食物', value: '草莓蛋糕' }]
    }))
    store = makeSessionStore()
    capturedMessages = []
  })

  afterEach(() => {
    __setLilithInternalStateFileForTest()
    try { rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  /** 构造使用默认回复生成器（不走注入 generateReply）的 adapter，并捕获送入 LLM 的消息序列 */
  function makeDefaultAdapter(overrides: { getEnvText?: () => string } = {}) {
    const llm = {
      isReady: () => true,
      chatWithTools: async (messages: never) => {
        capturedMessages = messages as Array<{ role: string; content: string }>
        return {
          content: '记得呀，我们一起做的草莓蛋糕~[emotion: happy] [animation: smile]',
          toolCalls: [],
          finishReason: 'stop'
        }
      }
    }
    const adapter = new LilithAdapter({
      port: 0,
      dataRoot,
      appDataDir,
      sessionStore: store,
      getLlmClient: () => llm as never,
      // 不传 generateReply → 走 defaultGenerateReply；getEnvText 可选注入（与主链路同构）
      getEnvText: overrides.getEnvText
    })
    return adapter
  }

  it('两段式装配：prefix(人设/总纲/输出要求) → 历史 → suffix(lore/记忆) → 本轮消息，顺序正确', async () => {
    const adapter = makeDefaultAdapter()
    // 历史 25 条（超出 RECENT_KEEP=20，验证只保留最近 20 条原文）
    const history: ChatMessage[] = Array.from({ length: 25 }, (_, i) => ({
      id: `m${i}`,
      role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
      content: `历史消息${i}`,
      createdAt: 1000 + i
    }))

    const fn = (
      adapter as unknown as {
        defaultGenerateReply: (
          message: string,
          playerName: string,
          history: ChatMessage[],
          character: Record<string, unknown> | null,
          sessionId: string
        ) => Promise<{ text: string; emotion: string; animation: string }>
      }
    ).defaultGenerateReply

    const reply = await fn.call(adapter, '你还记得草莓蛋糕吗？', 'Player', history, null, LILITH_SESSION_ID)

    // 协议零回归：解析后的文本/情感/动画
    expect(reply.text).toContain('草莓蛋糕')
    expect(reply.emotion).toBe('happy')
    expect(reply.animation).toBe('smile')

    // 装配结构：首个消息 = prefix 稳定段（人设 + 原作总纲 + 输出要求）
    const first = capturedMessages[0]
    expect(first.role).toBe('system')
    expect(first.content).toContain('莉莉丝')
    expect(first.content).toContain('原作总纲')
    expect(first.content).toContain('银葱之森')
    expect(first.content).toContain('## 输出要求')
    expect(first.content).toContain('[emotion:')
    // prefix 是稳定段：输出协议/人设必须在历史之前
    const prefixIndex = capturedMessages.findIndex((m) => m.role === 'system' && m.content.includes('## 输出要求'))
    expect(prefixIndex).toBe(0)

    // 历史：仅最近 20 条原文，位于 prefix 之后
    const historyStart = capturedMessages.findIndex((m) => m.content === '历史消息5')
    const historyEnd = capturedMessages.findIndex((m) => m.content === '历史消息24')
    expect(historyStart).toBeGreaterThan(0)
    expect(historyEnd).toBeGreaterThan(historyStart)
    expect(historyEnd).toBeLessThan(capturedMessages.length - 2)
    // 最早 5 条（0-4）已被截断（RECENT_KEEP=20）
    expect(capturedMessages.some((m) => m.content === '历史消息0')).toBe(false)

    // suffix 动态段：检索命中的 lore + 玩家长期记忆，位于历史之后、本轮消息之前
    const suffixIndex = capturedMessages.findIndex(
      (m) => m.role === 'system' && m.content.includes('原作记忆')
    )
    expect(suffixIndex).toBeGreaterThan(historyEnd)
    expect(capturedMessages[suffixIndex].content).toContain('草莓蛋糕')
    expect(capturedMessages[suffixIndex].content).toContain('Player')
    expect(capturedMessages[suffixIndex].content).toContain('喜欢的食物')

    // 最后一条 = 本轮玩家消息
    const last = capturedMessages[capturedMessages.length - 1]
    expect(last.role).toBe('user')
    expect(last.content).toBe('你还记得草莓蛋糕吗？')

    // 完整顺序：prefix < 历史 < suffix < user
    expect(prefixIndex).toBeLessThan(historyStart)
    expect(historyEnd).toBeLessThan(suffixIndex)
    expect(suffixIndex).toBeLessThan(capturedMessages.length - 1)
  })

  it('短会话（≤RECENT_KEEP）无摘要时不注入摘要锚点，保持纯原文零回归', async () => {
    const adapter = makeDefaultAdapter()
    const fn = (adapter as unknown as {
      defaultGenerateReply: (
        message: string,
        playerName: string,
        history: ChatMessage[],
        character: Record<string, unknown> | null,
        sessionId: string
      ) => Promise<{ text: string; emotion: string; animation: string }>
    }).defaultGenerateReply

    const history: ChatMessage[] = Array.from({ length: 3 }, (_, i) => ({
      id: `m${i}`,
      role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
      content: `短会话${i}`,
      createdAt: 1000 + i
    }))

    await fn.call(adapter, '你好', 'Player', history, null, LILITH_SESSION_ID)

    // 短会话无摘要 → 不出现【内部会话】摘要锚点（buildLilithSummaryAnchor 返回 null → 省略）
    const summaryAnchor = capturedMessages.find((m) => m.content.includes('【内部会话】'))
    expect(summaryAnchor).toBeUndefined()
  })

  it('配置 getEnvText 时：suffix 动态段注入「当前环境」（地址+天气，与主链路同构），置于历史之后', async () => {
    const adapter = makeDefaultAdapter({
      getEnvText: () =>
        `## 当前日期：2026-09-24 星期四\n- 时区：Asia/Shanghai\n- 地点（系统定位）：中国 测试省 测试市 测试街道（坐标 0.0000, 0.0000，精度 ±50m），天气：多云 6.2°C，风速 7.8 km/h`
    })
    const fn = (adapter as unknown as {
      defaultGenerateReply: (
        message: string,
        playerName: string,
        history: ChatMessage[],
        character: Record<string, unknown> | null,
        sessionId: string
      ) => Promise<{ text: string; emotion: string; animation: string }>
    }).defaultGenerateReply

    const history: ChatMessage[] = Array.from({ length: 3 }, (_, i) => ({
      id: `m${i}`,
      role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
      content: `短会话${i}`,
      createdAt: 1000 + i
    }))

    await fn.call(adapter, '我们现在在哪里？', 'Player', history, null, LILITH_SESSION_ID)

    // 环境注入落在 suffix（历史之后、本轮消息之前），与主链路 generateLilithReply 同构
    const env = capturedMessages.find((m) => m.role === 'system' && m.content.includes('当前环境'))
    expect(env).toBeTruthy()
    expect(env!.content).toContain('地点（系统定位）')
    expect(env!.content).toContain('测试市 测试街道')
    expect(env!.content).toContain('多云 6.2°C')
    expect(env!.content).toContain('风速 7.8 km/h')

    const envIndex = capturedMessages.indexOf(env!)
    const userIndex = capturedMessages.findIndex((m) => m.role === 'user' && m.content === '我们现在在哪里？')
    const lastHistoryIndex = capturedMessages.findIndex((m) => m.content === '短会话2')
    expect(envIndex).toBeGreaterThan(lastHistoryIndex)
    expect(envIndex).toBeLessThan(userIndex)
  })

  it('未配置 getEnvText 时：不注入「当前环境」（零回归）', async () => {
    const adapter = makeDefaultAdapter()
    const fn = (adapter as unknown as {
      defaultGenerateReply: (
        message: string,
        playerName: string,
        history: ChatMessage[],
        character: Record<string, unknown> | null,
        sessionId: string
      ) => Promise<{ text: string; emotion: string; animation: string }>
    }).defaultGenerateReply

    const history: ChatMessage[] = Array.from({ length: 2 }, (_, i) => ({
      id: `m${i}`,
      role: 'user' as const,
      content: `问题${i}`,
      createdAt: 1000 + i
    }))

    await fn.call(adapter, '你好', 'Player', history, null, LILITH_SESSION_ID)
    const env = capturedMessages.find((m) => m.role === 'system' && m.content.includes('当前环境'))
    expect(env).toBeUndefined()
  })
})
