import { describe, it, expect } from 'vitest'
import { Context, Service, FiberState, type Plugin } from '../electron/main/vendor/cordis/index.ts'

/**
 * Cordis 内核 vendor 验证（阶段 1，2026-08-25）

 * 源码来自第三方 Cordis 模块框架（MIT 许可，随工程 vendor 引入本地）。
 * 本测试证明：Context(Proxy)/Service/事件四分发(emit-parallel-serial-bail-waterfall)/
 * inject 依赖/effect 可逆副作用 全部在月蚀进程内可用 —— 这是「兼容 Cordis 模块生态」的地基。

 * ⚠️ Cordis waterfall 真实契约（2026-08-25 实测确认）：
 *    `next()` 是无参委托——下游收到的参数是原始 dispatch args；监听器要改写数据
 *    必须修改共享对象（如 args 里的对象/数组），返回值可以被外层包装。

 * 若本文件用例失败：先检查 vendor/cordis/*.ts 的 import 是否全部指向本地，
 * vendor 后不应有任何 npm 外部依赖。
 */

// 测试事件类型扩展（Cordis 类型化事件的声明合并机制，插件同款用法）
declare module '../electron/main/vendor/cordis/events.ts' {
  interface Events {
    'test/emit'(value: number): void
    'test/parallel'(value: number): Promise<void> | void
    'test/serial'(value: number): boolean | void
    'test/bail'(value: number): string | number | null | undefined | void
    'test/waterfall'(state: { text: string }, next: () => string): string
  }
}

describe('Cordis 内核：Context 工厂', () => {
  it('root 自引用 + 内置服务就绪', () => {
    const ctx = new Context()
    expect(Context.is(ctx)).toBe(true)
    expect(ctx.root).toBe(ctx)
    expect(ctx.events).toBeDefined()
    expect(ctx.logger).toBeDefined()
    expect(ctx.registry).toBeDefined()
  })

  it('extend() 子上下文继承父属性且不污染父', () => {
    const ctx = new Context()
    const child = ctx.extend()
    expect(child.root).toBe(ctx.root)
    // 子 ctx 写属性不影响父
    ;(child as { marked?: boolean }).marked = true
    expect((ctx as { marked?: boolean }).marked).toBeUndefined()
  })
})

describe('Cordis 内核：Service 注册与生命周期', () => {
  it('插件内提供 Service，插件卸载后服务不可读', async () => {
    const ctx = new Context()
    class Demo extends Service {
      constructor(c: Context) {
        super(c, 'demo')
      }
      hello() {
        return 'hi'
      }
    }
    const provider: Plugin = {
      name: 'demo-provider',
      apply(c) {
        new Demo(c)
      }
    }
    await ctx.plugin(provider)
    // ctx 读取经 reflect 追踪（每次返回包装对象），验证行为而非恒等
    expect((ctx.demo as Demo).hello()).toBe('hi')
    expect((ctx.demo as Demo).name).toBe('demo')
    // 卸载提供方插件 → 服务随 fiber 移除
    ctx.registry.delete(provider)
    await new Promise((r) => setTimeout(r, 10))
    expect((ctx as { demo: unknown }).demo).toBeUndefined()
  })
})

describe('Cordis 内核：事件分发', () => {
  it('emit 按注册顺序同步观察', () => {
    const ctx = new Context()
    const order: number[] = []
    const d1 = ctx.on('test/emit', () => order.push(1))
    ctx.on('test/emit', () => order.push(2))
    ctx.emit('test/emit', 99)
    expect(order).toEqual([1, 2])
    // disposer 移除单个监听
    d1()
    order.length = 0
    ctx.emit('test/emit', 99)
    expect(order).toEqual([2])
  })

  it('parallel 并行等待全部监听（含 async）', async () => {
    const ctx = new Context()
    const done: string[] = []
    ctx.on('test/parallel', async () => {
      await new Promise((r) => setTimeout(r, 20))
      done.push('slow')
    })
    ctx.on('test/parallel', () => done.push('fast'))
    await ctx.parallel('test/parallel', 1)
    expect(done).toContain('slow')
    expect(done).toContain('fast')
  })

  it('serial 按序执行且首个 bail 值短路', async () => {
    const ctx = new Context()
    const order: number[] = []
    ctx.on('test/serial', () => {
      order.push(1)
      return false // 不 bail
    })
    ctx.on('test/serial', () => {
      order.push(2)
      return true // bail！后续不再执行
    })
    ctx.on('test/serial', () => order.push(3))
    const result = await ctx.serial('test/serial', 7)
    expect(result).toBe(true)
    expect(order).toEqual([1, 2])
  })

  it('bail 同步短路', () => {
    const ctx = new Context()
    const order: number[] = []
    ctx.on('test/bail', () => {
      order.push(1)
      return null
    })
    ctx.on('test/bail', () => {
      order.push(2)
      return 'stop'
    })
    ctx.on('test/bail', () => order.push(3))
    const result = ctx.bail('test/bail', 7)
    expect(result).toBe('stop')
    expect(order).toEqual([1, 2])
  })

  it('waterfall 环绕中间件：共享对象改写 + 返回值包装 + 短路', () => {
    const ctx = new Context()
    // 第一层：改写共享对象 + 包装返回值（大写）
    ctx.on('test/waterfall', (state, next) => {
      state.text += '!'
      const downstream = next()
      return downstream.toUpperCase()
    })
    // 第二层：改写共享对象，next() 无参透传
    ctx.on('test/waterfall', (state, next) => {
      state.text += '-inner'
      return next()
    })
    // 最终行为：接收共享状态，返回加工串
    const state = { text: 'base' }
    const result = ctx.waterfall('test/waterfall', state, (s) => s.text + '-final')
    expect(state.text).toBe('base!-inner')
    expect(result).toBe('BASE!-INNER-FINAL')
    // 短路：监听器不调 next() 则下游（含最终行为）全部跳过
    const ctx2 = new Context()
    let hitInner = false
    ctx2.on('test/waterfall', () => 'vetoed')
    ctx2.on('test/waterfall', (state, next) => {
      hitInner = true
      return next()
    })
    const shorted = ctx2.waterfall('test/waterfall', { text: 'x' }, (s) => s.text)
    expect(shorted).toBe('vetoed')
    expect(hitInner).toBe(false)
  })
})

describe('Cordis 内核：插件形态与 config', () => {
  it('对象插件 apply 接收 (ctx, config) 且 config 透传', async () => {
    const ctx = new Context()
    let received: unknown
    const plugin: Plugin = {
      name: 'test-config-plugin',
      apply(_c, config) {
        received = config
      }
    }
    const fiber = ctx.plugin(plugin, { alpha: 1 })
    await fiber
    expect(received).toEqual({ alpha: 1 })
    expect(fiber.state).toBe(FiberState.ACTIVE)
  })
})

describe('Cordis 内核：inject 依赖', () => {
  it('inject 声明的服务缺失时不激活，提供后激活', async () => {
    const ctx = new Context()
    class DepA extends Service {
      constructor(c: Context) {
        super(c, 'depA')
      }
    }
    const plugin: Plugin = {
      name: 'test-inject-plugin',
      inject: ['depA'],
      apply(c) {
        void (c as { depA: DepA }).depA // 引用即证明注入触达
      }
    }
    const fiber = ctx.plugin(plugin)
    // 关键断言：await 一个微任务后仍未激活（依赖缺失 → 挂起等待）
    await new Promise((r) => setTimeout(r, 10))
    expect(fiber.state).toBe(FiberState.PENDING)
    // 提供服务 → 依赖满足 → 激活
    new DepA(ctx)
    await fiber
    expect(fiber.state).toBe(FiberState.ACTIVE)
  })

  it('ctx.inject(deps, cb) 简写同样生效', async () => {
    const ctx = new Context()
    let activated = false
    class DepB extends Service {
      constructor(c: Context) {
        super(c, 'depB')
      }
    }
    new DepB(ctx)
    const fiber = ctx.inject(['depB'], () => {
      activated = true
    })
    await fiber
    expect(activated).toBe(true)
    expect(fiber.state).toBe(FiberState.ACTIVE)
  })
})

describe('Cordis 内核：effect 可逆副作用', () => {
  it('fiber 卸载时 disposer 逆序执行', async () => {
    const ctx = new Context()
    const order: string[] = []
    const plugin: Plugin = {
      name: 'test-effect-plugin',
      apply(c) {
        c.effect(() => {
          order.push('setup-1')
          return () => order.push('teardown-1')
        })
        c.effect(() => {
          order.push('setup-2')
          return () => order.push('teardown-2')
        })
      }
    }
    const fiber = ctx.plugin(plugin)
    await fiber
    expect(order).toEqual(['setup-1', 'setup-2'])
    ctx.registry.delete(plugin)
    await new Promise((r) => setTimeout(r, 10)) // dispose 异步
    // 逆序 tear down：后注册的先清理
    expect(order.slice(2)).toEqual(['teardown-2', 'teardown-1'])
  })

  it('registry.delete 卸载插件全部 fiber（热重载语义，兼证监听随 fiber 移除）', async () => {
    const ctx = new Context()
    let runs = 0
    const plugin: Plugin = {
      name: 'test-reload-plugin',
      apply(c) {
        runs++
        c.on('test/emit', () => runs++)
      }
    }
    await ctx.plugin(plugin)
    await ctx.plugin(plugin)
    expect(runs).toBe(2)
    ctx.registry.delete(plugin)
    await new Promise((r) => setTimeout(r, 10)) // dispose 异步
    ctx.emit('test/emit', 1)
    expect(runs).toBe(2) // 两个 fiber 的监听都已移除
  })
})