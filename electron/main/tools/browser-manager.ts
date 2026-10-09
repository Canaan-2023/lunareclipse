/**
 * Playwright 浏览器管理器：为什么存在——AI 需要真正打开网页访问动态内容，但系统沙盒/
 * 包装环境下 Playwright 找不到浏览器二进制，必须先定位并注入 PLAYWRIGHT_BROWSERS_PATH。
 * 作用：管理浏览器（自动发现本机任意常见浏览器，缺失时降级内置 Chromium headless_shell）
 * 的启动与页面导航/快照/操作，单例导出 browserManager 供各工具复用。
 * 为什么支持任意浏览器：用户系统可能是 Chrome/Edge/Brave/Vivaldi/Opera/Firefox 中的
 * 任意一种，只认 Edge 会在无 Edge 机器上罢工；自动探测 + 候选链保证"本机有什么就用什么"。
 * 为什么不能删内置内核降级：见 launchBrowser 注释——无任何常见浏览器环境仍需可用。
 */
// 必须在 import playwright 之前设置浏览器路径（避开 AppData 沙盒限制）
// browser-manager.js 编译后在 out/main/tools/ 或 dist/main/tools/，向上三级到 app 根目录
// eslint-disable-next-line @typescript-eslint/no-require-imports -- 必须在环境变量设置前同步加载（ES import 提升会破坏顺序）
const path = require('path')
// eslint-disable-next-line @typescript-eslint/no-require-imports -- 同上：环境变量设置前需要 fs 判定路径存在
const fs = require('fs')
// eslint-disable-next-line @typescript-eslint/no-require-imports -- 同上：child_process 无副作用，保持 require 一致性
const { spawn, execFileSync } = require('child_process')
const localBrowsersPath = path.join(__dirname, '..', '..', '..', '.playwright-browsers')
const packagedBrowsersPath = process.resourcesPath
  ? path.join(process.resourcesPath, '.playwright-browsers')
  : null
if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
  if (fs.existsSync(localBrowsersPath)) {
    process.env.PLAYWRIGHT_BROWSERS_PATH = localBrowsersPath
  } else if (packagedBrowsersPath && fs.existsSync(packagedBrowsersPath)) {
    process.env.PLAYWRIGHT_BROWSERS_PATH = packagedBrowsersPath
  }
}

import type { Browser, BrowserContext, Page } from 'playwright'
// 必须在设置 PLAYWRIGHT_BROWSERS_PATH 之后再 require('playwright')，
// 否则 ES 模块 import 会被提升到模块顶部，先于环境变量设置执行，
// Playwright 在加载时就缓存了默认浏览器路径 → 找不到 .playwright-browsers 里的二进制。
// eslint-disable-next-line @typescript-eslint/no-require-imports -- 顺序敏感：必须在 env 设置后加载
const { chromium, firefox } = require('playwright') as typeof import('playwright')

// 超时配置：导航 30s，普通操作 10s
const NAVIGATION_TIMEOUT_MS = 30000
const ACTION_TIMEOUT_MS = 10000

/**
 * 页面快照脚本（accessibility 树精简版，与内置浏览器面板 SNAPSHOT_SCRIPT 同构）：
 * DOM 遍历收集交互元素/容器标签/带 class div，返回给 LLM 直接阅读的文本。
 * 不依赖截图——这就是"无头看页面"的核心。
 */
const SNAPSHOT_SCRIPT = `
  (() => {
    const lines = [];
    const interactiveTags = new Set(['a','button','input','select','textarea','label','video','img']);
    const containerTags = new Set(['nav','main','article','section','form','table','ul','ol','li','header','footer','aside','h1','h2','h3','h4','h5','h6']);
    const walk = (el, depth) => {
      if (depth > 8) return;
      const tag = el.tagName.toLowerCase();
      const role = el.getAttribute('role') || '';
      const aria = el.getAttribute('aria-label') || '';
      const cls = el.getAttribute('class') || '';
      const href = tag === 'a' ? (el.getAttribute('href') || '') : '';
      const text = (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 100);
      const isInteractive = interactiveTags.has(tag) || role;
      const isContainer = containerTags.has(tag);
      const isDivWithClass = tag === 'div' && cls;
      if (isInteractive || isContainer || isDivWithClass) {
        let label = role || tag;
        if (aria) label += ' [aria="' + aria + '"]';
        if (cls) label += ' .' + cls.split(' ').slice(0, 2).join('.');
        if (href) label += ' -> ' + href.slice(0, 50);
        if (text && tag !== 'div') label += ': ' + text;
        lines.push('  '.repeat(depth) + label);
      }
      for (const child of Array.from(el.children)) walk(child, depth + 1);
    };
    if (document.body) walk(document.body, 0);
    return lines.join('\\n');
  })()
`

/**
 * 浏览器管理器：单例模式管理 Playwright Chromium 实例
 * - 懒加载启动 browser，复用实例避免重复启动开销
 * - BrowserContext 隔离 cookie/session
 * - 维护当前活动 Page 供工具连续操作
 * - 浏览器崩溃/断开自动重启

 * 双模式（浏览器登录态持久化，storageState 模式 B）：
 * - 模式 A（CDP 桥）：connectOverCDP 连接用户调试模式启动的本地浏览器（--remote-debugging-port），
 * 复用其已登录会话（默认浏览器的登录态）
 * - 模式 B（持久化 profile）：getContext 加载/保存 storageState 到 {userData}/browser-state.json，
 * 登录一次永久复用（独立 profile，不碰用户默认浏览器）
 * 优先级：已连接 CDP 会话 > 持久化 profile > 全新无头
 */
class BrowserManager {
  private browser: Browser | null = null
  private context: BrowserContext | null = null
  private page: Page | null = null
  private launchingPromise: Promise<Browser> | null = null
  /** storageState 持久化路径（{userData}/browser-state.json），null 则不持久化 */
  private storageStatePath: string | null = null
  /** 是否处于 CDP 连接模式（连的是用户本地浏览器，不能关 browser/context） */
  private cdpMode = false
  /** 无头浏览器工具（browser_navigate/snapshot/click/type/scroll/evaluate/status/takeover，来自
   * headless-browser 插件，工具名前缀是 browser_* 而非 headless_browser_*）的持久单页：跨调用保留同一页面，
   * 让 navigate→snapshot→click 等连续操作停在同一个页面（区别于 withPage 的"用完即关"）。 */
  private headlessPage: Page | null = null
  /** headless 持久页的并发锁（串行化 headless 工具操作） */
  private headlessLock: Promise<void> = Promise.resolve()
  /** headless 的 BrowserContext（CDP 接管或自带：两者都可能用作 headlessPage 宿主） */
  private headlessContext: BrowserContext | null = null

  /** 设置 storageState 持久化路径（登录态保存/加载用，模式 B） */
  setStorageStatePath(p: string | null): void {
    this.storageStatePath = p
  }

  /** 获取 browser 实例（懒加载，崩溃自动重启） */
  async getBrowser(): Promise<Browser> {
    if (this.browser && this.browser.isConnected()) {
      return this.browser
    }
    // 浏览器已断开，清理旧引用，下次启动会重建
    this.browser = null
    this.context = null
    this.page = null
    this.cdpMode = false
    // 并发去重：避免多次同时调用时重复启动
    if (this.launchingPromise) {
      return this.launchingPromise
    }
    this.launchingPromise = this.launchBrowser()
    try {
      return await this.launchingPromise
    } finally {
      this.launchingPromise = null
    }
  }

  /** 挂接断开清理逻辑并登记当前 browser 实例（msedge / headless_shell 两条启动路径共用） */
  private attachBrowser(browser: Browser): Browser {
    browser.on('disconnected', () => {
      // 浏览器崩溃/断开：清理引用，下次 getBrowser 会自动重启
      this.browser = null
      this.context = null
      this.page = null
      this.cdpMode = false
    })
    this.browser = browser
    return browser
  }

  private async launchBrowser(): Promise<Browser> {
    // ===== 为什么支持任意常见浏览器（多级候选链）=====
    // 之前只认 channel:'msedge'：Windows 10/11 系统自带 Edge，Playwright 官方支持
    // channel:'msedge' 直接复用本机内核 → 发布包零浏览器分发（不打包 headless_shell 约 271MB）。
    // 但只认 Edge 有盲区：精简版/策略禁用的系统没有 Edge，用户更习惯 Chrome/Brave/Firefox
    // 的机器也应直接可用。策略 = 多级候选链，本机装了什么就用什么，未安装的自动跳过：
    // 1) 官方 channel 链：msedge → chrome（Playwright 按注册表+安装路径自动定位，最可靠）
    // 2) 常见安装路径自动探测（可执行文件真实存在才入链）
    // 覆盖 Edge/Chrome/Brave/Vivaldi/Opera/Chromium（Chromium 内核，chromium.launch）
    // 与 Firefox（非 Chromium 内核，必须 firefox.launch）
    // 3) 内置 headless_shell 最后兜底（无任何常见浏览器也能用）
    // ===== 为什么保留 headless_shell 降级（不能删）=====
    // 仍有全部常见浏览器缺失/被禁用/启动失败的机器，此时必须能回退到本地内置
    // headless_shell（PLAYWRIGHT_BROWSERS_PATH 已注入），保证浏览器工具在任何环境都可用
    // ——删掉降级路径，无浏览器环境将完全失去网页能力。
    // ===== CDP 路径不受影响（保留理由）=====
    // channel/executablePath 只作用于 chromium.launch / firefox.launch；connectOverCDP /
    // launchUserBrowser（一键接管系统默认浏览器）连的是用户自己启动的调试端口浏览器，
    // 本就不依赖月蚀自带内核，原样保留不动。
    const failures: string[] = []
    // channel 启动尝试：失败记录原因并继续下一候选（不中断候选链）
    const tryChannel = async (channel: string): Promise<Browser | null> => {
      try {
        return this.attachBrowser(await chromium.launch({ headless: true, channel }))
      } catch (err) {
        failures.push(`channel:${channel} 启动失败（${(err as Error).message}）`)
        return null
      }
    }
    // 1. 官方 channel 链：msedge（Windows 自带，最稳）→ chrome（最常见第三方浏览器）
    for (const ch of ['msedge', 'chrome']) {
      const b = await tryChannel(ch)
      if (b) return b
    }
    // 2. 探测本机已安装的常见浏览器（可执行文件真实存在才尝试）
    for (const c of detectInstalledBrowsers()) {
      try {
        return this.attachBrowser(
          c.kind === 'firefox'
            ? await firefox.launch({ headless: true, executablePath: c.exe })
            : await chromium.launch({ headless: true, executablePath: c.exe })
        )
      } catch (err) {
        failures.push(`${c.name}（${c.exe}）启动失败（${(err as Error).message}）`)
      }
    }
    // 3. 最后兜底：内置 headless_shell（无需 channel/executablePath，走已注入的内核）
    try {
      return this.attachBrowser(await chromium.launch({ headless: true }))
    } catch (headlessErr) {
      failures.push(`内置 headless_shell 启动失败（${(headlessErr as Error).message}）`)
    }
    // 全部候选失败：逐条列出失败原因，给出可操作指引
    throw new Error(
      `浏览器启动失败：全部候选不可用。\n` +
        failures.map((f) => `  - ${f}`).join('\n') +
        '\n请安装任意常见浏览器（Edge/Chrome/Brave/Firefox 等）后重试；' +
        '或改用 browser_takeover 接管系统默认浏览器（CDP 通道不依赖月蚀自带内核）。'
    )
  }

  /**
   * 模式 A：连接本地调试模式浏览器（CDP 桥）。
   * 用户以 --remote-debugging-port=PORT 启动 Edge/Chrome，月蚀连接它并复用其已登录会话。
   * 返回 { ok, browserName? }；失败（端口无浏览器/连不上）返回 { ok: false, error }。
   */
  async connectOverCDP(port: number): Promise<{ ok: boolean; error?: string; pageCount?: number }> {
    try {
      // 先断开当前无头浏览器（避免两套并存）
      if (this.browser && !this.cdpMode) {
        await this.closeBrowser()
      }
      const cdpBrowser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
      const contexts = cdpBrowser.contexts()
      if (contexts.length === 0) {
        return { ok: false, error: 'CDP 浏览器无 context（可能没有打开的标签页）' }
      }
      this.browser = cdpBrowser
      this.context = contexts[0]
      this.page = contexts[0].pages()[0] ?? null
      this.cdpMode = true
      // CDP 接管后清空 headless 持久页（下次操作基于真实浏览器 context 重建，复用登录态）
      await this.closeHeadless()
      cdpBrowser.on('disconnected', () => {
        this.browser = null
        this.context = null
        this.page = null
        this.cdpMode = false
        void this.closeHeadless()
      })
      return { ok: true, pageCount: contexts[0].pages().length }
    } catch (err) {
      return { ok: false, error: `CDP 连接失败: ${(err as Error).message}` }
    }
  }

  /** 检测本地调试端口是否有浏览器在跑（CDP 可用性检查） */
  async checkCdp(port: number): Promise<{ available: boolean; pageCount?: number }> {
    try {
      const cdpBrowser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
      const count = cdpBrowser.contexts()[0]?.pages().length ?? 0
      await cdpBrowser.close()
      return { available: true, pageCount: count }
    } catch {
      return { available: false }
    }
  }

  /** 当前是否处于 CDP 连接模式（连的是用户本地浏览器） */
  isCdpMode(): boolean {
    return this.cdpMode
  }

  /**
   * 一键接管默认浏览器：
   * 端口已有浏览器 → 直接连接；否则检测系统默认浏览器（Windows 注册表 http 关联）
   * → 以 --remote-debugging-port + 独立 user-data-dir 启动 → 轮询端口就绪 → connectOverCDP 接管。
   * 独立 profile 避免与用户日常浏览器实例冲突（默认浏览器开着时也能并行启动接管实例）。
   */
  async launchUserBrowser(port: number, profileDir: string): Promise<{ ok: boolean; error?: string; launched?: boolean; browserName?: string }> {
    // 端口已有浏览器 → 直接连（用户已手动启动过调试模式）
    const existing = await this.checkCdp(port)
    if (existing.available) {
      const conn = await this.connectOverCDP(port)
      return { ok: conn.ok, error: conn.error, launched: false }
    }
    // 检测默认浏览器
    const exe = detectDefaultBrowser()
    if (!exe) {
      return { ok: false, error: '未找到系统默认浏览器（Windows 注册表 http 关联读取失败），请手动启动：浏览器 --remote-debugging-port=9222' }
    }
    // 启动接管实例（独立 profile + 调试端口）
    try {
      fs.mkdirSync(profileDir, { recursive: true })
      const child = spawn(
        exe,
        [
          `--remote-debugging-port=${port}`,
          `--user-data-dir=${profileDir}`,
          '--no-first-run',
          '--no-default-browser-check',
          '--no-service-autorun'
        ],
        { detached: true, stdio: 'ignore', windowsHide: true }
      )
      child.unref()
    } catch (err) {
      return { ok: false, error: `启动浏览器失败: ${(err as Error).message}` }
    }
    // 轮询端口就绪（最多 15s，浏览器冷启动较慢）
    const deadline = Date.now() + 15000
    while (Date.now() < deadline) {
      const ready = await this.checkCdp(port)
      if (ready.available) {
        const conn = await this.connectOverCDP(port)
        return { ok: conn.ok, error: conn.error, launched: true, browserName: exe }
      }
      await new Promise((r) => setTimeout(r, 500))
    }
    return { ok: false, error: `浏览器已启动但端口 ${port} 15s 内未就绪（可能启动失败或被杀软拦截）` }
  }

  /** 获取/创建 BrowserContext（模式 B：加载持久化 storageState；CDP 模式返回已连接 context） */
  async getContext(): Promise<BrowserContext> {
    if (this.cdpMode && this.context) {
      return this.context
    }
    const browser = await this.getBrowser()
    if (this.context) {
      return this.context
    }
    // 模式 B：有持久化登录态则加载
    let storageState: string | undefined
    if (this.storageStatePath && fs.existsSync(this.storageStatePath)) {
      storageState = this.storageStatePath
    }
    this.context = await browser.newContext(storageState ? { storageState } : {})
    return this.context
  }

  /** 保存当前 context 的登录态到 storageState 文件（模式 B，登录后调用） */
  async saveStorageState(): Promise<{ ok: boolean; error?: string }> {
    if (!this.storageStatePath) {
      return { ok: false, error: '未设置 storageState 路径（模式 B 未启用）' }
    }
    if (!this.context) {
      return { ok: false, error: '没有活动 context（先打开浏览器）' }
    }
    try {
      const state = await this.context.storageState()
      fs.mkdirSync(path.dirname(this.storageStatePath), { recursive: true })
      fs.writeFileSync(this.storageStatePath, JSON.stringify(state, null, 2), 'utf-8')
      return { ok: true }
    } catch (err) {
      return { ok: false, error: `保存登录态失败: ${(err as Error).message}` }
    }
  }

  /** 清除持久化登录态（模式 B） */
  clearStorageState(): void {
    if (this.storageStatePath && fs.existsSync(this.storageStatePath)) {
      fs.unlinkSync(this.storageStatePath)
    }
  }

  /** 获取当前活动 Page，不存在或已关闭则创建新 Page */
  async getPage(): Promise<Page> {
    const ctx = await this.getContext()
    if (this.page && !this.page.isClosed()) {
      return this.page
    }
    this.page = await ctx.newPage()
    this.page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS)
    this.page.setDefaultTimeout(ACTION_TIMEOUT_MS)
    return this.page
  }

  /** 关闭当前页面（保留 browser/context，下次操作会自动新建 Page） */
  async closePage(): Promise<void> {
    if (this.page && !this.cdpMode) {
      try { await this.page.close() } catch { /* 忽略关闭错误 */ }
      this.page = null
    }
  }

  /**
   * 原子化页面操作：互斥锁串行执行 fn(page)，用完后自动关闭页面。
   * 解决并发竞争：多个调用方（web_search 读页 / deepSearch / 工具连续操作）同时
   * getPage/closePage 会争抢同一个单例页面，导致页面被中途导航走/关闭 → 读到空正文。
   * 锁内串行执行，互不干扰；返回 fn 的结果。
   */
  private pageLock: Promise<void> = Promise.resolve()

  async withPage<T>(fn: (page: Page) => Promise<T>): Promise<T> {
    const prev = this.pageLock
    let release!: () => void
    this.pageLock = new Promise<void>((res) => (release = res))
    await prev
    try {
      const page = await this.getPage()
      try {
        return await fn(page)
      } finally {
        await this.closePage()
      }
    } finally {
      release()
    }
  }

  // ============================================================
  // 无头浏览器"看 + 操作"能力：
  // 改为"持久单页"模型——navigate→snapshot→click 等连续操作停在**同一个页面**。
  // （之前用 withPage 每次用完即关，导致导航后的页面被关、快照/取链拿到空白页——会话实证 bug）
  // 不依赖截图——"看页面"= accessibility 快照文本。
  // ============================================================

  /** 以串行锁执行 headless 持久页操作（获取/复用同一页面，用完不关） */
  private async withHeadless<T>(fn: (page: Page) => Promise<T>): Promise<T> {
    const prev = this.headlessLock
    let release!: () => void
    this.headlessLock = new Promise((res) => (release = res))
    await prev
    try {
      const page = await this.getHeadlessPage()
      return await fn(page)
    } finally {
      release()
    }
  }

  /** 获取 headless 持久页（复用现有；否则基于当前 browser/context 新建） */
  private async getHeadlessPage(): Promise<Page> {
    if (this.headlessPage && !this.headlessPage.isClosed()) {
      return this.headlessPage
    }
    // context：CDP 接管时用已连接 context；否则获取/创建自带 context
    const ctx = this.cdpMode && this.context ? this.context
      : this.headlessContext ?? (this.headlessContext = await this.getContext())
    const page = await ctx.newPage()
    page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS)
    page.setDefaultTimeout(ACTION_TIMEOUT_MS)
    this.headlessPage = page
    return page
  }

  /** 关闭 headless 持久页（takeover 切换/CDP 重连前清理；下次操作自动重建） */
  async closeHeadless(): Promise<void> {
    if (this.headlessPage && !this.headlessPage.isClosed()) {
      try { await this.headlessPage.close() } catch { /* 忽略 */ }
    }
    this.headlessPage = null
    this.headlessContext = null
  }

  /** 无头导航并返回最终 URL/标题（停在持久页上，供后续 snapshot/click 复用） */
  async navigateHeadless(url: string): Promise<{ title: string; url: string }> {
    return this.withHeadless(async (page) => {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS })
      await page.waitForTimeout(1500)
      return { title: await page.title(), url: page.url() }
    })
  }

  /** 无头页面快照：accessibility 树精简版文本（给 LLM 阅读，不依赖截图） */
  async snapshot(): Promise<string> {
    return this.withHeadless(async (page) => {
      const text = await page.evaluate(SNAPSHOT_SCRIPT as string)
      return String(text ?? '').trim() || '(空页面，body 无内容)'
    })
  }

  /** 无头点击元素（CSS 选择器；找不到则尝试滚动进视图后点） */
  async click(selector: string): Promise<void> {
    return this.withHeadless(async (page) => {
      const el = page.locator(selector).first()
      await el.scrollIntoViewIfNeeded({ timeout: ACTION_TIMEOUT_MS })
      await el.click({ timeout: ACTION_TIMEOUT_MS })
    })
  }

  /** 无头输入文本（默认先清空） */
  async type(selector: string, text: string, clear = true): Promise<void> {
    return this.withHeadless(async (page) => {
      const el = page.locator(selector).first()
      await el.scrollIntoViewIfNeeded({ timeout: ACTION_TIMEOUT_MS })
      if (clear) await el.fill(text, { timeout: ACTION_TIMEOUT_MS }).catch(async () => {
        await el.click({ timeout: ACTION_TIMEOUT_MS })
        await page.keyboard.press('Control+a')
        await page.keyboard.type(text)
      })
      else await el.type(text, { timeout: ACTION_TIMEOUT_MS })
    })
  }

  /** 无头滚动页面 */
  async scroll(direction: 'up' | 'down', amount = 500): Promise<void> {
    return this.withHeadless(async (page) => {
      await page.mouse.wheel(0, direction === 'down' ? amount : -amount)
      await page.waitForTimeout(300)
    })
  }

  /** 无头执行 JS，返回结果（JSON 序列化） */
  async evaluate(script: string): Promise<unknown> {
    return this.withHeadless(async (page) => {
      const result = await page.evaluate(script)
      return result === undefined ? null : result
    })
  }

  /** 无头当前状态：URL / 标题 / 快照 —— 操作后让 AI 感知结果（不依赖截图） */
  async getState(): Promise<{ url: string; title: string; snapshot: string }> {
    return this.withHeadless(async (page) => {
      return {
        url: page.url(),
        title: await page.title(),
        snapshot: String(await page.evaluate(SNAPSHOT_SCRIPT as string) ?? '').trim() || '(空页面)'
      }
    })
  }


  async closeBrowser(): Promise<void> {
    if (this.page && !this.cdpMode) {
      try { await this.page.close() } catch { /* 忽略 */ }
      this.page = null
    }
    if (this.context && !this.cdpMode) {
      try { await this.context.close() } catch { /* 忽略 */ }
      this.context = null
    }
    if (this.browser && !this.cdpMode) {
      try { await this.browser.close() } catch { /* 忽略 */ }
      this.browser = null
    }
    // CDP 模式：只是断开连接，不关用户浏览器
    if (this.cdpMode) {
      this.browser = null
      this.context = null
      this.page = null
      this.cdpMode = false
    }
  }
}

// 单例：全进程共享一个浏览器实例
/** 读取 Windows 注册表值（reg query，返回 REG_SZ 值；valueName 为空读默认值；失败返回 null） */
function readRegistry(key: string, valueName: string): string | null {
  try {
    const args = valueName ? ['query', key, '/v', valueName] : ['query', key, '/ve']
    const out = execFileSync('reg', args, { encoding: 'utf8', timeout: 5000, windowsHide: true })
    for (const line of out.split('\n')) {
      const m = line.match(/REG_SZ\s+(.+)$/i)
      if (m) return m[1].trim()
    }
    return null
  } catch {
    return null
  }
}

/**
 * 检测系统默认浏览器可执行文件（Windows）：
 * 1. 注册表 http 关联 ProgId → HKCR\ProgId\shell\open\command 取 exe 路径
 * （ProgId 可能带随机后缀如 TbBrHTM.xxx——尝试完整名和去掉后缀两部分）
 * 2. 回退：Edge/Chrome 常见安装路径
 */
function detectDefaultBrowser(): string | null {
  try {
    const userChoiceKey = 'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice'
    const progId = readRegistry(userChoiceKey, 'ProgId')
    if (progId) {
      // ProgId 变体：完整名 + 去掉随机后缀（TbBrHTM.2LKIVV3... → TbBrHTM）
      const variants = [...new Set([progId, progId.split('.')[0]])]
      for (const v of variants) {
        const cmd = readRegistry(`HKCR\\${v}\\shell\\open\\command`, '')
        if (!cmd) continue
        // 优先取引号内的 exe 路径（"C:\...\msedge.exe" "args"）
        const quoted = cmd.match(/"([^"]+\.exe)"/i)
        if (quoted && fs.existsSync(quoted[1])) return quoted[1]
        // 无引号形式：第一个 token
        const first = cmd.trim().split(/\s+/)[0]
        if (first && fs.existsSync(first)) return first
      }
    }
  } catch {
    /* 注册表读取失败走回退 */
  }
  const pf = process.env.ProgramFiles ?? ''
  const pf86 = process.env['ProgramFiles(x86)'] ?? ''
  const candidates = [
    path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe')
  ]
  for (const c of candidates) {
    if (fs.existsSync(c)) return c
  }
  return null
}

/**
 * 探测本机已安装的常见浏览器可执行文件（Windows）：
 * 为什么存在——只靠 channel 无法覆盖 Brave/Vivaldi/Opera/Firefox 等浏览器，
 * executablePath 探测让"任何常见浏览器"都能被自动发现并启动（存在才入链，不存在自动跳过）。
 * 返回 [{ name, exe, kind }]，kind 区分 Chromium 内核与 Firefox：
 * 'chromium' → 用 chromium.launch（Chrome 系内核，channel 亦可驱动）
 * 'firefox' → 必须用 firefox.launch（Firefox 不是 Chromium 内核，混用会报错）
 * 覆盖路径：Edge/Chrome（Program Files 与 x86 双位）、Brave、Vivaldi、Opera、
 * Chromium（LOCALAPPDATA）、Firefox（Program Files 与 x86）。
 */
function detectInstalledBrowsers(): Array<{ name: string; exe: string; kind: 'chromium' | 'firefox' }> {
  const pf = process.env.ProgramFiles ?? ''
  const pf86 = process.env['ProgramFiles(x86)'] ?? ''
  const la = process.env.LOCALAPPDATA ?? ''
  const candidates: Array<{ name: string; exe: string; kind: 'chromium' | 'firefox' }> = [
    { name: 'Edge', exe: path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), kind: 'chromium' },
    { name: 'Edge', exe: path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), kind: 'chromium' },
    { name: 'Chrome', exe: path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'), kind: 'chromium' },
    { name: 'Chrome', exe: path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'), kind: 'chromium' },
    { name: 'Chrome', exe: path.join(la, 'Google', 'Chrome', 'Application', 'chrome.exe'), kind: 'chromium' },
    { name: 'Chromium', exe: path.join(la, 'Chromium', 'Application', 'chrome.exe'), kind: 'chromium' },
    { name: 'Brave', exe: path.join(pf, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'), kind: 'chromium' },
    { name: 'Brave', exe: path.join(la, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'), kind: 'chromium' },
    { name: 'Vivaldi', exe: path.join(la, 'Vivaldi', 'Application', 'vivaldi.exe'), kind: 'chromium' },
    { name: 'Opera', exe: path.join(pf, 'Opera', 'opera.exe'), kind: 'chromium' },
    { name: 'Opera', exe: path.join(la, 'Programs', 'Opera', 'opera.exe'), kind: 'chromium' },
    { name: 'Firefox', exe: path.join(pf, 'Mozilla Firefox', 'firefox.exe'), kind: 'firefox' },
    { name: 'Firefox', exe: path.join(pf86, 'Mozilla Firefox', 'firefox.exe'), kind: 'firefox' }
  ]
  // 去重（同一 path 命中多个候选名时保留第一个）+ 过滤不存在
  const seen = new Set<string>()
  const found: Array<{ name: string; exe: string; kind: 'chromium' | 'firefox' }> = []
  for (const c of candidates) {
    if (seen.has(c.exe)) continue
    seen.add(c.exe)
    if (fs.existsSync(c.exe)) found.push(c)
  }
  return found
}

export const browserManager = new BrowserManager()
export { BrowserManager }
