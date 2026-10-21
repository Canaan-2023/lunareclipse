/**
 * 月蚀 Cordis 运行时（阶段 2 + P1-A G3 真 fiber 化）

 * 把 vendor/cordis 的 Cordis 内核与月蚀既有内核机制（coeffect/capability/kernel）
 * 接成统一的 ctx 服务容器。自此：
 * - 模块通过 ctx 服务键取服务（不再模块级单例 import）
 * - 月蚀既有机制（coeffectRegistry 等）保持单例身份，Cordis 服务只是其门面
 * （与 plugins/loader 共用同一注册表，双向可见，零行为变化）

 * 真 fiber 化（G3，对应实施计划 P1-A G3）：
 * - 同步阶段（createRootContext）：只注册 3 基础 + 6 核心 + featurePlugins 服务；
 * 功能服务（memory/workflow/monitor/lilith/browser/subagent/mcp/skills/cron/governance）
 * 不再在此同步 new（避免模块顶层 createRootContext 在 dataRoot 就绪前构造读空状态）。
 * - 异步阶段（mountFeatureServices）：在 whenReady 里 dataRoot 就绪后调用，
 * 由 FeaturePluginsService.mountAll() 按状态文件逐项 `ctx.plugin()` 挂载为独立 fiber；
 * 服务键注册在插件 fiber 上，卸载 fiber 即自动撤销服务 + notify 依赖者。

 * 用法：
 * const ctx = createRootContext() // 同步：基础/核心服务立即可用
 * await mountFeatureServices(ctx) // 异步：功能服务按开关状态挂载
 * // 模块：{ inject: ['coeffect'], apply(ctx) { ctx.coeffect.get('x') } }
 */

import { Context, Service } from '../vendor/cordis/index.ts'
import {
  coeffectRegistry,
  type CoeffectKey,
  type CoeffectHandle,
  type CoeffectChangeListener,
  type CoeffectStatus
} from './coeffect'
import {
  checkCapability,
  readCapabilityPolicy,
  type CapabilityPolicy,
  type CapabilityDecision
} from './capability'
import { buildKernelStatus } from './introspection'
import type { RegistrySnapshot, ExtensionSource } from './extension'
import type { ToolMeta } from '../../../shared/tools/registry'
import { SessionService, LlmService, ToolsService, ConfigService, UsersService, SystemPromptService } from './core-services'
import { FeaturePluginsService } from './feature-plugins'

// ─── ctx 服务类型扩展（月蚀侧声明合并中心；新增 ctx 服务在此登记） ───
declare module '../vendor/cordis/context.ts' {
  interface Context {
    /** 反应式服务表门面（coeffect，与 plugins/loader 共用同一注册表） */
    coeffect: CoeffectService
    /** 声明式能力闸 */
    capability: CapabilityService
    /** 内核状态自检（插件/工具/服务快照） */
    kernel: KernelService
  }
}

// 核心服务（core-services.ts 的类型扩展声明在彼处，此处只注册实例）

/** ctx.coeffect：包装既有 CoeffectRegistry 单例 */
export class CoeffectService extends Service {
  readonly registry = coeffectRegistry

  constructor(ctx: Context) {
    super(ctx, 'coeffect')
  }

  provide<T>(key: CoeffectKey, value: T, source: ExtensionSource): CoeffectHandle<T> {
    return this.registry.provide(key, value, source)
  }

  get<T = unknown>(key: CoeffectKey): T | undefined {
    return this.registry.get<T>(key)
  }

  has(key: CoeffectKey): boolean {
    return this.registry.has(key)
  }

  onChanged(cb: CoeffectChangeListener): () => void {
    return this.registry.onChanged(cb)
  }

  listKeys(): CoeffectKey[] {
    return this.registry.listKeys()
  }

  inspect(): CoeffectStatus[] {
    return this.registry.inspect()
  }
}

/** ctx.capability：声明式能力闸门面 */
export class CapabilityService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'capability')
  }

  check(
    toolName: string,
    meta: Pick<ToolMeta, 'caps' | 'riskLevel'> | undefined,
    config?: unknown,
    effective?: CapabilityPolicy
  ): CapabilityDecision {
    return checkCapability(toolName, meta, config, effective)
  }

  readPolicy(config?: unknown): CapabilityPolicy {
    return readCapabilityPolicy(config)
  }
}

/** ctx.kernel：内核状态自检门面 */
export class KernelService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'kernel')
  }

  status(): RegistrySnapshot {
    return buildKernelStatus()
  }
}

/** 创建月蚀根上下文并注册全部基础/核心服务（同步阶段；功能服务见 mountFeatureServices） */
export function createRootContext(): Context {
  const ctx = new Context()
  new CoeffectService(ctx)
  new CapabilityService(ctx)
  new KernelService(ctx)
  new SessionService(ctx)
  new LlmService(ctx)
  new ToolsService(ctx)
  new ConfigService(ctx)
  new UsersService(ctx)
  new SystemPromptService(ctx)
  // 阶段 4 → G3：功能服务不再同步构造，改由 mountFeatureServices 异步挂载为 fiber
  new FeaturePluginsService(ctx)
  return ctx
}

/**
 * 异步装配全部功能服务（G3 真 fiber 化入口）。
 *
 * 必须在 dataRoot 就绪后调用（index.ts whenReady 内 setPathContext 之后）：
 * mountAll() 内部先重读状态文件，修复「createRootContext 同步期 dataRoot 未设置 → 状态读不到 → 用户关闭的插件被重新挂载」的问题。
 *
 * @returns 每个插件的挂载结果（{ id, ok, error?, mounted? }），失败不中断其余插件
 */
export async function mountFeatureServices(
  ctx: Context
): Promise<Array<{ id: string; ok: boolean; error?: string; mounted?: boolean }>> {
  return ctx.featurePlugins.mountAll()
}

export type { Context }