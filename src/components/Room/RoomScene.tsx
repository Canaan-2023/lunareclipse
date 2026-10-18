/**
 * ROOM 像素房间：AI 拟人化可视化（房间背景 + AI 形象），**相位 → 帧**。
 *
 * 为什么存在：用户 2026-10-18 裁决「像素指的是图像，不是字体，就好比 AI 拟人化可视化」——
 * ROOM 的视觉主体不是面板列表，而是「一个房间，AI 住在里面」。本组件是那个房间。
 *
 * 相位绑定（这是房间的仪表语义，勿改成静态图）：`running` 伸手干活 / `idle` 站立 /
 * `standby` 闭眼 / `stopped` 熄灯（仅描边色）。帧名与相位名同名，由 `pickFrame` 解析。
 *
 * 数据来源：`room:avatar-get`（单一真源在主进程 `<data>/room/avatar.json`，经校验回落默认）。
 * P3 起 AI 可重画这份规格 → 房间与形象随之改变。
 *
 * 不删理由：删掉即 ROOM 退回「面板列表」，用户否定的正是那个形态。
 */
import { useEffect, useState } from 'react'
import type { RoomAvatarSpec } from '@shared/room/avatar-spec'
import { useT } from '../../i18n/useT'
import { PixelCanvas } from './PixelCanvas'
import type { RoomPhase } from './RoomChrome'

export function RoomScene({ phase, avatarRev }: { phase: RoomPhase; avatarRev: number }) {
  const t = useT()
  const [spec, setSpec] = useState<RoomAvatarSpec | null>(null)

  // `avatarRev` 变化 = AI 刚重画过（P3）→ 重取规格；首次挂载也会取一次
  useEffect(() => {
    void window.lunareclipse?.roomAvatarGet?.().then((r) => {
      if (r?.ok && r.spec) setSpec(r.spec as RoomAvatarSpec)
    })
  }, [avatarRev])

  return (
    <div className="room-panel flex shrink-0 flex-col items-center justify-center gap-1 p-2">
      <div className="text-micro tracking-widest text-fg-muted">{t('room.scene.title')}</div>
      {spec ? (
        <PixelCanvas spec={spec} phase={phase} scale={4} />
      ) : (
        <div className="flex h-24 items-center text-micro text-fg-muted">{t('room.scene.loading')}</div>
      )}
    </div>
  )
}
