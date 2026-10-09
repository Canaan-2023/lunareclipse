/**
 * lune-media:// 特权协议：生成产物 + 头像图片的安全媒体通道。

 * 为什么存在：渲染进程（dev=http://localhost / prod=file://）无法直接加载本地
 * file:// 媒体（Chromium 拦截跨源本地资源），需要受控协议把磁盘媒体暴露给页面——

 * 作用：渲染进程（dev=http://localhost / prod=file://）无法直接加载本地 file://
 * 媒体（Chromium 拦截跨源本地资源）。本协议只放行
 * {dataRoot}/abyssac_data/generated/**（生成产物）
 * {dataRoot}/abyssac_data/avatars/**（AI/用户头像，avatar.{png|jpg|webp|gif}）
 * 扩展名白名单内的文件，供 <img>/<video>/<audio> 以
 * lune-media:///generated/U1/AI1/image/... 或 lune-media:///avatars/ai/3/avatar.png 形式加载。

 * 安全边界：
 * - 路径解析后必须落在数据根内（resolve 消解 .. 穿越，再前缀校验）
 * - 扩展名白名单（图片/视频/音频/文稿），其余 403
 * - 只读、无目录列表、URL 必须以 generated/ 或 avatars/ 开头
 */
import { protocol } from 'electron'
import { readFileSync, statSync } from 'fs'
import { join, resolve, extname } from 'path'

export const MEDIA_SCHEME = 'lune-media'

/** 允许服务的扩展名 → MIME（生成产物四分类的常见格式） */
const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8'
}

/** abyssac_data 根目录提供者（whenReady 后注入；此前请求一律 404） */
let dataRootProvider: (() => string | null) | null = null

/**
 * 注册特权 scheme。必须在 app ready 之前调用（registerSchemesAsPrivileged 的硬性要求），
 * 在 index.ts 模块顶层执行一次。
 */
export function registerMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: MEDIA_SCHEME,
      privileges: {
        standard: false,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        bypassCSP: false
      }
    }
  ])
}

/**
 * 挂载协议处理器（app ready 后调用一次）。
 * @param getDataRoot 返回 abyssac_data 根目录（如 dataDir 变更后可读到新值）
 */
export function initMediaProtocol(getDataRoot: () => string | null): void {
  dataRootProvider = getDataRoot
  protocol.handle(MEDIA_SCHEME, (request) => {
    const notFound = () => new Response('not found', { status: 404 })
    try {
      const root = dataRootProvider?.()
      if (!root) return notFound()

      // lune-media:///generated/U1/AI1/image/2026/09/14/x.png → pathname=/generated/...
      const url = new URL(request.url)
      const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '')
      // 只服务 generated/ 与 avatars/ 下（防越界读其他数据目录）
      if (!rel.startsWith('generated/') && !rel.startsWith('avatars/')) {
        return new Response('forbidden', { status: 403 })
      }
      const ext = extname(rel).toLowerCase()
      const mime = MIME_BY_EXT[ext]
      if (!mime) {
        return new Response('forbidden extension', { status: 403 })
      }
      // resolve 消解 .. / . 后强制落在 data root 内
      const abs = resolve(join(root, rel))
      if (!abs.startsWith(resolve(root) + '\\') && !abs.startsWith(resolve(root) + '/')) {
        return new Response('forbidden', { status: 403 })
      }
      const st = statSync(abs)
      if (!st.isFile()) return notFound()
      const buf = readFileSync(abs)
      return new Response(new Uint8Array(buf), {
        status: 200,
        headers: { 'Content-Type': mime, 'Content-Length': String(st.size) }
      })
    } catch {
      return notFound()
    }
  })
}
