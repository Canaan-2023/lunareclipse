/**
 * @category API
 * @summary `/api/v1` 卫星接入面网关（惰性转发挂载）
 *
 * 为什么存在：主分系统的 `/api/v1`（注册/登录/令牌/同步/管理/归档）**不能按启动时角色静态挂载**——
 * 「注册成为主系统」是运行时动作（`auth:register` → `becomeMaster`），启动时若为 standalone 则
 * `createMasterRouter()` 返回 null；旧实现 `app.use` 只在启动时执行一次，升级为主系统后 `/api/v1`
 * 永不挂载（分系统无法接入、本机账号管理局/备份中心 IPC 亦失效）。
 *
 * 什么作用：每次请求**动态**向 `getMasterRouter()` 取路由（内部 `ensureMasterAssets` 幂等装配）；
 * 启动即 standalone 时返回 503「非主系统」，注册升级后立即可用、无需重启。
 * 兼容：保留 `masterRouter` 直挂分支，供直接传 Router 的调用方（工具/测试）使用，不破坏旧签名。
 *
 * 不删理由：惰性转发是「运行时可升级主系统」的结构性保障；静态挂载会让该能力在升级路径上失效。
 */
import type { Express, Router } from 'express'

export interface MasterGatewayDeps {
  /** 直接传入的路由（旧签名；工具/测试用）。与 getMasterRouter 二选一。 */
  masterRouter?: Router
  /** 惰性取路由（优先）：每次请求现取，内部幂等装配。 */
  getMasterRouter?: () => Router | null
}

/** 安装 `/api/v1` 网关（须在鉴权中间件之后、业务路由之前注册）。 */
export function installMasterGateway(app: Express, deps: MasterGatewayDeps): void {
  const { masterRouter, getMasterRouter } = deps
  if (!masterRouter && !getMasterRouter) return
  app.use('/api/v1', (req, res, next) => {
    const router = getMasterRouter ? getMasterRouter() : masterRouter
    if (!router) {
      res.status(503).json({ ok: false, error: '非主系统' })
      return
    }
    router(req, res, next)
  })
}
