/**
 * 自动权限分类模式（auto 权限分类器）：为什么存在——让主模型
 * 对每个工具调用输出 allow/deny/review，把"每次调用都问用户"降为"只有不确定才问用户"。
 * 月蚀没有独立的权限分类服务，但 LLM 通道本身就是设施：LLMClient 可独立 new、支持多请求
 * 并发（controllers 按 requestId 隔离），直接复用主模型做非流式分类请求即可同构替代。
 *
 * 作用：提供 enter_auto_permission_mode / exit_auto_permission_mode 两个工具与会话级状态
 * （Map<sessionKey, boolean>）；执行链（execute-tool.ts）在权限覆写层消费本模块状态：
 * 管理员把工具配置为 require-approval 时，默认每次调用打断用户；自动权限模式激活后，
 * 该逐次授权决策先交给主模型分类——allow 放行 / deny 拒绝 / review 回退人工审批。
 *
 * 安全边界：
 * - 默认关闭：仅显式进入的会话生效，未进入一律走原审批；
 * - deny 优先：分类为 deny 直接拒绝（管理员收紧不能放宽）；deny 覆写在 execute-tool
 *   权限链更早的位置已拦截，本层不重复处理但仍保持 deny > allow 的判定顺序；
 * - fail-closed：LLM 未配置、分类请求失败（网络/超时/未就绪）、输出无法解析，
 *   一律回退 review（原人工审批），绝不因分类器不可用而放行；
 * - 不影响其他审批层：能力闸、deny 覆写、PreToolUse 治理 hook 仍按原序生效，
 *   不经由本模式绕过；
 * - 分类请求非流式（chatWithTools 自带 60s/180s 总超时与 abort 保护），温度 0 保证
 *   判定确定性；参数序列化截断到 2000 字符、分类输出只取首个词，控制体积与上下文开销。
 */
import type { Tool, ToolContext, ToolResult } from './base-tool'
import { LLMClient } from '../api/llm'
import type { ApiMessage, ChatWithToolsResult, ToolDef } from '../api/llm-types'
import type { LLMConfig } from '@shared/types'

/** 自动权限分类结论 */
export type AutoPermissionDecision = 'allow' | 'deny' | 'review'

/** 会话级自动权限状态：key 与执行链同一口径（sessionId ?? dmnId ?? 'global'） */
const autoPermissionSessions = new Map<string, boolean>()

/** 会话是否处于自动权限模式（execute-tool 权限覆写层消费） */
export function isAutoPermissionActive(sessionKey: string): boolean {
  return autoPermissionSessions.get(sessionKey) ?? false
}

/** 进入自动权限模式 */
export function enterAutoPermission(sessionKey: string): void {
  autoPermissionSessions.set(sessionKey, true)
}

/** 退出自动权限模式 */
export function exitAutoPermission(sessionKey: string): void {
  autoPermissionSessions.delete(sessionKey)
}

/** 清理全部会话自动权限状态（应用重启 / 测试隔离用） */
export function resetAutoPermissionState(): void {
  autoPermissionSessions.clear()
}

/** 会话 key：与 execute-tool 执行链的 sessionKey 同一口径 */
function sessionKeyOf(ctx?: ToolContext): string {
  return ctx?.sessionId ?? ctx?.dmnId ?? 'global'
}

// ===== 分类请求 =====

const SYSTEM_CLASSIFY_PROMPT =
  '你是月蚀的自动权限分类器。每次收到一个待人工审批的工具调用请求，判断是否可以自动放行、不打扰用户。' +
  '只输出一个词：allow / deny / review。' +
  'allow：操作安全、非破坏性、符合用户当前利益，无需人工确认即可放行。' +
  'deny：操作有不可逆风险（删除或覆盖文件、执行任意命令、访问敏感信息、产生财务或外部影响），或明显违背用户意图，必须拒绝。' +
  'review：参数不完整、信息不足、无法明确判断，或虽不明确拒绝但需要给用户机会确认——交给人工审批。' +
  '不确定时一律 review，绝不贸然 allow。'

/** 分类请求的 user 消息体（工具描述过长截断，避免请求体积膨胀） */
function buildClassifyPrompt(toolName: string, toolDescription: string, paramsJson: string): string {
  const desc = toolDescription.length > 500 ? `${toolDescription.slice(0, 500)}...（已截断）` : toolDescription
  return `工具名称：${toolName}\n工具描述：${desc}\n调用参数：${paramsJson}\n请只输出一个词。`
}

/** 参数序列化：失败或超长一律截断为可安全进请求的文本（fail-closed 上游已保证不会误放行） */
function safeParamsJson(params: Record<string, unknown>): string {
  try {
    const s = JSON.stringify(params)
    if (!s) return '{}'
    return s.length > 2000 ? `${s.slice(0, 2000)}...（参数过长已截断）` : s
  } catch {
    return '{}'
  }
}

/**
 * 解析分类输出为结论：只认首个词（allow/deny/review），其余一律 review（fail-closed）。
 * 要求模型严格遵守"只输出一个词"；输出带标点/换行/代码围栏时先清洗再取首词。
 * 为什么取首词而非全文搜索：全文搜索会把 "not allow" 误判为 allow（放行方向出错）；
 * 首词精确匹配天然对模型乱说话保守，任何非规范输出都落回人工审批。
 */
export function parseAutoDecision(content: string | null | undefined): AutoPermissionDecision {
  if (!content) return 'review'
  const cleaned = content
    .replace(/```[a-zA-Z]*/g, ' ')
    .trim()
    .toLowerCase()
  const firstWord = cleaned.split(/[,\s;:.\n]+/)[0] ?? ''
  if (firstWord === 'allow') return 'allow'
  if (firstWord === 'deny') return 'deny'
  return 'review'
}

/** 从应用配置中提取可用的主模型 LLM 配置（缺 baseURL/model 视为不可用） */
function extractLlmConfig(config: Record<string, unknown> | undefined): LLMConfig | null {
  const llm = (config as { llm?: Partial<LLMConfig> } | undefined)?.llm
  if (!llm || typeof llm !== 'object') return null
  if (!llm.baseURL || !llm.model) return null
  return llm as LLMConfig
}

/** 分类客户端最小契约（默认 LLMClient，测试可注入 fake） */
export type AutoClassifierClient = Pick<LLMClient, 'isReady' | 'chatWithTools'>
export type AutoClassifierClientFactory = (cfg: LLMConfig) => AutoClassifierClient

const defaultClientFactory: AutoClassifierClientFactory = (cfg) => new LLMClient(cfg)

/**
 * 对一次工具调用做自动权限分类。任何异常路径都返回 review（走原审批），绝不因
 * 分类器不可用而放行或静默拒绝。
 * @param config 应用配置（AppConfig 形态）；无 llm 配置 → review
 * @param clientFactory 客户端工厂（测试注入；缺省 new LLMClient）
 */
export async function classifyToolCall(
  config: Record<string, unknown> | undefined,
  toolName: string,
  toolDescription: string,
  params: Record<string, unknown>,
  clientFactory: AutoClassifierClientFactory = defaultClientFactory
): Promise<AutoPermissionDecision> {
  const llm = extractLlmConfig(config)
  if (!llm) return 'review'

  let client: AutoClassifierClient
  try {
    client = clientFactory(llm)
  } catch {
    return 'review'
  }
  if (!client.isReady()) return 'review'

  const messages: ApiMessage[] = [
    { role: 'system', content: SYSTEM_CLASSIFY_PROMPT },
    { role: 'user', content: buildClassifyPrompt(toolName, toolDescription, safeParamsJson(params)) }
  ]
  try {
    const res: ChatWithToolsResult = await client.chatWithTools(messages, [] as ToolDef[], undefined, {
      temperature: 0
    })
    return parseAutoDecision(res.content)
  } catch {
    // 网络错误 / 超时 / 未配置 API Key 等一律回退人工审批（fail-closed）
    return 'review'
  }
}

// ===== 开关工具（与 accept-edits-mode 同构） =====

export class EnterAutoPermissionModeTool implements Tool {
  name = 'enter_auto_permission_mode'
  description =
    '进入自动权限模式：本会话内，被管理员配置为"每次调用需授权"（require-approval）的工具，逐次授权请求改由主模型自动分类——allow 放行、deny 拒绝、review 才回到人工审批，减少打断。何时用：信任 AI 的调用判断、希望减少逐次确认时进入。仍受安全策略约束：deny 覆写优先、能力闸与治理 Hook 仍生效；LLM 不可用或分类失败时自动回退人工审批（绝不意外放行）；未进入的其他会话不受影响。需要恢复严格确认时调用 exit_auto_permission_mode 退出。'
  parameters: Tool['parameters'] = []
  behavior = {
    readOnly: true,
    concurrencySafe: true
  }
  execute(_params: Record<string, unknown>, ctx?: ToolContext): ToolResult {
    const key = sessionKeyOf(ctx)
    const already = isAutoPermissionActive(key)
    enterAutoPermission(key)
    return {
      ok: true,
      data: {
        message: already
          ? '已在自动权限模式中。require-approval 工具的逐次授权将由主模型分类（allow/deny/review），仅 review 回到人工审批；LLM 不可用或分类失败时自动回退人工审批。无需时调用 exit_auto_permission_mode 退出。'
          : '已进入自动权限模式。本会话 require-approval 工具的逐次授权由主模型自动分类：allow 放行、deny 拒绝、review 回到人工审批；分类失败回退人工审批（fail-closed），deny 策略与治理 Hook 仍优先。需恢复严格确认时调用 exit_auto_permission_mode 退出。'
      }
    }
  }
}

export class ExitAutoPermissionModeTool implements Tool {
  name = 'exit_auto_permission_mode'
  description =
    '退出自动权限模式：require-approval 工具恢复每次调用都请求用户授权。何时用：不再需要主模型代判权限、或需要恢复严格人工确认粒度时调用。'
  parameters: Tool['parameters'] = []
  behavior = {
    readOnly: true,
    concurrencySafe: true
  }
  execute(_params: Record<string, unknown>, ctx?: ToolContext): ToolResult {
    const key = sessionKeyOf(ctx)
    const wasActive = isAutoPermissionActive(key)
    exitAutoPermission(key)
    return {
      ok: true,
      data: {
        message: wasActive
          ? '已退出自动权限模式，require-approval 工具恢复每次调用都请求用户授权。'
          : '当前不在自动权限模式（无需退出）。require-approval 工具保持每次调用人工授权。'
      }
    }
  }
}