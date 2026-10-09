// 端到端验证：deepSearch 在 B 站站内搜「叙事 权力与秩序」
// 为什么存在：deepSearch 的站内站点搜索（sites=xxx）只在真实搜索引擎/真实站点下
// 才可验证返回结构，mock 搜索引擎返回的是假数据，无法证明生产链路可用；
// 作用：确认真实网络下 deepSearch 对指定站点返回非空结果集；
// 不删理由：删除后站内搜索链路的端到端信号消失，回归只能依赖人工。
// 判定策略：{ retry: 2 }（vitest 5 的 it 选项）容忍偶发网络抖动（DNS/连接瞬时失败自动重试）；
// 重试后仍失败则如实 fail 并提示网络/站点问题——绝不静默跳过或伪装通过，
// 也不因"需要网络"把本用例排除出验证口径。
import { describe, it, expect } from 'vitest'
import { deepSearch } from '../electron/main/api/web-search'

describe('e2e: deepSearch B 站站内搜索（真实网络）', () => {
  it(
    'sites=bilibili.com 搜到用户文章',
    { retry: 2 },
    async () => {
      const results = await deepSearch('雪花莲的超星际远征 叙事 权力与秩序', {
        sites: 'bilibili.com',
        maxResults: 8,
        timeoutMs: 25000
      })
      console.log('结果数:', results.length)
      results.forEach((r, i) => console.log(`[${i}]`, r.title?.slice(0, 50), '|', r.url?.slice(0, 60)))
      expect(results.length).toBeGreaterThan(0)
    },
    40000
  )
})