/**
 * 插件加载器（模块系统）：扫描插件目录、解析 plugin.json、动态加载
 * tools.js / hooks.js / prompts.md / config.patch.json，把工具注册进
 * 统一工具池、模块注册进内核注册表，并维护启用状态与目录热重载；
 * 卸载/停用时可逆回滚全部副作用。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, watch, writeFileSync } from 'fs'
import { readFile } from 'fs/promises'
import { join, resolve, sep } from 'path'
import { pathToFileURL } from 'url'
import { getDataRoot } from '../models/path-context'
import type { AnyTool, ToolResult } from '../tools/base-tool'
import type { ToolCategory } from '@shared/types'
import {
  registerPluginToolMetas,
  unregisterPluginTools,
  type PluginToolMeta
} from '../../../shared/tools/registry'
import { coeffectRegistry, createRegistrar, kernelRegistry } from '../kernel'
import { loadHooksModule } from './module-hooks'
import { loadPromptsModule } from './module-prompts'
import { loadConfigPatchModule } from './module-config-patch'
import type { LoadedPlugin, PluginLoaderApi, PluginManifest, PluginSource, PluginToolMetaDecl, PluginToolModule } from './types'

/**
 * 插件加载器（模块系统）。

 * 扫描 abyssac_data/plugins 下的每个插件子目录：
 * 1. 读 plugin.json（缺省时用目录名兜底构造 manifest）
 * 2. 动态 import tools.js（CJS/ESM，导出工具对象数组）
 * 3. 包装成 AnyTool + 构造 ToolMeta，注册进 dynamicToolMetas
 * 4. 加载可选模块：hooks.js（函数 hook）/ prompts.md（提示词段）/ config.patch.json（配置覆盖），
 * 经内核统一注册表登记（kernel/registry），卸载/停用时批量回滚
 * 5. fs.watch 监听插件目录变化 → 热重载

 * 设计对齐 MCP 动态工具注册（registerMcpToolMetas 同机制）：
 * - isToolForAgent 对查不到 meta 的工具返回 false——插件必须注册 ToolMeta
 * - 工具池是"每次调用工厂时重建"的，插件加载后无需重启即生效

 * 启用状态持久化到 abyssac_data/plugins/.plugin-state.json（目录名 → enabled）
 */

/**
 * 插件根目录（完全本地化：{root}/plugins/{插件名}/）。
 * 插件是程序扩展而非用户数据，不按 {uid}/{aiId} 分层——本机安装一次，所有用户/AI 共享。
 */
export function getUserPluginsDir(): string {
  return join(getDataRoot(), 'plugins')
}

/**
 * 领域级插件目录：{root}/plugins_domains/{插件名}/
 * 按领域分类存放不同领域的插件，不跟工作区走（同样不按 {uid}/{aiId} 分层）。
 * 未登录时不再返回 null——领域级与用户级一样全局可见。
 */
export function getDomainPluginsDir(): string | null {
  return join(getDataRoot(), 'plugins_domains')
}

/** 插件状态文件（用户级，与用户级插件目录同位置） */
function stateFilePath(): string {
  return join(getUserPluginsDir(), '.plugin-state.json')
}

export class PluginLoader implements PluginLoaderApi {
  private plugins: LoadedPlugin[] = []
  private watchers: ReturnType<typeof watch>[] = []
  private reloadTimer?: ReturnType<typeof setTimeout>
  private changeCbs: Array<() => void> = []
  private state: Record<string, boolean> = {}
  /** coeffect 变更退订回调（destroy 时清理） */
  private coeffectUnsub?: () => void
  /** 「coeffect 服务 key → 声明依赖它的插件」反向表（反应式重载用） */
  private coDepends = new Map<string, Set<string>>()
  /**
   * Cordis 模块卸载回调（由 cordis-mounter 挂载成功时注册；未挂载为 undefined）。
   *
   * 为什么存在：插件目录删除（deletePlugin）必须遵循论文 Algorithm 5 的
   * O-Remove 语义——**先卸载插件运行时（drain 依赖者 → LIFO 逆回副作用），
   * 再从磁盘移除目录**。cordis fiber 的挂载/卸载完全属于 Cordis 域，loader
   * 不知道 fiber 的细节，只通过这个回调把「卸载该插件全部 fiber」委托给
   * mounter（它持有 fiber 引用并负责 await 落定）。
   * 作用：让 loader 无需 import vendor/cordis 类型即可参与 cordis 插件的删除流程。
   * 不删理由：缺少它，删除目录后 cordis fiber 仍挂在 rootCtx 上，依赖该插件
   * 服务的模块会继续读到已删除插件的服务（Theorem 63 的逆序破坏）；
   * 因 loader 与 mounter 互相解耦（mounter import loader 类型），唯有回调能打通。
   */
  private cordisUnloader?: (dirName: string) => Promise<void>
  /**
   * 注册 Cordis 模块卸载回调（mountCordisPlugins 调用；重复注册覆盖旧值幂等）。
   *
   * 为什么存在：注册时机在 mounter 首次挂载完成后，保证 loader 的删除流程
   * 只在实际挂载过 cordis 模块后才尝试卸载——纯 tools.js 插件没有 fiber，
   * 回调为空时 deletePlugin 直接跳过，行为零变化。
   * 作用：把「如何卸载一个插件的全部 cordis fiber」从 loader 依赖反转成
   * mounter 提供能力，避免 loader 反向 import mounter 造成循环依赖。
   * 不删理由：这是 loader ↔ mounter 之间唯一的删除联动通道。
   */
  setCordisUnloader(fn: (dirName: string) => Promise<void>): void {
    this.cordisUnloader = fn
  }
  /** state 复合键：source:dirName，隔离用户级/领域级同名插件的启用状态 */
  private static stateKey(source: PluginSource, dirName: string): string {
    return `${source}:${dirName}`
  }
  private reloadChain: Promise<void> = Promise.resolve()
  /** 领域级插件目录 getter 回调（对齐 SkillLoader 模式） */
  private getDomainPluginsDir: () => string | null
  /** 内置（bundled）插件目录 getter —— 源码 electron/main/plugins/bundled 或打包 resources/plugins/bundled。
   * 缺省返回 null（无内置层）；内置层只读，优先级最低（同名被 user/domain 覆盖） */
  private getBundledPluginsDir: () => string | null

  private reloadMutex<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.reloadChain.then(fn, fn)
    this.reloadChain = run.then(() => undefined, () => undefined)
    return run
  }

  constructor(getDomainPluginsDir?: () => string | null, getBundledPluginsDir?: () => string | null) {
    this.getDomainPluginsDir = getDomainPluginsDir ?? (() => null)
    this.getBundledPluginsDir = getBundledPluginsDir ?? (() => null)
    mkdirSync(getUserPluginsDir(), { recursive: true })
    this.loadState()
    this.startWatch()
    // 反应式 coeffect（2026-08-18，对齐 Cordis）：某服务被提供/移除时，重载依赖它的插件
    // 防抖（一次 reload 可能多次 provide/dispose）
    let debounce: ReturnType<typeof setTimeout> | undefined
    this.coeffectUnsub = coeffectRegistry.onChanged((key, kind) => {
      const dependents = this.coDepends.get(key)
      if (!dependents || dependents.size === 0) return
      void (async () => {
        if (debounce) clearTimeout(debounce)
        debounce = setTimeout(() => {
          const toReload = [...dependents].filter((dir) => this.plugins.some((p) => p.dirName === dir))
          if (toReload.length > 0) {
            void this.reloadSome(toReload, key, kind)
          }
        }, 150)
      })()
    })
  }

  getRootDir(): string {
    return getUserPluginsDir()
  }

  list(): LoadedPlugin[] {
    return this.plugins
  }

  getTools(): AnyTool[] {
    const tools: AnyTool[] = []
    for (const p of this.plugins) {
      if (p.enabled) tools.push(...p.tools)
    }
    return tools
  }

  async setEnabled(dirName: string, enabled: boolean): Promise<void> {
    return this.reloadMutex(async () => {
      const p = this.plugins.find((x) => x.dirName === dirName)
      if (!p) return
      if (p.enabled === enabled) return
      this.state[PluginLoader.stateKey(p.source, dirName)] = enabled
      this.persistState()

      if (enabled) {
        // 重新加载（工具 meta + 内核模块注册）
        const loaded = await this.loadOne(p.dirName, p.dirPath, p.source)
        const idx = this.plugins.findIndex((x) => x.dirName === dirName)
        if (idx !== -1) this.plugins[idx] = loaded
        registerPluginToolMetas(loaded.metas)
      } else {
        // 禁用：移除工具 meta + 回滚内核注册（可逆效应）
        unregisterPluginTools(dirName)
        for (const h of p.kernelHandles) {
          if (!h.disposed) h.dispose()
        }
        p.enabled = false
        p.kernelHandles = []
        p.loadedModules = []
      }
      // 启停也会改变依赖/提供声明集合（禁用插件不再算提供方），
      // 必须重建反向表，否则 onChanged 查不到依赖方、反应式重载失效
      this.rebuildCoDepends()
      this.emitChanged()
    })
  }

  async deletePlugin(dirName: string): Promise<{ ok: boolean; error?: string }> {
    return this.reloadMutex(async () => {
      const idx = this.plugins.findIndex((p) => p.dirName === dirName)
      if (idx === -1) return { ok: false, error: '插件不存在' }
      const p = this.plugins[idx]
      // 内置插件只读：不可删除（源码/打包目录不允许 rmSync）
      if (p.source === 'bundled') {
        return { ok: false, error: `内置插件 ${dirName} 不可删除（可禁用）` }
      }
      // 先删除目录：失败必须如实报错并保持插件原状态（不 splice、不注销工具），
      // 否则目录还在磁盘上，fs watch 500ms 后 reload() 会把它重新加载回来——
      // 前端看到的现象就是"删了又复活/删除无效"。
      // 与论文"先卸载后删除"的关系：论文约束的是**运行时卸载顺序**（drain 依赖者 →
      // LIFO 逆回自身副作用 → 持久状态失效），月蚀无法在卸载前删目录——目录若还在，
      // watch 会把它当"新增插件"复活，这是比论文更底层的文件系统约束；
      // 因此磁盘删除先行（保证删除动作不可逆），fiber 的运行时卸载紧随其后
      // （下面 cordisUnloader 段），卸载内部的依赖者退出顺序仍严格遵循论文。
      try {
        rmSync(p.dirPath, { recursive: true, force: true })
      } catch (err) {
        console.error(`[plugins] 删除插件目录失败: ${p.dirPath}`, (err as Error).message)
        return { ok: false, error: `删除插件目录失败：${(err as Error)?.message ?? '未知错误'}` }
      }
      // 目录已删除，再按论文 Algorithm 5 L-Unload 语义卸载 cordis fiber：
      // 先 drain 依赖者、LIFO 逆回自身副作用，再 await 落定（详见 vent/cordis-mounter.ts unloadOne）。
      // 为什么放在注销工具之前：fiber 内的 effect 可能持有工具/内核注册副作用，
      // 逆回卸载（dispose）会负责清理它们，先注销工具会导致 fiber 清理时找不到对应资源。
      // 为什么必须 await：不等待落定就继续，依赖该插件服务的模块仍可能在窗口期内
      // 读到已删除插件提供的服务（论文 Theorem 63 要求 key 在被依赖者完整卸载后才失效）。
      // 卸载失败的处理：仅记录并继续清理——目录已从磁盘删除、插件已不可用，
      // 残留的 fiber 由 cordis-mounter.resync（emitChanged 触发）幂等兜底清掉。
      if (this.cordisUnloader && (p.cordisEntry || p.cordisConfig)) {
        try {
          await this.cordisUnloader(dirName)
        } catch (err) {
          console.error(`[plugins] 卸载 ${dirName} 的 cordis fiber 失败（继续清理）`, err)
        }
      }
      // 目录已删除 + fiber 已卸载，再注销工具 + 回滚内核句柄
      unregisterPluginTools(dirName)
      for (const h of p.kernelHandles) {
        if (!h.disposed) h.dispose()
      }
      // 从列表移除
      this.plugins.splice(idx, 1)
      // 清理状态
      delete this.state[PluginLoader.stateKey(p.source, dirName)]
      this.persistState()
      // 重建 coeffect 反向表
      this.rebuildCoDepends()
      this.emitChanged()
      return { ok: true }
    })
  }

  /**
   * 订阅插件集变化（reload/setEnabled/delete 后触发）。
   * 返回退订函数：工具集重建等订阅方须在服务关闭时退订，否则重开服务会叠加旧监听
   * （旧监听持有的 toolExecutorsRef 已失效，重建到废弃引用上）。
   */
  onChanged(cb: () => void): () => void {
    this.changeCbs.push(cb)
    return () => {
      const i = this.changeCbs.indexOf(cb)
      if (i !== -1) this.changeCbs.splice(i, 1)
    }
  }

  /**
   * 热重载（事务化，2026-08-18 对齐 Cordis Algorithm 10 的事务性 reload）：
   * - 先全量加载到 staged，全部成功才统一提交（替换 this.plugins + 注册新 meta）
   * - 任一插件 loadOne 抛出未捕获异常 → 整个批次回滚：dispose staged 已注册副作用、
   * this.plugins 保持旧集、旧 meta 从未被清 —— 一个坏插件不会拖垮/残废整批。
   * - 插件自身的加载错误（tools.js 无导出/语法错等）收进 errors 属软失败，不中止其它。
   */
  async reload(): Promise<void> {
    return this.reloadMutex(async () => {
    // 旧状态快照（提交前不动 it，保证失败时系统保持旧插件集）
    const prevPlugins = this.plugins
    const staged: LoadedPlugin[] = []

    // ---- Phase A：全量加载（不提交，kernel 副作用暂记 staged.kernelHandles 以便回滚） ----
    try {
      const byName = new Map<string, LoadedPlugin>()
      // 收集三层所有目录名，用于跨层依赖解析（toposort 时 dependsOn 可能引用另一层的插件）
      const allDirNames: string[] = []
      // 内置（bundled）层扫描（优先级最低，同名被 user/domain 覆盖；只读、不可删除）
      const bundledRoot = this.getBundledPluginsDir()
      const bundledDirNames: string[] = []
      if (bundledRoot && existsSync(bundledRoot)) {
        const entries = readdirSync(bundledRoot, { withFileTypes: true })
        const dirs = entries
          .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
          .map((e) => e.name)
        bundledDirNames.push(...dirs)
        allDirNames.push(...dirs)
      }
      // 用户级扫描
      const userRoot = getUserPluginsDir()
      if (existsSync(userRoot)) {
        const entries = readdirSync(userRoot, { withFileTypes: true })
        const dirs = entries
          .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
          .map((e) => e.name)
        allDirNames.push(...dirs)
      }
      // 领域级扫描（优先级最高，覆盖用户级同名）
      const domainRoot = this.getDomainPluginsDir()
      const domainDirNames: string[] = []
      if (domainRoot && existsSync(domainRoot)) {
        const entries = readdirSync(domainRoot, { withFileTypes: true })
        const dirs = entries
          .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
          .map((e) => e.name)
        domainDirNames.push(...dirs)
        allDirNames.push(...dirs)
      }

      // 统一拓扑排序（跨层依赖可解析——领域级 dependsOn 用户级时能匹配）
      // 同名时高层级覆盖低层级——去重后只保留唯一版本进入排序，加载按优先级取路径
      const uniqueNames = [...new Set(allDirNames)]
      const sortedNames = this.toposort(uniqueNames, userRoot, domainRoot, bundledRoot)

      for (const dirName of sortedNames) {
        // 按优先级取路径：领域级 > 用户级 > 内置（同名覆盖）
        let dirPath: string | null = null
        let source: PluginSource = 'user'
        if (domainRoot && domainDirNames.includes(dirName)) {
          dirPath = join(domainRoot, dirName)
          source = 'domain'
        } else if (existsSync(join(userRoot, dirName))) {
          dirPath = join(userRoot, dirName)
          source = 'user'
        } else if (bundledRoot && bundledDirNames.includes(dirName)) {
          dirPath = join(bundledRoot, dirName)
          source = 'bundled'
        }
        if (!dirPath) continue
        const loaded = await this.loadOne(dirName, dirPath, source)
        byName.set(dirName, loaded)
      }
      staged.push(...byName.values())
    } catch (err) {
      // ---- Phase B-失败：回滚 staged 已发生的 kernel 副作用，保持旧集 ----
      for (const p of staged) {
        for (const h of p.kernelHandles) {
          if (!h.disposed) h.dispose()
        }
      }
      console.error(`[plugins] 事务性 reload 失败，回滚到旧插件集（${prevPlugins.length} 个）：`, (err as Error).message)
      // this.plugins 保持 prevPlugins；旧 meta 从未被 unregister、旧 handles 从未被 dispose
      this.emitChanged()
      return
    }

    // ---- Phase C：提交（全部加载成功才原子切换） ----
    // 放掉旧集的工具 meta + 内核句柄
    for (const p of prevPlugins) {
      unregisterPluginTools(p.dirName)
      for (const h of p.kernelHandles) {
        if (!h.disposed) h.dispose()
      }
    }
    this.plugins = staged
    // 注册新集工具 meta（enabled 才注册；软失败的插件带 errors 仍加载）
    for (const p of staged) {
      if (p.enabled) registerPluginToolMetas(p.metas)
    }
    // 禁用插件的内核模块（hooks/prompts/configPatch/panel）不应保持激活：
    // loadOne 总是加载全部模块（为后续 setEnabled(true) 准备），
    // 但禁用状态下内核注册不应生效，回滚这些句柄
    for (const p of staged) {
      if (!p.enabled && p.kernelHandles.length > 0) {
        for (const h of p.kernelHandles) {
          if (!h.disposed) h.dispose()
        }
        p.kernelHandles = []
      }
    }
    // 重建「coeffect 服务 key → 依赖插件」反向表（反应式重载依据）
    this.rebuildCoDepends()
    this.emitChanged()
    })
  }

  /** 重建 coDepends 反向表 + 统一 deps 校验：coeffect 服务 key → 声明依赖它的插件（react） */
  private rebuildCoDepends(): void {
    this.coDepends.clear()
    for (const p of this.plugins) {
      // 1) 本插件依赖的服务键 → 记「key → 本插件」
      for (const d of p.deps) {
        if (!this.coDepends.has(d)) this.coDepends.set(d, new Set())
        this.coDepends.get(d)!.add(p.dirName)
        // 统一 deps 校验（顺序无关）：缺依赖记警告（幂等），不中断
        const warn = `依赖的 coeffect 服务 "${d}" 当前未提供（需某插件 provide 该键）——插件保持加载但该依赖暂缺`
        const idx = p.errors.indexOf(warn)
        if (!coeffectRegistry.has(d) && idx === -1) p.errors.push(warn)
        if (coeffectRegistry.has(d) && idx !== -1) p.errors.splice(idx, 1)
      }
      // 2) 本插件提供的服务键 → 记「key → 依赖它的插件」的键集合（空集占位，保证服务键存在可查）
      for (const prov of p.provides) {
        if (!this.coDepends.has(prov)) this.coDepends.set(prov, new Set())
      }
    }
  }

  /**
   * 反应式重载：coeffect 服务 key 被提供/移除后，重载所有依赖它的插件（保持其它不变）。
   * 对应「上下文变更 notify 各 fiber 并重新求值」的最小落地。
   */
  private async reloadSome(dirNames: string[], key: string, kind: 'provide' | 'dispose'): Promise<void> {
    return this.reloadMutex(async () => {
    const toReload = dirNames.filter((d) => this.plugins.some((p) => p.dirName === d))
    if (toReload.length === 0) return
    try {
      for (const dirName of toReload) {
        const existing = this.plugins.find((p) => p.dirName === dirName)
        if (!existing || !existsSync(existing.dirPath)) continue
        const loaded = await this.loadOne(dirName, existing.dirPath, existing.source)
        const idx = this.plugins.findIndex((p) => p.dirName === dirName)
        if (idx !== -1) {
          // 放掉旧注册，替换为新加载
          unregisterPluginTools(dirName)
          for (const h of this.plugins[idx].kernelHandles) {
            if (!h.disposed) h.dispose()
          }
          this.plugins[idx] = loaded
          if (loaded.enabled) registerPluginToolMetas(loaded.metas)
        }
      }
      this.rebuildCoDepends()
      this.emitChanged()
      console.log(`[plugins] 反应式 coeffect：服务 "${key}" ${kind === 'provide' ? '提供' : '移除'}，已重载依赖插件 ${toReload.join(', ')}`)
    } catch (err) {
      console.error(`[plugins] 反应式重载 ${toReload.join(',')} 失败（保持旧态）：`, (err as Error).message)
    }
    })
  }

  /** dependsOn 拓扑排序：支持跨层依赖（领域级 dependsOn 用户级或反之）。
   * 被依赖次数少的先加载，环形依赖按目录序兜底。
   * @param dirNames 两层合并去重后的全部插件目录名
   * @param userRoot 用户级插件根目录
   * @param domainRoot 领域级插件根目录（可能为 null）
   */
  private toposort(dirNames: string[], userRoot: string, domainRoot: string | null, bundledRoot: string | null): string[] {
    const deps = new Map<string, string[]>()
    for (const dir of dirNames) {
      // 按优先级读 manifest：领域级 > 用户级 > 内置
      let raw: { dependsOn?: string[] } | null = null
      if (domainRoot) {
        const pPath = join(domainRoot, dir, 'plugin.json')
        if (existsSync(pPath)) {
          try {
            raw = JSON.parse(readFileSync(pPath, 'utf-8')) as { dependsOn?: string[] }
          } catch {
            // 解析失败视为无 dependsOn（软失败：坏 manifest 不阻断整体拓扑排序）
            raw = null
          }
        }
      }
      if (!raw) {
        const uPath = join(userRoot, dir, 'plugin.json')
        if (existsSync(uPath)) {
          try {
            raw = JSON.parse(readFileSync(uPath, 'utf-8')) as { dependsOn?: string[] }
          } catch {
            raw = null
          }
        }
      }
      if (!raw && bundledRoot) {
        const bPath = join(bundledRoot, dir, 'plugin.json')
        if (existsSync(bPath)) {
          try {
            raw = JSON.parse(readFileSync(bPath, 'utf-8')) as { dependsOn?: string[] }
          } catch {
            raw = null
          }
        }
      }
      deps.set(dir, Array.isArray(raw?.dependsOn) ? raw!.dependsOn!.filter((d) => dirNames.includes(d)) : [])
    }
    const visited = new Set<string>()
    const order: string[] = []
    const visit = (dir: string, stack: Set<string>): void => {
      if (visited.has(dir)) return
      if (stack.has(dir)) {
        throw new Error(`插件存在环形依赖：${[...stack, dir].join(' → ')}`)
      }
      stack.add(dir)
      for (const dep of deps.get(dir) ?? []) visit(dep, stack)
      stack.delete(dir)
      visited.add(dir)
      order.push(dir)
    }
    for (const dir of dirNames) visit(dir, new Set())
    return order
  }

  private async loadOne(dirName: string, dirPath: string, source: PluginSource): Promise<LoadedPlugin> {
    const errors: string[] = []
    const manifest = await this.readManifest(dirPath, dirName, errors)
    const enabled = this.state[PluginLoader.stateKey(source, dirName)] !== false

    // 禁用插件不执行任何代码（top-level import / register() / hooks）
    if (!enabled) {
      return {
        dirName,
        dirPath,
        source,
        manifest,
        tools: [],
        metas: [],
        errors,
        kernelHandles: [],
loadedModules: [],
        cordisEntry: undefined,
        cordisConfig: undefined,
        cordisIsolate: undefined,
        cordisIntercept: undefined,
        enabled: false,
        provides: Array.isArray(manifest.provides) ? manifest.provides : [],
        deps: Array.isArray(manifest.deps) ? manifest.deps : [],
        panel: manifest.panel
      }
    }

    let tools: AnyTool[] = []
    let metas: PluginToolMeta[] = []

    // 加载 tools.js（可选——插件可能只提供元数据/以后扩展非工具能力）
    // [SECURITY] import() 在主进程执行，插件代码拥有完整 Node.js 权限（fs/child_process）。
    // 信任边界：插件来源必须由用户主动安装并信任。Worker thread 隔离会破坏 coeffect 注入模型，
    // 当前接受该风险并依赖插件来源信任（与 hook-manager vm 沙箱不在同一信任层）。
    const toolsFile = join(dirPath, 'tools.js')
    if (existsSync(toolsFile)) {
      // ESM import() 兼容 ESM/CJS；时间戳 query 绕过模块缓存保证热重载
      const fileUrl = `${pathToFileURL(toolsFile).href}?t=${Date.now()}`
      let arr: PluginToolModule = []
      try {
        const mod = (await import(/* @vite-ignore */ fileUrl)) as { default?: PluginToolModule } | PluginToolModule
        arr = Array.isArray(mod) ? mod : Array.isArray(mod.default) ? mod.default : []
      } catch (err) {
        // 软失败：tools.js 导入异常（语法错/抛错等）收进 errors，不拖垮其他插件
        errors.push(`tools.js 导入失败：${err instanceof Error ? err.message : String(err)}`)
      }
      if (arr.length === 0 && errors.length === 0) {
        errors.push('tools.js 未导出工具数组（需 module.exports = [...] 或 export default [...]）')
      }
      tools = arr.map((t, i) => this.toAnyTool(t, dirName, errors, i))
      // 构造 ToolMeta：manifest 声明优先，缺省从工具推导
      metas = this.buildMetas(dirName, tools, manifest.tools, errors)
    } else if (manifest.tools && manifest.tools.length > 0) {
      errors.push('manifest 声明了 tools 但没有 tools.js 文件')
    }

    // 加载可选模块（hooks.js / prompts.md / config.patch.json）→ 内核统一注册表
    const kernelHandles: Array<{ disposed: boolean; dispose(): void }> = []
    const loadedModules: string[] = []
    const dataRoot = join(getDataRoot(), 'plugins')
    const hooksHandles = await loadHooksModule(dirPath, dirName, dataRoot, errors)
    if (hooksHandles.length > 0) {
      kernelHandles.push(...hooksHandles)
      loadedModules.push('hooks.js')
    }
    const promptHandles = loadPromptsModule(dirPath, dirName, errors)
    if (promptHandles.length > 0) {
      kernelHandles.push(...promptHandles)
      loadedModules.push('prompts.md')
    }
    const patchHandles = loadConfigPatchModule(dirPath, dirName, errors)
    if (patchHandles.length > 0) {
      kernelHandles.push(...patchHandles)
      loadedModules.push('config.patch.json')
    }

    // Cordis 模块入口（阶段 5a）：只解析路径 + config（不 import——挂载由 cordis-mounter
    // 在 rootCtx 就绪后执行，import 时机与热重载语义归 mounter 管）
    let cordisEntry: string | undefined
    let cordisConfig: Record<string, unknown> | undefined
    if (manifest.cordis) {
      const resolvedEntry = resolve(dirPath, manifest.cordis.entry)
      if (resolvedEntry !== dirPath && !resolvedEntry.startsWith(dirPath + sep)) {
        errors.push(`cordis 入口路径越界: ${manifest.cordis.entry}（须在插件目录内）`)
      } else if (!existsSync(resolvedEntry)) {
        errors.push(`cordis 入口 ${manifest.cordis.entry} 不存在（plugins/${dirName}/）`)
      } else {
        cordisEntry = resolvedEntry
        cordisConfig = manifest.cordis.config
      }
    }

    // deps/provides 解析（实际校验在提交后统一做——依赖加载顺序无关，见 validateDeps）
    const deps = Array.isArray(manifest.deps) ? manifest.deps : []

    // 面板声明注册到内核（manifest.panel 声明时）
    const panel = manifest.panel
    if (panel && panel.id && panel.component) {
      const { reg, handles } = createRegistrar(kernelRegistry, { kind: 'plugin', pluginName: dirName })
      reg.registerPanel({
        id: panel.id,
        title: panel.title || dirName,
        icon: panel.icon || 'LayoutGrid',
        component: panel.component
      })
      kernelHandles.push(...handles)
      if (!loadedModules.includes('panel')) loadedModules.push('panel')
    }

    return {
      dirName,
      dirPath,
      source,
      manifest,
      tools,
      metas,
      errors,
      kernelHandles,
loadedModules,
      cordisEntry,
      cordisConfig,
      cordisIsolate: manifest.cordis?.isolate,
      cordisIntercept: manifest.cordis?.intercept,
      enabled,
      provides: Array.isArray(manifest.provides) ? manifest.provides : [],
      deps,
      panel
    }
  }

  private async readManifest(dirPath: string, dirName: string, errors: string[]): Promise<PluginManifest> {
    const manifestPath = join(dirPath, 'plugin.json')
    if (!existsSync(manifestPath)) {
      return { name: dirName, description: '', version: '0.0.0' }
    }
    // JSON.parse 语法错误必须软失败：日志记录 + 兜底 manifest，
    // 否则单个坏 plugin.json 会让 reload() 整批回滚、连带清掉其他插件变更
    let raw: Partial<PluginManifest>
    try {
      raw = JSON.parse(await readFile(manifestPath, 'utf-8')) as Partial<PluginManifest>
    } catch (err) {
      errors.push(`plugin.json 解析失败: ${(err as Error).message}（按缺失 manifest 兜底）`)
      return { name: dirName, description: '', version: '0.0.0' }
    }
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      errors.push('plugin.json 顶层结构无效（需为对象）')
      return { name: dirName, description: '', version: '0.0.0' }
    }
    const validated = raw as Record<string, unknown>

    let cordis: PluginManifest['cordis'] | undefined
    if (validated.cordis && typeof validated.cordis === 'object') {
      const c = validated.cordis as Record<string, unknown>
      if (typeof c.entry === 'string') {
        const cfg = c.config
        const iso = c.isolate
        const inter = c.intercept
        cordis = {
          entry: c.entry,
          config: (cfg && typeof cfg === 'object' && !Array.isArray(cfg))
            ? cfg as Record<string, unknown>
            : undefined,
          isolate: (iso && typeof iso === 'object' && !Array.isArray(iso))
            ? Object.fromEntries(
                Object.entries(iso as Record<string, unknown>).filter(([, v]) => typeof v === 'string')
              ) as Record<string, string>
            : undefined,
          intercept: (inter && typeof inter === 'object' && !Array.isArray(inter))
            ? inter as Record<string, unknown>
            : undefined
        }
      }
    }

    let panel: PluginManifest['panel'] | undefined
    if (validated.panel && typeof validated.panel === 'object') {
      const p = validated.panel as Record<string, unknown>
      if (typeof p.id === 'string' && typeof p.component === 'string') {
        panel = {
          id: p.id,
          title: typeof p.title === 'string' ? p.title : undefined,
          icon: typeof p.icon === 'string' ? p.icon : undefined,
          component: p.component
        }
      }
    }

    return {
      name: typeof validated.name === 'string' ? validated.name : dirName,
      description: typeof validated.description === 'string' ? validated.description : '',
      version: typeof validated.version === 'string' ? validated.version : '0.0.0',
      author: typeof validated.author === 'string' ? validated.author : undefined,
      tools: Array.isArray(validated.tools) ? validated.tools : undefined,
      dependsOn: Array.isArray(validated.dependsOn) ? validated.dependsOn : undefined,
      provides: Array.isArray(validated.provides) ? validated.provides : undefined,
      deps: Array.isArray(validated.deps) ? validated.deps : undefined,
      cordis,
      panel
    }
  }

  private toAnyTool(t: PluginToolModule[number], dirName: string, errors: string[], index: number): AnyTool {
    const name = String(t.name ?? '').trim()
    if (!name) {
      errors.push('tools.js 有工具缺少 name')
      return { name: `__invalid_${dirName}_${index}`, description: '无效工具（缺 name）', parameters: [], execute: async () => ({ ok: false, error: '无效工具' }) }
    }
    const params = Array.isArray(t.parameters) ? t.parameters : []
    return {
      name,
      description: String(t.description ?? ''),
      parameters: params,
      execute: async (p: Record<string, unknown>, ctx?: unknown): Promise<ToolResult> => {
        try {
          const r = await t.execute(p, ctx)
          return r
        } catch (err) {
          return { ok: false, error: (err as Error).message }
        }
      }
    }
  }

  private buildMetas(
    dirName: string,
    tools: AnyTool[],
    declared: PluginToolMetaDecl[] | undefined,
    errors: string[]
  ): PluginToolMeta[] {
    const metas: PluginToolMeta[] = []
    const declMap = new Map((declared ?? []).map((d) => [d.id, d]))
    for (const tool of tools) {
      const decl = declMap.get(tool.name)
      const category = (decl?.category ?? 'plugin') as ToolCategory
      metas.push({
        id: tool.name,
        name: decl?.name ?? tool.name,
        category,
        description: decl?.description ?? tool.description,
        defaultEnabled: decl?.defaultEnabled ?? true,
        riskLevel: decl?.riskLevel ?? 'low',
        agents: decl?.agents ?? ['frontend'],
        caps: decl?.caps,
        source: 'plugin',
        plugin: dirName
      })
    }
    // manifest 声明了但 tools.js 没导出的 → 提示
    if (declared) {
      const exported = new Set(tools.map((t) => t.name))
      for (const d of declared) {
        if (!exported.has(d.id)) {
          errors.push(`manifest 声明工具 ${d.id} 但 tools.js 未导出`)
        }
      }
    }
    return metas
  }

  private loadState(): void {
    const p = stateFilePath()
    if (existsSync(p)) {
      const raw = JSON.parse(readFileSync(p, 'utf-8'))
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        this.state = {}
        return
      }
      const validated: Record<string, boolean> = {}
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof v === 'boolean') validated[k] = v
      }
      this.state = validated
    }
  }

  private persistState(): void {
    writeFileSync(stateFilePath(), JSON.stringify(this.state, null, 2), 'utf-8')
  }

  private startWatch(): void {
    // 先关闭旧 watchers
    for (const w of this.watchers) {
      try { w.close() } catch { /* 忽略关闭错误 */ }
    }
    this.watchers = []

    const dirs = [getUserPluginsDir()]
    const domainDir = this.getDomainPluginsDir()
    if (domainDir) dirs.push(domainDir)

    for (const dir of dirs) {
      if (!existsSync(dir)) continue
      const w = watch(dir, { recursive: true }, () => {
        if (this.reloadTimer) clearTimeout(this.reloadTimer)
        // 500ms 防抖（目录变化可能连续触发）
        this.reloadTimer = setTimeout(() => void this.reload(), 500)
      })
      this.watchers.push(w)
    }
  }

  private emitChanged(): void {
    for (const cb of this.changeCbs) cb()
  }

  destroy(): void {
    for (const w of this.watchers) {
      try { w.close() } catch { /* 忽略关闭错误 */ }
    }
    this.watchers = []
    if (this.reloadTimer) clearTimeout(this.reloadTimer)
    if (this.coeffectUnsub) {
      this.coeffectUnsub()
      this.coeffectUnsub = undefined
    }
    this.coDepends.clear()
    for (const p of this.plugins) {
      unregisterPluginTools(p.dirName)
      for (const h of p.kernelHandles) {
        if (!h.disposed) h.dispose()
      }
    }
    this.plugins = []
  }
}

