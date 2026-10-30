/**
 * @category 核心
 * @summary 组合根共享依赖：启动装配各原子与 IPC 层都要用到的三件基础设施
 *
 * 为什么存在：`index.ts` 的装配原子（`initXxx`）此前直接闭包引用模块级的
 * `configStore` / `sessionStore` / `rootCtx`。原子迁入 `bootstrap/` 后必须显式注入——
 * 用**一个**容器而不是三个独立形参，是为了让 `service-assembly.ts` 的编排调用点保持
 * 单行、且后续新增共享基础设施时不改动所有原子签名。
 *
 * 什么作用：承载三个在 `index.ts` 顶层创建、全启动链共用的实例。**注意它们是同一批对象**：
 * `deps` 只是打包传递，不复制、不重建——`rootCtx` 尤其如此（Cordis 服务容器必须全链同源）。
 *
 * 不删理由：删掉它，三个依赖会退回「各原子各自闭包引用模块级变量」的隐式耦合，
 * 原子就无法迁出 `index.ts`（ADR-01 第 3~4 步的前提）。
 */
import type { Context } from '../kernel/cordis-runtime'
import type { ConfigStore } from '../api/config-store'
import type { SessionStore } from '../api/session-store'

/**
 * 权限绿通判定：读 `config.permissionGreenlight`。
 * AI 自我重启（`app_restart` 工具）后绿通保留；用户完全关闭时由退出链重置为 false（保底防死循环）。
 * 放在本模块而非各消费方：装配编排（权限桥接注入）与退出链两处都要用，各自实现会分叉。
 */
export function isGreenlight(configStore: ConfigStore): boolean {
  return configStore.get().permissionGreenlight === true
}

export interface BootstrapDeps {
  /** 配置存储（顶层 `rootCtx.config.init(...)` 创建，全链同源） */
  configStore: ConfigStore
  /** 会话存储（顶层 `rootCtx.sessions.init(...)` 创建，全链同源） */
  sessionStore: SessionStore
  /** 月蚀 Cordis 根上下文：`ctx.<service>` 服务门面 + `featurePlugins` 功能开关 */
  rootCtx: Context
}
