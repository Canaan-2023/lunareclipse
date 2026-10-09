/**
 * 月蚀核心服务（阶段 3a）

 * 核心四件套的 ctx 服务形态。设计原则（多实例架构实证后定案）：

 * 月蚀是【多实例并存】架构——前端 AI / DMN / 莉莉丝各有独立 LLMClient 和工具池
 * （index.ts 6+ 处 new LLMClient、server.ts 3 处 createToolRegistry），
 * 因此核心服务一律是【工厂门面】：不夺实例所有权，只统一能力入口 + 登记审计点。
 * 单一实例的（sessionStore）由服务持有（ctx.sessions.store），
 * 后续迁移把现有调用点逐步改走 ctx 服务方法，行为零变化、可渐进。

 * 用法：createRootContext() 已注册本文件全部服务（见 cordis-runtime.ts）。
 */

import { Context, Service } from '../vendor/cordis/index.ts'
import type { LLMConfig, ChatMessage, SessionContext } from '@shared/types'
import { LLMClient } from '../api/llm'
import { SessionStore } from '../api/session-store'
import { ConfigStore } from '../api/config-store'
import { UserStore } from '../models/user-store'
import { createToolRegistry, type ToolRegistry, type ToolRegistryOptions } from '../tools'
import type { ToolContext } from '../tools/base-tool'

// ─── 声明合并：核心服务登记进 Context 类型 ───
declare module '../vendor/cordis/context.ts' {
  interface Context {
    /** 会话存储服务（唯一单例：ctx.sessions.store 与 index.ts 旧引用同一实例） */
    sessions: SessionService
    /** LLM 客户端工厂门面（多实例并存；统一构造点 = 后续审计/串行检查的入口） */
    llm: LlmService
    /** 工具池工厂门面（多实例并存；统一构造点 = 能力闸登记入口） */
    tools: ToolsService
    /** 配置存储（真单例） */
    config: ConfigService
    /** 用户存储（真单例，延迟 init） */
    users: UsersService
    /** 系统提示词组装服务（上下文注入的 seam；实现由 server.ts 注册，阶段 4 拆为插件实现） */
    systemPrompt: SystemPromptService
  }
}

// ─── Cordis 兼容事件载荷类型（阶段 5b：system-prompt/assemble 模块通道） ───
/** Cordis system-prompt/assemble 的 assembled 载荷（最小兼容形状：sections/tools/contexts） */
export interface PromptAssemblyPayload {
  sections: Array<{ role?: string; content?: string }>
  tools: Array<{ name: string }>
  contexts: unknown[]
}

/** Cordis 模块监听器读取的 context（agent.options.model / session.id / session.events） */
export interface PromptAssemblyContext {
  agent?: {
    options?: { model?: string }
    session?: { id?: string; events: Array<{ type: string }> }
  }
}

declare module '../vendor/cordis/events.ts' {
  interface Events {
    /** Cordis 兼容的提示词组装瀑布事件：监听器可改 assembled 后 next() 透传（如 flash-router 注入 persona + 首轮 core 工具集） */
    'system-prompt/assemble'(
      assembled: PromptAssemblyPayload,
      context: PromptAssemblyContext,
      next: (a: PromptAssemblyPayload) => PromptAssemblyPayload
    ): PromptAssemblyPayload
  }
}

/** ctx.sessions：会话存储（真单例，与 index.ts 的 sessionStore 共享实例） */
export class SessionService extends Service {
  private _store!: SessionStore

  constructor(ctx: Context) {
    super(ctx, 'sessions')
  }

  /** 初始化（幂等）：创建/挂载 SessionStore。index.ts 启动链调用一次 */
  init(dir: string): SessionStore {
    if (!this._store) {
      this._store = new SessionStore(dir)
    }
    return this._store
  }

  /** 当前 SessionStore 实例（未 init 时抛错——防止绕过启动链） */
  get store(): SessionStore {
    if (!this._store) {
      throw new Error('ctx.sessions 未初始化：请先在启动链调用 sessions.init(dir)')
    }
    return this._store
  }

  /** 会话目录（委托） */
  getDir(): string {
    return this.store.getDir()
  }
}

/** ctx.llm：LLM 客户端工厂门面 */
export class LlmService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'llm')
  }

  /** 创建 LLMClient（统一构造点；串行铁律由调用方保证——见 main-process 审查清单） */
  create(config: LLMConfig): LLMClient {
    return new LLMClient(config)
  }
}

/** ctx.tools：工具池工厂门面 */
export class ToolsService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'tools')
  }

  /** 创建工具注册表（统一构造点） */
  createRegistry(ctx: ToolContext = {}, options?: ToolRegistryOptions): ToolRegistry {
    return createToolRegistry(ctx, options)
  }
}

/** ctx.config：配置存储（真单例，与 index.ts 的 configStore 共享实例） */
export class ConfigService extends Service {
  private _store!: ConfigStore

  constructor(ctx: Context) {
    super(ctx, 'config')
  }

  /** 初始化（幂等）：创建 ConfigStore。index.ts 启动链调用一次 */
  init(path: string): ConfigStore {
    if (!this._store) {
      this._store = new ConfigStore(path)
    }
    return this._store
  }

  /** 当前 ConfigStore 实例（未 init 时抛错——防止绕过启动链） */
  get store(): ConfigStore {
    if (!this._store) {
      throw new Error('ctx.config 未初始化：请先在启动链调用 config.init(path)')
    }
    return this._store
  }
}

/** ctx.users：用户存储（真单例，延迟 init——需 dataPaths 就绪） */
export class UsersService extends Service {
  private _store: UserStore | null = null

  constructor(ctx: Context) {
    super(ctx, 'users')
  }

  /** 初始化（幂等）：首次调用创建 UserStore */
  init(usersJsonPath: string): UserStore {
    if (!this._store) {
      this._store = new UserStore(usersJsonPath)
    }
    return this._store
  }

  /** 当前 UserStore 实例 */
  get store(): UserStore {
    if (!this._store) {
      throw new Error('ctx.users 未初始化：请先在启动链调用 users.init(path)')
    }
    return this._store
  }
}

/** buildInjectedMessages 的对外签名（systemPrompt 服务的实现契约） */
export type SystemPromptAssembler = (
  messages: ChatMessage[],
  sessionId?: string,
  sessionContext?: SessionContext | null
) => Promise<ChatMessage[]>

/**
 * ctx.systemPrompt：系统提示词组装服务（上下文注入的 seam）

 * 阶段 3c 壳：接口先行，实现由 server.ts 在启动时 registerAssembler() 注册
 * （buildInjectedMessages 闭包捕获 server 内部状态——先注册后迁移）。
 * 阶段 4：实现拆入插件（ctx.config/ctx.users/ctx.skills/ctx.mcp... 服务表齐全后机械平移）。
 */
export class SystemPromptService extends Service {
  private assembler: SystemPromptAssembler | null = null
  /** Cordis 模块通道的组装上下文（阶段 5b）：model/toolNames/工具调用事件流 */
  private assemblyInfo: {
    model?: string
    toolNames: string[]
    events: Array<{ type: string; tool?: string }>
  } = {
    model: undefined,
    toolNames: [],
    events: []
  }

  constructor(ctx: Context) {
    super(ctx, 'systemPrompt')
  }

  /** server.ts 启动时注册实现 */
  registerAssembler(fn: SystemPromptAssembler): void {
    this.assembler = fn
  }

  /** 注入当前模型（Cordis 模块读 agent.options.model） */
  setModel(model: string | undefined): void {
    this.assemblyInfo.model = model
  }

  /** 注入可用工具名列表（Cordis 模块读 assembled.tools） */
  setToolNames(names: string[]): void {
    this.assemblyInfo.toolNames = names
  }

  /** 记录一次工具调用（Cordis 模块读 session.events 判断 tool/call 是否发生） */
  recordToolCall(toolName?: string): void {
    // （奥卡姆剃刀）：events 数组无上限会随会话无限增长——Cordis 模块只需
    // 最近几轮的事件做判断，cap 50 条按 FIFO 丢弃最旧。
    this.assemblyInfo.events.push({ type: 'tool/call', tool: toolName })
    if (this.assemblyInfo.events.length > 50) {
      this.assemblyInfo.events.shift()
    }
  }

  /** 组装注入消息（未注册实现时抛错——服务就绪性由注册时刻保证） */
  async assemble(
    messages: ChatMessage[],
    sessionId?: string,
    sessionContext?: SessionContext | null
  ): Promise<ChatMessage[]> {
    if (!this.assembler) {
      throw new Error('ctx.systemPrompt 未注册组装实现')
    }
    // 阶段 5b：Cordis 兼容的 system-prompt/assemble 瀑布事件（zip 模块通道，如 flash-router）
    // 载荷给 Cordis 形状（assembled + agent/session context）；结果暂只记录不回流——
    // tools 目录过滤回写月蚀注入流属阶段 6 适配项（月蚀工具见性走 frontendToolPolicy）。
    const assembledIn: PromptAssemblyPayload = {
      sections: [{ role: 'system', content: '' }],
      tools: this.assemblyInfo.toolNames.map((name) => ({ name })),
      contexts: []
    }
    const context: PromptAssemblyContext = {
      agent: {
        options: { model: this.assemblyInfo.model },
        session: { id: sessionId ?? '', events: this.assemblyInfo.events }
      }
    }
    try {
      // waterfall 同步分发，但监听器可是 async（Cordis 模块 await next()）→ 统一 await 结果
      const assembledOut = (await this.ctx.waterfall(
        'system-prompt/assemble',
        assembledIn,
        context,
        (a) => a
      )) as PromptAssemblyPayload
      if (
        assembledOut &&
        Array.isArray(assembledOut.tools) &&
        assembledOut.tools.length !== assembledIn.tools.length
      ) {
        console.log(
          `[system-prompt/assemble] 模块路由生效：工具 ${assembledIn.tools.length} → ${assembledOut.tools.length} 个` +
            `（首轮 core 集；回流过滤实现见阶段 6）`
        )
      }
    } catch (err) {
      // 监听器异常不阻断组装（与 hook 异常保护一致）
      console.warn('[system-prompt/assemble] 监听器异常（不阻断组装）:', (err as Error).message)
    }
    return this.assembler(messages, sessionId, sessionContext)
  }
}

export type { ToolRegistry, ToolRegistryOptions, LLMConfig }
