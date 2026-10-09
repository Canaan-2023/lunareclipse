import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'os'
import { join } from 'path'
import { createHash } from 'crypto'
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'fs'
import {
  LILITH_RECENT_KEEP,
  LILITH_SUMMARY_MAX_CHARS,
  generateLilithSummaryUpdate,
  buildLilithSummaryAnchor,
  buildLilithCacheIndexAnchor,
  resolveLilithInternalState,
  maintainLilithInternalSession,
  addLilithCacheLocation,
  lilithPlayerMemoryPath,
  lilithLoreIndexPath,
  __setLilithInternalStateFileForTest
} from '../electron/main/services/lilith-internal-session'

/**
 * 莉莉丝内部会话服务回归：
 * 1) 状态解析 —— 缺失→新建绑定指纹、指纹不符→会话切换重置、损坏→重置；
 * 2) 锚点构建 —— 无摘要/无缓存→null（原文零回归）、有则输出 system 段；
 * 3) 增量摘要 —— 多轮段拼接、失败=null=旧摘要保持、输出按上限截断；
 * 4) 维护 —— 切换重置、同文件清空重置、短会话跳过（游标不推进）、
 *             增量摘要推进游标、pendingCache 落盘；
 * 5) 缓存路径 —— 玩家记忆/lore 索引与插件工具同源。
 */
const TEST_DIR = join(tmpdir(), `lilith-internal-test-${process.pid}-${Date.now()}`)
const STATE_FILE = join(TEST_DIR, 'lilith-internal.json')

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true })
  __setLilithInternalStateFileForTest(STATE_FILE)
})

afterEach(() => {
  __setLilithInternalStateFileForTest()
  rmSync(TEST_DIR, { recursive: true, force: true })
})

function history(n: number, prefix = 'u'): Array<{ role: string; content: string }> {
  const arr: Array<{ role: string; content: string }> = []
  for (let i = 0; i < n; i++) {
    arr.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: `${prefix}${i}` })
  }
  return arr
}

describe('resolveLilithInternalState 会话切换检测', () => {
  it('状态缺失 → 新建空状态并绑定当前指纹', () => {
    const { state, switched } = resolveLilithInternalState('/x/abc123.json')
    expect(switched).toBe(true)
    expect(state.sourceFile).toBe('abc123.json')
    expect(state.summary).toBe('')
    expect(state.cursor).toBe(0)
    expect(state.cacheLocations).toEqual([])
  })

  it('指纹与状态一致 → 直接复用（switched=false）', async () => {
    await maintainLilithInternalSession({
      chat: vi.fn().mockResolvedValue(JSON.stringify({ summary: 's' })),
      activeFile: '/x/a.json',
      history: history(LILITH_RECENT_KEEP + 4)
    })
    // 状态已写入 sourceFile=a.json（history 超窗口 → 摘要已生成）
    const { state, switched } = resolveLilithInternalState('/x/a.json')
    expect(switched).toBe(false)
    expect(state.sourceFile).toBe('a.json')
  })

  it('指纹变化（LilithMod 清空/重开会话 → 新哈希文件）→ 重置为新会话', async () => {
    // 先建一个 bound 在 a.json 的状态
    await maintainLilithInternalSession({
      chat: vi.fn().mockResolvedValue(JSON.stringify({ summary: '旧会话摘要' })),
      activeFile: '/x/a.json',
      history: history(LILITH_RECENT_KEEP + 4)
    })
    const { state, switched } = resolveLilithInternalState('/x/ffffffff.json')
    expect(switched).toBe(true)
    expect(state.sourceFile).toBe('ffffffff.json')
    expect(state.summary).toBe('')
  })

  it('状态文件损坏 → 重置为绑定当前指纹的新状态', () => {
    writeFileSync(STATE_FILE, '{ not json', 'utf8')
    const { state, switched } = resolveLilithInternalState('/x/b.json')
    expect(switched).toBe(true)
    expect(state.sourceFile).toBe('b.json')
  })
})

describe('锚点构建', () => {
  it('无摘要 → 摘要锚点 null（短会话原文零回归）', () => {
    const { state } = resolveLilithInternalState('/x/c.json')
    expect(buildLilithSummaryAnchor(state)).toBeNull()
    expect(buildLilithCacheIndexAnchor(state)).toBeNull()
  })

  it('有摘要 → 输出 system 锚点（含标题/创建/摘要）', () => {
    const { state } = resolveLilithInternalState('/x/c.json')
    state.summary = '玩家爱吃草莓蛋糕'
    state.title = '日常'
    state.createdAt = 1725000000000
    const anchor = buildLilithSummaryAnchor(state)
    expect(anchor).not.toBeNull()
    expect(anchor?.role).toBe('system')
    expect(anchor?.content).toContain('【会话摘要】玩家爱吃草莓蛋糕')
    expect(anchor?.content).toContain('日常')
  })

  it('有缓存位置 → 输出缓存索引锚点', () => {
    const { state } = resolveLilithInternalState('/x/c.json')
    addLilithCacheLocation(state, 'memory/players/hash.json')
    const anchor = buildLilithCacheIndexAnchor(state)
    expect(anchor?.content).toContain('【记忆缓存位置】')
    expect(anchor?.content).toContain('memory/players/hash.json')
  })

  it('缓存位置去重', () => {
    const { state } = resolveLilithInternalState('/x/c.json')
    expect(addLilithCacheLocation(state, '/a/b.json')).toBe(true)
    expect(addLilithCacheLocation(state, '/a/b.json')).toBe(false)
    expect(state.cacheLocations).toEqual(['/a/b.json'])
    expect(addLilithCacheLocation(state, '')).toBe(false)
  })
})

describe('generateLilithSummaryUpdate 莉莉丝增量摘要', () => {
  it('LLM 返回 JSON → 新摘要；输入含多轮段拼接', async () => {
    const chat = vi.fn().mockResolvedValue(JSON.stringify({ summary: '玩家喜欢咖啡' }))
    const out = await generateLilithSummaryUpdate(chat, {
      oldSummary: '',
      segment: [
        { role: 'user', content: '我喜欢咖啡' },
        { role: 'assistant', content: '记住了' },
        { role: 'user', content: '还有甜点' }
      ],
      createdAt: 1725000000000
    })
    expect(out?.summary).toBe('玩家喜欢咖啡')
    expect(chat).toHaveBeenCalledTimes(1)
    const user = chat.mock.calls[0][0][1].content
    expect(user).toContain('我喜欢咖啡')
    expect(user).toContain('记住了')
    expect(user).toContain('还有甜点') // 多轮段全部上送
    const sys = chat.mock.calls[0][0][0].content
    expect(sys).toContain(String(LILITH_SUMMARY_MAX_CHARS))
  })

  it('LLM 返回 JSON 含 title → 透传新标题（与月蚀继承摘要同构）', async () => {
    const chat = vi.fn().mockResolvedValue(JSON.stringify({ summary: '玩家喜欢咖啡', title: '咖啡之约' }))
    const out = await generateLilithSummaryUpdate(chat, {
      oldSummary: '',
      segment: [{ role: 'user', content: '我喜欢咖啡' }],
      createdAt: 1725000000000
    })
    expect(out?.summary).toBe('玩家喜欢咖啡')
    expect(out?.title).toBe('咖啡之约')
  })

  it('LLM 返回 title 为空白串 → 标题缺省（沿用原标题）', async () => {
    const chat = vi.fn().mockResolvedValue(JSON.stringify({ summary: 's', title: '  ' }))
    const out = await generateLilithSummaryUpdate(chat, {
      oldSummary: '', segment: [{ role: 'user', content: 'x' }], createdAt: 1
    })
    expect(out?.summary).toBe('s')
    expect(out?.title).toBeUndefined()
  })

  it('LLM 返回 title 非字符串 → 本次摘要作废（校验失败 = 旧状态保持）', async () => {
    const chat = vi.fn().mockResolvedValue(JSON.stringify({ summary: 's', title: 42 }))
    const out = await generateLilithSummaryUpdate(chat, {
      oldSummary: '', segment: [{ role: 'user', content: 'x' }], createdAt: 1
    })
    expect(out).toBeNull()
  })

  it('LLM 抛错 → null（本次未执行，旧摘要保持）', async () => {
    const chat = vi.fn().mockRejectedValue(new Error('boom'))
    const out = await generateLilithSummaryUpdate(chat, {
      oldSummary: '旧', segment: [{ role: 'user', content: 'x' }], createdAt: 1
    })
    expect(out).toBeNull()
  })

  it('解析失败 / 空摘要 → null', async () => {
    const chat = vi.fn().mockResolvedValue('不是 JSON')
    const out = await generateLilithSummaryUpdate(chat, {
      oldSummary: '', segment: [{ role: 'user', content: 'x' }], createdAt: 1
    })
    expect(out).toBeNull()
    const chat2 = vi.fn().mockResolvedValue(JSON.stringify({ summary: '  ' }))
    const out2 = await generateLilithSummaryUpdate(chat2, {
      oldSummary: '', segment: [{ role: 'user', content: 'x' }], createdAt: 1
    })
    expect(out2).toBeNull()
  })

  it('输出超过 summaryMaxChars → 截断', async () => {
    const chat = vi.fn().mockResolvedValue(JSON.stringify({ summary: '啊'.repeat(500), title: '超长标题'.repeat(20) }))
    const out = await generateLilithSummaryUpdate(chat, {
      oldSummary: '', segment: [{ role: 'user', content: 'x' }], createdAt: 1
    })
    expect(out?.summary?.length).toBe(LILITH_SUMMARY_MAX_CHARS)
    expect(out?.title?.length).toBe(30) // 与月蚀 title 截断上限一致
  })

  it('增量模式：旧摘要传入 + 新增段 → 提示词含旧摘要与新增段', async () => {
    const chat = vi.fn().mockResolvedValue(JSON.stringify({ summary: '合并后的摘要' }))
    const out = await generateLilithSummaryUpdate(chat, {
      oldSummary: '旧摘要内容',
      segment: [{ role: 'user', content: '新消息' }],
      createdAt: 1725000000000
    })
    expect(out?.summary).toBe('合并后的摘要')
    const user = chat.mock.calls[0][0][1].content
    expect(user).toContain('旧摘要内容')
    expect(user).toContain('新消息')
  })
})

describe('maintainLilithInternalSession 维护', () => {
  it('会话切换：写入绑定新指纹的空状态（不继承旧摘要）', async () => {
    // 先在 a.json 生成摘要
    await maintainLilithInternalSession({
      chat: vi.fn().mockResolvedValue(JSON.stringify({ summary: '旧会话摘要' })),
      activeFile: '/x/a.json',
      history: history(LILITH_RECENT_KEEP + 4)
    })
    // 切换 b.json
    const state = await maintainLilithInternalSession({
      chat: vi.fn(),
      activeFile: '/x/b.json',
      history: history(3)
    })
    expect(state.sourceFile).toBe('b.json')
    expect(state.summary).toBe('')
    expect(state.cursor).toBe(0)
    expect(existsSync(STATE_FILE)).toBe(true)
    const onDisk = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
    expect(onDisk.sourceFile).toBe('b.json')
    expect(onDisk.summary).toBe('')
  })

  it('同文件清空（history < cursor）→ 重置派生状态', async () => {
    await maintainLilithInternalSession({
      chat: vi.fn().mockResolvedValue(JSON.stringify({ summary: '旧摘要' })),
      activeFile: '/x/a.json',
      history: history(LILITH_RECENT_KEEP + 4)
    })
    const state = await maintainLilithInternalSession({
      chat: vi.fn(),
      activeFile: '/x/a.json',
      history: [] // 游戏侧同文件清空
    })
    expect(state.summary).toBe('')
    expect(state.cursor).toBe(0)
  })

  it('短会话（≤ RECENT_KEEP 且无旧摘要）→ 跳过摘要，游标不推进', async () => {
    const chat = vi.fn()
    const state = await maintainLilithInternalSession({
      chat,
      activeFile: '/x/a.json',
      history: history(5)
    })
    expect(chat).not.toHaveBeenCalled()
    expect(state.cursor).toBe(0)
    expect(state.summary).toBe('')
  })

  it('历史超过窗口 → 生成首整体摘要并推进游标', async () => {
    const chat = vi.fn().mockResolvedValue(JSON.stringify({ summary: '早期对话摘要' }))
    const state = await maintainLilithInternalSession({
      chat,
      activeFile: '/x/a.json',
      history: history(LILITH_RECENT_KEEP + 4)
    })
    expect(chat).toHaveBeenCalledTimes(1)
    expect(state.summary).toBe('早期对话摘要')
    expect(state.cursor).toBe(LILITH_RECENT_KEEP + 4)
    // 落盘
    const onDisk = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
    expect(onDisk.summary).toBe('早期对话摘要')
    expect(onDisk.cursor).toBe(LILITH_RECENT_KEEP + 4)
  })

  it('有旧摘要后新增对话 → 增量摘要（段 = 游标后）', async () => {
    const chat = vi
      .fn()
      .mockResolvedValueOnce(JSON.stringify({ summary: '首摘要' }))
      .mockResolvedValueOnce(JSON.stringify({ summary: '增量后摘要' }))
    await maintainLilithInternalSession({
      chat,
      activeFile: '/x/a.json',
      history: history(LILITH_RECENT_KEEP + 4)
    })
    await maintainLilithInternalSession({
      chat,
      activeFile: '/x/a.json',
      history: history(LILITH_RECENT_KEEP + 6)
    })
    expect(chat).toHaveBeenCalledTimes(2)
    // 第二次：段只含游标后的 2 条（不含前面已摘要的）
    const secondUser = chat.mock.calls[1][0][1].content
    expect(secondUser).toContain('【旧摘要】首摘要')
  })

  it('摘要失败 → 旧摘要/旧游标保持（仅缓存落盘）', async () => {
    // 先成功一次
    const chat = vi
      .fn()
      .mockResolvedValueOnce(JSON.stringify({ summary: '首摘要' }))
      .mockRejectedValueOnce(new Error('llm down'))
    await maintainLilithInternalSession({
      chat,
      activeFile: '/x/a.json',
      history: history(LILITH_RECENT_KEEP + 4)
    })
    const state = await maintainLilithInternalSession({
      chat,
      activeFile: '/x/a.json',
      history: history(LILITH_RECENT_KEEP + 6),
      pendingCacheLocations: ['/cache/players/hash.json']
    })
    expect(state.summary).toBe('首摘要')
    expect(state.cursor).toBe(LILITH_RECENT_KEEP + 4) // 未推进
    expect(state.cacheLocations).toContain('/cache/players/hash.json') // 缓存仍落盘
  })

  it('摘要附带 title → 落盘；增量无 title → 原名保持', async () => {
    const chat = vi
      .fn()
      .mockResolvedValueOnce(JSON.stringify({ summary: '首摘要', title: '初遇' }))
      .mockResolvedValueOnce(JSON.stringify({ summary: '增量后摘要' }))
    await maintainLilithInternalSession({
      chat,
      activeFile: '/x/a.json',
      history: history(LILITH_RECENT_KEEP + 4)
    })
    const state = await maintainLilithInternalSession({
      chat,
      activeFile: '/x/a.json',
      history: history(LILITH_RECENT_KEEP + 6)
    })
    expect(chat).toHaveBeenCalledTimes(2)
    expect(state.summary).toBe('增量后摘要')
    expect(state.title).toBe('初遇') // 首个摘要给出新名 → 落盘
    const onDisk = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
    expect(onDisk.title).toBe('初遇') // 增量未给 title → 原名保持
  })

  it('pendingCacheLocations 随维护落盘（历史未增长且无新增段时也落盘）', async () => {
    const chat = vi.fn()
    const state = await maintainLilithInternalSession({
      chat,
      activeFile: '/x/a.json',
      history: history(3),
      pendingCacheLocations: ['/players/p1.json', '/lore/index.json']
    })
    expect(state.cacheLocations).toEqual(['/players/p1.json', '/lore/index.json'])
    const onDisk = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
    expect(onDisk.cacheLocations).toEqual(['/players/p1.json', '/lore/index.json'])
  })
})

describe('缓存路径（与插件工具同源）', () => {
  it('玩家记忆路径 = %APPDATA%/LilithAI/players/{sha256(playerName)}.json', () => {
    // tools.js: createHash('sha256').update(playerName).digest('hex')
    const hash = createHash('sha256').update('Player', 'utf8').digest('hex')
    const expected = join('C:', 'Users', 't', 'AppData', 'Roaming', 'LilithAI', 'players', `${hash}.json`)
    expect(lilithPlayerMemoryPath('C:/Users/t/AppData/Roaming', 'Player')).toBe(expected)
    expect(expected).toContain(hash)
  })

  it('lore 索引路径 = {root}/frontend/character/lore/index.json', () => {
    const expected = join('D:', 'data', 'abyssac_data', 'frontend', 'character', 'lore', 'index.json')
    expect(lilithLoreIndexPath('D:/data/abyssac_data')).toBe(expected)
    expect(expected.endsWith(join('frontend', 'character', 'lore', 'index.json'))).toBe(true)
  })
})

describe('companion 单一真相源约束', () => {
  it('状态文件中不复制消息正文（无 messages 字段；只存摘要/游标/缓存）', async () => {
    await maintainLilithInternalSession({
      chat: vi.fn().mockResolvedValue(JSON.stringify({ summary: '摘要' })),
      activeFile: '/x/a.json',
      history: history(LILITH_RECENT_KEEP + 8)
    })
    const onDisk = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
    expect(onDisk).not.toHaveProperty('messages')
    expect(Object.keys(onDisk).sort()).toEqual(
      ['sourceFile', 'summary', 'cursor', 'cacheLocations', 'title', 'createdAt', 'updatedAt'].sort()
    )
  })
})