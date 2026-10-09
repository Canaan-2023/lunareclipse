import { describe, it, expect } from 'vitest'
import { extractMainText } from '../electron/main/api/web-search'
import { assertSafeFetchUrl } from '../electron/main/api/web-search-deep'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

describe('web-search extractMainText（正文启发式提取）', () => {
  it('JS 渲染页：script/style 源码不被当正文，正文过短可触发降级', () => {
    // 模拟 B站空间页：大量 script（>200 字符）+ 少量真实内容
    const html = `<!DOCTYPE html>
<html>
<head><title>雪花莲的超星际远征 - 哔哩哔哩</title></head>
<body>
<script>
window.__INITIAL_STATE__ = {"video": [{"id": 1, "title": "关于学习"}, {"id": 2, "title": "关于金钱"}]};
function render() { return JSON.stringify(window.__INITIAL_STATE__); }
</script>
<script src="https://static.bilibili.com/app.js"></script>
<style>body { background: #000; } .opus { display: flex; }</style>
<div id="app"><div class="opus-module-content"><p>你好，欢迎来到我的空间</p></div></div>
</body>
</html>`
    const { title, text } = extractMainText(html)
    expect(title).toBe('雪花莲的超星际远征 - 哔哩哔哩')
    // script 源码不进入正文（关键断言：修复前这里会是一大坨 JS）
    expect(text).not.toContain('__INITIAL_STATE__')
    expect(text).not.toContain('function render')
    // 正文只含真实内容
    expect(text).toContain('欢迎来到我的空间')
    // 正文过短（<200）→ 调用方应据此降级 Playwright
    expect(text.length).toBeLessThan(200)
  })

  it('普通文章页：正文容器提取正常且不含 script', () => {
    const html = `<!DOCTYPE html>
<html>
<head><title>关于AI的使用 - 哔哩哔哩专栏</title></head>
<body>
<script>var analytics = { track: function() {} };</script>
<article class="article-content">
<p>把 AI 当工具，它就是你的杠杆；把 AI 当大脑，你就是它的回声。这句话是整篇文章的核心判断，它区分了两种使用人工智能的根本姿态：一种是主动驾驭，一种是被动依附。</p>
<p>主动驾驭的人带着清晰的问题意识进入对话，他们知道自己要什么、边界在哪里、什么时候该怀疑模型的输出。他们不会把模型当作真理的源泉，而是当作一个可以反复推敲的讨论对象。</p>
<p>被动依附的人则相反，他们期待模型替自己思考、替自己做决定，久而久之连判断力都交给了模型。这篇正文内容足够长了，用来验证文章页的正文容器提取逻辑能够正常工作。</p>
</article>
</body>
</html>`
    const { title, text } = extractMainText(html)
    expect(title).toBe('关于AI的使用 - 哔哩哔哩专栏')
    expect(text).toContain('把 AI 当工具')
    expect(text).not.toContain('analytics')
    expect(text.length).toBeGreaterThan(200)
  })

  it('纯静态页 fallback body：script 剔除后仍能拿到正文', () => {
    const html = `<!DOCTYPE html>
<html>
<head><title>测试页</title><script>document.cookie = 'x=1';</script></head>
<body>
<script>console.log('noise')</script>
<p>第一段正文内容，这是一篇完整的静态文章的开头部分，用来验证 body fallback 路径能够正确剔除脚本噪声并提取真正的正文内容。</p>
<p>第二段正文内容，继续补充文章的主体段落，让总长度超过提取阈值，这样 fallback 的 body 文本提取就能正常返回完整内容。</p>
<p>第三段正文内容，这里再补充一些细节描述，确保整个页面在剔除 script 之后依然有足够长度的真实正文可供提取和使用。</p>
<p>第四段补充说明：这段用于确认提取结果完整保留了多段落的静态页面正文结构。</p>
</body>
</html>`
    const { text } = extractMainText(html)
    expect(text).toContain('第一段正文内容')
    expect(text).not.toContain('console.log')
    expect(text.length).toBeGreaterThan(200)
  })
})

describe('web-search Playwright evaluate 字符串形式（IIFE 防回归）', () => {
  it('源码中 page.evaluate 的字符串必须是完整 IIFE，禁止裸箭头函数（历史 bug：返回 undefined）', () => {
    const src = readFileSync(
      path.resolve(__dirname, '../electron/main/api/web-search-deep.ts'),
      'utf-8'
    )
    // 1. 禁止裸箭头函数字符串：page.evaluate(`() => ...`)
    //    Playwright eval 成函数对象不执行 → undefined
    expect(src).not.toMatch(/page\.evaluate\(`\(\)\s*=>/)
    // 2. 直接 page.evaluate 的 IIFE 开头至少 2 处（fetchWithBrowser / deepSearch fallback）
    const iifeStarts = src.match(/page\.evaluate\(`\(\(\)\s*=>/g) || []
    expect(iifeStarts.length).toBeGreaterThanOrEqual(2)
    // 3. IIFE 结尾调用必须存在：})()` （历史 bug：开头改成 (() => 但结尾漏了 ()）
    const iifeEnds = src.match(/}\)\(\)`/g) || []
    expect(iifeEnds.length).toBeGreaterThanOrEqual(2)
    // 4. EXTRACT_SEARCH_RESULTS_JS 常量本身必须是完整 IIFE
    expect(src).toMatch(/EXTRACT_SEARCH_RESULTS_JS = `\(\(\) =>/)
  })
})

describe('fetchPageContent SSRF/协议校验（评审 CRITICAL 回归）', () => {
  it('file:// 协议被拒绝（防止经 Playwright 降级读本地文件）', async () => {
    await expect(assertSafeFetchUrl('file:///C:/Windows/win.ini')).rejects.toThrow(/协议/)
  })
  it('非 http(s) 协议被拒绝', async () => {
    await expect(assertSafeFetchUrl('javascript:alert(1)')).rejects.toThrow(/协议/)
    await expect(assertSafeFetchUrl('data:text/html,hi')).rejects.toThrow(/协议/)
  })
  it('内网/回环地址被拒绝（字面 IP）', async () => {
    await expect(assertSafeFetchUrl('http://127.0.0.1:3000/secret')).rejects.toThrow(/内网/)
    await expect(assertSafeFetchUrl('http://192.168.1.1/admin')).rejects.toThrow(/内网/)
    await expect(assertSafeFetchUrl('http://localhost:6186/api')).rejects.toThrow(/内网/)
    await expect(assertSafeFetchUrl('http://169.254.169.254/latest/meta-data')).rejects.toThrow(/内网/)
  })
  it('云元数据主机名（metadata.google.internal 等）被拦截', async () => {
    await expect(assertSafeFetchUrl('http://metadata.google.internal/computeMetadata/v1/')).rejects.toThrow(/内网/)
  })
  it('公网合法 URL 放行', async () => {
    await expect(assertSafeFetchUrl('https://www.baidu.com/')).resolves.toBeUndefined()
    await expect(assertSafeFetchUrl('http://example.com/path?q=1')).resolves.toBeUndefined()
  })
})
