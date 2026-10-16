import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { WebSocket } from 'ws'
import express from 'express'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir, networkInterfaces } from 'os'

// ---- mock openai：可控流式/非流式响应 ----
// 第一轮流式调用返回工具调用（Glob），后续轮流返回最终文本；
// 非流式调用（内部会话摘要/蒸馏等）返回固定摘要。
const mockCreate = vi.fn()
vi.mock('openai', () => {
  return {
    default: class MockOpenAI {
      chat = {
        completions: {
          create: mockCreate
        }
      }
    }
  }
})

// ---- mock electron：server.ts 顶层 import { app } 仅莉莉丝路径惰性使用 ----
vi.mock('electron', () => {
  return {
    app: {
      getPath: () => process.cwd(),
      whenReady: () => Promise.resolve(),
      on: () => {}
    }
  }
})

import { startApiServer, closeApiServer, getHeadlessChatRunner, getApiToken, hasReviewPass } from '../electron/main/api/server'
import { isLoopback, isLilithBypassPath, allowLilithBypass } from '../electron/main/api/server-utils'
import { ConfigStore } from '../electron/main/api/config-store'
import { SessionStore } from '../electron/main/api/session-store'
import { UserStore } from '../electron/main/models/user-store'
import { ActivationManager } from '../electron/main/api/activation-manager'
import { buildDataPaths } from '../electron/main/models/paths'
import { setPathContext } from '../electron/main/models/path-context'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** /api/v1 主分系统测试路由：模拟 createMasterRouter 成功装配后返回的 Express 路由（含注册页健康探测端点） */
function makeTestMasterRouter(): express.Router {
  const router = express.Router()
  router.get('/hello', (_req, res) => {
    res.json({ ok: true, appName: 'test-master' })
  })
  return router
}

/** 构造可控 mock 流：chunks 是 OpenAI 流式 chunk 数组（每 chunk 间隔 delayMs，模拟真实流速） */
function makeAsyncIterable(chunks: unknown[], delayMs = 40) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) {
        await new Promise((r) => setTimeout(r, delayMs))
        yield c
      }
    }
  }
}

/** 第一轮流：只发起一次 Glob 工具调用 */
function toolCallRoundChunks(sandboxPath: string): unknown[] {
  return [
    {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'call_glob_1',
                type: 'function',
                function: {
                  name: 'Glob',
                  arguments: JSON.stringify({ pattern: '**/*', path: sandboxPath })
                }
              }
            ]
          }
        }
      ]
    },
    { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    {
      choices: [],
      usage: { prompt_tokens: 20, completion_tokens: 8 }
    }
  ]
}

/** 最终轮流：输出一段正常文本并结束 */
function finalTextRoundChunks(text: string): unknown[] {
  return [
    { choices: [{ index: 0, delta: { content: text } }] },
    { choices: [{ index: 0, delta: {} }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    {
      choices: [],
      usage: { prompt_tokens: 30, completion_tokens: 12 }
    }
  ]
}

/**
 * 中途报错流：先按序吐 chunks，再抛指定错误。
 * 为什么需要：`stream-runner` 的 onError 收口只有「流中途失败」才会被触发，
 * 一次性抛错的 mock（create 直接 throw）走的是同一收口但时序不同，两者都要能造。
 * 作用：模拟「已经开始输出后连接断开/服务端 5xx」这一最常见的真实故障形态。
 */
function throwingAsyncIterable(chunks: unknown[], error: Error, delayMs = 40) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) {
        await new Promise((r) => setTimeout(r, delayMs))
        yield c
      }
      throw error
    }
  }
}

/**
 * 持续吐「空 delta」的流：给「用户中止」测试留出可观测窗口。
 * 为什么需要：llm.ts 的 for-await 循环只在收到下一个 chunk 时才检查 ctrl.signal.aborted，
 * 若流瞬间结束则 abort 到达时请求已收尾，测不到中止分支。
 * 作用：以固定间隔产出无内容 chunk，使 abort 消息能在流运行期间被处理。
 */
function slowEmptyChunks(count = 30): unknown[] {
  return Array.from({ length: count }, () => ({ choices: [{ index: 0, delta: {} }] }))
}

interface TestEnv {
  tmpRoot: string
  port: number
}

/** 组装依赖并启动真实 HTTP/WS server，返回临时根目录与监听端口 */
async function startTestServer(opts?: {
  apiPort?: number
  /** 主分系统：直挂路由（旧签名兼容，见 startApiServer 文档） */
  masterRouter?: import('express').Router
  /** 主分系统：惰性取路由（热升级修复：/api/v1 动态转发，见 server.ts 头注释） */
  getMasterRouter?: () => import('express').Router | null
}): Promise<TestEnv> {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'api-server-test-'))
  const sandbox = join(tmpRoot, 'sandbox')
  mkdirSync(sandbox, { recursive: true })
  writeFileSync(join(sandbox, 'a.txt'), 'hello', 'utf-8')

  // 路径上下文：skills/config/memory 等全部指向临时目录（关键——否则落到 cwd）。
  // 系统强制登录后才可解析分层路径（uid=null 已禁止兜底，见 path-context.ts），
  // 此处用户已 register+login，故注入登录态 uid/aiId。
  setPathContext(tmpRoot, () => 1, () => 1)

  const cfgPath = join(tmpRoot, 'config.json')
  writeFileSync(
    cfgPath,
    JSON.stringify({
      llm: {
        provider: 'openai',
        apiKey: 'test-key',
        model: 'gpt-test',
        temperature: 0.7,
        maxTokens: 2048
      },
      aiMode: 'coding',
      continuousActivation: false,
      lilith: { apiPort: opts?.apiPort ?? 0 }
    }),
    'utf-8'
  )

  const configStore = new ConfigStore(cfgPath)
  const sessionStore = new SessionStore(join(tmpRoot, 'sessions'))
  const userStore = new UserStore(join(tmpRoot, 'users.json'))
  // 注册并登录测试用户：RawMemoryWriter 的 getScope 依赖当前登录态，
  // 无登录态时 raw_memory 写入会因无作用域而失败（见 raw-memory-writer.ts 修复）
  userStore.register('测试用户', 'test-pass')
  userStore.login('测试用户', 'test-pass')
  const activationManager = new ActivationManager(join(tmpRoot, 'activation'))
  const dataPaths = buildDataPaths(tmpRoot)

  const port = await startApiServer(
    configStore,
    sessionStore,
    userStore,
    activationManager,
    {}, // toolCtx：空对象 → geoService/cron/monitor 全部跳过，无网络出站
    dataPaths,
    undefined, // mcpClientManager
    undefined, // pluginLoader
    undefined, // ctx
    undefined, // sharedInternalSessionStore
    opts?.masterRouter,
    opts?.getMasterRouter
  )
  return { tmpRoot, port }
}

describe('api/server.ts 可达测试网（批次 A1）', () => {
  let env: TestEnv | null = null
  const tmpRoots: string[] = []

  afterEach(async () => {
    closeApiServer()
    await sleep(800) // 等待内部 500ms 两写/摘要任务收尾
    for (const root of tmpRoots) {
      try {
        rmSync(root, { recursive: true, force: true })
      } catch {
        /* 清理失败不影响断言 */
      }
    }
  })

  beforeEach(() => {
    mockCreate.mockReset()
  })

  /** 收集 WS 事件直到出现指定 type（含超时保护） */
  function collectUntil(ws: WebSocket, type: string, timeoutMs = 9000): Promise<Array<Record<string, unknown>>> {
    return new Promise((resolveEvent, reject) => {
      const events: Array<Record<string, unknown>> = []
      const timer = setTimeout(() => reject(new Error(`等待 WS 事件超时: ${type}`)), timeoutMs)
      ws.on('message', (data: Buffer) => {
        const evt = JSON.parse(data.toString()) as Record<string, unknown>
        events.push(evt)
        if (evt.type === type) {
          clearTimeout(timer)
          resolveEvent(events)
        }
      })
      ws.on('close', () => {
        clearTimeout(timer)
        reject(new Error('WS 在收到事件前关闭'))
      })
      ws.on('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })
    })
  }

  function openWs(port: number): Promise<WebSocket> {
    return new Promise((res, rej) => {
      // 为什么：server 的 WS 握手现在要求 ?token=<apiToken>（verifyClient），裸连会被 401 拒
      // 作用：把鉴权 token 拼进 URL，建立合法 WS 连接
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${getApiToken()}`)
      ws.on('open', () => res(ws))
      ws.on('error', rej)
    })
  }

  describe('HTTP 端点', () => {
    it('GET /api/health 返回 ok，/api/streams/active 空闲时为 false', async () => {
      env = await startTestServer()
      tmpRoots.push(env.tmpRoot)

      const health = await fetch(`http://127.0.0.1:${env.port}/api/health`).then((r) => r.json())
      expect(health).toEqual({ status: 'ok' })

      const active = await fetch(`http://127.0.0.1:${env.port}/api/streams/active`, {
        headers: { Authorization: `Bearer ${getApiToken()}` }
      }).then((r) => r.json())
      expect(active).toEqual({ active: false })
    })

    it('GET /reports/：无/错 token 401、缺失 404、穿越 400、越权扩展名 403、合法报告 200', async () => {
      env = await startTestServer()
      tmpRoots.push(env.tmpRoot)

      const base = `http://127.0.0.1:${env.port}/reports`
      const token = getApiToken()
      // 1) 无 token / 错 token → 401（浏览器导航必须带 ?token=，防任意网页读本机报告）
      expect((await fetch(`${base}/any.html`)).status).toBe(401)
      expect((await fetch(`${base}/any.html?token=wrong`)).status).toBe(401)
      // 2) 带 token 但文件不存在 → 404
      expect((await fetch(`${base}/nope.html?token=${token}`)).status).toBe(404)
      // 3) 路径穿越 → 400（../、/、\ 一律 fail-fast）
      expect((await fetch(`${base}/..%2F..%2Fpackage.json?token=${token}`)).status).toBe(400)
      expect((await fetch(`${base}/a%2Fb.html?token=${token}`)).status).toBe(400)
      // 4) 扩展名白名单：非 html/htm/md/txt → 403（先写入真实文件，避免不存在先行 404）
      const reportsRoot = join(__dirname, '..', 'reports')
      mkdirSync(reportsRoot, { recursive: true })
      // probe.json 与 report-probe.html 均为探测临时文件，必须随测试清理（漏删会在
      // 工程 reports/ 留下勘察残留——0.14 曾清理过同源残留，此处 finally 一并兜底）
      const blockProbeFile = join(reportsRoot, 'probe.json')
      writeFileSync(blockProbeFile, '{"x":1}', 'utf-8')
      try {
        expect((await fetch(`${base}/probe.json?token=${token}`)).status).toBe(403)
      } finally {
        try {
          rmSync(blockProbeFile, { force: true })
        } catch {
          /* 清理失败不影响断言 */
        }
      }
      // 5) 写入真实报告（工程 reports/，与 server 的 reportsRoot 同一目录）→ 200 且内容/类型正确
      const probeFile = join(reportsRoot, 'report-probe.html')
      writeFileSync(probeFile, '<h1>code-review probe</h1>', 'utf-8')
      try {
        const r = await fetch(`${base}/report-probe.html?token=${token}`)
        expect(r.status).toBe(200)
        expect(await r.text()).toBe('<h1>code-review probe</h1>')
        expect(r.headers.get('content-type') ?? '').toContain('text/html')
      } finally {
        try {
          rmSync(probeFile, { force: true })
        } catch {
          /* 清理失败不影响断言 */
        }
      }
    })
  })

  describe('/api/v1 主分系统端（getMasterRouter 惰性转发：热升级修复回归）', () => {
    it('未传 getMasterRouter/masterRouter → /api/v1 不挂载（404，路由缺失而非服务错误）', async () => {
      env = await startTestServer()
      tmpRoots.push(env.tmpRoot)
      const r = await fetch(`http://127.0.0.1:${env.port}/api/v1/hello`)
      expect(r.status).toBe(404)
    })

    it('getMasterRouter 返回 null（启动即 standalone）→ 503 非主系统（语义化拒绝分系统接入）', async () => {
      env = await startTestServer({ getMasterRouter: () => null })
      tmpRoots.push(env.tmpRoot)
      const r = await fetch(`http://127.0.0.1:${env.port}/api/v1/hello`)
      expect(r.status).toBe(503)
      const body = (await r.json()) as { ok: boolean; error: string }
      expect(body.ok).toBe(false)
      expect(body.error).toBe('非主系统')
    })

    it('运行时注册成为主系统（getMasterRouter 从 null 变为真实路由）→ 同端口立即可用（历史打包版 BUG 回归）', async () => {
      // 模拟真实热升级：启动时 standalone（createMasterRouter 返回 null），用户注册成为主系统后
      // 内存态 router 变为非 null——旧实现 app.use 只在启动时执行一次，升级后 /api/v1 永不挂载；
      // 新实现每次请求动态取 getMasterRouter()，升级即插即用免重启。
      let router: ReturnType<typeof makeTestMasterRouter> | null = null
      env = await startTestServer({ getMasterRouter: () => router })
      tmpRoots.push(env.tmpRoot)

      // 升级前：503
      const before = await fetch(`http://127.0.0.1:${env.port}/api/v1/hello`)
      expect(before.status).toBe(503)

      // 升级：注入路由（等价于 createMasterRouter(userStore) 首次返回非 null）
      router = makeTestMasterRouter()
      const after = await fetch(`http://127.0.0.1:${env.port}/api/v1/hello`)
      expect(after.status).toBe(200)
      const body = (await after.json()) as { ok: boolean; appName: string }
      expect(body.ok).toBe(true)
      expect(body.appName).toBe('test-master')
    })

    it('masterRouter 直挂（旧签名兼容路径）→ /api/v1 直接可用', async () => {
      env = await startTestServer({ masterRouter: makeTestMasterRouter() })
      tmpRoots.push(env.tmpRoot)
      const r = await fetch(`http://127.0.0.1:${env.port}/api/v1/hello`)
      expect(r.status).toBe(200)
    })
  })

  // 2025 安全评审回归：主实例监听 0.0.0.0 时 /api/lilith/* 对局域网任何人免令牌开放。
  // 修复：lilith 桥接面（/api/lilith/* + /chat/completions）仍免令牌（companion 带不了令牌），
  // 但来源必须回环，非回环 403。这里两层验证：纯函数口径（allowLilithBypass）锁定判定，
  // 再起真实 masterRouter（监听 0.0.0.0）证明本机 companion 链路不受影响、非回环来源被拒。
  describe('lilith 桥接面回环拦截（2025 安全评审回归）', () => {
    it('isLilithBypassPath：仅放行 /api/lilith/* 与 /chat/completions', () => {
      expect(isLilithBypassPath('/api/lilith/history')).toBe(true)
      expect(isLilithBypassPath('/api/lilith/clear')).toBe(true)
      expect(isLilithBypassPath('/api/lilith/message')).toBe(true)
      expect(isLilithBypassPath('/api/lilith/status')).toBe(true)
      expect(isLilithBypassPath('/chat/completions')).toBe(true)
      // 相邻但不属于桥接面：不得误放行（精确匹配，防前缀/联想越权）
      expect(isLilithBypassPath('/api/lilithx')).toBe(false)
      expect(isLilithBypassPath('/api/health')).toBe(false)
      expect(isLilithBypassPath('/reports/x.html')).toBe(false)
    })

    it('isLoopback：127.0.0.1 / ::1 / IPv4-mapped IPv6 均为回环', () => {
      expect(isLoopback('127.0.0.1')).toBe(true)
      expect(isLoopback('::1')).toBe(true)
      expect(isLoopback('::ffff:127.0.0.1')).toBe(true)
      // 局域网/公网地址与空地址一律非回环
      expect(isLoopback('192.168.1.23')).toBe(false)
      expect(isLoopback('10.0.0.8')).toBe(false)
      expect(isLoopback('172.16.0.5')).toBe(false)
      expect(isLoopback('100.64.0.1')).toBe(false)
      expect(isLoopback(undefined)).toBe(false)
    })

    it('allowLilithBypass：本机回环放行，局域网来源拒绝（判定单源）', () => {
      // 本机 companion（127.0.0.1）走 lilith 桥接面：放行
      expect(allowLilithBypass('/api/lilith/history', '127.0.0.1')).toBe(true)
      expect(allowLilithBypass('/chat/completions', '::ffff:127.0.0.1')).toBe(true)
      // 局域网设备（主实例监听 0.0.0.0 时可达）：拒绝，即使路径在桥接面内
      expect(allowLilithBypass('/api/lilith/history', '192.168.1.23')).toBe(false)
      expect(allowLilithBypass('/api/lilith/clear', '10.0.0.8')).toBe(false)
      expect(allowLilithBypass('/chat/completions', '192.168.1.23')).toBe(false)
      // 非桥接面路径：无论来源一律不进本判定（由后续 Bearer / reports 分支处理）
      expect(allowLilithBypass('/api/health', '127.0.0.1')).toBe(false)
      expect(allowLilithBypass('/api/v1/hello', '127.0.0.1')).toBe(false)
    })

    it('集成：masterRouter 模式（0.0.0.0）下，本机访问 /api/lilith/status 正常，非回环来源 403', async () => {
      env = await startTestServer({ masterRouter: makeTestMasterRouter() })
      tmpRoots.push(env.tmpRoot)

      // 本机回环来源：免令牌直达（companion 链路不被破坏；启用态不返回 enabled 字段，
      // 以「非 403 + 未做停用声明」即证明放行成功）
      const local = await fetch(`http://127.0.0.1:${env.port}/api/lilith/status`)
      expect(local.status).toBe(200)
      const body = (await local.json()) as { enabled?: boolean; brain_ready?: boolean }
      expect(body.enabled).not.toBe(false)
      expect(body.brain_ready).toBe(true)

      // 非回环来源：取本机局域网 IPv4（Windows 桌面通常有；纯离线环境取不到时跳过集成断言，
      // 判定本身已由上方 allowLilithBypass 纯函数锁定）。模拟"局域网设备访问主实例 0.0.0.0"：
      // 与浏览器跨域不同，socket 层 remoteAddress 是本机 LAN IP → 非回环 → 即使带令牌也 403。
      const lanAddrs = Object.values(networkInterfaces() as Record<
        string,
        Array<{ address: string; family: string | number; internal: boolean }>
      >)
        .flat()
        .filter((a) => !a.internal && String(a.family).startsWith('4'))
        .map((a) => a.address)
      if (lanAddrs.length > 0) {
        const fakeLan = await fetch(`http://${lanAddrs[0]}:${env.port}/api/lilith/history`, {
          headers: { Authorization: `Bearer ${getApiToken()}` }
        })
        expect(fakeLan.status).toBe(403)
        const deniedBody = (await fakeLan.json()) as { error: string }
        expect(deniedBody.error).toBe('仅限本机回环访问')
      } else {
        // 无局域网地址：回环全链路仍须拿到 200，避免测试静默跳过全部断言
        expect(local.status).toBe(200)
      }
    })
  })

  describe('hasReviewPass（code-review 通过判定：行级匹配）', () => {
    it('单独一行 [REVIEW_PASS] → true（正常通过场景）', () => {
      expect(hasReviewPass('一切正常，可交付\n[REVIEW_PASS]\n')).toBe(true)
      expect(hasReviewPass(['逐条核对完成', '  [REVIEW_PASS]  ', '无遗留问题'].join('\n'))).toBe(true)
    })
    it('叙述中出现 [REVIEW_PASS] 字样但非单独行 → false（防误判通过）', () => {
      expect(hasReviewPass('你的回复没有输出 [REVIEW_PASS]，请重新审查')).toBe(false)
      expect(hasReviewPass('仍在讨论中，尚未到 [REVIEW_PASS] 阶段')).toBe(false)
      expect(hasReviewPass('[REVIEW_PASS]应出现在行首且独占一行，这里是混排')).toBe(false)
      expect(hasReviewPass('')).toBe(false)
    })
  })

  describe('WS 完整流式对话 + 工具调用往返', () => {
    it('token → tool_start/tool_end(Glob) → done，且流式期间 active 为 true', async () => {
      env = await startTestServer()
      tmpRoots.push(env.tmpRoot)

      const sandbox = join(env.tmpRoot, 'sandbox')
      const finalText = '已经按模式完成查找并汇总结果'
      let streamCall = 0
      mockCreate.mockImplementation(async (params: Record<string, unknown>) => {
        if (params.stream === true) {
          streamCall++
          return streamCall === 1
            ? makeAsyncIterable(toolCallRoundChunks(sandbox))
            : makeAsyncIterable(finalTextRoundChunks(finalText))
        }
        return {
          choices: [{ message: { role: 'assistant', content: '简要摘要' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 5 }
        }
      })

      const ws = await openWs(env.port)
      const eventsPromise = collectUntil(ws, 'done')

      ws.send(
        JSON.stringify({
          type: 'token',
          messageId: 'm_utest_1',
          sessionId: 's_utest_1',
          model: 'gpt-test',
          messages: [
            { id: 'um_1', role: 'user', content: '请用 Glob 查找沙箱下的文件', createdAt: Date.now() }
          ]
        })
      )

      // 流式运行中（mock 每 chunk 40ms，流持续 ~150ms）：/api/streams/active 应报 active:true
      await sleep(120)
      const activeMid = await fetch(`http://127.0.0.1:${env.port}/api/streams/active`, {
        headers: { Authorization: `Bearer ${getApiToken()}` }
      }).then((r) => r.json())

      const events = await eventsPromise
      ws.close()

      const toolStarts = events.filter((e) => e.type === 'tool_start')
      const toolEnds = events.filter((e) => e.type === 'tool_end')
      const tokens = events.filter((e) => e.type === 'token')
      const dones = events.filter((e) => e.type === 'done')

      expect(toolStarts.length).toBeGreaterThanOrEqual(1)
      expect(toolStarts[0]).toMatchObject({ toolName: 'Glob', toolCallId: 'call_glob_1', messageId: 'm_utest_1' })
      expect(toolEnds.length).toBeGreaterThanOrEqual(1)
      expect(toolEnds[0]).toMatchObject({ toolName: 'Glob', messageId: 'm_utest_1' })

      // 工具结果真实回灌后第二轮正常输出文本
      const joinedTokens = tokens.map((t) => String(t.payload ?? '')).join('')
      expect(joinedTokens).toContain(finalText)

      expect(dones.length).toBe(1)
      expect(dones[0]).toMatchObject({ messageId: 'm_utest_1' })
      expect(String((dones[0] as Record<string, unknown>).finalContent ?? '')).toContain(finalText)

      expect(activeMid).toMatchObject({ active: true, sessionId: 's_utest_1', messageId: 'm_utest_1' })
      expect(streamCall).toBeGreaterThanOrEqual(2)
    })

    it('工具未注册时仍完整返回 done（错误结果回灌对话，不中断流）', async () => {
      env = await startTestServer()
      tmpRoots.push(env.tmpRoot)

      let streamCall = 0
      mockCreate.mockImplementation(async (params: Record<string, unknown>) => {
        if (params.stream === true) {
          streamCall++
          return streamCall === 1
            ? makeAsyncIterable([
                {
                  choices: [
                    {
                      index: 0,
                      delta: {
                        tool_calls: [
                          {
                            index: 0,
                            id: 'call_ghost_1',
                            type: 'function',
                            function: { name: 'NoSuchTool', arguments: '{}' }
                          }
                        ]
                      }
                    }
                  ]
                },
                { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }
              ])
            : makeAsyncIterable(finalTextRoundChunks('工具不可用，已如实说明'))
        }
        return {
          choices: [{ message: { role: 'assistant', content: 'x' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 5, completion_tokens: 2 }
        }
      })

      const ws = await openWs(env.port)
      const eventsPromise = collectUntil(ws, 'done')

      ws.send(
        JSON.stringify({
          type: 'token',
          messageId: 'm_utest_2',
          messages: [
            { id: 'um_2', role: 'user', content: '调用不存在的工具', createdAt: Date.now() }
          ]
        })
      )

      const events = await eventsPromise
      ws.close()

      const ghostEnd = events.find((e) => e.type === 'tool_end' && e.toolName === 'NoSuchTool')
      expect(ghostEnd).toBeDefined()
      expect(String((ghostEnd as Record<string, unknown>).toolResult ?? '')).toContain('工具未注册')
      expect(events.some((e) => e.type === 'done')).toBe(true)
    })
  })

  describe('关闭与清理', () => {
    it('closeApiServer 后 HTTP 拒绝连接', async () => {
      env = await startTestServer()
      tmpRoots.push(env.tmpRoot)

      const closedPort = env.port
      closeApiServer()
      env = null
      await sleep(300)

      await expect(
        fetch(`http://127.0.0.1:${closedPort}/api/health`).then((r) => r.json())
      ).rejects.toThrow()
    })
  })

  describe('runHeadlessChat 无头对话（消息接入全链路）', () => {
    it('上下文组装→工具往返→事件推送→会话持久化全链路', async () => {
      env = await startTestServer()
      tmpRoots.push(env.tmpRoot)

      const sandbox = join(env.tmpRoot, 'sandbox')
      const finalText = '无头链路已按模式完成查找'
      let streamCall = 0
      mockCreate.mockImplementation(async (params: Record<string, unknown>) => {
        if (params.stream === true) {
          streamCall++
          return streamCall === 1
            ? makeAsyncIterable(toolCallRoundChunks(sandbox))
            : makeAsyncIterable(finalTextRoundChunks(finalText))
        }
        return {
          choices: [{ message: { role: 'assistant', content: '简要摘要' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 5 }
        }
      })

      const runner = getHeadlessChatRunner()
      expect(runner).not.toBeNull()
      const reply = await runner!('请用 Glob 查找沙箱下的文件', 's_headless_1')

      // 回合驱动：首轮工具调用 + 二轮最终文本
      expect(streamCall).toBeGreaterThanOrEqual(2)
      // 事件推送：返回完整输出
      expect(reply).toContain(finalText)

      // 会话持久化：消息接入会话已保存用户消息 + AI 回复
      // SessionStore 新形态：{root}/sessions/{sessionId}/user/meta.json + 消息分片
      // saveMessages 走 300ms 去抖写入，轮询等待消息分片落盘
      const userDir = join(env.tmpRoot, 'sessions', 's_headless_1', 'user')
      const shardPath = join(userDir, '1.json')
      for (let i = 0; i < 40 && !existsSync(shardPath); i++) await sleep(100)
      expect(existsSync(shardPath)).toBe(true)
      const meta = JSON.parse(readFileSync(join(userDir, 'meta.json'), 'utf-8')) as { title: string }
      expect(meta.title).toContain('消息接入会话')

      // 消息分片：全部 shard 的内容合并后应同时包含用户消息与 AI 回复
      const allMessages: Array<{ role: string; content: string }> = []
      for (let i = 1; ; i++) {
        const sp = join(userDir, `${i}.json`)
        if (!existsSync(sp)) break
        const shard = JSON.parse(readFileSync(sp, 'utf-8')) as Array<{
          role: string
          content: string
        }>
        allMessages.push(...shard)
      }
      expect(allMessages.some((m) => m.role === 'user' && m.content.includes('Glob'))).toBe(true)
      expect(allMessages.some((m) => m.role === 'assistant' && m.content.includes(finalText))).toBe(true)
    })
  })

  // 批次 3（主链路可测化）：补 [stream-error] 错误分支的端到端覆盖。
  // 为什么单独成段：此前本文件只覆盖 happy path（正常流 + 工具往返 + 工具未注册），
  // stream-runner 的 onError 五条出路（永久性错误 / 用户中止 / 静默续接重试 /
  // 断线中断恢复 / 重试耗尽恢复）在本文件里【零覆盖】——而 2026-09-08 的 402 死循环
  // 与"停止按钮无效"都长在这些分支上。0.34 已把判定口径抽成 stream-error-policy.ts
  // 的纯函数并单测，本段补的是「判定→副作用（推哪种帧 / 是否重试）」的接线是否接对。
  describe('WS 错误分支（批次 3：stream-error 路径）', () => {
    it('永久性错误（LLM 未配置）→ 推 error 帧且原文透出，不进入静默续接', async () => {
      env = await startTestServer()
      tmpRoots.push(env.tmpRoot)

      const errMsg = 'LLM 未配置：请在设置中填写 API Key'
      let streamCall = 0
      mockCreate.mockImplementation(async (params: Record<string, unknown>) => {
        if (params.stream === true) {
          streamCall++
          throw new Error(errMsg)
        }
        return {
          choices: [{ message: { role: 'assistant', content: 'x' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1 }
        }
      })

      const ws = await openWs(env.port)
      const eventsPromise = collectUntil(ws, 'error')
      ws.send(
        JSON.stringify({
          type: 'token',
          messageId: 'm_err_cfg',
          messages: [{ id: 'um_cfg', role: 'user', content: '你好', createdAt: Date.now() }]
        })
      )

      const events = await eventsPromise
      ws.close()
      const errEvt = events.find((e) => e.type === 'error') as Record<string, unknown>
      expect(errEvt.messageId).toBe('m_err_cfg')
      // 非余额类永久性错误：payload 原样透出错误消息（该消息本身已是可行动提示）
      expect(String(errEvt.payload)).toBe(errMsg)
      expect(streamCall).toBe(1)
    })

    it('永久性错误（402 余额不足）→ error 帧带充值建议，且停止自动恢复（2026-09-08 回归）', async () => {
      env = await startTestServer()
      tmpRoots.push(env.tmpRoot)

      // 余额不足的两种识别口径（状态码 402 / 文案命中）取状态码路径，文案断言另一条
      const balanceErr = Object.assign(new Error('Error 402: Insufficient Balance'), { status: 402 })
      let streamCall = 0
      mockCreate.mockImplementation(async (params: Record<string, unknown>) => {
        if (params.stream === true) {
          streamCall++
          throw balanceErr
        }
        return {
          choices: [{ message: { role: 'assistant', content: 'x' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1 }
        }
      })

      const ws = await openWs(env.port)
      const eventsPromise = collectUntil(ws, 'error')
      ws.send(
        JSON.stringify({
          type: 'token',
          messageId: 'm_err_402',
          messages: [{ id: 'um_402', role: 'user', content: '你好', createdAt: Date.now() }]
        })
      )

      const events = await eventsPromise
      const errEvt = events.find((e) => e.type === 'error') as Record<string, unknown>
      const payload = String(errEvt.payload)
      // 修复的另一半：不只"不重试"，还要让用户看得到原因与出路
      expect(payload).toContain('余额不足')
      expect(payload).toContain('充值')
      expect(payload).toContain('已暂停自动恢复')

      // 静默续接的首次退避是 1500ms：等过一个退避周期，确认既没重试、也没有任何收尾帧
      const after: Array<Record<string, unknown>> = []
      ws.on('message', (data: Buffer) => after.push(JSON.parse(data.toString()) as Record<string, unknown>))
      await sleep(1800)
      expect(streamCall).toBe(1)
      expect(after.some((e) => e.type === 'error' || e.type === 'interrupted' || e.type === 'done')).toBe(false)
      ws.close()
    })

    it('流中报错 → 静默续接重试，增量不丢且前端完全无感', async () => {
      env = await startTestServer()
      tmpRoots.push(env.tmpRoot)

      let streamCall = 0
      mockCreate.mockImplementation(async (params: Record<string, unknown>) => {
        if (params.stream === true) {
          streamCall++
          if (streamCall === 1) {
            // 首轮：先输出一部分正文再断（模拟服务端中途 5xx / socket hang up）
            return throwingAsyncIterable(
              [{ choices: [{ index: 0, delta: { content: '前半段已输出' } }] }],
              new Error('socket hang up')
            )
          }
          return makeAsyncIterable(finalTextRoundChunks('后半段续接完成'))
        }
        return {
          choices: [{ message: { role: 'assistant', content: '简要摘要' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 5 }
        }
      })

      const ws = await openWs(env.port)
      const eventsPromise = collectUntil(ws, 'done', 15000)
      ws.send(
        JSON.stringify({
          type: 'token',
          messageId: 'm_err_retry',
          sessionId: 's_err_retry',
          messages: [{ id: 'um_retry', role: 'user', content: '继续', createdAt: Date.now() }]
        })
      )

      const events = await eventsPromise
      ws.close()

      // 重试一次（非永久性错误 + WS 仍开 + 未达上限 → retry）
      expect(streamCall).toBe(2)
      const done = events.find((e) => e.type === 'done') as Record<string, unknown>
      expect(done.messageId).toBe('m_err_retry')
      // 续接语义（buildContinuationMessages）：断前已输出的正文作为 assistant 前置保留，
      // done.finalContent = 两段增量之和——断言"前半段不丢"是这条链路的核心不变量
      expect(String(done.finalContent)).toContain('前半段已输出')
      expect(String(done.finalContent)).toContain('后半段续接完成')
      // 静默：前端不应看到 error / interrupted / abort 任何一帧
      expect(events.some((e) => e.type === 'error' || e.type === 'interrupted' || e.type === 'abort')).toBe(false)
    })

    it('用户中止（WS abort）→ 推 abort 帧收尾，不重试不恢复', async () => {
      env = await startTestServer()
      tmpRoots.push(env.tmpRoot)

      let streamCall = 0
      mockCreate.mockImplementation(async (params: Record<string, unknown>) => {
        if (params.stream === true) {
          streamCall++
          // 长流：每 150ms 一个空 delta，给 abort 留出「流运行中」的窗口
          return makeAsyncIterable(slowEmptyChunks(30), 150)
        }
        return {
          choices: [{ message: { role: 'assistant', content: 'x' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1 }
        }
      })

      const ws = await openWs(env.port)
      const eventsPromise = collectUntil(ws, 'abort', 12000)
      ws.send(
        JSON.stringify({
          type: 'token',
          messageId: 'm_err_abort',
          messages: [{ id: 'um_abort', role: 'user', content: '开始', createdAt: Date.now() }]
        })
      )
      await sleep(400) // 等流真正进入消费态（create 已调用、for-await 已在跑）
      ws.send(JSON.stringify({ type: 'abort' }))

      const events = await eventsPromise
      ws.close()
      const abortEvt = events.find((e) => e.type === 'abort') as Record<string, unknown>
      expect(abortEvt.messageId).toBe('m_err_abort')
      // 用户中止必须排在恢复之前：不重试、不触发中断恢复（停止按钮有效）
      expect(streamCall).toBe(1)
      expect(events.some((e) => e.type === 'error' || e.type === 'interrupted')).toBe(false)
    })

    it('工具执行失败（Read 不存在文件）→ 错误结果回灌且流程照常 done', async () => {
      env = await startTestServer()
      tmpRoots.push(env.tmpRoot)

      const missing = join(env.tmpRoot, 'sandbox', 'not-exist.txt')
      let streamCall = 0
      mockCreate.mockImplementation(async (params: Record<string, unknown>) => {
        if (params.stream === true) {
          streamCall++
          return streamCall === 1
            ? makeAsyncIterable([
                {
                  choices: [
                    {
                      index: 0,
                      delta: {
                        tool_calls: [
                          {
                            index: 0,
                            id: 'call_read_1',
                            type: 'function',
                            function: {
                              name: 'Read',
                              arguments: JSON.stringify({ file_path: missing })
                            }
                          }
                        ]
                      }
                    }
                  ]
                },
                { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }
              ])
            : makeAsyncIterable(finalTextRoundChunks('读取失败已如实说明'))
        }
        return {
          choices: [{ message: { role: 'assistant', content: 'x' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 5, completion_tokens: 2 }
        }
      })

      const ws = await openWs(env.port)
      const eventsPromise = collectUntil(ws, 'done')
      ws.send(
        JSON.stringify({
          type: 'token',
          messageId: 'm_err_tool',
          messages: [{ id: 'um_tool', role: 'user', content: '读这个文件', createdAt: Date.now() }]
        })
      )

      const events = await eventsPromise
      ws.close()
      // 工具【已注册但执行失败】：与"工具未注册"是两条不同路径（前者走 execute 的 ok:false 结果回灌）
      const toolEnd = events.find((e) => e.type === 'tool_end' && e.toolName === 'Read') as Record<string, unknown>
      expect(toolEnd).toBeDefined()
      expect(String(toolEnd.toolResult)).toContain('文件不存在')
      expect(events.some((e) => e.type === 'done')).toBe(true)
      expect(events.some((e) => e.type === 'error')).toBe(false)
    })
  })
})