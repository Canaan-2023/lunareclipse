/**
 * Hook 管理器与执行器：为什么存在——工具调用等关键动作需要被用户定义的钩子统一拦截
 * （审计、守卫、审批），且单条钩子不能拖垮流程；本模块是钩子机制的落地执行端。
 * 作用：HookExecutor 按配置确定性执行钩子（javascript 经 worker 线程隔离 / 外部命令），
 * HookManager 管理注册并统一实施超时、嵌套深度闸门与事件触发。
 * 不删理由：DMN 与前端 AI 共用同一 HookManager 实例（index.ts initHooksSkills），
 * 删除后整个 Hook 拦截/审计/守卫机制失去执行端。
 */
import { AsyncLocalStorage } from 'async_hooks'
import { execFile } from 'child_process'
import { resolveExternalCommand } from '../utils/external-command'
import { runJavaScript, MAX_SANDBOX_TIMEOUT_MS } from '../tools/code-sandbox'
import { kernelRegistry } from '../kernel'
import type { HookFn } from '../kernel'
import type {
  HookEvent,
  HookHandler,
  HookContext,
  HookResult,
  ResolvedHook
} from './types'

/** 默认超时时间（毫秒） */
const DEFAULT_HOOK_TIMEOUT_MS = 10000

/** 最大嵌套深度：防止 PostToolUse Hook 内调工具导致无限循环 */
const MAX_HOOK_DEPTH = 3

/** matcher 正则模式最大长度（防 ReDoS：超长正则可导致指数级回溯） */
const MAX_MATCHER_PATTERN_LENGTH = 500

/** 工具名最大长度（防 ReDoS：超长输入串可触发指数级回溯） */
const MAX_TOOL_NAME_LENGTH = 200

/**
 * matcher 正则匹配工具名（大小写不敏感：工具名 PascalCase，matcher 常写小写）。
 * 提取为模块级共享函数：HookExecutor.matchMatcher 与 HookManager.matchToolName 逻辑一致。
 * ReDoS 防护：限制 matcher 和 toolName 长度，避免超长输入触发指数级正则回溯。
 */
function matchToolNameShared(matcher: string | undefined, toolName: string | undefined): boolean {
  if (!matcher || matcher === '.*' || matcher === '') return true
  if (!toolName) return false
  if (matcher.length > MAX_MATCHER_PATTERN_LENGTH || toolName.length > MAX_TOOL_NAME_LENGTH) {
    return false
  }
  return new RegExp(matcher, 'i').test(toolName)
}

/**
 * 异步上下文存储：在 Hook 嵌套调用链中传递深度。

 * 解决问题：HookExecutor 是单例（HookManager 持有），实例字段 currentDepth 在并发下会数据竞争。
 * SubAgentManager 的 parallel 模式下多个子 agent 并发触发 Hook 时，各自应有独立深度计数。
 * AsyncLocalStorage 在 async 调用链中自动传递，每个并发流独立。

 * 工作流：
 * - 顶层 Hook 触发 → getStore()=undefined → 视为 0 → run(1, execute)
 * - Hook 内调工具 → 工具触发新 Hook → getStore()=1 → 检查 1>=3=false，允许 → run(2, execute)
 * - 深度 ≥ 3 → 拒绝执行（防止 PostToolUse Hook 内调工具死循环）

* 深度闸门用 AsyncLocalStorage 传播，与 sub-agent/manager.ts 的 subAgentDepthStorage 同模式。
 */
const hookDepthStorage = new AsyncLocalStorage<number>()

/**
 * Hook 执行器（无配置加载，仅执行传入的 Hook 列表）

 * 设计要点：
 * - 确定性触发：配置即执行，不依赖模型输出（区别于 ActivationManager）
 * - 退出码语义：
 * - 0 = 通过（continue）
 * - 1 = 非阻塞错误（error，显示后继续执行）
 * - 2 = 阻塞（block，停止操作）
 * - javascript 类型：同进程执行，返回 HookResult 对象
 * - 循环防护：PostToolUse 内调工具会再次触发 Hook，加深度限制（最多 3 层）
 */
export class HookExecutor {
  /**
   * 执行指定事件的所有 Hook

   * @param hooks 已解析的 Hook 列表（按 scope 优先级排序：global < project）
   * @param event 触发的事件
   * @param ctx Hook 上下文
   * @returns 最终结果（block 立即返回，continue 合并修改）
   */
  async run(hooks: ResolvedHook[], event: HookEvent, ctx: HookContext): Promise<HookResult> {
    // 深度限制：防止 PostToolUse Hook 内调工具导致无限循环
    // 读 AsyncLocalStorage：每个并发流独立深度，避免实例字段数据竞争
    const currentDepth = hookDepthStorage.getStore() ?? 0
    if (currentDepth >= MAX_HOOK_DEPTH) {
      return { action: 'continue' }
    }

    // 按事件过滤 + matcher 匹配
    const matched = hooks.filter((h) => {
      if (h.event !== event) return false
      return matchToolNameShared(h.matcher, ctx.toolName)
    })

    if (matched.length === 0) return { action: 'continue' }

    // 用 AsyncLocalStorage 隔离深度：每个 async 调用链独立计数
    // storage.run 退出时（含 return/throw）自动恢复父上下文，无需手动 try/finally
    return hookDepthStorage.run(currentDepth + 1, async () => {
      // PreLLMCall 注入内容收集（多个 hook 均可能返回 injectedContext，按序拼接）
      const injectedParts: string[] = []
      // modifiedParams/modifiedResult 聚合：为什么存在——execute-tool.ts 依赖 run()
      // 返回值上的这两个字段真正改写参数/结果（Object.assign(params, modifiedParams)），
      // 若此处只并入 ctx 而不聚合成返回值，跨批 hook 链中修改会在最终返回值丢失，
      // 导致 PreToolUse 改参 / PostToolUse 改结果整体失效；作用：把同批各 hook 的
      // 修改浅合并（后写覆盖同名键）后随 continue 一起透传；不删理由：删掉即回归
      // 步骤 A6 已修复的缺陷（hook 修改参数/结果不生效）。
      let mergedParams: Record<string, unknown> | undefined
      let mergedResult: HookResult['modifiedResult']
      for (const hook of matched) {
        const hookResult = await this.executeHandler(hook.handler, ctx)

        // block 立即返回，不再执行后续 Hook
        if (hookResult.action === 'block') {
          return hookResult
        }
        // error 立即返回（显示错误，但调用方决定是否继续）
        if (hookResult.action === 'error') {
          return hookResult
        }
        // continue 但修改了参数/结果，合并到 ctx 供下一个 Hook 使用
        if (hookResult.modifiedParams) {
          ctx.toolParams = { ...ctx.toolParams, ...hookResult.modifiedParams }
          // 同时聚合成最终返回值（供 execute-tool 消费），后写覆盖同名键
          mergedParams = { ...(mergedParams ?? {}), ...hookResult.modifiedParams }
        }
        if (hookResult.modifiedResult) {
          ctx.toolResult = hookResult.modifiedResult
          mergedResult = hookResult.modifiedResult
        }
        // PreLLMCall 注入内容收集
        if (hookResult.injectedContext) {
          injectedParts.push(hookResult.injectedContext)
        }
      }
      // 聚合返回：injectedContext + 修改透传；block/error 已提前 return，此处必为 continue
      const acc: HookResult = { action: 'continue' }
      if (injectedParts.length > 0) {
        acc.injectedContext = injectedParts.join('\n\n')
      }
      if (mergedParams && Object.keys(mergedParams).length > 0) {
        acc.modifiedParams = mergedParams
      }
      if (mergedResult !== undefined) {
        acc.modifiedResult = mergedResult
      }
      return acc
    })
  }

  /** 执行单个处理器 */
  private async executeHandler(handler: HookHandler, ctx: HookContext): Promise<HookResult> {
    const timeout = handler.timeout ?? DEFAULT_HOOK_TIMEOUT_MS

    if (handler.type === 'command') {
      return this.executeCommand(handler, ctx, timeout)
    } else {
      return this.executeJavaScript(handler, ctx, timeout)
    }
  }

  /**
   * 执行 command 类型 Hook

   * - stdin 传 JSON 上下文
   * - 退出码 0=通过 / 1=非阻塞错误 / 2=阻塞
   * - stderr 内容在 block/error 时返回给用户
   * - stdout 可选 JSON：{ action, message, injectedContext, modifiedParams, modifiedResult }——
   * 与 PreToolUse/PostToolUse 的 javascript 类型同构；PreLLMCall 用 injectedContext 注入上下文
   */
  private executeCommand(
    handler: HookHandler,
    ctx: HookContext,
    timeout: number
  ): Promise<HookResult> {
    return new Promise((resolve) => {
      // 裸命令名先解析成可启动进程（Windows 上 npm 等是 .cmd，直接 execFile 会 ENOENT）
      const resolved = resolveExternalCommand(handler.command!, handler.args ?? [])
      const child = execFile(
        resolved.file,
        resolved.args,
        { timeout, maxBuffer: 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err) {
            // err.code：数字=进程退出码；字符串=Node 错误码（如 'ENOENT'=命令不存在）
            const exitCode = typeof err.code === 'number' ? err.code : null
            if (exitCode === null) {
              // 命令启动失败（ENOENT/权限不足等），不是退出码
              resolve({ action: 'error', message: `Hook 命令执行失败: ${err.message}` })
            } else if (exitCode === 2) {
              // 阻塞
              resolve({ action: 'block', message: stderr?.trim() || 'Hook 阻止了操作' })
            } else if (exitCode === 1) {
              // 非阻塞错误（1=忽略并继续）
              resolve({ action: 'error', message: stderr?.trim() || 'Hook 返回非阻塞错误' })
            } else {
              // 其他退出码（如超时 143=SIGTERM）
              resolve({ action: 'error', message: `Hook 执行失败（exit ${exitCode}）: ${stderr?.trim() || err.message}` })
            }
          } else {
            // exit 0 = 通过；解析 stdout JSON（可选，含 injectedContext/modifiedParams/modifiedResult 时生效）
            resolve(this.parseStdoutResult(stdout))
          }
        }
      )
      // stdin 传 JSON 上下文
      child.stdin?.write(JSON.stringify(ctx))
      child.stdin?.end()
    })
  }

  /** 解析 command hook 的 stdout JSON；无有效 JSON 时返回 continue */
  private parseStdoutResult(stdout: string): HookResult {
    const text = (stdout || '').trim()
    if (!text) return { action: 'continue' }
    let parsed: HookResult
    try {
      parsed = JSON.parse(text) as HookResult
    } catch {
      // stdout 非 JSON 文本 → 视为 continue（不注入）
      return { action: 'continue' }
    }
    if (!parsed || typeof parsed !== 'object') return { action: 'continue' }
    // 无 action 但有 injectedContext（{ "context": "..." } 兼容形态）→ 视为 continue + 注入
    const raw = parsed as unknown as Record<string, unknown>
    if (!parsed.action && (parsed.injectedContext || raw.context)) {
      const context = raw.context
      return {
        action: 'continue',
        injectedContext: parsed.injectedContext ?? (typeof context === 'string' ? context : undefined)
      }
    }
    if (parsed.action === 'continue' || parsed.action === 'block' || parsed.action === 'error') {
      return parsed
    }
    return { action: 'continue' }
  }

  /**
   * 执行 javascript 类型 Hook（月蚀扩展）
   *
   * - 经 code-sandbox 的 worker_threads 隔离执行（与 code_run 同一隔离内核）：
   *   独立 V8 isolate + 全局消毒（require/process/fetch/setTimeout 等 20+ 敏感
   *   全局被遮蔽为 undefined）+ 冻结内置构造器 + resourceLimits，超时由主线程
   *   terminate 强制终止；不使用 vm 模块（vm 逃逸面风险更高，见 tools/code-sandbox.ts）
   * - ctx 经 worker globals 注入，用户代码可按名引用 ctx（与原实现同语义）
   * - 返回 HookResult 对象
   *
   * 安全说明：javascript 类型执行用户配置的函数体，有安全风险。
   * 配置需用户手动编辑，不自动加载第三方配置。
   * 项目级 Hook 需用户确认启用（通过 UI）。
   */
  private async executeJavaScript(
    handler: HookHandler,
    ctx: HookContext,
    timeout: number
  ): Promise<HookResult> {
    try {
      // 与原实现一致：用户函数体包成 async IIFE（支持 await/顶层 return）。
      // 必须以 return 前缀：worker 沙箱 new Function 只把显式 return 的结果
      // 作为返回值（无 return 时最后一条表达式语句的值不返回）
      const wrapped = `return (async () => {\n${handler.handler}\n})()`
      // 沙箱超时上限 30s（worker 资源保护）；hook 配置超时超过则按上限执行
      const effectiveTimeout = Math.min(timeout, MAX_SANDBOX_TIMEOUT_MS)
      // ctx 按原实现（vm 版 JSON.parse(JSON.stringify(ctx))）的契约 JSON 化后注入：
      // postMessage 结构化克隆只接受可克隆值，JSON 化避免 toolResult 内部
      // 含函数/循环引用等不可克隆值时整个 hook 抛 DataCloneError 失败
      let ctxData: HookContext
      try {
        ctxData = JSON.parse(JSON.stringify(ctx)) as HookContext
      } catch {
        ctxData = { event: ctx.event, cwd: ctx.cwd }
      }
      const result = await runJavaScript(wrapped, {
        timeoutMs: effectiveTimeout,
        globals: { ctx: ctxData },
        // 用户代码 console 输出转发到主进程日志（保持 [hook] 前缀语义）
        onStdout: (line) => console.log('[hook] ' + line.trimEnd()),
        onStderr: (line) => console.log('[hook] ' + line.trimEnd())
      })

      if (result.timedOut) {
        return { action: 'error', message: `Hook 执行超时（${effectiveTimeout}ms）` }
      }
      if (!result.ok) {
        const detail = (result.errorMessage ?? result.stderr.trimEnd()) || '未知执行错误'
        return { action: 'error', message: `Hook 执行失败: ${detail}` }
      }

      const hookResult = result.result as HookResult | undefined
      // 确保 action 字段有效
      if (!hookResult || !hookResult.action || !['continue', 'block', 'error'].includes(hookResult.action)) {
        return { action: 'error', message: 'Hook 返回了无效的 action 值' }
      }
      return hookResult
    } catch (err) {
      const msg = (err as Error).message
      if (msg.includes('超时')) {
        return { action: 'error', message: msg }
      }
      return { action: 'error', message: `Hook 执行失败: ${msg}` }
    }
  }
}

/**
 * Hook 管理器：加载配置 + 触发 Hook

 * 月蚀的 HookManager 和 ActivationManager 是两个独立系统：
 * - ActivationManager：AI 自主激活（AI 决定何时唤醒自己）
 * - HookManager：确定性钩子（系统在固定生命周期点执行）

 * 配置加载见 config-loader.ts，三级作用域：global < project
 */
export class HookManager {
  private hooks: ResolvedHook[] = []
  private executor = new HookExecutor()
  private loaded = false
  /** 连续错误计数：连续 error 达阈值后自动禁用 hooks，防止配置错误阻塞所有工具调用 */
  private consecutiveErrors = 0
  private readonly MAX_CONSECUTIVE_ERRORS = 5
  private autoDisabled = false

  /** 加载配置（合并全局 + 项目级） */
  loadHooks(hooks: ResolvedHook[]): void {
    this.hooks = hooks
    this.loaded = true
    // 重新加载配置时重置自动禁用状态（用户可能修复了配置）
    this.autoDisabled = false
    this.consecutiveErrors = 0
  }

  /** 触发指定事件的 Hook */
  async run(event: HookEvent, ctx: HookContext): Promise<HookResult> {
    // config hooks 和内核函数 hook 都为空时才跳过（任一存在都继续执行）
    if (!this.loaded || (this.hooks.length === 0 && kernelRegistry.getHandles('hook').length === 0)) {
      return { action: 'continue' }
    }
    // 自动禁用：连续错误超阈值，跳过所有 hooks 防止系统瘫痪
    if (this.autoDisabled) {
      return { action: 'continue' }
    }
    // 健壮性保护：Hook 执行异常不阻断主流程（方案第7节）
    // executeJavaScript/executeCommand 内部已有 try/catch，这里兜底防止 storage.run 等极端异常
    try {
      const result = await this.executor.run(this.hooks, event, ctx)
      // 内核/插件注册的函数 hook（registry 真相源）：config hooks 之后执行，结果合并
      const kernelResult = await this.runKernelHooks(event, ctx)
      const merged = this.mergeHookResults(result, kernelResult)
      // 连续错误计数：error 递增，continue/block 清零
      if (merged.action === 'error') {
        this.consecutiveErrors++
        if (this.consecutiveErrors >= this.MAX_CONSECUTIVE_ERRORS) {
          this.autoDisabled = true
          console.error(
            `[hooks] Hook 连续错误 ${this.consecutiveErrors} 次达阈值，已自动禁用所有 hooks。` +
            `请检查 hooks 配置（可能是脚本语法错误或命令路径错误）。修复后重新加载配置即可恢复。`
          )
        }
      } else {
        // 正常执行（continue 或 block）清零计数
        this.consecutiveErrors = 0
      }
      return merged
    } catch (err) {
      const msg = (err as Error).message
      console.warn(`[hooks] Hook 执行异常（${event}）: ${msg}`)
      this.consecutiveErrors++
      if (this.consecutiveErrors >= this.MAX_CONSECUTIVE_ERRORS) {
        this.autoDisabled = true
        console.error(
          `[hooks] Hook 连续异常 ${this.consecutiveErrors} 次达阈值，已自动禁用所有 hooks。`
        )
      }
      return { action: 'error', message: `Hook 执行异常: ${msg}` }
    }
  }

  /**
   * 执行内核/插件注册的函数 hook（registry 真相源）。

   * - 从 kernelRegistry 拉取匹配 event + matcher 的注册，按 priority 升序执行
   * - 复用 hookDepthStorage 深度限制（防函数 hook 内调工具死循环）
   * - 与 config hooks 相同的 block/error/continue + 注入合并语义
   */
  private async runKernelHooks(event: HookEvent, ctx: HookContext): Promise<HookResult> {
    const currentDepth = hookDepthStorage.getStore() ?? 0
    if (currentDepth >= MAX_HOOK_DEPTH) {
      return { action: 'continue' }
    }
    const handles = kernelRegistry
      .getHandles('hook')
      .filter((h) => {
        const v = h.value as { event: HookEvent; matcher?: string; fn: HookFn }
        if (v.event !== event) return false
        return matchToolNameShared(v.matcher, ctx.toolName)
      })
      .sort((a, b) => {
        const pa = (a.value as { priority?: number }).priority ?? 100
        const pb = (b.value as { priority?: number }).priority ?? 100
        return pa - pb
      })
    if (handles.length === 0) return { action: 'continue' }

    return hookDepthStorage.run(currentDepth + 1, async () => {
      const injectedParts: string[] = []
      // kernel（registry）hook 的 modifiedParams/modifiedResult 同样需要聚合并透传：
      // 与 config hook 同语义，execute-tool.ts 消费最终返回值，若内部修改只在 ctx
      // 传递而最终丢失，内核注册的守卫/改写 hook 对工具形同虚设（评审 M12 同类缺陷），
      // 因此与 config 分支一致地做浅合并 + 随 continue 返回。
      let mergedParams: Record<string, unknown> | undefined
      let mergedResult: HookResult['modifiedResult']
      for (const h of handles) {
        const v = h.value as { event: HookEvent; matcher?: string; fn: HookFn }
        try {
          const r = await this.withHookTimeout(() => v.fn(ctx))
          if (r.action === 'block') return r
          if (r.action === 'error') return r
          if (r.modifiedParams) {
            ctx.toolParams = { ...ctx.toolParams, ...r.modifiedParams }
            mergedParams = { ...(mergedParams ?? {}), ...r.modifiedParams }
          }
          if (r.modifiedResult) {
            ctx.toolResult = r.modifiedResult
            mergedResult = r.modifiedResult
          }
          if (r.injectedContext) {
            injectedParts.push(r.injectedContext)
          }
        } catch (err) {
          return { action: 'error', message: `内核 Hook 执行失败: ${(err as Error).message}` }
        }
      }
      const acc: HookResult = { action: 'continue' }
      if (injectedParts.length > 0) {
        acc.injectedContext = injectedParts.join('\n\n')
      }
      if (mergedParams && Object.keys(mergedParams).length > 0) {
        acc.modifiedParams = mergedParams
      }
      if (mergedResult !== undefined) {
        acc.modifiedResult = mergedResult
      }
      return acc
    })
  }

/**
   * 合并两个 Hook 结果（先 config 后 kernel；block/error 优先，注入拼接）。

   * 为什么存在：config hook 与内核函数 hook 各产出一份 HookResult，工具执行前
   * 需要把两份修改（改参数、改结果、注入上下文）合成单一结果，避免后跑的内核
   * hook 覆盖或丢弃先跑 config hook 的修改。
   * 作用：a（config）的 modifiedParams / modifiedResult 无条件浅合并进结果（b 优先），
   * 只有 b 对同一字段有修改时才被 b 覆盖——修复前 b 未修改时 a 的修改整体丢失，
   * 导致内核 hook 常驻时 config hook 对工具的门禁形同虚设（评审 M12）。
   */
  private mergeHookResults(a: HookResult, b: HookResult): HookResult {
    if (a.action === 'block' || a.action === 'error') return a
    if (b.action === 'block' || b.action === 'error') return b
    const injected: string[] = []
    if (a.injectedContext) injected.push(a.injectedContext)
    if (b.injectedContext) injected.push(b.injectedContext)
    // 浅合并两侧参数修改：b 覆盖同名键，a 独有的键保留
    const mergedParams = { ...(a.modifiedParams ?? {}), ...(b.modifiedParams ?? {}) }
    const hasParams = Object.keys(mergedParams).length > 0
    // 结果修改：b 优先，b 未改时保留 a 的
    const mergedResult = b.modifiedResult ?? (a.modifiedResult as HookResult['modifiedResult'])
    return {
      action: 'continue',
      ...(injected.length > 0 ? { injectedContext: injected.join('\n\n') } : {}),
      ...(hasParams ? { modifiedParams: mergedParams } : {}),
      ...(mergedResult !== undefined ? { modifiedResult: mergedResult } : {})
    }
  }

  /** 带超时的函数执行（与 executeJavaScript 同保护模式） */
  private async withHookTimeout<T>(fn: () => T | Promise<T>, timeoutMs = DEFAULT_HOOK_TIMEOUT_MS): Promise<T> {
    let timer: NodeJS.Timeout | null = null
    try {
      const timeoutPromise = new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`内核 Hook 执行超时（${timeoutMs}ms）`)), timeoutMs)
      })
      return await Promise.race([Promise.resolve(fn()), timeoutPromise])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  /** 获取已加载的 Hook 数量（调试/诊断用） */
  getHookCount(): number {
    return this.hooks.length
  }

  /** 按事件列出 Hook（调试/UI 用） */
  listByEvent(event: HookEvent): ResolvedHook[] {
    return this.hooks.filter((h) => h.event === event)
  }

  /** 是否已加载配置 */
  isLoaded(): boolean {
    return this.loaded
  }

  /** 是否被自动禁用（UI 诊断用） */
  isAutoDisabled(): boolean {
    return this.autoDisabled
  }

  /** 手动恢复（用户确认修复配置后调用） */
  resetAutoDisable(): void {
    this.autoDisabled = false
    this.consecutiveErrors = 0
  }
}
