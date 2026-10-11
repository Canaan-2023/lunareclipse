/**
 * @category 核心
 * @summary 代码审查（code-review）报告通道：审查链收集、HTML 报告渲染与落盘、浏览器打开

 * 从 server.ts 拆出（纯搬移，不改行为）。
 * 为什么存在：审查链（执行者产出 + 独立审查意见 + 修正轮）在对话流中逐轮产生，
 * 结束（[REVIEW_PASS] 或达最大轮数）时把整条链渲染为自包含 HTML 报告，落盘到工程
 * reports/ 目录，并在月蚀内置浏览器（browser:navigate）中打开——用户可以直接在
 * 浏览器面板里审阅而非在聊天里翻找。headless/无窗口场景下打开失败仅记日志，
 * 报告文件仍在 reports/ 可手动用浏览器打开。
 * 键 = messageId（主回复的 messageId；审查/修正轮在同一 session 内继续用该键聚合）。
 * 独立成文件：server.ts 的 runStream 只负责轮次调度（调 MAX_REVIEW_ROUNDS/审查 prompt/
 * 链收集函数），本模块收拢「链的存储 + 报告的渲染与打开」，新增审查场景（如手动触发、
 * 定时审查）可直接复用本模块能力而不触碰流引擎。
 *
 * 未来功能增减规划（本模块扩展边界）：
 * - 新增审查维度（如安全专项审查）：在 REVIEWER_SYSTEM_PROMPT 中扩展阶段，或为不同
 * 审查目标新增 prompt 常量，runStream 按阶段选择注入；
 * - 报告格式升级（PDF/分页/暗色主题切换）：只改 writeCodeReviewReport，调用方无感；
 * - 审查历史查询（reports/ 目录文件枚举）：在 getReportsRoot 之上加只读列表函数。
 */
import http from 'http'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { browserViewManager } from '../tools/browser-view-manager'

/** 审查链单轮条目：角色（产出/审查/修正）与原始文本 */
export type CodeReviewRole = '产出' | '审查' | '修正'
export interface CodeReviewChainEntry {
  role: CodeReviewRole
  content: string
}

/**
 * 本机 API 访问令牌与 server 实例的注入点。
 * 为什么存在：openCodeReviewReport 打开报告 URL 时需要「server 端口 + 鉴权 token」，
 * 而 server 与 token 的宿主（server.ts）不能反向依赖本模块（避免循环 import），
 * 故由 startApiServer 装配完成后注入两个 getter，这里只按需取值、不持有生命周期。
 */
let serverRef: (() => http.Server | null) | null = null
let tokenRef: (() => string) | null = null
/** 绑定报告打开所需的 server/port 与 token 读取器（startApiServer 装配时调用一次） */
export function bindCodeReviewEnv(env: { getServer: () => http.Server | null; getToken: () => string }): void {
  serverRef = env.getServer
  tokenRef = env.getToken
}

/** 审查链存储：键 = messageId（审查/修正轮沿同一键聚合） */
const codeReviewChainRef = new Map<string, CodeReviewChainEntry[]>()

/** 是否以「单独一行 [REVIEW_PASS]」宣告审查通过（行级匹配，防叙述中出现该字样误判） */
export function hasReviewPass(output: string): boolean {
  return output.split('\n').some((line) => line.trim() === '[REVIEW_PASS]')
}

/** 取某会话的审查链（无链返回 undefined；只读，不消费） */
export function getCodeReviewChain(sessionId: string): CodeReviewChainEntry[] | undefined {
  return codeReviewChainRef.get(sessionId)
}

/**
 * 主回复轮初始化审查链（覆盖式：新一轮主产出取代旧链根）。
 * 什么时候被调：runStream 完成主回复（非 review/rework）时。
 */
export function setCodeReviewChain(sessionId: string, entry: CodeReviewChainEntry): void {
  codeReviewChainRef.set(sessionId, [entry])
}

/**
 * 审查/修正轮追加（有链则 push，无链兜底建链）。
 * 为什么有兜底：异常顺序（未初始化就出现 review/rework 轮，理论不达）也不丢内容。
 */
export function appendCodeReviewChain(sessionId: string, entry: CodeReviewChainEntry): void {
  const prevChain = codeReviewChainRef.get(sessionId)
  if (prevChain) {
    prevChain.push(entry)
  } else {
    codeReviewChainRef.set(sessionId, [entry])
  }
}

/** 取整链并清除（审查结束分支用；返回空数组当无链，与调用方「?? []」语义一致） */
export function takeCodeReviewChain(sessionId: string): CodeReviewChainEntry[] {
  const chain = codeReviewChainRef.get(sessionId)
  codeReviewChainRef.delete(sessionId)
  return chain ?? []
}

/** 工程根 reports/ 目录（只读静态服务的根；报告落盘处） */
export function getReportsRoot(): string {
  return join(__dirname, '..', '..', '..', 'reports')
}

/** 审查文本转 HTML（转义防注入；severity 行首标签高亮） */
function escapeHtmlText(t: string): string {
  return t
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\n/g, '<br/>')
}
function highlightSeverity(t: string): string {
  // 行首 [CRITICAL]/[MAJOR]/[MINOR]/[NIT]/[REVIEW_PASS] 标成带色徽章，其余原样转义
  return escapeHtmlText(t).replace(
    /\[(CRITICAL|MAJOR|MINOR|NIT|REVIEW_PASS)\]/g,
    (_, sev: string) =>
      `<span class="sev sev-${sev.toLowerCase()}">[${sev}]</span>`
  )
}

/** 把审查链渲染为自包含 HTML 并落盘 reports/，返回 {file, url} */
export function writeCodeReviewReport(
  chain: Array<{ role: string; content: string }>,
  sessionId: string | undefined
): { file: string; url: string } {
  const file = `code-review-${Date.now()}.html`
  const body = chain
    .map(
      (r, i) =>
        `<section class="round">
  <div class="round-head">第 ${i + 1} 轮 · ${escapeHtmlText(r.role)}</div>
  <div class="round-body">${highlightSeverity(r.content)}</div>
</section>`
    )
    .join('\n')
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>代码审查报告（月蚀 code-review）</title>
<style>
  body{margin:0;background:#0f1115;color:#e6e8ee;font:14px/1.7 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;padding:24px}
  h1{font-size:20px;margin:0 0 4px}
  .sub{color:#8b93a7;margin:0 0 20px;font-size:12px}
  .round{border:1px solid #232838;border-radius:8px;margin:0 0 14px;overflow:hidden}
  .round-head{background:#171a23;padding:6px 12px;font-size:12px;color:#9aa3ba}
  .round-body{padding:12px;white-space:normal;word-break:break-word}
  .sev{display:inline-block;border-radius:4px;padding:0 6px;font-weight:600;font-size:12px}
  .sev-critical{background:#4a1020;color:#ff7a8a}
  .sev-major{background:#4a2a10;color:#ffb36b}
  .sev-minor{background:#23324a;color:#8ab8ff}
  .sev-nit{background:#2a2a30;color:#b9becd}
  .sev-review_pass{background:#0f3522;color:#7ee2a8}
</style>
</head>
<body>
<h1>代码审查报告</h1>
<p class="sub">session: ${escapeHtmlText(sessionId ?? '（无）')} · 生成于 ${new Date().toLocaleString('zh-CN')} · 月蚀 code-review</p>
${body}
</body>
</html>`
  const filePath = join(getReportsRoot(), file)
  mkdirSync(getReportsRoot(), { recursive: true })
  writeFileSync(filePath, html, 'utf-8')
  // url 需由调用方补充端口与 token（写报告时 server 可能未 listen，端口未知）
  return { file, url: '' }
}

/** 在月蚀内置浏览器中打开报告（headless/失败仅日志，不打断主流程） */
export async function openCodeReviewReport(chain: Array<{ role: string; content: string }>, sessionId: string | undefined): Promise<void> {
  try {
    const { file } = writeCodeReviewReport(chain, sessionId)
    const addr = serverRef ? serverRef()?.address() : undefined
    const port = typeof addr === 'object' && addr ? addr.port : 0
    if (!port) {
      console.log(`[code-review] 报告已生成（server 未监听，跳过自动打开）: reports/${file}`)
      return
    }
    const url = `http://127.0.0.1:${port}/reports/${file}?token=${tokenRef ? tokenRef() : ''}`
    await browserViewManager.show()
    await browserViewManager.navigate(url)
    console.log(`[code-review] 报告已生成并在月蚀浏览器打开: reports/${file}`)
  } catch (err) {
    console.log(`[code-review] 报告已生成（浏览器打开失败，可手动用浏览器打开 reports/）: ${(err as Error).message}`)
  }
}

/** 代码审查最大轮数：主回复 + review + rework 交替，达到即强制结束（防无限自审） */
export const MAX_REVIEW_ROUNDS = 4

// 审查者提示词统一集中管理（prompts/reviewer.ts）：REVIEWER_SYSTEM_PROMPT / REVIEW_INSTRUCTION
export { REVIEWER_SYSTEM_PROMPT, REVIEW_INSTRUCTION } from '../prompts/reviewer'