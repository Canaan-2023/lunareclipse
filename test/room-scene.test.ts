/**
 * 房间直播镜头（一点透视）的数据不变量：
 * - **近大远小**：纵深越大，缩放/角色高度严格越小；
 * - 投影中心与地平线自洽；
 * - AI 声明的 `scene` 是闭集（非法 zone 丢弃、非法 action 回落 walk）；
 * - `actorIntent` 的优先级：停/出错 > 待机 > AI 声明 > 阶段兜底；
 * - 移动是线性的、不会越过目标。
 */
import { describe, it, expect } from 'vitest'
import {
  ROOM_COMPOSITION,
  ROOM_ZONES,
  ROOM_SCENE_ACTIONS,
  ROOM_VIEW_H,
  ROOM_VIEW_W,
  actorIntent,
  characterHeight,
  defaultProjection,
  isRoomZone,
  moveToward,
  parseRoomScene,
  placementFromFootScreen,
  projectPoint,
  scaleAt,
  sceneStage,
  zoneForStage,
  zoneForToolCategory
} from '../shared/room/room-scene'

describe('房间镜头 · 近大远小', () => {
  it('纵深越大，缩放越小（严格单调）', () => {
    const p = defaultProjection()
    expect(scaleAt(0, p)).toBeGreaterThan(scaleAt(4, p))
    expect(scaleAt(4, p)).toBeGreaterThan(scaleAt(9, p))
    expect(scaleAt(9, p)).toBeGreaterThan(scaleAt(11, p))
  })

  it('角色高度同样近大远小', () => {
    expect(characterHeight(2)).toBeGreaterThan(characterHeight(6))
    expect(characterHeight(6)).toBeGreaterThan(characterHeight(10))
  })

  it('镜头中心点投到画布中心；远处同一点向中心收缩', () => {
    const p = defaultProjection()
    const near = projectPoint(1, 2, 1, p)
    const far = projectPoint(1, 9, 1, p)
    expect(Math.abs(far.x - p.cx)).toBeLessThan(Math.abs(near.x - p.cx))
    // 相机 z 高度上的点落在同一水平线（地平线）
    expect(projectPoint(-2, 2, p.camZ, p).y).toBeCloseTo(projectPoint(2, 9, p.camZ, p).y, 6)
  })

  it('非法坐标不产生 NaN（防爆）', () => {
    const p = defaultProjection()
    expect(Number.isFinite(projectPoint(0, -100, 0, p).x)).toBe(true)
    expect(Number.isFinite(scaleAt(Number.NaN, p))).toBe(true)
  })
})

describe('房间区域与 AI 声明', () => {  it('六个语义分区坐标都在房间内', () => {
    for (const [id, z] of Object.entries(ROOM_ZONES)) {
      expect(isRoomZone(id)).toBe(true)
      expect(Math.abs(z.x)).toBeLessThan(3.5)
      expect(z.y).toBeGreaterThanOrEqual(0)
      expect(z.y).toBeLessThanOrEqual(11)
    }
  })

  it('分区是「它此刻在哪类空间」，不是家具清单', () => {
    expect(Object.keys(ROOM_ZONES)).toEqual(['home', 'plan', 'work', 'memory', 'device', 'lan'])
  })

  it('旧分区名仍有别名：bookshelf → memory、desk → work、window → plan，其余归到 home', () => {
    expect(parseRoomScene({ zone: 'bookshelf' })).toEqual({ zone: 'memory', action: 'walk' })
    expect(parseRoomScene({ zone: 'desk' })).toEqual({ zone: 'work', action: 'walk' })
    expect(parseRoomScene({ zone: 'window' })).toEqual({ zone: 'plan', action: 'walk' })
    expect(parseRoomScene({ zone: 'center' })).toEqual({ zone: 'home', action: 'walk' })
    expect(parseRoomScene({ zone: 'door' })).toEqual({ zone: 'home', action: 'walk' })
    expect(parseRoomScene({ zone: 'rug' })).toEqual({ zone: 'home', action: 'walk' })
    expect(parseRoomScene({ zone: 'foyer' })).toEqual({ zone: 'home', action: 'walk' })
  })

  it('ROOM_COMPOSITION：视觉小说式固定构图落在画面中右侧、接近满高', () => {
    const p = defaultProjection()
    const foot = projectPoint(ROOM_COMPOSITION.x, ROOM_COMPOSITION.y, 0, p)
    const h = characterHeight(ROOM_COMPOSITION.y, p)
    expect(foot.x).toBeGreaterThan(ROOM_VIEW_W / 2)
    expect(foot.x).toBeLessThan(ROOM_VIEW_W * 0.75)
    expect(h).toBeGreaterThan(ROOM_VIEW_H * 0.8)
  })

  it('placementFromFootScreen 与 projectPoint 互逆（舞台拖拽跟手，不是加减像素）', () => {
    const p = defaultProjection()
    const cases: Array<[number, number]> = [
      [-0.45, 2.16],
      [1, 5],
      [2, 7],
      [-1.5, 1.2]
    ]
    for (const [x, y] of cases) {
      const foot = projectPoint(x, y, 0, p)
      const back = placementFromFootScreen(foot.x, foot.y, p)
      expect(back.x).toBeCloseTo(x, 6)
      expect(back.y).toBeCloseTo(y, 6)
    }
  })

  it('parseRoomScene：合法透传 / 非法 zone 丢弃 / action 缺省或未知回落 walk', () => {
    expect(parseRoomScene({ zone: 'plan', action: 'observe', say: ' 看月亮 ' })).toEqual({
      zone: 'plan',
      action: 'observe',
      say: '看月亮'
    })
    expect(parseRoomScene({ zone: 'moon' })).toBeNull()
    expect(parseRoomScene({ zone: 'work' })).toEqual({ zone: 'work', action: 'walk' })
    expect(parseRoomScene({ zone: 'work', action: 'fly' })).toEqual({ zone: 'work', action: 'walk' })
    expect(parseRoomScene(null)).toBeNull()
  })

  it('sceneStage：动作映射到行为绑定触发源', () => {
    expect(sceneStage('observe')).toBe('collect')
    expect(sceneStage('read')).toBe('recall')
    expect(sceneStage('think')).toBe('plan')
    expect(sceneStage('work')).toBe('execute')
    expect(sceneStage('rest')).toBe('standby')
    expect(sceneStage('walk')).toBeUndefined()
  })

  it('zoneForStage：阶段落点与「在哪类空间做事」一致', () => {
    expect(zoneForStage('collect')).toBe('device')
    expect(zoneForStage('triage')).toBe('plan')
    expect(zoneForStage('recall')).toBe('memory')
    expect(zoneForStage('plan')).toBe('plan')
    expect(zoneForStage('execute')).toBe('work')
    expect(zoneForStage(undefined)).toBe('home')
  })

  it('zoneForToolCategory：只有局域网/设备会改变落点', () => {
    expect(zoneForToolCategory('lan')).toBe('lan')
    expect(zoneForToolCategory('device')).toBe('device')
    expect(zoneForToolCategory('file')).toBeNull()
    expect(zoneForToolCategory(undefined)).toBeNull()
  })

  it('actorIntent：停/出错 > 待机 > AI 声明 > 阶段', () => {
    expect(actorIntent('stopped')).toEqual({ zone: 'home', mode: 'stay' })
    expect(actorIntent('error')).toEqual({ zone: 'home', mode: 'stay' })
    expect(actorIntent('standby', 'execute')).toEqual({ zone: 'home', mode: 'goto' })
    expect(actorIntent('running', 'execute', { zone: 'device', action: 'observe' })).toEqual({
      zone: 'device',
      mode: 'scene'
    })
    expect(actorIntent('running', 'execute')).toEqual({ zone: 'work', mode: 'goto' })
    expect(actorIntent('idle')).toEqual({ zone: 'home', mode: 'goto' })
  })

  it('所有场景动作都在闭集内', () => {
    for (const a of ROOM_SCENE_ACTIONS) expect(typeof a).toBe('string')
    expect(ROOM_SCENE_ACTIONS).toHaveLength(6)
  })
})

describe('moveToward：线性移动', () => {
  it('预算足够 → 到达目标', () => {
    const r = moveToward({ x: 0, y: 0 }, { x: 3, y: 4 }, 5, 1)
    expect(r).toEqual({ x: 3, y: 4, arrived: true })
  })

  it('预算不足 → 沿直线走 speed×dt，不越过目标', () => {
    const r = moveToward({ x: 0, y: 0 }, { x: 3, y: 4 }, 1, 1)
    expect(r.arrived).toBe(false)
    expect(Math.hypot(r.x, r.y)).toBeCloseTo(1, 6)
    expect(r.x).toBeCloseTo(0.6, 6)
    expect(r.y).toBeCloseTo(0.8, 6)
  })

  it('速度为 0 → 原地不动', () => {
    const r = moveToward({ x: 1, y: 2 }, { x: 3, y: 4 }, 0, 1)
    expect(r).toEqual({ x: 1, y: 2, arrived: false })
  })
})
