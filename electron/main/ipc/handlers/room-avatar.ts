/**
 * @category ROOM
 * @summary 看板娘 IPC：`room:avatar-get`（像素规格）+ `room:mascot-get`（图片立绘）
 *
 * 为什么存在：`Presence`（渲染进程）要画出房间与看板娘，单一真源在主进程：
 * - 像素规格：`<data>/room/avatar.json`（经 `AvatarStore` 校验后回落默认）；
 * - 图片立绘：`<data>/room/mascot/<帧名>.png`（经 `MascotStore` 逐张校验）。
 *
 * 两条读通道**都不设门控**：它们是本地可视化数据、只读且已校验（见 `@shared/room/avatar-spec`
 * 与 `@shared/room/mascot`）。写通道（P3「AI 决定像素点」）才需要 `t2.room-avatar` 门控 + 审计。
 *
 * 为什么两条通道分开而不是合并成一条：**失败面不同**。像素规格读坏了要回落默认（房间必须有画）；
 * 图片表读不到就是空表（回落像素画），而 `skipped` 必须单独回传——用户要能知道
 * 「我放了图但哪几张没生效、为什么」。
 *
 * 不删理由：删掉即渲染端拿不到看板娘数据，房间只能显示写死的图。
 */
import type { ipcMain as IpcMainType } from 'electron'
import { existsSync, readdirSync } from 'fs'
import { join } from 'path'
import { DEFAULT_AI_ID } from '@shared/types'
import type { BaseDataPaths } from '../../models/paths'
import type { RoomAvatarSpec } from '@shared/room/avatar-spec'
import { DEFAULT_ROOM_APPEARANCE } from '@shared/room/appearance'
import { EMPTY_MASCOT_SHEET, type MascotSheet, type MascotSkip } from '@shared/room/mascot'
import { AvatarStore } from '../../room/avatar-store'
import { AppearanceStore } from '../../room/appearance-store'
import { MascotStore } from '../../room/mascot-store'
import { MascotProcessor, type MascotProcessed } from '../../room/mascot-process'
import { DEFAULT_AVATAR_SPEC } from '../../room/default-art'
import { safeHandle } from './safe-handle'

export interface RoomAvatarHandlerDeps {
  getDataPaths: () => BaseDataPaths | null
}

/**
 * @deprecated 0.53.5 起立绘按 AI 分层（`<data>/room/AI{aiId}/mascot`），目录由 `roomDirs` 派生。
 * 本函数只保留全局目录的旧语义，仅为兼容外部引用；应用内不再调用。
 */
export function mascotDirOf(paths: BaseDataPaths | null): string | null {
  return paths ? join(paths.root, 'room', 'mascot') : null
}

export function registerRoomAvatarHandlers(ipc: typeof IpcMainType, deps: RoomAvatarHandlerDeps): void {
  const aiScope = (aiId: unknown): number =>
    typeof aiId === 'number' && Number.isInteger(aiId) && aiId >= 1 ? aiId : DEFAULT_AI_ID

  /**
   * 按 AI 分层：`<data>/room/AI{aiId}` 是当前 AI 的房间目录；
   * `<data>/room` 是全局目录（0.53.4 之前的单份数据，作为兜底读取）。
   */
  const roomDirs = (aiId: number): { ai: string; global: string } | null => {
    const paths = deps.getDataPaths()
    if (!paths) return null
    const global = join(paths.root, 'room')
    return { ai: join(global, `AI${aiId}`), global }
  }

  const avatarStore = (aiId: number): AvatarStore | null => {
    const dirs = roomDirs(aiId)
    return dirs ? new AvatarStore(dirs.ai, dirs.global) : null
  }

  safeHandle<{ ok: boolean; spec: RoomAvatarSpec }>(
    ipc,
    'room:avatar-get',
    (_e, aiIdRaw) => {
      const s = avatarStore(aiScope(aiIdRaw))
      return { ok: true, spec: s ? s.load() : DEFAULT_AVATAR_SPEC }
    },
    { ok: false, spec: DEFAULT_AVATAR_SPEC }
  )

  /**
   * 图片立绘：读当前 AI 目录 → 逐张校验 → 帧名 → data URL；当前 AI 没有的帧用全局目录补齐。
   * `skipped` 一并回传（用户要能看到「放了但没生效的那几张，以及为什么」）；
   * `dir` 也回传，界面直接把它显示出来——**「图放哪」不该靠猜**。
   */
  safeHandle<{ ok: boolean; sheet: MascotSheet; skipped: MascotSkip[]; dir: string | null }>(
    ipc,
    'room:mascot-get',
    (_e, aiIdRaw) => {
      const dirs = roomDirs(aiScope(aiIdRaw))
      if (!dirs) return { ok: true, sheet: EMPTY_MASCOT_SHEET, skipped: [], dir: null }
      const { sheet, skipped } = new MascotStore(join(dirs.ai, 'mascot'), join(dirs.global, 'mascot')).load()
      return { ok: true, sheet, skipped, dir: join(dirs.ai, 'mascot') }
    },
    { ok: false, sheet: EMPTY_MASCOT_SHEET, skipped: [], dir: null }
  )

  /**
   * **后处理**（用户裁决「我自己在外面出图，丢进目录，应用负责去背/裁切/命名」）：
   * `mascot/raw/*.png` → 去背 → 裁切 → 统一画布 → `mascot/<帧名>.png`。
   *
   * 画布比例取自**当前像素规格的形象框**（`avatar.w:avatar.h`），这样立绘与像素版的
   * 「脚踩在地板上」是同一个基准；AI 若重画过规格，比例也跟着变，不需要另配一个数字。
   * 用户路径、按钮触发（不是工具、不经 AI）——它只写用户自己的数据目录。
   */
  safeHandle<{
    ok: boolean
    processed: MascotProcessed[]
    skipped: MascotSkip[]
    dir: string | null
    error?: string
  }>(
    ipc,
    'room:mascot-process',
    (_e, aiIdRaw) => {
      const dirs = roomDirs(aiScope(aiIdRaw))
      if (!dirs) return { ok: false, processed: [], skipped: [], dir: null, error: '数据目录尚未就绪' }
      const dir = join(dirs.ai, 'mascot')
      const spec = new AvatarStore(dirs.ai, dirs.global).load()
      const box = MascotProcessor.boxFor(spec.avatar.w, spec.avatar.h)
      const { processed, skipped } = new MascotProcessor(dir).process(box)
      return { ok: true, processed, skipped, dir }
    },
    { ok: false, processed: [], skipped: [], dir: null }
  )

  const appearanceStore = (aiId: number): AppearanceStore | null => {
    const dirs = roomDirs(aiId)
    return dirs
      ? new AppearanceStore(dirs.ai, dirs.global, {
          ai: `room-asset://room/AI${aiId}`,
          global: 'room-asset://room/global'
        })
      : null
  }

  /**
   * Live2D 资产发现：**当前 AI 优先，缺失回落全局**。
   *
   * 查找顺序：
   * 1. `<data>/room/AI{aiId}/live2d/`（每个 AI 可以有自己的形象）；
   * 2. `<data>/room/live2d/`（全局一套；0.53.11 起模型/Core 由用户自备，不随包）。
   *
   * 目录里同时有 `model/*.model3.json` 与 `live2dcubismcore.min.js` 才算可用；
   * 返回的 URL 指向实际命中的目录（`room-asset://room/AI{n}/live2d` 或 `/global/live2d`）。
   *
   * `motions` / `expressions` 是模型目录里的**附加文件清单**：玳瑁猫的 model3.json 没有声明
   * `Motions`，但目录里有 `IDLE.motion3.json`。渲染侧只在**内存里**给设置补一条 Idle
   * （不改模型文件——作者条款禁止修改），加载后就有待机动作。
   */
  const live2dInfo = (
    aiId: number
  ): {
    modelUrl: string
    coreUrl: string
    model: string
    motions: string[]
    expressions: { name: string; file: string }[]
  } | null => {
    const dirs = roomDirs(aiId)
    if (!dirs) return null
    const candidates = [
      { dir: join(dirs.ai, 'live2d'), base: `room-asset://room/AI${aiId}/live2d` },
      { dir: join(dirs.global, 'live2d'), base: 'room-asset://room/global/live2d' }
    ]
    for (const candidate of candidates) {
      const modelDir = join(candidate.dir, 'model')
      const core = join(candidate.dir, 'live2dcubismcore.min.js')
      if (!existsSync(modelDir) || !existsSync(core)) continue
      try {
        const files = readdirSync(modelDir)
        const model = files.find((f) => f.toLowerCase().endsWith('.model3.json'))
        if (!model) continue
        return {
          modelUrl: `${candidate.base}/model/${encodeURIComponent(model)}`,
          coreUrl: `${candidate.base}/live2dcubismcore.min.js`,
          model,
          motions: files.filter((f) => f.toLowerCase().endsWith('.motion3.json')),
          expressions: files
            .filter((f) => f.toLowerCase().endsWith('.exp3.json'))
            .map((f) => ({ name: f.replace(/\.exp3\.json$/i, ''), file: f }))
        }
      } catch {
        // 该目录不可读：继续看下一个候选
      }
    }
    return null
  }

  /**
   * 外观配置（人物位置/大小 + 背景来源）：**用户侧独立配置**，AI 不可写。
   * 返回背景/场景的 `room-asset://` URL（没有 = null）与目录（界面直接显示「图放哪」）。
   * **只回 URL、不回 base64**：请求是常数级，图片交给 Chromium 自己流式读。
   */
  safeHandle<{
    ok: boolean
    appearance: typeof DEFAULT_ROOM_APPEARANCE
    background: string | null
    scenes: Partial<Record<string, string>>
    live2d: {
      modelUrl: string
      coreUrl: string
      model: string
      motions: string[]
      expressions: { name: string; file: string }[]
    } | null
    dir: string | null
    scenesDir: string | null
    error?: string
  }>(
    ipc,
    'room:appearance-get',
    (_e, aiIdRaw) => {
      const aiId = aiScope(aiIdRaw)
      const store = appearanceStore(aiId)
      if (!store) {
        return {
          ok: false,
          appearance: DEFAULT_ROOM_APPEARANCE,
          background: null,
          scenes: {},
          live2d: null,
          dir: null,
          scenesDir: null,
          error: '数据目录尚未就绪'
        }
      }
      const loaded = store.load()
      const bg = store.loadBackground()
      const sc = store.loadScenes()
      const error = loaded.error ?? bg.error ?? (sc.errors.length > 0 ? sc.errors.join('；') : undefined)
      return {
        ok: true,
        appearance: loaded.appearance,
        background: bg.url,
        scenes: sc.scenes,
        live2d: live2dInfo(aiId),
        dir: bg.dir,
        scenesDir: sc.dir,
        ...(error ? { error } : {})
      }
    },
    {
      ok: false,
      appearance: DEFAULT_ROOM_APPEARANCE,
      background: null,
      scenes: {},
      live2d: null,
      dir: null,
      scenesDir: null
    }
  )

  safeHandle<{ ok: true; appearance: typeof DEFAULT_ROOM_APPEARANCE } | { ok: false; error: string }>(
    ipc,
    'room:appearance-set',
    (_e, aiIdRaw, raw) => {
      const store = appearanceStore(aiScope(aiIdRaw))
      if (!store) return { ok: false, error: '数据目录尚未就绪' }
      return store.save(raw)
    },
    { ok: false, error: '外观配置保存失败' }
  )
}

