/**
 * auth-middleware（CORS 白名单 + 令牌鉴权中间件）契约测试。
 *
 * 为什么存在：ADR-02 第 1 步把 CORS 与鉴权外移为 `installAuthMiddleware`，但该模块此前**无直测**——
 * 覆盖只来自 `api-server.test.ts` 的集成用例（经完整 `startApiServer`）。而「CORS 必须先于鉴权注册」
 * 是本模块的核心安全语义：顺序错位会改变预检/拒绝响应的头语义，集成用例难以稳定断言该相对次序。
 *
 * 覆盖：
 * 1. CORS：允许来源回显 / `null`（file://）放行 / 非允许来源 403（**先于鉴权**——无令牌也不返回 401）
 * 2. CORS：无 Origin 的非浏览器客户端放行（ACAO `*`）；OPTIONS 预检 204；CORS 头齐备
 * 3. 鉴权白名单：`/api/health` 与 `/api/v1` 免令牌
 * 4. 令牌：Bearer 正确放行 / 错误 401 / `/reports/?token=` 与 Bearer 等效
 * 5. 令牌晚绑定：`getApiTokenSecret` 每次请求现读（换令牌立即生效）
 *
 * 用 `http.request` 而非 `fetch`：需要精确控制 `Origin` 头（fetch 的 forbidden header 行为随实现而异）。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import express from 'express'
import http from 'http'
import { installAuthMiddleware } from '../electron/main/api/auth-middleware'

const TOKEN = 'token-abc'

let currentSecret = TOKEN

interface Ctx {
  port: number
  close: () => Promise<void>
}

/** 起一个仅装鉴权中间件 + 两个探针路由的 express 应用（127.0.0.1 随机端口） */
async function startApp(getSecret: () => string): Promise<Ctx> {
  const app = express()
  installAuthMiddleware(app, { getApiTokenSecret: getSecret })
  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok' })
  })
  app.get('/protected', (_req, res) => {
    res.json({ ok: true })
  })
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>((resolve) => server.once('listening', () => resolve()))
  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  return { port, close: () => new Promise<void>((resolve) => server.close(() => resolve())) }
}

interface Res {
  status: number
  headers: http.IncomingHttpHeaders
  body: string
}

function req(
  port: number,
  path: string,
  init: { method?: string; headers?: Record<string, string> } = {}
): Promise<Res> {
  return new Promise((resolve, reject) => {
    const r = http.request(
      { host: '127.0.0.1', port, path, method: init.method ?? 'GET', headers: init.headers },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (c: string) => {
          body += c
        })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }))
      }
    )
    r.on('error', reject)
    r.end()
  })
}

let ctx: Ctx

beforeAll(async () => {
  ctx = await startApp(() => currentSecret)
})

afterAll(async () => {
  await ctx.close()
})

beforeEach(() => {
  currentSecret = TOKEN
})

describe('CORS 白名单（注册在鉴权之前，顺序即安全语义）', () => {
  it('无 Origin（非浏览器客户端）→ 放行且 ACAO 为 *', async () => {
    const r = await req(ctx.port, '/api/health')
    expect(r.status).toBe(200)
    expect(r.headers['access-control-allow-origin']).toBe('*')
  })

  it('允许来源（localhost:任意端口 / 127.0.0.1 / null）→ 回显该 origin 并放行', async () => {
    for (const origin of ['http://localhost:5173', 'http://127.0.0.1:8080', 'null']) {
      const r = await req(ctx.port, '/api/health', { headers: { Origin: origin } })
      expect(r.status).toBe(200)
      expect(r.headers['access-control-allow-origin']).toBe(origin)
    }
  })

  it('CORS 头齐备：Methods / Headers / Max-Age', async () => {
    const r = await req(ctx.port, '/api/health', { headers: { Origin: 'http://localhost:5173' } })
    expect(r.headers['access-control-allow-methods']).toBe('GET, POST, PUT, DELETE, OPTIONS')
    expect(r.headers['access-control-allow-headers']).toBe('Content-Type, Authorization')
    expect(r.headers['access-control-max-age']).toBe('86400')
  })

  it('非允许来源 → 403 且**先于鉴权**（即便带正确令牌也 403，不落到 401）', async () => {
    const r = await req(ctx.port, '/protected', {
      headers: { Origin: 'https://evil.example.com', Authorization: `Bearer ${TOKEN}` }
    })
    expect(r.status).toBe(403)
    expect(JSON.parse(r.body).error).toBe('origin not allowed')
  })

  it('OPTIONS 预检（允许来源）→ 204 空响应', async () => {
    const r = await req(ctx.port, '/protected', {
      method: 'OPTIONS',
      headers: { Origin: 'http://localhost:5173' }
    })
    expect(r.status).toBe(204)
    expect(r.body).toBe('')
  })
})

describe('令牌鉴权中间件', () => {
  it('Bearer 正确 → 放行', async () => {
    const r = await req(ctx.port, '/protected', { headers: { Authorization: `Bearer ${TOKEN}` } })
    expect(r.status).toBe(200)
    expect(JSON.parse(r.body).ok).toBe(true)
  })

  it('无令牌 / 错误令牌 / 非 Bearer 形式 → 401', async () => {
    expect((await req(ctx.port, '/protected')).status).toBe(401)
    expect(
      (await req(ctx.port, '/protected', { headers: { Authorization: 'Bearer wrong-token' } })).status
    ).toBe(401)
    expect((await req(ctx.port, '/protected', { headers: { Authorization: TOKEN } })).status).toBe(401)
    const r = await req(ctx.port, '/protected')
    expect(JSON.parse(r.body).error).toBe('unauthorized')
  })

  it('/reports/<name>?token= 与 Bearer 等效；token 错误仍 401', async () => {
    // 放行（无该路由 → 404；关键是不为 401）
    expect((await req(ctx.port, `/reports/probe.html?token=${TOKEN}`)).status).toBe(404)
    expect((await req(ctx.port, '/reports/probe.html?token=wrong')).status).toBe(401)
  })

  it('白名单：/api/health 与 /api/v1 免令牌（无令牌不为 401）', async () => {
    expect((await req(ctx.port, '/api/health')).status).toBe(200)
    expect((await req(ctx.port, '/api/v1/anything')).status).toBe(404)
  })

  it('令牌晚绑定：换令牌后立即生效（旧令牌失效、新令牌放行）', async () => {
    expect((await req(ctx.port, '/protected', { headers: { Authorization: `Bearer ${TOKEN}` } })).status).toBe(200)

    currentSecret = 'token-xyz'
    expect(
      (await req(ctx.port, '/protected', { headers: { Authorization: `Bearer ${TOKEN}` } })).status
    ).toBe(401)
    expect(
      (await req(ctx.port, '/protected', { headers: { Authorization: 'Bearer token-xyz' } })).status
    ).toBe(200)
  })
})
