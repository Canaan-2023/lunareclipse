/**
 * 余额探测（B7b）回归测试。
 *
 * 为什么存在：用户裁决「不加成本上限，改为可查余额」。余额是**唯一**让用户预知额度耗尽的信号；
 * 各提供商端点不同，未知时必须如实报 unknown（不得臆造端点或假余额）。
 *
 * 覆盖：端点推导（DeepSeek 有 / 其余无）/ 无端点 → known=false / HTTP 失败 / 返回体识别 /
 * 返回体不可识别 / 网络异常 / 未配置 key。全部通过注入 fetch，不发真实网络请求。
 */
import { describe, it, expect } from 'vitest'
import { balanceEndpointOf, probeBalance, type FetchLike } from '../electron/main/api/llm/balance'

function fakeFetch(res: { ok: boolean; status: number; body?: unknown; throws?: boolean }): FetchLike {
  return async () => {
    if (res.throws) throw new Error('network down')
    return { ok: res.ok, status: res.status, json: async () => res.body }
  }
}

describe('balanceEndpointOf：端点推导（只认已知提供商）', () => {
  it('DeepSeek 有 /user/balance', () => {
    expect(balanceEndpointOf('https://api.deepseek.com/v1')).toBe('https://api.deepseek.com/v1/user/balance')
    expect(balanceEndpointOf('https://api.deepseek.com/v1/')).toBe('https://api.deepseek.com/v1/user/balance')
  })

  it('其余（含 OpenAI）返回 null（不猜端点）', () => {
    expect(balanceEndpointOf('https://api.openai.com/v1')).toBeNull()
    expect(balanceEndpointOf('')).toBeNull()
  })
})

describe('probeBalance：探测与如实报 unknown', () => {
  it('无公开端点 → ok=true / known=false + 说明', async () => {
    const r = await probeBalance('https://api.openai.com/v1', 'sk-x', fakeFetch({ ok: true, status: 200 }))
    expect(r.ok).toBe(true)
    expect(r.known).toBe(false)
    expect(String(r.error)).toContain('未提供公开')
  })

  it('DeepSeek 正常返回 → known=true + 余额列表', async () => {
    const body = { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '12.34' }] }
    const r = await probeBalance('https://api.deepseek.com/v1', 'sk-x', fakeFetch({ ok: true, status: 200, body }))
    expect(r.ok).toBe(true)
    expect(r.known).toBe(true)
    expect(r.balances).toEqual([{ currency: 'CNY', total: '12.34' }])
    expect(r.isAvailable).toBe(true)
  })

  it('HTTP 非 2xx → ok=false + 状态码', async () => {
    const r = await probeBalance('https://api.deepseek.com/v1', 'sk-x', fakeFetch({ ok: false, status: 401 }))
    expect(r.ok).toBe(false)
    expect(String(r.error)).toContain('401')
  })

  it('返回体不可识别 → ok=true / known=false（不臆造余额）', async () => {
    const r = await probeBalance('https://api.deepseek.com/v1', 'sk-x', fakeFetch({ ok: true, status: 200, body: {} }))
    expect(r.ok).toBe(true)
    expect(r.known).toBe(false)
  })

  it('网络异常 → ok=false + 原因', async () => {
    const r = await probeBalance('https://api.deepseek.com/v1', 'sk-x', fakeFetch({ ok: false, status: 0, throws: true }))
    expect(r.ok).toBe(false)
    expect(String(r.error)).toContain('network down')
  })

  it('未配置 key → ok=false', async () => {
    const r = await probeBalance('https://api.deepseek.com/v1', '', fakeFetch({ ok: true, status: 200 }))
    expect(r.ok).toBe(false)
    expect(String(r.error)).toContain('API Key')
  })
})
