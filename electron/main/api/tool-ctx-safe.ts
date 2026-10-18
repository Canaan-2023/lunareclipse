/**
 * @category 核心
 * @summary 装配期安全读取工具上下文：`safePaths`（未登录态归一到 null）与 `spreadToolCtx`（跳过 paths 键的浅拷贝）
 * @note 为什么存在：`ToolContext.paths` 是动态 getter，未登录访问会抛「未登录态禁止解析工具作用域 paths」。
 * 启动装配期只关心「paths 是否可用」，直接求值会把「未登录」升级成整进程启动崩溃（打包版/全新环境首次启动必现）。
 * 这两个函数是**唯一**的归一入口，故独立成模块供 `server.ts` 与 `segment-manifest.ts` 共用（ADR-02 第二轮外移）。
 * @note 不删理由：干净环境首次启动必须能进登录页，装配期不允许因 paths 抛错崩掉应用。
 */
import type { ToolContext } from '../tools/base-tool'

/**
 * 安全读取工具作用域 paths：paths 是动态 getter，未登录访问会抛
 * 「未登录态禁止解析工具作用域 paths」（登录后才可解析用户记忆域）。
 * 启动装配期只用「paths 是否可用」决定是否创建 geo/cron/team/mission
 * 等依赖用户作用域的服务；直接读 getter 会把未登录抛错升级成整进程启动崩溃
 * （打包版/全新环境首次启动无登录数据必现）。本函数把「不可用」归一到 null，
 * 与既有 `toolCtx.paths ? ... : null` 判空语义一致。
 * 登录恢复（index.ts 启动链）先于 initApiServer 执行，已登录用户启动不受影响；
 * 未登录时这些服务本就无意义，置 null 是正确语义而非掩盖错误。
 */
export function safePaths(tc: ToolContext): ToolContext['paths'] | null {
  try {
    return tc?.paths ?? null
  } catch {
    return null
  }
}

/**
 * 安全展开工具上下文：`...toolCtx` 对象展开会强制求值全部 getter——paths 是动态 getter，
 * 未登录抛「未登录态禁止解析工具作用域 paths」，求值阶段就崩，后续 defineProperty
 * 覆盖根本执行不到。此处跳过 paths 键（serverCtx 处 defineProperty 重新挂动态 getter），
 * 其余属性（含其它 getter）按对象展开等价语义浅拷贝。
 */
export function spreadToolCtx(tc: ToolContext): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(tc)) {
    if (key === 'paths') continue
    out[key] = (tc as Record<string, unknown>)[key]
  }
  return out
}
