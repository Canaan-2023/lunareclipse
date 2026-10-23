/**
 * @category 核心
 * @summary HTTP 服务 + WS 升级服务（含握手令牌鉴权）创建，并把句柄登记进 serviceRefs
 * @note 为什么存在：`server`/`wss` 的创建与「登记 serviceRefs（释放链唯一入口）」是同一件事的两面，
 * 且 WS 握手鉴权口径（`tokensEqual` + 进程随机令牌）必须单源；从宿主 `server.ts` 外移（ADR-02 第二轮）。
 * @note 不删理由：WS 不受同源策略约束（CORS 拦不住），握手鉴权是「只有持令牌的连接能升级」的唯一防线。
 */
import http from 'http'
import { WebSocketServer } from 'ws'
import type { Express } from 'express'
import { WS_MAX_PAYLOAD, WS_PATH, tokensEqual } from './server-utils'
import { bindCodeReviewEnv } from './code-review'
import { serviceRefs } from './service-refs'

export interface HttpWsServer {
  server: http.Server
  wss: WebSocketServer
}

/**
 * 创建 HTTP server 与 WS 升级服务。
 * - 局部别名返回非空 `server`（serviceRefs.server 字段为可空 `Server | null`，仅作释放入口）
 * - code-review 报告打开需 server 端口与鉴权 token（注入 getter，避免循环依赖）
 * - maxPayload：默认 100MiB，AI 工具输出可能把会话消息撑到几百 MB，全量发送会触发
 *   "Max payload size exceeded" 销毁连接 → 前端 [连接中断] 循环；前端已按预算裁剪（2MB），此处调大是双保险。
 */
export function createHttpWsServer(app: Express): HttpWsServer {
  const server = http.createServer(app)
  serviceRefs.server = server
  bindCodeReviewEnv({ getServer: () => server, getToken: () => serviceRefs.apiTokenSecret })

  const wss = new WebSocketServer({
    server,
    path: WS_PATH,
    maxPayload: WS_MAX_PAYLOAD,
    verifyClient: (info, done) => {
      const token = new URL(info.req.url ?? '', 'http://localhost').searchParams.get('token')
      if (tokensEqual(token, serviceRefs.apiTokenSecret)) {
        done(true)
      } else {
        done(false, 401, 'unauthorized')
      }
    }
  })
  serviceRefs.wss = wss

  return { server, wss }
}
