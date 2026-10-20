/**
 * ROOM 的 Live2D 叠加层（**本地试验路径**）。
 *
 * 技术栈：`pixi.js@6`（MIT）+ `pixi-live2d-display@0.4`（MIT）——
 * 但**真正解析 `.moc3` 的 `live2dcubismcore.min.js` 是 Live2D 专有核心**，
 * 不属于本仓库，也不打进安装包；它由用户放在 `<data>/room/AI{aiId}/live2d/`，
 * 通过只读 `room-asset://` 协议加载。
 *
 * 授权边界：
 * - 正式分发前必须确认 Live2D 发布许可（个人/小规模免费，但需版权标识；营收门槛以上要签约）；
 * - 本项目的 AGPL-3.0 与专有核心组合有许可证冲突，**这是试验代码，不是可直接分发的默认能力**；
 * - 模型本身的使用条款独立（玳瑁猫模型允许游戏商用，需署名、禁止修改/转卖）。
 *
 * 三个实现决定（0.53.6）：
 * 1. **动作在内存里补**：模型目录有 `IDLE.motion3.json`，但 `model3.json` 没声明 `Motions`。
 *    这里 fetch 设置后在内存补一条 `Motions.Idle`，**不改模型文件**（条款禁止修改）；
 * 2. **实例缓存**：模型 + Pixi 应用挂在模块级单槽里，离开房间只停表（`app.stop()`），
 *    再进来直接复用——否则每次进房间都要重新解码 12MB `.moc3` 与 13 张贴图；
 * 3. **状态上报**：`loading / ready / failed` 三态。父组件据此决定「要不要画 2D 立绘」，
 *    而不是等模型加载完才把立绘换掉（那会闪一下）。
 */
import { useEffect, useRef, useState, type CSSProperties } from 'react'
import type { Application } from 'pixi.js'
import type { Live2DModel } from 'pixi-live2d-display/cubism4'
import { characterHeight, defaultProjection, projectPoint, ROOM_VIEW_H, ROOM_VIEW_W } from '@shared/room/room-scene'
import type { RoomAppearance } from '@shared/room/appearance'
import { augmentSettings, type Live2DSettingsJson } from './live2d-settings'

export type Live2DStatus = 'ready' | 'failed'

function loadCore(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if ((window as unknown as { Live2DCubismCore?: unknown }).Live2DCubismCore) {
      resolve()
      return
    }
    // 并发挂载（StrictMode / 快速切房间）时复用同一个 script，避免重复注入
    const existing = document.querySelector<HTMLScriptElement>('script[data-room-cubism-core]')
    if (existing) {
      if ((window as unknown as { Live2DCubismCore?: unknown }).Live2DCubismCore) resolve()
      else {
        existing.addEventListener('load', () => resolve(), { once: true })
        existing.addEventListener('error', () => reject(new Error('Live2D Cubism Core 加载失败')), { once: true })
      }
      return
    }
    const script = document.createElement('script')
    script.src = src
    script.async = true
    script.dataset.roomCubismCore = '1'
    script.onload = () => resolve()
    script.onerror = () => reject(new Error('Live2D Cubism Core 加载失败'))
    document.head.appendChild(script)
  })
}

/**
 * 读模型设置并补动作。补全逻辑在 `live2d-settings.ts`（纯函数，单独测）。
 */
async function buildSettings(
  modelUrl: string,
  motions: string[],
  expressions: Array<{ name: string; file: string }>
): Promise<Live2DSettingsJson> {
  const res = await fetch(modelUrl)
  if (!res.ok) throw new Error(`模型设置读取失败（${res.status}）`)
  const json = (await res.json()) as Live2DSettingsJson
  json.url = modelUrl
  return augmentSettings(json, motions, expressions)
}

function placeModel(model: Live2DModel, appearance: RoomAppearance): void {
  const p = defaultProjection()
  const placement = appearance.character
  const foot = projectPoint(placement.x, placement.y, 0, p)
  const targetH = characterHeight(placement.y, p) * placement.scale
  // `model.height` 是**乘过 scale** 的高度；用当前 scale 还原自然高度，否则第二次放置会把 scale 重置成 1
  const natural = model.height / (model.scale.y || 1)
  model.anchor.set(0.5, 1)
  model.scale.set(targetH / Math.max(1, natural))
  model.x = foot.x
  // 垂直偏移：只抬模型，地面阴影仍留在 foot（透视/大小不变）
  model.y = foot.y - (placement.lift ?? 0)
}

/**
 * 模型运行时默认参数的统一修正（**只改已加载参数，不改模型文件**）：
 * `Param6 = 1` 是玳瑁猫的白色提示卡开关（`关闭提示.exp3.json` 用的同一参数）。
 * 参数不存在（换模型）时忽略，不影响显示。
 */
function applyModelDefaults(model: Live2DModel): void {
  try {
    const core = (model.internalModel as unknown as {
      coreModel?: { setParameterValueById?: (id: string, value: number, weight?: number) => void }
    }).coreModel
    core?.setParameterValueById?.('Param6', 1, 1)
  } catch {
    // 参数不存在（换模型）时忽略：不影响模型显示
  }
}

interface CachedModel {
  key: string
  app: Application
  model: Live2DModel
}

/** 单槽缓存：同一时间只保留一个模型（51MB 级别，留两个没有意义） */
let cached: CachedModel | null = null
let inflight: { key: string; promise: Promise<CachedModel> } | null = null
/** 递增代次：切模型时让更早的加载结果自己作废，不覆盖新模型 */
let generation = 0

function destroyCached(): void {
  const old = cached
  cached = null
  if (!old) return
  try {
    old.model.autoUpdate = false
  } catch {
    /* 忽略 */
  }
  try {
    old.app.destroy(true, { children: true })
  } catch {
    /* 忽略销毁异常 */
  }
}

async function createModel(
  key: string,
  modelUrl: string,
  coreUrl: string,
  motions: string[],
  expressions: Array<{ name: string; file: string }>
): Promise<CachedModel> {
  await loadCore(coreUrl)
  const { Application, Ticker } = await import('pixi.js')
  const { Live2DModel: Model } = await import('pixi-live2d-display/cubism4')
  Model.registerTicker(Ticker)
  const settings = await buildSettings(modelUrl, motions, expressions)
  const app = new Application({
    width: ROOM_VIEW_W,
    height: ROOM_VIEW_H,
    backgroundAlpha: 0,
    antialias: true,
    resolution: Math.min(2, window.devicePixelRatio || 1),
    autoDensity: false
  })
  app.view.style.width = '100%'
  app.view.style.height = '100%'
  app.view.style.display = 'block'
  // 固定逻辑坐标系为房间的 960×600；CSS 再随容器缩放（否则 Pixi 会按宿主像素放大，人物位置会漂）
  app.renderer.resize(ROOM_VIEW_W, ROOM_VIEW_H)
  try {
    const model = await Model.from(settings, { autoInteract: false })
    app.stage.addChild(model)
    model.autoUpdate = true
    applyModelDefaults(model)
    // 有 Idle 组就立刻播一次：MotionManager 之后会自己续播
    try {
      void model.motion('Idle')
    } catch {
      // 模型没有动作组：保持静止，不影响显示
    }
    return { key, app, model }
  } catch (err) {
    try {
      app.destroy(true, { children: true })
    } catch {
      /* 忽略 */
    }
    throw err
  }
}

function ensureModel(
  key: string,
  modelUrl: string,
  coreUrl: string,
  motions: string[],
  expressions: Array<{ name: string; file: string }>
): Promise<CachedModel> {
  if (cached?.key === key) return Promise.resolve(cached)
  if (inflight?.key === key) return inflight.promise
  const myGen = ++generation
  const promise = createModel(key, modelUrl, coreUrl, motions, expressions).then((next) => {
    if (myGen !== generation) {
      // 期间已经有人请求了别的模型：这一份作废，避免覆盖新缓存
      try {
        next.app.destroy(true, { children: true })
      } catch {
        /* 忽略 */
      }
      throw new Error('superseded')
    }
    destroyCached()
    cached = next
    return next
  })
  inflight = { key, promise }
  return promise.finally(() => {
    if (inflight?.promise === promise) inflight = null
  })
}

export function Live2DCharacter({
  modelUrl,
  coreUrl,
  motions = [],
  expressions = [],
  appearance,
  canvasStyle,
  onStatus
}: {
  modelUrl: string
  coreUrl: string
  /** 模型目录里的动作文件（用于补 Idle 组） */
  motions?: string[]
  /** 模型目录里的表情文件（补 Expressions 清单，供后续情绪使用） */
  expressions?: Array<{ name: string; file: string }>
  appearance: RoomAppearance
  /** 与房间 canvas 完全一致的定位/缩放样式 */
  canvasStyle: CSSProperties
  /** ready = 已接管画面；failed = 加载失败，父组件回落 2D */
  onStatus?: (status: Live2DStatus) => void
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const appearanceRef = useRef(appearance)
  appearanceRef.current = appearance
  const onStatusRef = useRef(onStatus)
  onStatusRef.current = onStatus
  /** 动作/表情清单只在换模型时变；放 ref 里避免把它们写进加载 effect 的依赖 */
  const extrasRef = useRef({ motions, expressions })
  extrasRef.current = { motions, expressions }
  const [phase, setPhase] = useState<'loading' | 'ready' | 'failed'>('loading')
  /** 加载完成后才显示（淡入），避免「画布已挂但人物还没解码」时一块空白抢先出现 */
  const [opacity, setOpacity] = useState(0)
  const modelKey = `${modelUrl}|${coreUrl}`

  useEffect(() => {
    let disposed = false
    const run = async (): Promise<void> => {
      try {
        const entry = await ensureModel(
          modelKey,
          modelUrl,
          coreUrl,
          extrasRef.current.motions,
          extrasRef.current.expressions
        )
        if (disposed || !hostRef.current) return
        // 复用缓存时 canvas 可能还挂在旧的（已卸载的）宿主里：重新挂到当前宿主
        if (entry.app.view.parentNode !== hostRef.current) {
          hostRef.current.appendChild(entry.app.view as HTMLCanvasElement)
        }
        entry.app.start()
        entry.model.autoUpdate = true
        placeModel(entry.model, appearanceRef.current)
        setPhase('ready')
        setOpacity(1)
        onStatusRef.current?.('ready')
      } catch (err) {
        if (disposed) return
        console.error('[room] Live2D 加载失败，回落 2D 立绘:', (err as Error).message)
        setPhase('failed')
        setOpacity(0)
        onStatusRef.current?.('failed')
      }
    }
    void run()
    return () => {
      disposed = true
      // **不销毁**：实例留在缓存里，下次进房间直接复用；这里只停表省 CPU/GPU
      if (cached?.key === modelKey) {
        try {
          cached.model.autoUpdate = false
        } catch {
          /* 忽略 */
        }
        try {
          cached.app.stop()
        } catch {
          /* 忽略 */
        }
      }
      setOpacity(0)
    }
  }, [modelKey])

  // 外观（x/y/scale）变化：只挪模型，不重新加载贴图
  useEffect(() => {
    if (phase !== 'ready' || !cached || cached.key !== modelKey) return
    placeModel(cached.model, appearance)
  }, [phase, appearance, modelKey])

  return (
    <div
      ref={hostRef}
      data-live2d={phase}
      aria-hidden="true"
      style={{
        position: 'absolute',
        zIndex: 1,
        pointerEvents: 'none',
        opacity,
        transition: 'opacity 320ms ease-out',
        ...canvasStyle
      }}
    />
  )
}
