/**
 * 房间直播镜头：**视觉小说式固定构图**（0.53.5 重做信息层级）。
 *
 * 设计判断（用户质疑「在房间里……这种不明意义的词汇，以及占用大量窗口」）：
 * 上一版把房间做成了**状态面板**——`LIVE / CAM 01 / 在房间里 / 感知中` 这些词
 * 不携带信息，却和真正的内容抢注意力；底部一个空对话盒又常驻占位。
 * 现在：
 * - **房间是环境，不是仪表盘**：状态由月相 / 光 / 呼吸表达（`PresenceBar` 已有一条）；
 * - **文字只用于真的说话**：`reply` / `scene.say` 才出现单行字幕，无卡片、无名字；
 * - **输出流是主要可读内容**：房间与输出按 3:2 分空间（`RoomView`）。
 *
 * 画布仍是 960×600 逻辑坐标；`scale = max(容器宽/960, 容器高/600)` 后**顶部对齐**，
 * 宽屏时裁掉的是底部（字幕只占一条），而不是角色的头。
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import {
  ROOM_VIEW_H,
  ROOM_VIEW_W,
  defaultProjection,
  projectPoint,
  sceneStage,
  type RoomSceneDirective
} from '@shared/room/room-scene'
import { resolveAvatarFrameMs, resolveAvatarFrameName, resolveAvatarFrames, type RoomAvatarSpec } from '@shared/room/avatar-spec'
import {
  DEFAULT_ROOM_APPEARANCE,
  backgroundImageFor,
  characterSourceOf,
  sceneKeysOf,
  type RoomAppearance
} from '@shared/room/appearance'
import { avatarFrameMs, type SceneState } from './scene-layers'
import { drawCharacter, drawCharacterImage, drawFootShadow, type CharacterMotion } from './perspective-character'
import { drawCharacterBacklight, drawRoomAtmosphere, drawRoomGrade, renderStaticRoom } from './perspective-art'
import { Live2DCharacter } from './Live2DCharacter'
import type { Live2DAssets } from './use-appearance'
import { useCharacterDrag } from './use-character-drag'
import defaultCharacterUrl from '../../assets/default-character.png'

/**
 * 静止时的重绘节奏（0.53.14 从 100ms 提到 66ms ≈ 15fps）：
 * 人物现在有呼吸/微倾，10fps 的台阶感肉眼可见；15fps 足够顺滑，仍是每帧一次 drawImage。
 */
const FRAME_MS = 66
/** 拖拽时提高重绘频率（10fps 跟手太差）；松开后回到省电节奏 */
const DRAG_FRAME_MS = 33
/** 立绘帧缓存上限：预设库最多 24 帧 + 换图余量；超过按插入顺序淘汰最旧的一张 */
const MASCOT_CACHE_MAX = 32
/**
 * 内置默认立绘的显示比例（0.95）。
 * 默认立绘是 2083×3145 的月蚀全身立绘（超清透明底，白发紫瞳、月相头饰），保留 alpha。
 * 0.95 让 3145px 的成品在 960×600 画布里接近视觉小说的人物大小；用户自己的立绘不受此系数影响。
 */
const DEFAULT_CHARACTER_SCALE = 0.95

function useSize(): { ref: React.RefObject<HTMLDivElement | null>; width: number; height: number } {
  const ref = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  useEffect(() => {
    const el = ref.current
    if (!el) return
    setSize({ width: Math.floor(el.clientWidth), height: Math.floor(el.clientHeight) })
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        setSize({ width: Math.floor(e.contentRect.width), height: Math.floor(e.contentRect.height) })
      }
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return { ref, width: size.width, height: size.height }
}

function useEnv(): { hidden: boolean; reducedMotion: boolean } {
  const [env, setEnv] = useState({ hidden: false, reducedMotion: false })
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const read = (): void => setEnv({ hidden: document.visibilityState === 'hidden', reducedMotion: mq.matches })
    read()
    const onVis = (): void => read()
    const onMq = (): void => read()
    document.addEventListener('visibilitychange', onVis)
    mq.addEventListener('change', onMq)
    return () => {
      document.removeEventListener('visibilitychange', onVis)
      mq.removeEventListener('change', onMq)
    }
  }, [])
  return env
}

export function PerspectiveRoom({
  spec,
  mascotFrames,
  state,
  phase,
  stage,
  scene,
  reply,
  aiName,
  llmFailed = false,
  bottomInset = 0,
  /** 2D 人物数据（规格 + 帧表）是否已经取过一次：没取到之前**不画兜底立牌** */
  characterSettled = false,
  appearanceLoaded = true,
  appearance = DEFAULT_ROOM_APPEARANCE,
  aiId,
  background = null,
  scenes,
  live2d = null,
  backgroundOverride = null
}: {
  spec: RoomAvatarSpec | null
  /** 图片立绘帧表（帧名 → data URL）；帧选择与像素角色共用同一份判定 */
  mascotFrames?: Record<string, string> | null
  state: SceneState
  phase: string
  stage?: string
  scene?: RoomSceneDirective
  reply?: string
  aiName: string
  llmFailed?: boolean
  /** 字幕底边距（常驻输出带 + 输入浮层）：只抬字幕，不缩舞台 */
  bottomInset?: number
  /** 2D 人物规格/帧表已取过一次；false 时画布留空，避免先闪一个兜底立牌 */
  characterSettled?: boolean
  /** 外观配置是否已取回；false 时先留黑，避免先闪代码房间再切图片背景 */
  appearanceLoaded?: boolean
  /** 用户侧外观配置（人物位置/大小 + 背景来源） */
  appearance?: RoomAppearance
  /** 当前房间所属 AI：舞台拖拽/滚轮调整后写回该 AI 的 appearance.json */
  aiId?: number
  /** 背景图 URL（`room-asset://`）；null = 代码房间 */
  background?: string | null
  /** 可选背景图（文件名 stem → URL）；key 就是菜单选项名 */
  scenes?: Record<string, string>
  /** 检测到的 Live2D 模型（用户自备；安装包不再内置模型/Core） */
  live2d?: Live2DAssets | null
  /** 用户手动选的背景文件名 stem：**只决定当前画面用哪张图** */
  backgroundOverride?: string | null
}) {
  const { ref, width, height } = useSize()
  const env = useEnv()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const staticRef = useRef<HTMLCanvasElement | null>(null)
  const lastDrawRef = useRef(-Infinity)
  /** 立绘帧缓存：同一帧只解码一次 */
  const mascotCacheRef = useRef(new Map<string, HTMLImageElement>())
  const mascotLoadingRef = useRef(new Set<string>())
  /** 加载失败的帧：不再重试（否则 error → setFrameRev → 重画 → 再 error 会自激） */
  const mascotFailedRef = useRef(new Set<string>())
  const [frameRev, setFrameRev] = useState(0)
  /** 场景图缓存（zone → URL；同一张只解码一次）；换分区时直接切图 */
  const sceneCacheRef = useRef(new Map<string, HTMLImageElement>())
  const sceneLoadingRef = useRef(new Set<string>())
  const sceneFailedRef = useRef(new Set<string>())
  /** 上一张已解码的场景图：新分区图还没到之前**保持旧画面**，不闪回代码房间 */
  const lastSceneRef = useRef<HTMLImageElement | null>(null)
  const [sceneRev, setSceneRev] = useState(0)
  /**
   * Live2D 人物层的状态（**按模型 URL 记账**）。
   *
   * 为什么不是 `live2dReady: boolean`：那会让「已声明但还在加载」被当成「没有 Live2D」，
   * 于是先画 2D 立绘、加载完再替换——正是用户看到的闪替。loading 期间画布**不画人物**。
   * 用 key 记账而不是 effect 复位，避免子组件先报 ready、父组件后复位成 loading 的竞态。
   */
  const [live2dState, setLive2dState] = useState<{ key: string; status: 'ready' | 'failed' } | null>(null)
  /**
   * 形象来源（0.53.11）：**默认立绘**。Live2D 能力保留，但安装包不再内置模型；
   * 旧数据目录里残留的模型不会自动抢占画面，用户必须在「形象与背景」里显式切到 Live2D。
   * 未声明来源的旧配置按 portrait 处理（`characterSourceOf` 是唯一读取口径）。
   */
  const wantsLive2d = characterSourceOf(appearance) === 'live2d'
  const live2dStatus: 'none' | 'loading' | 'ready' | 'failed' = !wantsLive2d || !live2d?.modelUrl
    ? 'none'
    : live2dState?.key === live2d.modelUrl
      ? live2dState.status
      : 'loading'

  // refs：避免每次状态推送重启 rAF
  const specRef = useRef(spec)
  specRef.current = spec
  const framesRef = useRef(mascotFrames)
  framesRef.current = mascotFrames
  const stateRef = useRef(state)
  stateRef.current = state
  const phaseRef = useRef(phase)
  phaseRef.current = phase
  const stageRef = useRef(stage)
  stageRef.current = stage
  const sceneRef = useRef(scene)
  sceneRef.current = scene
  const llmFailedRef = useRef(llmFailed)
  llmFailedRef.current = llmFailed

  // cover：填满容器，顶部对齐；宽屏时裁掉底部（对话盒会盖住那里）
  const scale = width > 0 && height > 0 ? Math.max(width / ROOM_VIEW_W, height / ROOM_VIEW_H) : 1
  /**
   * 舞台直调人物（0.53.6）：拖动移动 + 滚轮缩放，松手/停下后写回外观配置。
   * 逻辑在 `use-character-drag.ts`（含唯一一个用户动作防抖计时器；不是后台轮询）。
   */
  const drag = useCharacterDrag({ aiId, appearance, scale, containerRef: ref })
  const { placement, placementRef, dragging } = drag
  // 视觉小说式：只有 idle / running 才跑 rAF（待机 / 出错 / 停止画面定住）；
  // 拖拽期间也跑——否则停住的画面不会跟着手走
  const animate = !env.hidden && !env.reducedMotion && (state === 'idle' || state === 'running' || dragging)
  const frameMs = dragging ? DRAG_FRAME_MS : FRAME_MS

  useEffect(() => {
    const base = renderStaticRoom()
    // **浅景深**（0.53.5）：房间在人物之后，做一次性的轻微离焦。
    // 这是「更写实 + 更简约」里最划算的一步——家具的细线被柔化，人物自然成为焦点；
    // 只在静态图生成时算一次，运行时仍是每帧一次 drawImage。
    const blurred = document.createElement('canvas')
    blurred.width = base.width
    blurred.height = base.height
    const bctx = blurred.getContext('2d')
    if (!bctx) {
      staticRef.current = base
      return
    }
    try {
      bctx.fillStyle = '#07090e'
      bctx.fillRect(0, 0, blurred.width, blurred.height)
      bctx.filter = 'blur(1.6px)'
      bctx.drawImage(base, 0, 0)
      bctx.filter = 'none'
      staticRef.current = blurred
    } catch {
      // 老引擎不支持 canvas filter → 退回清晰背景（不报错、不影响功能）
      staticRef.current = base
    }
  }, [])

  /**
   * 取一张场景图（同步返回已解码的图；未命中则后台加载，下一次 rAF 自然用上）。
   * 分区切换（scene.zone）只是换 key：同一张图只解码一次。
   */
  const ensureScene = useCallback((src: string): HTMLImageElement | null => {
    const cached = sceneCacheRef.current.get(src)
    if (cached) return cached
    if (sceneFailedRef.current.has(src)) return null
    if (!sceneLoadingRef.current.has(src)) {
      sceneLoadingRef.current.add(src)
      const img = new Image()
      img.onload = () => {
        sceneLoadingRef.current.delete(src)
        sceneCacheRef.current.set(src, img)
        if (sceneCacheRef.current.size > 16) {
          const oldest = sceneCacheRef.current.keys().next().value
          if (oldest) sceneCacheRef.current.delete(oldest)
        }
        setSceneRev((n) => n + 1)
      }
      img.onerror = () => {
        sceneLoadingRef.current.delete(src)
        sceneFailedRef.current.add(src)
        setSceneRev((n) => n + 1)
      }
      img.src = src
    }
    return null
  }, [])

  /**
   * 取一帧立绘（同步返回已解码的图；未命中则后台加载，下一次 rAF 自然用上）。
   * 缓存上限 32 = 预设库最多 24 帧 + 换图余量；超过按插入顺序淘汰最旧的一张。
   */
  const ensureMascot = useCallback((src: string): HTMLImageElement | null => {
    const cached = mascotCacheRef.current.get(src)
    if (cached) return cached
    if (mascotFailedRef.current.has(src)) return null
    if (!mascotLoadingRef.current.has(src)) {
      mascotLoadingRef.current.add(src)
      const img = new Image()
      img.onload = () => {
        mascotLoadingRef.current.delete(src)
        mascotCacheRef.current.set(src, img)
        if (mascotCacheRef.current.size > MASCOT_CACHE_MAX) {
          const oldest = mascotCacheRef.current.keys().next().value
          if (oldest) mascotCacheRef.current.delete(oldest)
        }
        setFrameRev((n) => n + 1)
      }
      img.onerror = () => {
        mascotLoadingRef.current.delete(src)
        mascotFailedRef.current.add(src)
        setFrameRev((n) => n + 1)
      }
      img.src = src
    }
    return null
  }, [])

  useEffect(() => {
    const cv = canvasRef.current
    if (!cv) return
    const ctx = cv.getContext('2d')
    if (!ctx) return
    if (cv.width !== ROOM_VIEW_W) cv.width = ROOM_VIEW_W
    if (cv.height !== ROOM_VIEW_H) cv.height = ROOM_VIEW_H
    const p = defaultProjection()

    const draw = (now: number): void => {
      // 立绘是照片级图片，必须高质量平滑；房间静态层本身已离焦，不受影响
      ctx.imageSmoothingEnabled = true
      ctx.imageSmoothingQuality = 'high'
      // 拖拽中的本地位置优先（不经过 IPC），否则用已保存的外观配置
      const placement = placementRef.current
      const pos = { x: placement.x, y: placement.y }
      const charScale = placement.scale
      const sceneNow = sceneRef.current
      // 背景只由**用户手动选择**，文件名就是选项（2026-10-23 用户裁决：不让房间背景随便切换）。
      // `scene.zone` 仍驱动姿态/行为（sceneStage），但不再参与背景取图。
      // 未选 / 选中的文件已被删除 → 用当前目录里自然序第一张（没有则由主背景兜底）。
      const keys = sceneKeysOf(scenes)
      const key =
        backgroundOverride && scenes?.[backgroundOverride] ? backgroundOverride : keys[0] ?? null
      // 图片模式：该文件名对应的图；没有则用主背景图
      const imageMode = appearance.background.mode === 'image'
      if (!imageMode) lastSceneRef.current = null
      const sceneSrc = imageMode ? backgroundImageFor(key, scenes, background) : null
      const bgImg = sceneSrc ? ensureScene(sceneSrc) : null
      if (bgImg) lastSceneRef.current = bgImg
      // **不在「图片模式但图还没到」时画代码房间**：那会先闪一间灰屋子再切到 4K 背景。
      // 有上一张分区图就先用它（直播里的「切机位」延迟），没有就留黑。
      const shownScene = bgImg ?? lastSceneRef.current
      if (!appearanceLoaded) {
        ctx.fillStyle = '#07090e'
        ctx.fillRect(0, 0, ROOM_VIEW_W, ROOM_VIEW_H)
      } else if (imageMode) {
        // 用户背景：cover 填满画布（宽/高中取更小比例，保持不拉伸）
        ctx.fillStyle = '#07090e'
        ctx.fillRect(0, 0, ROOM_VIEW_W, ROOM_VIEW_H)
        if (shownScene) {
          const iw = shownScene.naturalWidth
          const ih = shownScene.naturalHeight
          const s = Math.max(ROOM_VIEW_W / Math.max(1, iw), ROOM_VIEW_H / Math.max(1, ih))
          const dw = iw * s
          const dh = ih * s
          ctx.drawImage(shownScene, (ROOM_VIEW_W - dw) / 2, (ROOM_VIEW_H - dh) / 2, dw, dh)
        }
      } else {
        const staticCv = staticRef.current
        if (staticCv) ctx.drawImage(staticCv, 0, 0)
        else {
          ctx.fillStyle = '#07090e'
          ctx.fillRect(0, 0, ROOM_VIEW_W, ROOM_VIEW_H)
        }
      }
      // 图片背景：色偏/暗角**只压背景**，人物随后再画（直播里不会跟着房间一起熄灯）
      if (appearanceLoaded && imageMode) drawRoomGrade(ctx, stateRef.current, { clock: false })
      // 人物背光：画在人物之前，只影响「人物 vs 背景」的分离度
      drawCharacterBacklight(ctx, p, pos, stateRef.current, now, charScale)

      const specNow = specRef.current
      const poseStage = sceneNow ? sceneStage(sceneNow.action) : stageRef.current
      const query = {
        phase: phaseRef.current,
        ...(poseStage ? { stage: poseStage } : {}),
        ...(llmFailedRef.current ? { llmFailed: true } : {})
      }
      const avatarMs = resolveAvatarFrameMs(specNow, query, avatarFrameMs(stateRef.current))
      const tick = avatarMs ? Math.floor(now / avatarMs) : 0

      const rows = specNow ? resolveAvatarFrames(specNow, { ...query, tick }) : []
      const frameName = specNow ? resolveAvatarFrameName(specNow, { ...query, tick }) : null
      const mascotSrc = frameName ? framesRef.current?.[frameName] : null
      const img = mascotSrc ? ensureMascot(mascotSrc) : null
      /**
       * **内置默认立绘**（0.53.11）：用户没有放立绘、也没有显式切到 Live2D 时，
       * 画随代码分发的**月蚀立绘**（白发紫瞳 + 黑猫 + 月相头饰），而不是旧的白衣少女/像素小人。
       * 用户自己的帧仍然优先；某个动作缺帧时也用它兜底，避免不同状态突然变回像素画。
       */
      const defaultImg = ensureMascot(defaultCharacterUrl)
      // 固定构图：不走路，只保留呼吸 / 浮动（动作只影响节奏与取帧）
      const motion: CharacterMotion = {
        now,
        walking: false,
        phase: 0,
        state: stateRef.current,
        ...(sceneNow ? { action: sceneNow.action } : {})
      }
      // 人物层：
      // - Live2D **已声明**时，loading 与 ready 都不画 2D（否则进场会先闪一张立绘）；
      // - 只有 Live2D 加载失败才回落到 2D；
      // - 2D 的数据（规格/帧表）没取到之前也不画兜底立牌——那是「还没准备好」，不是「没有形象」。
      const live2dActive = live2dStatus === 'ready'
      if (live2dActive) {
        // Live2D 在自己的 canvas 上；房间画布只补一块落地阴影，避免人物看起来浮在地板上
        drawFootShadow(ctx, p, pos, charScale)
      } else if (live2dStatus !== 'loading') {
        const shown = img ?? defaultImg
        if (shown) {
          drawCharacterImage(
            ctx,
            p,
            pos,
            shown,
            shown.naturalWidth,
            shown.naturalHeight,
            false,
            motion,
            // 内置立绘缩小显示（见 DEFAULT_CHARACTER_SCALE）；用户自己的立绘沿用配置
            img ? charScale : charScale * DEFAULT_CHARACTER_SCALE,
            placement.lift
          )
        } else if (rows.length > 0 || characterSettled) {
          drawCharacter(
            ctx,
            p,
            pos,
            rows,
            specNow ? specNow.avatar.palette : [],
            specNow ? specNow.avatar.w : 28,
            specNow ? specNow.avatar.h : 40,
            false,
            'down',
            motion,
            charScale,
            placement.lift
          )
        }
      }
      // 代码房间：吊灯/显示器光 + 调色 + 挂钟（画在人物之后：这些是照在人物上的光）
      if (appearanceLoaded && !imageMode) drawRoomAtmosphere(ctx, p, now, stateRef.current)
    }

    if (!animate) {
      draw(0)
      return
    }

    let raf = 0
    const loop = (now: number): void => {
      if (now - lastDrawRef.current >= frameMs) {
        draw(now)
        lastDrawRef.current = now
      }
      raf = requestAnimationFrame(loop)
    }
    lastDrawRef.current = -Infinity
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [animate, spec, frameRev, mascotFrames, ensureMascot, ensureScene, state, phase, stage, scene, scenes, background, scale, width, height, appearance, appearanceLoaded, sceneRev, live2dStatus, characterSettled, backgroundOverride, dragging, frameMs])

  // **只有真的说了话才出现字幕**。没有台词时保持画面干净：
  // 「在房间里 / 感知中 / 停止」这类填充词不携带信息，只会把直播间变回状态面板。
  const subtitle = reply || scene?.say

  // cover 会在「窄而高」的容器里裁掉左右。锚点跟随用户配置的人物：
  // 人物在右 → 画布右对齐（裁左边），人物在左 → 左对齐；默认构图因此不会被切到人物。
  const charScreenX =
    projectPoint(appearance.character.x, appearance.character.y, 0, defaultProjection()).x / ROOM_VIEW_W
  const anchor: 'left' | 'center' | 'right' = charScreenX > 0.58 ? 'right' : charScreenX < 0.42 ? 'left' : 'center'
  /** 房间 canvas 与 Live2D 叠加层共用同一份定位/缩放 */
  const canvasStyle: CSSProperties = {
    position: 'absolute',
    top: 0,
    ...(anchor === 'center'
      ? { left: '50%', transform: 'translateX(-50%)' }
      : anchor === 'right'
        ? { right: 0 }
        : { left: 0 }),
    width: ROOM_VIEW_W * scale,
    height: ROOM_VIEW_H * scale,
    willChange: 'transform'
  }

  return (
    <div
      ref={ref}
      className="room-camera relative h-full w-full overflow-hidden"
      style={{
        background: 'radial-gradient(ellipse at 50% 35%, #0b1020 0%, #05070b 72%)',
        // 直接操纵：拖住画面即可移动人物，滚轮缩放（松开后写回外观配置）
        cursor: dragging ? 'grabbing' : 'grab',
        touchAction: 'none'
      }}
      aria-label={`${aiName}的房间直播镜头`}
      role="img"
      {...drag.handlers}
    >
      <canvas ref={canvasRef} style={canvasStyle} />
      {wantsLive2d && live2d?.modelUrl && live2d.coreUrl && (
        <Live2DCharacter
          modelUrl={live2d.modelUrl}
          coreUrl={live2d.coreUrl}
          motions={live2d.motions}
          expressions={live2d.expressions}
          appearance={{ ...appearance, character: placement }}
          canvasStyle={canvasStyle}
          onStatus={(status) => setLive2dState({ key: live2d.modelUrl, status })}
        />
      )}
      {/* 底部渐隐：始终垫一层短渐变，遮住半身立绘的下缘。
          它不是「对话盒」——没有台词时这里没有任何文字，也不占版面。 */}
      <div
        className="pointer-events-none absolute inset-x-0 bottom-0 h-20 bg-linear-to-t from-bg-base/90 to-transparent"
        aria-hidden="true"
      />
      {subtitle && (
        <div
          className="pointer-events-none absolute inset-x-0 bottom-0 z-10 px-6 pb-5"
          style={bottomInset > 0 ? { bottom: bottomInset } : undefined}
          role="status"
          aria-live="polite"
        >
          {/* 单行字幕：无卡片、无边框、无名字（顶栏已经有名字）；最多两行 */}
          <p className="room-subtitle-line mx-auto max-h-12 max-w-[88%] overflow-hidden text-center text-caption leading-6 text-fg-primary">
            {subtitle}
          </p>
        </div>
      )}
    </div>
  )
}
