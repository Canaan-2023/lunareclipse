/**
 * 统一扩展注册表（ExtensionRegistry）

 * 真相源：所有扩展（工具/hook/prompt/配置覆盖/命令）在此登记，
 * 消费方（HookManager / 提示词装配 / 工具工厂）查询而非各自持有。

 * 可逆效应：register 返回句柄，dispose() 使注册失效；
 * disposeBySource() 批量回滚（插件卸载 / patch 停用）。
 */
import { randomUUID } from 'crypto'
import type {
  ExtensionHandle,
  ExtensionKind,
  ExtensionSource,
  RegistrySnapshot
} from './extension'

/** 变更订阅回调 */
export type RegistryChangeListener = (kind: ExtensionKind) => void

export class ExtensionRegistry {
  private handles = new Map<ExtensionKind, ExtensionHandle[]>()
  private listeners = new Map<ExtensionKind, Set<RegistryChangeListener>>()

  /** 注册任意扩展，返回可逆效应句柄 */
  register<T>(
    kind: ExtensionKind,
    source: ExtensionSource,
    value: T,
    id?: string
  ): ExtensionHandle<T> {
    const finalId =
      id ?? `${kind}:${source.kind === 'plugin' ? source.pluginName : source.kind}:${randomUUID().slice(0, 8)}`
    const handle: ExtensionHandle<T> = {
      id: finalId,
      kind,
      source,
      value,
      disposed: false,
      dispose: () => this.unregister(kind, finalId)
    }
    if (!this.handles.has(kind)) this.handles.set(kind, [])
    this.handles.get(kind)!.push(handle as ExtensionHandle)
    this.emit(kind)
    return handle
  }

  /** 按类别取全部注册值（未失效的） */
  get<T>(kind: ExtensionKind): T[] {
    return (this.handles.get(kind) ?? [])
      .filter((h) => !h.disposed)
      .map((h) => h.value as T)
  }

  /** 按类别 + 来源取注册值 */
  getBySource<T>(kind: ExtensionKind, source: ExtensionSource): T[] {
    return (this.handles.get(kind) ?? [])
      .filter((h) => !h.disposed && this.sameSource(h.source, source))
      .map((h) => h.value as T)
  }

  /** 取带来源的原始句柄（自我检视 / 管理工具用） */
  getHandles(kind: ExtensionKind): ExtensionHandle[] {
    return (this.handles.get(kind) ?? []).filter((h) => !h.disposed)
  }

  /** 批量回滚某来源的全部注册，返回回滚数量 */
  disposeBySource(source: ExtensionSource): number {
    let count = 0
    for (const kind of this.handles.keys()) {
      const list = this.handles.get(kind)!
      for (const h of [...list]) {
        if (!h.disposed && this.sameSource(h.source, source)) {
          h.dispose()
          count++
        }
      }
    }
    return count
  }

  /** 订阅变更，返回退订函数 */
  onChanged(kind: ExtensionKind, cb: RegistryChangeListener): () => void {
    if (!this.listeners.has(kind)) this.listeners.set(kind, new Set())
    this.listeners.get(kind)!.add(cb)
    return () => this.listeners.get(kind)?.delete(cb)
  }

  /** 自我检视快照 */
  inspect(): RegistrySnapshot {
    const counts = { tool: 0, hook: 0, prompt: 0, configPatch: 0, command: 0, panel: 0 } as Record<ExtensionKind, number>
    const bySource: Record<string, number> = {}
    const hooks: RegistrySnapshot['hooks'] = []
    const tools: RegistrySnapshot['tools'] = []
    const prompts: RegistrySnapshot['prompts'] = []
    const configPatches: RegistrySnapshot['configPatches'] = []
    const commands: RegistrySnapshot['commands'] = []
    const panels: RegistrySnapshot['panels'] = []

    for (const kind of ['tool', 'hook', 'prompt', 'configPatch', 'command', 'panel'] as ExtensionKind[]) {
      for (const h of this.getHandles(kind)) {
        counts[kind]++
        const srcKey = h.source.kind === 'plugin' ? `plugin:${h.source.pluginName}` : h.source.kind
        bySource[srcKey] = (bySource[srcKey] ?? 0) + 1
        const src = h.source
        if (kind === 'hook') {
          const v = h.value as { event: string; matcher?: string }
          hooks.push({ id: h.id, event: v.event, matcher: v.matcher, source: src })
        } else if (kind === 'tool') {
          const v = h.value as { name: string }
          tools.push({ id: h.id, name: v.name, source: src })
        } else if (kind === 'prompt') {
          const v = h.value as { name: string }
          prompts.push({ id: h.id, name: v.name, source: src })
        } else if (kind === 'configPatch') {
          configPatches.push({ id: h.id, source: src })
        } else if (kind === 'panel') {
          const v = h.value as { id: string; title: string; icon: string; component: string }
          panels.push({ id: v.id, title: v.title, icon: v.icon, component: v.component, source: src })
        } else {
          const v = h.value as { id: string }
          commands.push({ id: v.id, source: src })
        }
      }
    }

    return { counts, bySource, hooks, tools, prompts, configPatches, commands, panels }
  }

  private unregister(kind: ExtensionKind, id: string): void {
    const list = this.handles.get(kind)
    if (!list) return
    const idx = list.findIndex((h) => h.id === id)
    if (idx === -1) return
    const handle = list[idx]
    handle.disposed = true
    list.splice(idx, 1)
    this.emit(kind)
  }

  private sameSource(a: ExtensionSource, b: ExtensionSource): boolean {
    if (a.kind !== b.kind) return false
    if (a.kind === 'plugin' && b.kind === 'plugin') return a.pluginName === b.pluginName
    return true
  }

  private emit(kind: ExtensionKind): void {
    const set = this.listeners.get(kind)
    if (!set) return
    for (const cb of [...set]) {
      try {
        cb(kind)
      } catch {
        // 监听器异常不影响注册表
      }
    }
  }
}

/** 全局单例：主进程启动时创建，注入各处消费方 */
export const kernelRegistry = new ExtensionRegistry()
