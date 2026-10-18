/**
 * server 侧公共工具函数与常量：把服务端（WebSocket / 上下文预算 / 异步委托）
 * 用到的魔法数字提取为命名常量，并提供模型窗口估算等跨模块共享能力。
 * 注意：只保留「有多个消费方」的共享项；单一消费方的辅助逻辑下沉到消费模块
 * （例：countFileToolChanges 唯一使用方是流式引擎，先从 utils 迁入 stream-runner，
 * 0.34 又因「可测性」独立为 stream-file-changes.ts——单消费方且无共享诉求的逻辑不该留在这里）。
 */
import { timingSafeEqual } from 'crypto'
import { resolveModelCapability } from './model-capability'

// ===== 魔法数字提取为命名常量 =====
export const WS_MAX_PAYLOAD = 512 * 1024 * 1024
export const CORS_MAX_AGE = 86400
export const SOFT_BUDGET_RATIO = 0.5
export const WS_PATH = '/ws'

/**
 * 从模型名推断上下文窗口大小（token）。
 * 软预算动态化：软预算 = 模型上下文窗口 × SOFT_BUDGET_RATIO；
 * 原 SOFT_BUDGET_TOKENS 常量 16000 硬编码（注释停在 qwen 32k 时代），大窗口模型人为失忆。
 * 从 config.llm.model 推断窗口，保底 16000；tokenBudget 显式配置时优先（见各使用点三元）。
 * 窗口推断委托 model-capability 解析：registry 精确匹配 → 家族推断 → 128k 兜底。
 */
export function estimateModelWindow(model: string): number {
  return resolveModelCapability(model).contextWindow
}

/**
 * 会话存储继承阈值推导比例：模型窗口 × 1/4（设计依据：未显式配置时自动推导的用户设定
 * 基线——与注入预算拉开倍数差，保证继承阈值之下仍有注入余量，见下方 SOFT_BUDGET_RATIO 辨析）。
 * 为什么独立于 SOFT_BUDGET_RATIO(0.5)：后者是「注入预算」口径（server.ts tokenBudget
 * 软预算、上下文注入给 LLM 的量）；summaryBudgetChars 是「存储继承阈值」。
 * 取 1/4 窗口而非 1/2：存满触发继承时留足注入余量（1/4 阈值 ≪ 1/2 注入预算），
 * AI 有空间读入继承摘要与最近消息，不会「存满即继承又立即超注入预算」死循环。
 * 为什么放在 server-utils：internal-session.ts 推导有效预算与 IPC 层回显「生效值」
 * 两处需要同一口径，抽公共函数避免重复实现分叉（评审 W1 收敛双源）。
 */
export const SESSION_BUDGET_RATIO = 0.25

/**
 * 解析会话存储继承阈值（summaryBudgetChars）的「生效值」。
 * configured>0 时手动值优先；<=0/缺省时自动推导 = max(30000, 模型窗口 × SESSION_BUDGET_RATIO)。
 * 保底 30000 的原因：小窗口模型（如 32k）×1/4 仅 8k，短会话就频繁继承；30000 保证低端模型
 * 也有可用会话跨度，又不至于逼近大窗口模型 1/4（如 128k 窗口 → 32k 精确命中）。
 */
export function resolveSummaryBudgetChars(model: string, configured?: number): number {
  if (configured && configured > 0) return configured
  return Math.max(30000, Math.floor(SESSION_BUDGET_RATIO * estimateModelWindow(model)))
}

/**
 * 判定请求来源是否为回环地址（本机进程直连）。
 * 覆盖 IPv4 与 IPv6 的常见回环形态：127.0.0.1、::1、IPv4-mapped IPv6（::ffff:127.0.0.1）。
 * 为什么放这里而不是各模块私有：server.ts（lilith 面回环放行）与 master-router.ts
 * （/api/v1 requireLoopback）都需要同一判定口径——两处各自实现会在补漏时出现分叉，
 * 提取单源保证「回环」语义全程一致。
 */
export function isLoopback(addr: string | undefined): boolean {
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
}

/** 是否属于「lilith 桥接面、免令牌」的路径（本机游戏 companion / ♥ 窗口 / MOD 桥接）。 */
export function isLilithBypassPath(path: string): boolean {
  return path.startsWith('/api/lilith/') || path === '/chat/completions'
}

/**
 * lilith 桥接面统一准入判定：路径命中 且 来源必须回环。
 * 为什么需要独立函数：server.ts（lilith 面中间件）与安全回归测试共用同一口径，
 * 避免「中间件改了一处、测试按旧语义断言」的分叉；非回环来源一律拒绝（403）。
 */
export function allowLilithBypass(path: string, addr: string | undefined): boolean {
  return isLilithBypassPath(path) && isLoopback(addr)
}

/**
 * 令牌常量时间比较：访问令牌（Bearer 头 / /reports/ query / WS 握手）的统一判定口径。
 * 为什么存在：三处原本各自用 `===` 字符串比较，长度信息提前泄漏（时序侧信道），且
 * 「实现改一处、测试按旧语义断言」存在分叉风险；抽成单源后用 crypto.timingSafeEqual，
 * 长度不同直接判不相等（timingSafeEqual 本身要求等长 Buffer，不等长需先短路）。
 * 语义与旧 `===` 完全等价：只有完全一致才返回 true，undefined/null 一律 false。
 */
export function tokensEqual(actual: string | null | undefined, expected: string): boolean {
  if (typeof actual !== 'string' || actual.length !== expected.length) return false
  return timingSafeEqual(Buffer.from(actual, 'utf8'), Buffer.from(expected, 'utf8'))
}