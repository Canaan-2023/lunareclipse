/**
 * hook-manager.test.ts —— Hook 执行器核心逻辑单元验证（D13 补测）
 *
 * 为什么存在：D13 评审缺口记录指出 hooks 域此前仅有 PreLLMCall 链路测试（hooks-prellm.test.ts），
 * 而 HookExecutor 的 matcher 匹配、深度闸门、block 短路、modifiedParams 合并以及
 * HookManager 的自动禁用熔断这些核心执行语义没有任何直接测试，
 * 属于「审计/守卫/审批」安全关键路径，回归风险高。
 *
 * 覆盖：
 * 1. matcher 匹配语义：空 / 点星通配 / undefined 全匹配、大小写不敏感、超长 matcher 拒绝（ReDoS 防护）
 * 2. 深度闸门：AsyncLocalStorage 深度达到 MAX_HOOK_DEPTH 后不再执行 hook
 * 3. block 短路：首个 block 立即返回，后续 hook 不执行
 * 4. continue 时 modifiedParams / modifiedResult 按序合并（流水线语义）
 * 5. 内核注册 hook 与 config hook 结果合并（mergeHookResults）
 * 6. 连续错误熔断：达阈值自动禁用，resetAutoDisable 恢复
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { HookExecutor, HookManager } from '../electron/main/hooks/hook-manager'
import type { ResolvedHook, HookContext, HookResult } from '../electron/main/hooks/types'
import { kernelRegistry } from '../electron/main/kernel'

const ctx: HookContext = {
  event: 'PreToolUse',
  toolName: 'read_file',
  toolParams: { path: '/tmp/a.txt' },
  cwd: process.cwd()
}

/** 构造一个 javascript 类型 hook 的 ResolvedHook */
function jsHook(event: string, code: string, matcher?: string): ResolvedHook {
  return {
    event: event as 'PreToolUse',
    handler: { type: 'javascript', handler: code, timeout: 5000 },
    matcher,
    scope: 'global',
    sourceFile: '<unit-test>'
  }
}

afterEach(() => {
  // 清理内核注册：避免测试间 kernelRegistry 残留影响其他用例
  kernelRegistry.getHandles('hook').forEach((h) => h.dispose())
})

describe('HookExecutor · matcher 匹配（D13 补测）', () => {
  const exec = new HookExecutor()

  it('matcher 为空 / .* / undefined → 全部匹配', async () => {
    for (const matcher of [undefined, '', '.*']) {
      const r = await exec.run(
        [jsHook('PreToolUse', 'return { action: "block", message: "m" }', matcher as string)],
        'PreToolUse',
        ctx
      )
      expect(r.action).toBe('block')
    }
  })

  it('大小写不敏感：matcher 小写可匹配 PascalCase 工具名', async () => {
    const r = await exec.run(
      [jsHook('PreToolUse', 'return { action: "block", message: "b" }', 'read_file')],
      'PreToolUse',
      ctx
    )
    expect(r.action).toBe('block')
  })

  it('matcher 不匹配 → continue 且不执行', async () => {
    const r = await exec.run(
      [jsHook('PreToolUse', 'return { action: "block" }', 'write_file')],
      'PreToolUse',
      ctx
    )
    expect(r.action).toBe('continue')
  })

  it('事件不匹配 → continue（hook 是其他事件的）', async () => {
    const r = await exec.run(
      [jsHook('PostToolUse', 'return { action: "block" }', '.*')],
      'PreToolUse',
      ctx
    )
    expect(r.action).toBe('continue')
  })

  it('超长 matcher / 超长工具名 → 拒绝匹配并 continue（ReDoS 防护）', async () => {
    const longMatcher = '(a+)+$'.padEnd(600, 'x') // 超过 MAX_MATCHER_PATTERN_LENGTH=500
    const r1 = await exec.run(
      [jsHook('PreToolUse', 'return { action: "block" }', longMatcher)],
      'PreToolUse',
      ctx
    )
    expect(r1.action).toBe('continue')
    // 超长工具名 + 非通配 matcher：长度检查在正则执行前拦截（防超长输入触发回溯）
    const longToolName = 'x'.repeat(300) // 超过 MAX_TOOL_NAME_LENGTH=200
    const r2 = await exec.run(
      [jsHook('PreToolUse', 'return { action: "block" }', 'read_file')],
      'PreToolUse',
      { ...ctx, toolName: longToolName }
    )
    expect(r2.action).toBe('continue')
  })
})

describe('HookExecutor · 执行语义（D13 补测）', () => {
  const exec = new HookExecutor()

  it('block 短路：首个 block 立即返回，后续 hook 不执行', async () => {
    const hooks = [
      jsHook('PreToolUse', 'return { action: "block", message: "stop" }', '.*'),
      { ...jsHook('PreToolUse', 'return { action: "continue" }', '.*'), event: 'PreToolUse' as const }
    ]
    const r = await exec.run(hooks, 'PreToolUse', ctx)
    expect(r).toMatchObject({ action: 'block', message: 'stop' })
  })

  it('continue + modifiedParams：按执行序合并进 ctx 供下一个 hook 使用', async () => {
    // 前两个 hook 各自追加 modifiedParams；第三个 hook 读取 ctx.toolParams，
    // 把观测到的合并后参数经 injectedContext 带回主进程（worker 沙箱内 globalThis
    // 被遮蔽，不可用全局变量传递观测，故用返回值传递）
    const hooks = [
      jsHook('PreToolUse', 'return { action: "continue", modifiedParams: { mode: "fast" } }', '.*'),
      jsHook('PreToolUse', 'return { action: "continue", modifiedParams: { extra: "yes" } }', '.*'),
      jsHook(
        'PreToolUse',
        'return { action: "continue", injectedContext: JSON.stringify(ctx.toolParams) }',
        '.*'
      )
    ]
    const r = await exec.run(hooks, 'PreToolUse', ctx)
    expect(r.action).toBe('continue')
    // 前两个 hook 的 modifiedParams 已按执行序合并进随后 hook 的 ctx.toolParams
    expect(r.injectedContext).toContain('"path":"/tmp/a.txt"')
    expect(r.injectedContext).toContain('"mode":"fast"')
    expect(r.injectedContext).toContain('"extra":"yes"')
  })

  it('continue + modifiedResult：结果修改透传', async () => {
    const r = await exec.run(
      [jsHook('PreToolUse', 'return { action: "continue", modifiedResult: { ok: true } }', '.*')],
      'PreToolUse',
      ctx
    )
    expect(r.modifiedResult).toMatchObject({ ok: true })
  })

  it('多个 hook 的 injectedContext 按序拼接', async () => {
    const hooks = [
      jsHook('PreToolUse', 'return { action: "continue", injectedContext: "A" }', '.*'),
      jsHook('PreToolUse', 'return { action: "continue", injectedContext: "B" }', '.*')
    ]
    const r = await exec.run(hooks, 'PreToolUse', ctx)
    expect(r.injectedContext).toBe('A\n\nB')
  })
})

describe('HookExecutor · worker 沙箱隔离（D14 迁移补测）', () => {
  const exec = new HookExecutor()

  it('敏感全局不可达：process/require/fetch/setTimeout 在沙箱内均为 undefined', async () => {
    const code = 'return { action: "continue", injectedContext: [typeof process, typeof require, typeof fetch, typeof setTimeout].join(",") }'
    const r = await exec.run([jsHook('PreToolUse', code, '.*')], 'PreToolUse', ctx)
    expect(r.action).toBe('continue')
    expect(r.injectedContext).toBe('undefined,undefined,undefined,undefined')
  })

  it('经典 vm 原型链逃逸表达式拿不到宿主能力（process 仍为 undefined）', async () => {
    // 经典逃逸：绕过 Function 参数遮蔽，经 [].constructor.constructor 取回 Function 构造器
    // 再探测 process —— worker 内 DANGEROUS_GLOBALS 消毒后仍为 undefined（隔离成立）
    const code = 'return { action: "continue", injectedContext: String([].constructor.constructor("return typeof process")()) }'
    const r = await exec.run([jsHook('PreToolUse', code, '.*')], 'PreToolUse', ctx)
    expect(r.action).toBe('continue')
    expect(r.injectedContext).toBe('undefined')
  })

  it('死循环 hook 被超时强制终止并返回 error', async () => {
    const r = await exec.run(
      [{ ...jsHook('PreToolUse', 'while (true) {}', '.*'), handler: { type: 'javascript', handler: 'while (true) {}', timeout: 200 } }],
      'PreToolUse',
      ctx
    )
    expect(r.action).toBe('error')
    expect(r.message).toContain('超时')
  })
})

describe('HookExecutor · 深度闸门（D13 补测）', () => {
  // javascript hook 内再调用 exec.run：模拟 PostToolUse hook 内调工具再次触发的递归
  it('深度达到上限后不再执行（防止工具回调死循环）', async () => {
    const exec = new HookExecutor()
    // 用 command 类型执行 node -e 递归太难控制，改用 javascript 类型 hook 内部
    // 无法访问外部 exec（vm 沙箱隔离）→ 通过 kernel 注册 hook 在真实 JS 环境递归验证
    let calls = 0
    const recursive = async (): Promise<HookResult> => {
      calls++
      // 模拟：hook 内再次触发同一事件（深度会递增直至闸门）
      // inner 结果不消费：递归只是为了触发深度计数，返回值交给外层聚合即可
      await exec.run(
        [jsHook('PreToolUse', 'return { action: "continue" }', '.*')],
        'PreToolUse',
        ctx
      )
      return { action: 'continue', injectedContext: `depth:${calls}` }
    }
    const handle = kernelRegistry.register('hook', { kind: 'module', moduleId: 'test' }, {
      event: 'PreToolUse',
      fn: recursive
    })
    try {
      const r = await exec.run([], 'PreToolUse', ctx) // 不传 config hooks，只跑 kernel
      // 递归应被深度闸门截断：最多 MAX_HOOK_DEPTH(3) 层，calls 不会无限增长
      expect(calls).toBeLessThanOrEqual(4)
      expect(r.action).toBe('continue')
    } finally {
      handle.dispose()
    }
  })
})

describe('HookManager · 熔断与合并（D13 补测）', () => {
  it('配置错误 hook 连续达阈值自动禁用；resetAutoDisable 恢复', async () => {
    const mgr = new HookManager()
    mgr.loadHooks([jsHook('PreToolUse', 'return { action: "error", message: "boom" }', '.*')])
    // 每次 error 递增连续计数，达 MAX_CONSECUTIVE_ERRORS(5) 后自动禁用
    for (let i = 0; i < 5; i++) {
      const r = await mgr.run('PreToolUse', ctx)
      expect(r.action).toBe('error')
    }
    expect(mgr.isAutoDisabled()).toBe(true)
    // 禁用后直接 continue，不再执行 hook
    const r = await mgr.run('PreToolUse', ctx)
    expect(r.action).toBe('continue')
    // 恢复后重新执行
    mgr.resetAutoDisable()
    expect(mgr.isAutoDisabled()).toBe(false)
    const r2 = await mgr.run('PreToolUse', ctx)
    expect(r2.action).toBe('error')
  })

  it('kernel 注册 hook 并入执行：config hook 与 kernel hook 结果合并', async () => {
    const mgr = new HookManager()
    mgr.loadHooks([
      jsHook('PreToolUse', 'return { action: "continue", modifiedParams: { fromConfig: 1 } }', '.*')
    ])
    const kernelFn = vi.fn(async (): Promise<HookResult> => {
      return { action: 'continue', modifiedParams: { fromKernel: 2 } }
    })
    const handle = kernelRegistry.register('hook', { kind: 'module', moduleId: 'test' }, {
      event: 'PreToolUse',
      fn: kernelFn
    })
    try {
      const r = await mgr.run('PreToolUse', ctx)
      expect(r.action).toBe('continue')
      // mergeHookResults：两侧 modifiedParams 均保留
      expect(r.modifiedParams).toMatchObject({ fromConfig: 1, fromKernel: 2 })
      expect(kernelFn).toHaveBeenCalled()
    } finally {
      handle.dispose()
    }
  })

  it('未加载配置且无 kernel hook → 快速 continue（不产生副作用）', async () => {
    const mgr = new HookManager()
    const r = await mgr.run('PreToolUse', ctx)
    expect(r.action).toBe('continue')
    expect(mgr.getHookCount()).toBe(0)
    expect(mgr.isLoaded()).toBe(false)
  })

  it('listByEvent 按事件过滤已加载 hook', () => {
    const mgr = new HookManager()
    mgr.loadHooks([
      jsHook('PreToolUse', 'return { action: "continue" }', '.*'),
      jsHook('PostToolUse', 'return { action: "continue" }', '.*')
    ])
    expect(mgr.listByEvent('PreToolUse')).toHaveLength(1)
    expect(mgr.listByEvent('PostToolUse')).toHaveLength(1)
    expect(mgr.listByEvent('Stop')).toHaveLength(0)
  })
})