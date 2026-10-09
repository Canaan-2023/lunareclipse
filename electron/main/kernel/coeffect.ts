/**
 * 反应式 coeffect 服务表（LXK 内核，2026-08-18 对齐 Cordis 的最小落地）

 * 把「空间可组合性」实现为 reactive coeffects：组件声明它需要的上下文（inject），
 * 上下文变更时 notify 各组件并重新求值其激活/停用状态。这里做最小版：
 * - 服务键（realm 符号键）上的**可逆提供**：provide(key, value) 返回句柄，dispose 即移除
 * - **声明式依赖**：插件 manifest 声明 deps，加载时校验依赖是否已提供（缺则停用不崩）
 * - **反应式通知**：key 被提供/移除时，订阅方收到回调（loader 用它重载依赖方）

 * 与 ExtensionRegistry 同一哲学：注册即效应、卸载即回滚；signal provider 换主时依赖方重载。
 */
import { randomUUID } from 'crypto'
import type { ExtensionSource } from './extension'

/** 服务键（realm 符号键的字符串形态；如需强隔离可用命名空间前缀，如 `pkg:key`） */
export type CoeffectKey = string

/** 服务提供句柄（可逆效应） */
export interface CoeffectHandle<T = unknown> {
  /** 全局唯一 id */
  id: string
  key: CoeffectKey
  value: T
  source: ExtensionSource
  /** 调用后该提供失效 */
  dispose(): void
  disposed: boolean
}

/** 单个 key 的当前提供状态（自我检视用） */
export interface CoeffectStatus {
  key: CoeffectKey
  /** 当前生效的提供者（最新的未失效句柄）；无则 null */
  value: unknown
  source: ExtensionSource | null
  /** 全部未失效提供者数（含已被替换但未 dispose 的旧版） */
  providers: number
}

/** key 变更通知（提供或移除） */
export type CoeffectChangeListener = (key: CoeffectKey, kind: 'provide' | 'dispose') => void

export class CoeffectRegistry {
  private providers = new Map<CoeffectKey, CoeffectHandle[]>()
  private listeners = new Set<CoeffectChangeListener>()

  /**
   * 提供某服务键的实现，返回可逆句柄。
   * 同 key 可多次提供（后提供的生效）；dispose 句柄即移除该提供。
   * 若移除的是当前生效者，则回退到上一个未失效提供者（「provider 换主」）。
   */
  provide<T>(key: CoeffectKey, value: T, source: ExtensionSource): CoeffectHandle<T> {
    const handle: CoeffectHandle<T> = {
      id: `${key}:${source.kind === 'plugin' ? source.pluginName : source.kind}:${randomUUID().slice(0, 8)}`,
      key,
      value,
      source,
      disposed: false,
      dispose: () => {
        if (handle.disposed) return
        handle.disposed = true
        const list = this.providers.get(key)
        if (list) {
          const i = list.indexOf(handle as CoeffectHandle)
          if (i !== -1) list.splice(i, 1)
          if (list.length === 0) this.providers.delete(key)
        }
        this.emit(key, 'dispose')
      }
    }
    if (!this.providers.has(key)) this.providers.set(key, [])
    this.providers.get(key)!.push(handle as CoeffectHandle)
    this.emit(key, 'provide')
    return handle
  }

  /** 取某 key 当前生效值（最新未失效提供者）；无则 undefined */
  get<T = unknown>(key: CoeffectKey): T | undefined {
    const list = this.providers.get(key)
    if (!list || list.length === 0) return undefined
    const last = list[list.length - 1]
    return last.disposed ? undefined : (last.value as T)
  }

  /** 某 key 是否当前有生效提供者 */
  has(key: CoeffectKey): boolean {
    return this.get(key) !== undefined
  }

  /** 订阅 key 变更（提供/移除），返回退订函数 */
  onChanged(cb: CoeffectChangeListener): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  /** 列出所有有生效提供者的 key */
  listKeys(): CoeffectKey[] {
    return [...this.providers.keys()].filter((k) => this.has(k))
  }

  /** 自我检视：当前全部服务的提供状态 */
  inspect(): CoeffectStatus[] {
    const out: CoeffectStatus[] = []
    for (const [key, list] of this.providers) {
      out.push({
        key,
        value: list[list.length - 1]?.value,
        source: list[list.length - 1]?.source ?? null,
        providers: list.length
      })
    }
    return out
  }

  private emit(key: CoeffectKey, kind: 'provide' | 'dispose'): void {
    for (const cb of [...this.listeners]) {
      try {
        cb(key, kind)
      } catch {
        // 监听器异常不影响注册表
      }
    }
  }
}

/** 全局单例：与 kernelRegistry 配套，主进程启动时创建 */
export const coeffectRegistry = new CoeffectRegistry()
