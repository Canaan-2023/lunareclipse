/**
 * @category ROOM
 * @summary ROOM 的本地资源协议：`room-asset://room/AI{aiId}/live2d/...`、
 * `room-asset://room/AI{aiId}/background|scenes/...`、`room-asset://room/global/...`
 *
 * 为什么需要：渲染进程开着 `webSecurity`，不能直接 `file://` 读用户数据目录；
 * Live2D 的 `.model3.json` 会按相对路径去 fetch `.moc3` / 贴图 / 物理文件，
 * 必须有一个**标准、可 fetch、可被 canvas 读**的源。
 * 背景/分区场景同理：4K 图走协议比 base64 过 IPC 快一个数量级（见 `appearance-store.ts`）。
 *
 * 边界（**只读、按目录白名单**）：
 * - `/AI{n}/live2d/{json,moc3,png,jpg,js,wasm}`；
 * - `/global/live2d/...`（全局回落：随包素材默认落 `<data>/room/live2d/`，
 *   多个 AI 共用一份模型，不必各复制 50MB）；
 * - `/AI{n}/background/{background.png|jpg|jpeg}`（**只认固定文件名**，不接受子目录）；
 * - `/AI{n}/scenes/{zone}.{png|jpg|jpeg}`（zone 取自 `ROOM_SCENE_ZONES`）；
 * - `/global/background|scenes/...` 是全局回落目录；
 * - 先 `resolve` 再 `relative` 校验，任何 `..` / 绝对路径越界直接 403；
 * - 不列目录、不写文件、不代理网络。
 *
 * **授权说明**：`live2dcubismcore.min.js` 是 Live2D 专有核心，不属于本仓库；
 * 它由用户放在自己的数据目录里，本协议只做本地读取，不打包、不提交。
 */
import { protocol } from 'electron'
import { readFile } from 'fs/promises'
import { basename, extname, isAbsolute, relative, resolve } from 'path'
import { ROOM_BACKGROUND_FILES, ROOM_SCENE_ZONES } from '@shared/room/appearance'
import type { BaseDataPaths } from '../models/paths'

const ROOM_ASSET_SCHEME = 'room-asset'
const MIME: Record<string, string> = {
  '.json': 'application/json; charset=utf-8',
  '.moc3': 'application/octet-stream',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm'
}

/** 背景/场景允许的文件名闭集（防止把协议当成任意文件读取器） */
const BACKGROUND_FILES = new Set<string>(ROOM_BACKGROUND_FILES)
const SCENE_FILES = new Set<string>(
  ROOM_SCENE_ZONES.flatMap((zone) => [`${zone}.png`, `${zone}.jpg`, `${zone}.jpeg`])
)

let schemeRegistered = false

/** **必须在 app ready 之前调用**（Electron 限制）。 */
export function registerRoomAssetScheme(): void {
  if (schemeRegistered) return
  schemeRegistered = true
  protocol.registerSchemesAsPrivileged([
    {
      scheme: ROOM_ASSET_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true }
    }
  ])
  console.log('[room] room-asset scheme registered')
}

/** app ready 之后调用：把请求映射到用户数据目录下的只读资源。 */
export function installRoomAssetProtocol(getDataPaths: () => BaseDataPaths | null): void {
  console.log('[room] room-asset handler installed')
  protocol.handle(ROOM_ASSET_SCHEME, async (request) => {
    try {
      const paths = getDataPaths()
      if (!paths) return new Response('数据目录尚未就绪', { status: 503 })
      const url = new URL(request.url)
      // room-asset://room/AI1/live2d/model/xxx.model3.json
      // room-asset://room/AI1/scenes/window.jpg?v=...
      // room-asset://room/global/background/background.png
      const pathname = decodeURIComponent(url.pathname)
      const matched = /^\/(AI\d+|global)\/(live2d|background|scenes)\/(.+)$/.exec(pathname)
      if (!matched) return new Response('not found', { status: 404 })
      const [, scope, kind, rest] = matched
      if (kind === 'background' && !BACKGROUND_FILES.has(rest)) {
        return new Response('forbidden name', { status: 403 })
      }
      if (kind === 'scenes' && !SCENE_FILES.has(rest)) {
        return new Response('forbidden name', { status: 403 })
      }
      const roomRoot = resolve(paths.root, 'room')
      const root = scope === 'global' ? roomRoot : resolve(roomRoot, scope)
      const target = resolve(root, kind, rest)
      const rel = relative(resolve(root, kind), target)
      if (!rel || rel.startsWith('..') || isAbsolute(rel)) return new Response('forbidden', { status: 403 })
      const ext = extname(target).toLowerCase()
      const mime = MIME[ext]
      if (!mime) return new Response('forbidden type', { status: 403 })
      // 只允许 Live2D 官方核心这一支 JS；不接受任意脚本（缩小本地文件被当成脚本执行的攻击面）
      if (ext === '.js' && basename(target) !== 'live2dcubismcore.min.js') {
        return new Response('forbidden script', { status: 403 })
      }
      const data = await readFile(target)
      return new Response(new Uint8Array(data), {
        headers: {
          'content-type': mime,
          // 图片 URL 带 `?v=<mtime>`：可长期缓存，换图后 URL 变化自然失效。
          // Live2D 资源保持 no-cache（模型可能被用户替换，且体积大、加载慢，不值得猜）。
          'cache-control':
            kind === 'live2d' ? 'no-cache' : 'public, max-age=31536000, immutable'
        }
      })
    } catch {
      return new Response('not found', { status: 404 })
    }
  })
}
