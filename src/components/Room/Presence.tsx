/**
 * ROOM 的「存在」：**它就在房间里**（0.53.5 信息层级重做）。
 *
 * 设计口径：
 * - 房间是**环境**，不是状态面板——状态由顶栏月相 / 光表达，画面里不再压 HUD 术语；
 * - **镜头是固定的**：整幅画面不做呼吸缩放（那会让 4K 背景一直在前后动）；
 * - **文字只用于真的说话**：没有 `reply` / `scene.say` 时不出现字幕，也不留空对话盒；
 * - 房间与输出流按 3:2 分空间，输出是主要可读内容。
 *
 * 不删理由：删掉即自主模式只剩一条文本流，用户看不到「它是什么样子 / 它在房间里」。
 */
import { useEffect, useState } from 'react'
import type { RoomAvatarSpec } from '@shared/room/avatar-spec'
import type { RoomAppearance } from '@shared/room/appearance'
import type { RoomSceneDirective, RoomZoneId } from '@shared/room/room-scene'
import { reloadMascot, useMascot } from './use-mascot'
import type { Live2DAssets } from './use-appearance'
import { PerspectiveRoom } from './PerspectiveRoom'
import { sceneStateOf } from './scene-layers'

export function Presence({
  aiId,
  phase,
  avatarRev,
  llmFailed = false,
  stage,
  scene,
  reply,
  aiName,
  bottomInset = 0,
  appearance,
  appearanceLoaded = true,
  background = null,
  scenes,
  live2d = null,
  zoneOverride = null
}: {
  /** 房间所属 AI：形象/外观/场景都按 AI 分层 */
  aiId: number
  phase: string
  avatarRev: number
  /** LLM 未回复（出错）→ 五态里的 `error`（红警光晕 + 出错行为帧） */
  llmFailed?: boolean
  /** 本轮阶段（`collect` / `triage` / `recall` / `plan` / `execute`）——AI 未声明 scene 时的兜底 */
  stage?: string
  /** AI 直接声明的房间动作（直播里「我在哪 / 做什么」） */
  scene?: RoomSceneDirective
  /** AI 最近一次对用户/镜头的回应（字幕） */
  reply?: string
  aiName: string
  /** 字幕底边距（常驻输出带 + 输入浮层）：只抬字幕，不缩舞台 */
  bottomInset?: number
  /** 用户侧外观配置（人物位置/大小 + 背景来源）；缺省 = 默认构图/代码房间 */
  appearance?: RoomAppearance
  /** 外观配置是否已从主进程取回（false 时舞台留黑，不先画代码房间） */
  appearanceLoaded?: boolean
  /** 用户背景图 data URL（null = 代码房间） */
  background?: string | null
  /** 按分区切换的场景图（zone → data URL）；AI 去哪个分区就用哪个 */
  scenes?: Partial<Record<RoomZoneId, string>>
  /** 检测到的 Live2D 模型（本地试验；核心不打包） */
  live2d?: Live2DAssets | null
  /** 用户手动选的分区背景（只影响画面；AI 下次声明 scene 时清空） */
  zoneOverride?: RoomZoneId | null
}) {
  const [spec, setSpec] = useState<RoomAvatarSpec | null>(null)
  /** 画像规格是否已经取过一次（区分「还没取」与「取了但用默认」） */
  const [specLoaded, setSpecLoaded] = useState(false)
  const mascot = useMascot(aiId)

  useEffect(() => {
    // `await` 对「桥接方法缺失（undefined）」是安全的；直接 `.then` 会同步抛 TypeError
    void (async () => {
      const r = await window.lunareclipse?.roomAvatarGet?.(aiId)
      if (r?.ok && r.spec) setSpec(r.spec as RoomAvatarSpec)
      setSpecLoaded(true)
    })()
  }, [avatarRev, aiId])

  useEffect(() => {
    void reloadMascot(aiId)
  }, [avatarRev, aiId])

  const state = sceneStateOf(phase, { llmFailed })

  return (
    <div className="room-presence relative flex min-h-0 flex-1 overflow-hidden">
      {/* 固定机位：**整幅画面不做呼吸/缩放**（用户 2026-10-20：「不要那个背景前后动、放大缩小的特效」）。
          呼吸只保留在顶栏的小月相上——它是一个状态指示器，不是镜头运动。 */}
      <div className="absolute inset-0 flex">
        <div className="relative min-w-0 flex-1">
          <PerspectiveRoom
            spec={spec}
            mascotFrames={mascot.frames}
            state={state}
            phase={phase}
            {...(stage ? { stage } : {})}
            {...(scene ? { scene } : {})}
            {...(reply ? { reply } : {})}
            aiName={aiName}
            llmFailed={llmFailed}
            bottomInset={bottomInset}
            characterSettled={specLoaded && mascot.loaded}
            appearanceLoaded={appearanceLoaded}
            aiId={aiId}
            {...(appearance ? { appearance } : {})}
            background={background}
            {...(scenes ? { scenes } : {})}
            live2d={live2d}
            zoneOverride={zoneOverride}
          />
        </div>
      </div>
    </div>
  )
}
