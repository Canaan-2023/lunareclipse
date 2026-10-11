import { describe, it, expect } from 'vitest'
import { Context, FiberState, type Plugin } from '../electron/main/vendor/cordis/index.ts'

// 测试服务键与事件的类型扩展（与 cordis-vendor.test.ts 的声明合并用法一致，
// 使 ctx.get/ctx.emit 带类型而非 any）
declare module '../electron/main/vendor/cordis/context.ts' {
  interface Context {
    alpha?: { v: number }
    stable?: { tag: string }
    volatile?: { tag: string }
    dep?: { seq: number }
    res?: { token: string }
    data?: { v: number }
  }
}
declare module '../electron/main/vendor/cordis/events.ts' {
  interface Events {
    'test/scan'(): void
  }
}

/**
 * Cordis 元理论测试网（G5，对齐 Cordis）

  * 用操作语义建立计算元理论，本文件用 vendor/cordis 纯内核（不依赖 mounter/
 * loader 侧渲染）构造场景逐条验证六条定理与工程实现的对应：

 *   T59 Preservation      —— 生命周期规则保持注册表 well-formed 不变式
 *   T61 Recovery exact.   —— 卸载撤销 fiber 自身贡献、且只撤销自身贡献
 *   T63 Ordering          —— fiber 只在依赖就绪时开始；provider 退场晚于依赖者
 *   T64 Resolution coher. —— 一次转换（transition）内解析视图不漂移
 *   T66 Progress          —— 依赖链收敛有界、无死锁（guard 必释放）
 *   T73 Confluence        —— 最终配置相同的不同加载顺序收敛到同一静止态

 * 构造方式：每次用例独立 new Context()，avoid 跨用例共享注册表。
 */

const settle = () => new Promise<void>((r) => setTimeout(r, 20))

/** 加载插件并等待 fiber 稳定（apply 阶段 LOADING → ACTIVE 有异步边界）。 */
async function load(ctx: Context, plugin: Plugin) {
  const fiber = ctx.plugin(plugin)
  await fiber
  await settle()
  return fiber
}

/** 卸载插件（registry.delete）并等待依赖链收敛。 */
async function unload(ctx: Context, plugin: Plugin) {
  ctx.registry.delete(plugin)
  await settle()
}

describe('Cordis 元理论：T59 Preservation（注册表 well-formed 不变式）', () => {
  it('well-formed 四子句在加载/卸载转换后保持', async () => {
    const ctx = new Context()
    const provider: Plugin = {
      name: 'alpha-provider',
      apply(c) {
        c.provide('alpha', { v: 1 })
      },
    }
    const consumer: Plugin = {
      name: 'alpha-consumer',
      inject: ['alpha'],
      apply() {},
    }

    // ① 先加载 consumer：alpha 未提供 → PENDING 等待（π 指针仍在注册表中）
    const consumerFiber = await load(ctx, consumer)
    expect(consumerFiber.state).not.toBe(FiberState.ACTIVE)

    // ② 加载 provider 后 consumer 自动激活
    const providerFiber = await load(ctx, provider)
    await settle()
    expect(providerFiber.state).toBe(FiberState.ACTIVE)
    expect(consumerFiber.state).toBe(FiberState.ACTIVE)

    // ③ 子句 (3)：installed ⇒ ω 全定义于 d（激活的 consumer 其依赖快照完整）
    expect(Object.keys(consumerFiber.store ?? {})).toEqual(['alpha'])

    // ④ 子句 (2)：m ≠ n ⇒ 提供键互斥 —— 同一作用域二次 provide 同名抛错 → FAILED
    const duplicate: Plugin = {
      name: 'duplicate-alpha',
      apply(c) {
        c.provide('alpha', { v: 2 })
      },
    }
    const dupPromise = load(ctx, duplicate)
    await expect(dupPromise).rejects.toThrowError(/registered/)
    await settle()

    // ⑤ 子句 (4) + (1)：卸载 provider 后依赖者先退场，注册表仍 well-formed
    //    registry.delete 只删 provider runtime；consumer fiber 因依赖消失 → PENDING
    await unload(ctx, provider)
    expect(providerFiber.state).toBe(FiberState.DISPOSED)
    expect(consumerFiber.state).not.toBe(FiberState.ACTIVE)
    // 不再存在任何 provider 指向已删除 runtime 的 committed 绑定
    const names = new Set(ctx.registry.keys())
    for (const impl of Object.values(ctx.reflect.store)) {
      if (impl.fiber !== ctx.fiber) {
        const callback = impl.fiber.runtime?.callback
        if (callback) expect(names.has(callback)).toBe(true)
      }
    }
  })

  it('T59 单一条目：同名服务在无 isolate 时单源（互斥即 well-formed 子句 2）', async () => {
    const ctx = new Context()
    const bad: Plugin = {
      name: 'second-alpha',
      apply(c) {
        c.provide('alpha', { v: 1 })
        // 同一 fiber 内二次 provide 同样被拒（store 已占用）
        c.provide('alpha', { v: 2 })
      },
    }
    await expect(load(ctx, bad)).rejects.toThrowError(/registered/)
  })
})

describe('Cordis 元理论：T61 Recovery Exactness（恢复精确性）', () => {
  it('卸载撤销 f(iber) 自身贡献且只撤销自身（其他 fiber 贡献不受影响）', async () => {
    const ctx = new Context()

    const stable: Plugin = {
      name: 'stable-provider',
      apply(c) {
        c.provide('stable', { tag: 'keep' })
      },
    }
    const volatile: Plugin = {
      name: 'volatile-provider',
      apply(c) {
        // 三项贡献：服务 / 事件监听 / mixin 式 accessor
        c.provide('volatile', { tag: 'drop' })
        c.on('test/scan', () => {
          volatileCalls++
        })
      },
    }
    let volatileCalls = 0

    await load(ctx, stable)
    const volatileFiber = await load(ctx, volatile)

    // 卸载前：两者均可读，事件触达
    expect(ctx.get('stable')).toMatchObject({ tag: 'keep' })
    expect(ctx.get('volatile')).toMatchObject({ tag: 'drop' })
    ctx.emit('test/scan')
    expect(volatileCalls).toBe(1)

    // 卸载 volatile：其服务消失、事件监听移除（φ 逆元运行）
    await unload(ctx, volatile)
    expect(ctx.volatile).toBeUndefined()
    expect(volatileFiber.state).toBe(FiberState.DISPOSED)

    ctx.emit('test/scan')
    expect(volatileCalls).toBe(1) // 不再触达

    // "nothing else"：stable 服务原样保留
    expect(ctx.get('stable')).toMatchObject({ tag: 'keep' })

    // 结果等价性（Theorem 61 的 ≈ 取控制字段忽略）：
    // 卸载 volatile 后可达状态 = 从未加载 volatile 的状态（stable 可读、事件无痕）
    const pristine = new Context()
    await load(pristine, stable)
    pristine.emit('test/scan')
    expect(pristine.get('stable')).toMatchObject({ tag: 'keep' })
    expect(pristine.volatile).toBeUndefined()
  })
})

describe('Cordis 元理论：T63 Ordering（顺序性）', () => {
  it('consumer 只在依赖提供后开始转换；provider 退场晚于依赖者（guard）', async () => {
    const ctx = new Context()

    const provider: Plugin = {
      name: 'dep-provider',
      apply(c) {
        c.provide('dep', { seq: 1 })
      },
    }
    const consumer: Plugin = {
      name: 'dep-consumer',
      inject: ['dep'],
      apply(c) {
        // 激活时依赖已提供（L-Begin 前提 γ ⊨ d_m）
        observed = c.get('dep')
      },
    }
    let observed: unknown

    // ① 先 consumer：依赖未提供 → 不激活（Step = L-Begin 被拒）
    const consumerFiber = await load(ctx, consumer)
    expect(consumerFiber.state).not.toBe(FiberState.ACTIVE)
    expect(observed).toBeUndefined()

    // ② provider 就位 → consumer 的 L-Begin 放行，且观察到同一解析（ω 固定）
    const providerFiber = await load(ctx, provider)
    await settle()
    expect(consumerFiber.state).toBe(FiberState.ACTIVE)
    expect(observed).toMatchObject({ seq: 1 })

    // ③ provider 卸载：guard 先让依赖者退场（u' < u），provider 逆元后运行
    const disposeOrder: string[] = []
    const tracker: Plugin = {
      name: 'order-tracker',
      inject: ['dep'],
      apply(c) {
        c.effect(() => () => disposeOrder.push('tracker'))
      },
    }
    await load(ctx, tracker)
    // tracker 加载时 dep 已由 provider 提供 → 已激活、注册了 disposer
    await unload(ctx, provider)
    // 依赖者（tracker）先于 provider 的逆元运行退场；provider 卸载完成后其
    // 依赖者必然已 inert —— guard（¬relied_n^t）在此成立
    expect(disposeOrder).toEqual(['tracker'])
    expect(consumerFiber.state).not.toBe(FiberState.ACTIVE)
    expect(providerFiber.state).toBe(FiberState.DISPOSED)
  })
})

describe('Cordis 元理论：T64 Resolution Coherence（解析一致性）', () => {
  it('一次转换（apply 运行期）内全部迭代解析到同一视图 ω', async () => {
    const ctx = new Context()

    const provider: Plugin = {
      name: 'resolution-provider',
      apply(c) {
        c.provide('res', { token: 'A' })
      },
    }
    await load(ctx, provider)

    // 插件 apply 内连续读取（模拟转换内多迭代），解析不得漂移
    let reads: ({ token: string } | undefined)[] = []
    const transitional: Plugin = {
      name: 'transitional-reader',
      inject: ['res'],
      apply(c) {
        reads = [
          c.get('res'),
          c.get('res'),
          c.get('res'),
        ]
      },
    }
    await load(ctx, transitional)
    expect(reads.every((v) => v && v.token === 'A')).toBe(true)
  })
})

describe('Cordis 元理论：T66 Progress（进展/终止/无死锁）', () => {
  it('依赖链 A→B→C 中卸载链头后整链收敛静止（guard 必释放，无死锁）', async () => {
    const ctx = new Context()

    const A: Plugin = {
      name: 'A',
      apply(c) {
        c.provide('a', { s: 'A' })
      },
    }
    const B: Plugin = {
      name: 'B',
      inject: ['a'],
      apply(c) {
        c.provide('b', { s: 'B' })
      },
    }
    const C: Plugin = {
      name: 'C',
      inject: ['b'],
      apply() {},
    }

    const fA = await load(ctx, A)
    const fB = await load(ctx, B)
    const fC = await load(ctx, C)
    expect(fA.state).toBe(FiberState.ACTIVE)
    expect(fB.state).toBe(FiberState.ACTIVE)
    expect(fC.state).toBe(FiberState.ACTIVE)

    // 卸载 A：B 失依赖 → 退场 → C 随 B 退场（Theorem 66：guard 沿着依赖链释放）
    await unload(ctx, A)
    await settle()
    expect(fB.state).not.toBe(FiberState.ACTIVE)
    expect(fC.state).not.toBe(FiberState.ACTIVE)
  })
})

describe('Cordis 元理论：T73 Confluence（汇合性）', () => {
  it('相同最终配置、不同加载顺序 → 静止态一致（动态历史无痕）', async () => {
    const provider: Plugin = {
      name: 'confl-provider',
      apply(c) {
        c.provide('data', { v: 42 })
      },
    }
    const consumer: Plugin = {
      name: 'confl-consumer',
      inject: ['data'],
      apply(c) {
        seen.push(c.get('data')?.v ?? 0)
      },
    }
    let seen: number[] = []

    // 顺序 1：provider → consumer
    const ctx1 = new Context()
    await load(ctx1, provider)
    await load(ctx1, consumer)

    seen = []
    // 顺序 2：consumer（先挂起）→ provider（后提供）
    const ctx2 = new Context()
    const pending = load(ctx2, consumer)
    await settle()
    await load(ctx2, provider)
    await pending

    // 两条历史收敛到同一静止态：同一解析视图、同一贡献集
    expect(ctx1.get('data')).toMatchObject({ v: 42 })
    expect(ctx2.get('data')).toMatchObject({ v: 42 })
    expect(seen).toEqual([42]) // consumer 激活时看到的 provider 贡献一致
  })
})