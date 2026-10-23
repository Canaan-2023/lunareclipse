/**
 * @category 安全
 * @summary 本机 API 的 CORS 白名单中间件与令牌鉴权中间件（注册顺序即安全语义）
 *
 * 为什么存在：HTTP 面暴露「运行中流状态、LLM 连接测试」等仅限本机 UI 的接口。两件事必须成对且有序：
 * ① CORS 白名单——dev 模式渲染进程从 vite dev server 加载（origin = localhost:5173 等任意 dev 端口），
 *    fetch 到 127.0.0.1:port 属跨域，无 CORS 头会被浏览器拦截（面板静默失败）；生产从 file:// 加载，
 *    Origin 为字符串 "null"。只对可信来源回显 CORS 头，对任意网页 origin 返回 403，阻断浏览器侧
 *    跨域读取本机 API 响应（WS 无同源限制，由令牌鉴权兜底）。
 * ② 令牌鉴权——除白名单路径外要求 `Authorization: Bearer <apiToken>`，否则 401。
 *
 * 不删理由：这两段是分发版的本机 API 安全边界，且**相对注册顺序不可重排**——CORS 必须先于鉴权，
 * 否则预检/拒绝响应的头语义变化（安全回归测试 `test/api-server.test.ts` 的回环拦截段依赖此顺序）。
 *
 * 口径单源（CODE-RULES §3.7 协议面红线）：鉴权判定一律 import `./server-utils` 的
 * `allowLilithBypass` / `isLilithBypassPath` / `tokensEqual`，**不复制实现**——中间件与安全回归测试
 * 共用同一实现，防止「实现改了一处、测试按旧语义断言」的分叉。
 */
import type { Express } from 'express'
import { allowLilithBypass, isLilithBypassPath, tokensEqual, CORS_MAX_AGE } from './server-utils'

export interface AuthMiddlewareDeps {
  /** 读当前 API 令牌（每次请求现读：令牌在 startApiServer 内生成后写入，晚绑定与原地闭包语义一致） */
  getApiTokenSecret: () => string
}

/**
 * 安装 CORS 白名单 + 令牌鉴权中间件。
 *
 * 何时用：`startApiServer` 装配 HTTP 面时调用一次，且必须**先于** body 上限与全部路由注册。
 * 注册顺序（不得重排）：CORS → 鉴权 → `/api/v1` 200mb → 全局 50mb → `/reports` → `/api/v1` master → 路由。
 */
export function installAuthMiddleware(app: Express, deps: AuthMiddlewareDeps): void {
  // ===== CORS 白名单 =====
  const isAllowedOrigin = (o: string): boolean =>
    o === 'null' || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o)
  app.use((req, res, next) => {
    const origin = req.headers.origin
    if (origin) {
      if (isAllowedOrigin(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin)
      } else {
        res.status(403).json({ error: 'origin not allowed' })
        return
      }
    } else {
      // 非浏览器客户端（Lilith companion 等无 Origin 的外部进程）不受同源策略约束，放开。
      res.setHeader('Access-Control-Allow-Origin', '*')
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
    res.setHeader('Access-Control-Max-Age', String(CORS_MAX_AGE))
    if (req.method === 'OPTIONS') {
      res.sendStatus(204)
      return
    }
    next()
  })

  // ===== 本机 API 令牌鉴权中间件 =====
  // 白名单：/api/health、/api/v1（卫星面鉴权由 masterRouter 自管：public hello/register/login，
  // 其余 requireSatellite Bearer + requireLoopback 回环限制，此处不重复设防）。
  //
  // 2025 评审补充：主实例（挂 masterRouter）监听 0.0.0.0，/api/lilith/* 若直接放行，
  // 局域网内任意设备可免令牌读最近 200 条对话 / 清空会话 / 驱动 LLM 消耗 API 额度。
  // /api/lilith/* 与 MOD 桥接 /chat/completions 同属「本机进程（游戏 companion）桥接面」：
  // 仍免令牌（companion 带不了令牌），但来源必须回环——非回环一律 403，与 /api/v1 同口径。
  app.use((req, res, next) => {
    if (req.path === '/api/health' || req.path.startsWith('/api/v1')) {
      return next()
    }
    if (allowLilithBypass(req.path, req.socket.remoteAddress)) {
      return next()
    }
    if (isLilithBypassPath(req.path)) {
      res.status(403).json({ error: '仅限本机回环访问' })
      return
    }
    // 月蚀内置浏览器导航只能带 URL，无法携带 Authorization 头，
    // 故 query 参数 ?token=<apiToken> 与 Bearer 头等效（与 WS 握手同源）。
    // 只放行 /reports/ 前缀且 token 精确匹配；其余路径仍必须走 Bearer 头校验。
    const secret = deps.getApiTokenSecret()
    if (
      req.path.startsWith('/reports/') &&
      typeof req.query.token === 'string' &&
      tokensEqual(req.query.token, secret)
    ) {
      return next()
    }
    const authHeader = req.headers.authorization
    if (
      typeof authHeader === 'string' &&
      authHeader.startsWith('Bearer ') &&
      tokensEqual(authHeader.slice('Bearer '.length), secret)
    ) {
      return next()
    }
    res.status(401).json({ error: 'unauthorized' })
  })
}
