/**
 * @category LLM
 * @summary 提供商余额探测：AI 可查「API 站点还有多少余额」
 *
 * 为什么存在：交接单 §8.2⑤ 的「成本上限」被用户裁决取消（原话「超 token 本就发不出去」），
 * 改为「可以加一个配置，AI 可以去 API 网站看看还有多少余额」。本模块是这条能力的实现。
 *
 * 不删理由：删掉即「成本」维度只剩 token 计数，用户无法预知额度耗尽（而额度耗尽会直接让生成失败）。
 *
 * 适配口径（**各提供商端点不同，未知即如实报 unknown，不臆造**）：
 * - DeepSeek：`GET {baseURL}/user/balance`（Bearer）→ `{ is_available, balance_infos:[{currency,total_balance}] }`
 * - 其余（含 OpenAI）：**无公开余额端点** → `known=false`，由 UI/工具如实告知「该提供商不支持查询」。
 *
 * 网络调用通过注入的 `fetchImpl`，便于单测；不在本模块内直连网络。
 */

export interface BalanceInfo {
  currency: string
  total: string
}

export interface BalanceResult {
  /** 调用是否成功（网络/解析层面） */
  ok: boolean
  /** 是否拿到了余额信息（false = 该提供商无公开端点或返回不可识别） */
  known: boolean
  balances?: BalanceInfo[]
  /** 账户是否可用（部分提供商返回） */
  isAvailable?: boolean
  /** 失败原因（ok=false 时） */
  error?: string
}

export interface HttpResponseLike {
  ok: boolean
  status: number
  json: () => Promise<unknown>
}

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string> }
) => Promise<HttpResponseLike>

/**
 * 余额端点推导。**只认已知提供商**；未知返回 null（调用方据此报 unknown，不猜端点）。
 */
export function balanceEndpointOf(baseURL: string): string | null {
  const base = (baseURL ?? '').replace(/\/+$/, '')
  if (!base) return null
  if (/deepseek/i.test(base)) return `${base}/user/balance`
  return null
}

/** 探测余额。见文件头「适配口径」。 */
export async function probeBalance(
  baseURL: string,
  apiKey: string,
  fetchImpl?: FetchLike
): Promise<BalanceResult> {
  const endpoint = balanceEndpointOf(baseURL)
  if (!endpoint) {
    return { ok: true, known: false, error: '该提供商未提供公开的余额查询端点' }
  }
  const doFetch: FetchLike | undefined = fetchImpl ?? (globalThis.fetch as unknown as FetchLike | undefined)
  if (!doFetch) return { ok: false, known: false, error: '当前环境不支持网络请求' }
  if (!apiKey) return { ok: false, known: false, error: '未配置 API Key' }

  try {
    const res = await doFetch(endpoint, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' }
    })
    if (!res.ok) return { ok: false, known: false, error: `余额查询失败（HTTP ${res.status}）` }
    const body = (await res.json()) as {
      is_available?: boolean
      balance_infos?: Array<{ currency?: unknown; total_balance?: unknown }>
    }
    const infos = Array.isArray(body?.balance_infos) ? body.balance_infos : []
    const balances: BalanceInfo[] = infos
      .filter((b) => b && b.currency != null && b.total_balance != null)
      .map((b) => ({ currency: String(b.currency), total: String(b.total_balance) }))
    if (balances.length === 0) {
      return { ok: true, known: false, error: '返回体中未识别到余额字段' }
    }
    return {
      ok: true,
      known: true,
      balances,
      ...(typeof body?.is_available === 'boolean' ? { isAvailable: body.is_available } : {})
    }
  } catch (err) {
    return { ok: false, known: false, error: `余额查询异常：${(err as Error).message}` }
  }
}
