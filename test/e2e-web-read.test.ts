// 端到端验证（vitest 环境，真实源码）：fetchPageContent 读 B 站空间页
// 为什么存在：web-search 的 JS 渲染页降级路径（Playwright 抓正文）只在真实浏览器+真实
// 站点下才能被测到，纯 mock 无法覆盖；作用：确认真实网络下降级链路返回可消费正文；
// 不删理由：删除后降级路径失去唯一端到端回归信号，垮掉时只能靠线上事故暴露。
// 判定策略：{ retry: 2 }（vitest 5 的 it 选项）容忍偶发网络抖动（DNS/连接瞬时失败自动重试）；
// 重试后仍失败则如实 fail 并提示网络/站点问题——绝不静默跳过或伪装通过，
// 也不因"需要网络"把本用例排除出验证口径。
import { describe, it, expect } from 'vitest'
import { fetchPageContent } from '../electron/main/api/web-search'

describe('e2e: fetchPageContent 读 B 站空间（真实网络）', () => {
  it('JS 渲染页降级 Playwright 拿到正文', { retry: 2 }, async () => {
    const content = await fetchPageContent('https://space.bilibili.com/14730904', { timeoutMs: 25000 })
    console.log('method:', content.method)
    console.log('title:', content.title)
    console.log('textLen:', content.text.length)
    // 降级成功：方法应为 browser，正文包含真实内容
    expect(content.method).toBe('browser')
    expect(content.text.length).toBeGreaterThan(100)
    expect(content.title).toContain('雪花莲')
  }, 40000)
})
