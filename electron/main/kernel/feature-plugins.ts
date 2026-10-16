/**
 * 月蚀功能插件对象表（阶段 4 → P1-A G3 真 fiber 化）

 * 十大功能模块（memory/workflow/monitor/lilith/browser/subagent/mcp/skills/cron/governance）
 * 以「代码内 Cordis 插件对象表」形态演进：每个功能模块登记一个 mounter（挂载器），
 * 由 FeaturePluginsService 按启用状态 `ctx.plugin()` 挂载为独立 Cordis fiber。

 * 真 fiber 化语义（与轻 fiber 化的区别）：
 * - 功能服务不再由 createRootContext() 同步构造，而是放进 mounter 的 apply() 里 `new`，
 * 服务键注册在插件 fiber 上（Service 构造 → ctx.reflect.provide → fiber.effect 链）。
 * - 卸载对应 fiber 时：store 键删除（reflect.ts provide disposer）+ 依赖者 notify
 * + 服务实现随 fiber 生命周期自动撤销——开关状态与真实服务存在性强一致。
 * - setEnabled(true/false) = 真正挂载/卸载 fiber；状态层（持久化 + 广播）先行，
 * 装卸失败不影响状态（返回 error），重启后按状态文件挂载。
 * - 实体资源（SkillLoader/McpClientManager/PathSyncMonitor 等）所有权在调用方
 * （index.ts/server.ts 模块级引用 + before-quit 清理链），fiber 卸载只移除服务键，
 * 不越权 stop/close 共享实体（避免 double-stop）。

 * 面板验收：`--plugins` 面板可逐项开关（经 featurePlugins:list / featurePlugins:toggle IPC）。
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { Context, Service, Plugin, Fiber } from '../vendor/cordis/index.ts'
import { getDataRoot } from '../models/path-context'
import {
  GovernanceService,
  SkillsService,
  McpService,
  BrowserService,
  LilithService,
  SubAgentService,
  CronService,
  WorkflowService,
  MonitorService
} from './func-services'
import { MemoryService } from './memory-service'

declare module '../vendor/cordis/context.ts' {
  interface Context {
    /** 功能插件对象表：可枚举/可装卸状态（阶段 4 + G3 真 fiber 化） */
    featurePlugins: FeaturePluginsService
  }
}

/** 单个功能插件对象的元信息 + 挂载器（N1：mounter 是运行时真相源） */
export interface FeaturePluginMeta {
  /** 插件 id（slug，与状态文件键一致） */
  id: string
  /** 展示名 */
  name: string
  /** 描述（面板展示） */
  description: string
  /** 版本号 */
  version: string
  /** 对应 ctx 服务键（服务构造器注册在 mounter.apply 内；与 Service 构造的 name 一致） */
  serviceKey: string
  /**
   * 挂载器：返回 Cordis 插件对象，apply() 内 `new XxxService(ctx)`。
   * apply 收到的 ctx 属于插件 fiber → 服务键注册在该 fiber 上，
   * fiber 卸载时随 provide disposer 自动撤销 + notify。
   */
  mounter: (ctx: Context) => Plugin
}

/**
 * 功能插件声明表（阶段 4 十项；新增功能模块在此登记 mounter 即可进面板 + 参与装卸）。
 * serviceKey 与各 Service 构造的注册名保持一致（真相源是 mounter.apply 的实际构造）。
 */
export const FEATURE_PLUGINS: readonly FeaturePluginMeta[] = [
  {
    id: 'governance', name: '治理机制', description: '空转抑制 / 查证提醒 / 收尾反思 / 失败止损', version: '1.0.0', serviceKey: 'governance',
    mounter: () => ({ apply: (ctx) => { new GovernanceService(ctx) } })
  },
  {
    id: 'skills', name: '技能池', description: '技能加载器（SkillLoader，真单例）', version: '1.0.0', serviceKey: 'skills',
    mounter: () => ({ apply: (ctx) => { new SkillsService(ctx) } })
  },
  {
    id: 'mcp', name: 'MCP 客户端', description: 'MCP 客户端管理器（真单例）', version: '1.0.0', serviceKey: 'mcp',
    mounter: () => ({ apply: (ctx) => { new McpService(ctx) } })
  },
  {
    id: 'browser', name: '浏览器管理器', description: '模块级单例浏览器实例门面', version: '1.0.0', serviceKey: 'browser',
    mounter: () => ({ apply: (ctx) => { new BrowserService(ctx) } })
  },
  {
    id: 'lilith', name: '莉莉丝适配器', description: '桌宠链路 B 适配器工厂（多实例）', version: '1.0.0', serviceKey: 'lilith',
    mounter: () => ({ apply: (ctx) => { new LilithService(ctx) } })
  },
  {
    id: 'subagent', name: '子 Agent 管理器', description: '子代理执行器工厂（前端 / DMN 各一）', version: '1.0.0', serviceKey: 'subagent',
    mounter: () => ({ apply: (ctx) => { new SubAgentService(ctx) } })
  },
  {
    id: 'cron', name: '定时任务', description: 'CronScheduler 调度器工厂', version: '1.0.0', serviceKey: 'cron',
    mounter: () => ({ apply: (ctx) => { new CronService(ctx) } })
  },
  {
    id: 'workflow', name: '工作流引擎', description: 'WorkflowManager 引擎（真单例）', version: '1.0.0', serviceKey: 'workflow',
    mounter: () => ({ apply: (ctx) => { new WorkflowService(ctx) } })
  },
  {
    id: 'monitor', name: '监视器组', description: 'PathSync / Supervisor / HealthCheck', version: '1.0.0', serviceKey: 'monitor',
    mounter: () => ({ apply: (ctx) => { new MonitorService(ctx) } })
  },
  {
    id: 'memory', name: '记忆系统', description: '记忆服务壳（RAW/NNG 内部逻辑零改动）', version: '1.0.0', serviceKey: 'memory',
    mounter: () => ({ apply: (ctx) => { new MemoryService(ctx) } })
  }
]

/** 功能插件 id → 声明项 查找表（避免 list/mount/unmount 反复 find） */
const FEATURE_PLUGIN_MAP: ReadonlyMap<string, FeaturePluginMeta> = new Map(
  FEATURE_PLUGINS.map((m) => [m.id, m])
)

/** IPC 可见的插件快照（list() 显式挑字段：mounter 是函数，structuredClone 无法序列化） */
export interface FeaturePluginSnapshot {
  id: string
  name: string
  description: string
  version: string
  serviceKey: string
  enabled: boolean
  /** 当前是否已挂载（fiber 存活） */
  mounted: boolean
}

/** 状态文件（对齐 plugin-state.json：{dataRoot}/.feature-plugins.json）；
 * dataRoot 未设置（如无 pathContext 的测试环境）时返回 null，跳过读写 */
function stateFilePath(): string | null {
  const root = getDataRoot()
  return root ? join(root, '.feature-plugins.json') : null
}

/** ctx.featurePlugins：功能插件对象表的可枚举/可装卸 API（G3 真 fiber 化） */
export class FeaturePluginsService extends Service {
  private state: Record<string, boolean> = {}
  private listeners = new Set<() => void>()
  /** id → 已挂载 fiber（mount 成功才登记；unmount/失败即移除） */
  private fibers = new Map<string, Fiber>()

  constructor(ctx: Context) {
    super(ctx, 'featurePlugins')
    this.loadState()
  }

  /** 枚举全部功能插件（含启用状态 + 当前挂载状态；显式挑字段，mounter 不进 IPC） */
  list(): FeaturePluginSnapshot[] {
    return FEATURE_PLUGINS.map((meta) => ({
      id: meta.id,
      name: meta.name,
      description: meta.description,
      version: meta.version,
      serviceKey: meta.serviceKey,
      enabled: this.isEnabled(meta.id),
      mounted: this.isMounted(meta.id)
    }))
  }

  /** 查询某功能插件是否启用（未登记过状态则默认启用——行为零变化基线） */
  isEnabled(id: string): boolean {
    if (!FEATURE_PLUGIN_MAP.has(id)) return false
    return this.state[id] !== false
  }

  /** 查询某功能插件当前是否已挂载（fiber 存活） */
  isMounted(id: string): boolean {
    return this.fibers.has(id)
  }

  /**
   * 开关某功能插件：写状态 + 持久化 + 广播（状态层先行），再真实挂载/卸载 fiber。
   * - 状态相同 → 幂等返回（不装卸、不广播、不写冗余）
   * - 状态变更 → 装卸失败不影响状态（返回 error），重启后按状态文件挂载
   */
  async setEnabled(
    id: string,
    enabled: boolean
  ): Promise<{ ok: boolean; error?: string; fiber?: Fiber; mounted?: boolean }> {
    const meta = FEATURE_PLUGIN_MAP.get(id)
    if (!meta) return { ok: false, error: `功能插件 "${id}" 不存在` }
    const stateSame = this.isEnabled(id) === enabled
    const mountAligned = this.isMounted(id) === enabled
    // 状态与挂载都已对齐 → 纯幂等：不装卸、不广播、不写冗余
    if (stateSame && mountAligned) return { ok: true, mounted: enabled }
    // 状态未变但挂载未对齐（如默认启用但尚未挂载）：自愈装卸，但不广播/不持久化（状态未变）
    if (stateSame) {
      if (enabled) {
        const r = await this.mount(id)
        return { ok: r.ok, error: r.error, fiber: r.fiber, mounted: r.ok }
      }
      await this.unmount(id)
      return { ok: true, mounted: false }
    }
    // 状态变更：先改内存 + 持久化状态为真相，再装卸 fiber（装卸失败不影响状态，只返回 error）
    this.state[id] = enabled
    this.persistState()
    this.emit()
    if (enabled) {
      const r = await this.mount(id)
      return { ok: r.ok, error: r.error, fiber: r.fiber, mounted: r.ok }
    }
    await this.unmount(id)
    return { ok: true, mounted: false }
  }

  /**
   * 挂载单个功能插件（幂等：已挂载直接返回现有 fiber）。
   * fail-fast：mounter.apply 抛错向上返回 error，不中断其余插件。
   */
  async mount(id: string): Promise<{ ok: boolean; error?: string; fiber?: Fiber }> {
    const meta = FEATURE_PLUGIN_MAP.get(id)
    if (!meta) return { ok: false, error: `功能插件 "${id}" 不存在` }
    const existing = this.fibers.get(id)
    if (existing) return { ok: true, fiber: existing }
    try {
      // ctx.plugin() 同步返回 Fiber & PromiseLike；await 后 apply 完成（服务已注册、fiber ACTIVE）
      const fiber = await this.ctx.plugin(meta.mounter(this.ctx))
      this.fibers.set(id, fiber)
      return { ok: true, fiber }
    } catch (err) {
      return { ok: false, error: `功能插件 "${id}" 挂载失败：${(err as Error).message}` }
    }
  }

  /**
   * 卸载单个功能插件（幂等：未挂载直接 ok）。
   * fiber.dispose() 等待插件卸载完成（provide disposer 删 store 键 + notify 依赖者）。
   */
  async unmount(id: string): Promise<{ ok: boolean; error?: string }> {
    const fiber = this.fibers.get(id)
    if (!fiber) return { ok: true }
    try {
      await fiber.dispose()
    } catch (err) {
      // dispose 内部已吞错（fiber._unload 走 logger.error）；此处兜底不阻断状态层
      console.error(`[feature-plugins] 功能插件 "${id}" 卸载异常：${(err as Error).message}`)
    }
    this.fibers.delete(id)
    return { ok: true }
  }

  /**
   * 批量挂载所有功能插件（启动链 mountFeatureServices 使用）。
   * 先重读状态文件：dataRoot 此时已就绪（setPathContext 在 mountFeatureServices 之前），
   * 修复「状态文件在 createRootContext 同步期读不到 → 用户关闭的插件被重新挂载」的问题。
   * 返回全部 10 项结果：关闭项不挂载（mounted=false），调用方可见完整装卸状态。
   */
  async mountAll(): Promise<Array<{ id: string; ok: boolean; error?: string; mounted?: boolean }>> {
    this.loadState()
    const results: Array<{ id: string; ok: boolean; error?: string; mounted?: boolean }> = []
    for (const meta of FEATURE_PLUGINS) {
      if (!this.isEnabled(meta.id)) {
        results.push({ id: meta.id, ok: true, mounted: false })
        continue
      }
      const r = await this.mount(meta.id)
      results.push({ id: meta.id, ok: r.ok, error: r.error, mounted: r.ok })
    }
    return results
  }

  /** 订阅启用状态变更，返回退订函数 */
  onChanged(cb: () => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  private loadState(): void {
    const p = stateFilePath()
    if (!p || !existsSync(p)) return
    try {
      const raw = JSON.parse(readFileSync(p, 'utf-8'))
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return
      const validated: Record<string, boolean> = {}
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        // 白名单过滤（N3）：只接受声明表内 id 且为 boolean 的键，脏键/未知 id 丢弃
        if (FEATURE_PLUGIN_MAP.has(k) && typeof v === 'boolean') validated[k] = v
      }
      this.state = validated
    } catch (err) {
      console.error(`[feature-plugins] 状态文件解析失败（按默认全启用继续）：${(err as Error).message}`)
    }
  }

  private persistState(): void {
    try {
      const p = stateFilePath()
      if (!p) return
      // 路径收敛（N2）：dirname(p) 与 stateFilePath() 同源，不再二次取 getDataRoot()
      mkdirSync(dirname(p), { recursive: true })
      writeFileSync(p, JSON.stringify(this.state, null, 2), 'utf-8')
    } catch (err) {
      console.error(`[feature-plugins] 状态持久化失败：${(err as Error).message}`)
    }
  }

  private emit(): void {
    for (const cb of [...this.listeners]) {
      try {
        cb()
      } catch (err) {
        // N4：监听器异常不阻断服务，但留下诊断日志
        console.warn(`[feature-plugins] 状态变更监听器异常：${(err as Error).message}`)
      }
    }
  }
}