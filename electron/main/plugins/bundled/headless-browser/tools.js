/**
 * 浏览器控制工具集（bundled 插件，2026-08-18，2026-09-28 支持任意常见浏览器）：
 * 基于 Playwright 单例（browser-manager.ts），多级候选链自动发现本机浏览器——
 * 官方 channel（msedge → chrome）→ 常见安装路径探测（Edge/Chrome/Brave/Vivaldi/Opera/
 * Chromium 走 chromium.launch，Firefox 走 firefox.launch）→ 内置 headless_shell 兜底，
 * 全部后台自动运行，不弹窗口。
 * 核心：页面快照——AI "看"网页靠读快照文本结构，不需要看截图。
 * 可分发：首选系统自带浏览器（零内核分发，发布包不带浏览器二进制），
 * 可选接管系统默认浏览器复用登录态（browser_takeover，走 CDP 桥，不依赖宿主内核）。
 * 核心单例经 ctx.getBrowserManager() 注入（server.ts 注入），插件不直接 import 主进程模块。
 */

/** 从 ctx 拿浏览器管理器（未注入则报错） */
function getBm(ctx) {
  const bm = ctx?.getBrowserManager?.()
  if (!bm) {
    return { error: '浏览器服务未注入（需 bundled/headless-browser 插件 + server 注入 getBrowserManager）' }
  }
  return { bm }
}

/** 操作后附带当前状态快照，让 AI 看到结果（主操作失败不阻断） */
async function withState(bm, data) {
  let state = null
  let stateError = null
  try {
    state = await bm.getState()
  } catch (err) {
    stateError = `获取状态失败: ${err.message}`
  }
  return { ok: true, data: { ...data, state, ...(stateError ? { stateError } : {}) } }
}

const navigate = {
  name: 'browser_navigate',
  description: '打开指定网页（后台自动加载，不弹窗口），等页面加载后返回标题、最终 URL 和页面快照。如果 state.snapshot 为空，说明页面渲染较慢，等待后再次调用 browser_snapshot 查看。',
  parameters: [{ name: 'url', type: 'string', description: '目标 URL（含协议，如 https://www.bilibili.com）', required: true }],
  async execute(params, ctx) {
    const url = String(params.url ?? '').trim()
    if (!url) return { ok: false, error: 'url 必填且不能为空' }
    try {
      const parsed = new URL(url)
      if (!['http:', 'https:'].includes(parsed.protocol)) return { ok: false, error: `仅支持 http/https 协议: ${url}` }
    } catch {
      return { ok: false, error: `URL 格式无效: ${url}` }
    }
    const { bm, error } = getBm(ctx)
    if (error) return { ok: false, error }
    try {
      const r = await bm.navigateHeadless(url)
      await new Promise((resolve) => setTimeout(resolve, 300))
      return await withState(bm, { title: r.title, url: r.url, navigated: true })
    } catch (err) {
      return { ok: false, error: err.message }
    }
  }
}

const snapshot = {
  name: 'browser_snapshot',
  description: '返回当前页面的结构快照（文本），用于理解页面结构、找可点击元素。这是 AI 看页面的方式——不需要看截图。若页面还在渲染可稍后重试。快照含 a/button/input 等可交互元素的 href 和文本。',
  parameters: [],
  async execute(_params, ctx) {
    const { bm, error } = getBm(ctx)
    if (error) return { ok: false, error }
    try {
      const text = await bm.snapshot()
      return { ok: true, data: { snapshot: text, fullLength: text.length } }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  }
}

const click = {
  name: 'browser_click',
  description: '点击页面上的元素（CSS 选择器）。点击后返回页面快照，可判断是否生效。',
  parameters: [{ name: 'selector', type: 'string', description: 'CSS 选择器，如 "button#submit" 或 "a.login"', required: true }],
  async execute(params, ctx) {
    const selector = String(params.selector ?? '').trim()
    if (!selector) return { ok: false, error: 'selector 必填且不能为空' }
    const { bm, error } = getBm(ctx)
    if (error) return { ok: false, error }
    try {
      await bm.click(selector)
      await new Promise((resolve) => setTimeout(resolve, 600))
      return await withState(bm, { selector, clicked: true })
    } catch (err) {
      return { ok: false, error: err.message }
    }
  }
}

const typeText = {
  name: 'browser_type',
  description: '在页面输入框输入文本（CSS 选择器）。默认先清空再输入。输入后返回页面快照看结果。',
  parameters: [
    { name: 'selector', type: 'string', description: 'CSS 选择器，指向 input/textarea/contenteditable', required: true },
    { name: 'text', type: 'string', description: '要输入的文本', required: true },
    { name: 'clear', type: 'boolean', description: '是否先清空内容（默认 true）', required: false, default: true }
  ],
  async execute(params, ctx) {
    const selector = String(params.selector ?? '').trim()
    if (!selector) return { ok: false, error: 'selector 必填且不能为空' }
    const text = String(params.text ?? '')
    if (!text) return { ok: false, error: 'text 必填' }
    const { bm, error } = getBm(ctx)
    if (error) return { ok: false, error }
    try {
      const shouldClear = params.clear !== false
      await bm.type(selector, text, shouldClear)
      return await withState(bm, { selector, typed: text, cleared: shouldClear })
    } catch (err) {
      return { ok: false, error: err.message }
    }
  }
}

const scroll = {
  name: 'browser_scroll',
  description: '滚动当前网页。direction 默认 down，amount 默认 500 像素。滚动后返回页面快照看新内容。',
  parameters: [
    { name: 'direction', type: 'string', description: '滚动方向：up 或 down（默认 down）', required: false, default: 'down' },
    { name: 'amount', type: 'number', description: '滚动像素数（默认 500）', required: false, default: 500 }
  ],
  async execute(params, ctx) {
    const direction = params.direction ?? 'down'
    if (direction !== 'up' && direction !== 'down') return { ok: false, error: `direction 只支持 up/down，收到: ${direction}` }
    const amount = params.amount ?? 500
    if (typeof amount !== 'number' || amount < 0 || !Number.isFinite(amount)) return { ok: false, error: `amount 必须是非负有限数，收到: ${amount}` }
    const { bm, error } = getBm(ctx)
    if (error) return { ok: false, error }
    try {
      await bm.scroll(direction, amount)
      return await withState(bm, { direction, amount })
    } catch (err) {
      return { ok: false, error: err.message }
    }
  }
}

const evaluate = {
  name: 'browser_evaluate',
  description: '在网页里执行一段 JavaScript，返回结果（JSON）。用于读特定数据或做页面内操作，谨慎。',
  parameters: [{ name: 'script', type: 'string', description: '要执行的 JS 表达式，如 "document.title" 或 "1+1"', required: true }],
  async execute(params, ctx) {
    const script = String(params.script ?? '').trim()
    if (!script) return { ok: false, error: 'script 必填且不能为空' }
    const { bm, error } = getBm(ctx)
    if (error) return { ok: false, error }
    try {
      const result = await bm.evaluate(script)
      return { ok: true, data: { result: result === undefined ? null : result } }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  }
}

const status = {
  name: 'browser_status',
  description: '查询当前网页的地址、标题和结构快照。用于操作前确认状态或操作后检查结果。',
  parameters: [],
  async execute(_params, ctx) {
    const { bm, error } = getBm(ctx)
    if (error) return { ok: false, error }
    try {
      const state = await bm.getState()
      return { ok: true, data: state }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  }
}

const takeover = {
  name: 'browser_takeover',
  description: '切换到对方系统的默认浏览器（Edge/Chrome/Brave 等 Chromium 内核浏览器，Windows 注册表探测 + 回退安装路径）→ 以 CDP + 独立 profile 接管，复用其已登录会话。之后的网页操作会在真实浏览器上进行（可有窗口）。可选传端口。',
  parameters: [{ name: 'port', type: 'number', description: 'CDP 调试端口（默认 9222）', required: false, default: 9222 }],
  async execute(params, ctx) {
    const { Error } = globalThis
    const { bm, error } = getBm(ctx)
    if (error) return { ok: false, error }
    if (typeof bm.launchUserBrowser !== 'function') {
      return { ok: false, error: '当前环境不支持接管系统浏览器（launchUserBrowser 未提供）' }
    }
    const port = params.port ?? 9222
    try {
      // 独立 profile 目录（与设置面板"一键接管"一致）
      const { join } = await import('path')
      const { app } = await import('electron')
      const profileDir = join(app.getPath('userData'), 'browser-profiles', 'cdp-headless')
      const r = await bm.launchUserBrowser(port, profileDir)
      return { ok: r.ok, error: r.error, launched: !!r.launched, browserName: r.browserName ?? null }
    } catch (err) {
      return { ok: false, error: `接管失败: ${err.message}` }
    }
  }
}

export default [navigate, snapshot, click, typeText, scroll, evaluate, status, takeover]