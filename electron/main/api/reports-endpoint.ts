/**
 * @category API
 * @summary 只读报告静态服务（`/reports/:name`）
 *
 * 为什么存在：code-review 等审查链落盘成 HTML 后，需要能在月蚀内置浏览器中打开。
 * 浏览器导航只能访问 http/https（`browser-view-manager` 协议白名单禁止 `file:`），故把工程
 * `reports/` 目录经本机 HTTP 端点只读暴露。令牌校验已在 `auth-middleware` 完成，本模块只做：
 * 1) **路径穿越防护**——只允许 reports 根目录下的单层文件名（禁用 `/`、`\`、`..`），fail-fast 400；
 * 2) **扩展名白名单**——只放行报告类静态资源（html/htm/md/txt），禁任意文件下载，越权 403；
 * 3) **统一 charset**——html 走 text/html，md/txt 原样返回纯文本供浏览器直接渲染。
 *
 * 不删理由：它是「报告可在应用内打开」这条链路的唯一 HTTP 出口；路径与扩展名两道防线是分发版的
 * 本机文件读取边界，移出后仍必须与 `auth-middleware` 的 `/reports/` token 放行口径配套使用。
 */
import type { Express } from 'express'
import { existsSync, mkdirSync, readFileSync } from 'fs'
import { join } from 'path'

export interface ReportsEndpointDeps {
  /** 报告目录（由调用方经 `getReportsRoot()` 取得——锚点派生 + 越界守卫，见 utils/app-root） */
  reportsRoot: string
}

/** 安装 `/reports/:name` 只读端点（须在鉴权中间件之后注册）。 */
export function installReportsEndpoint(app: Express, deps: ReportsEndpointDeps): void {
  const reportsRoot = deps.reportsRoot
  mkdirSync(reportsRoot, { recursive: true })
  app.get('/reports/:name', (req, res) => {
    const name = req.params.name ?? ''
    // 防穿越：只允许单层文件名；含路径分隔符/上级引用直接拒绝（fail-fast）
    if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) {
      res.status(400).json({ error: 'bad report name' })
      return
    }
    const filePath = join(reportsRoot, name)
    if (!existsSync(filePath)) {
      res.status(404).json({ error: 'report not found' })
      return
    }
    const lower = name.toLowerCase()
    const extOk =
      lower.endsWith('.html') ||
      lower.endsWith('.htm') ||
      lower.endsWith('.md') ||
      lower.endsWith('.txt')
    if (!extOk) {
      res.status(403).json({ error: 'report type not allowed' })
      return
    }
    res.type(
      lower.endsWith('.md') || lower.endsWith('.txt') ? 'text/plain; charset=utf-8' : 'text/html; charset=utf-8'
    )
    res.send(readFileSync(filePath, 'utf-8'))
  })
}
