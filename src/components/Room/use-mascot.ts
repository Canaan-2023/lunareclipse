/**
 * 图片看板娘的**唯一取数点**（按 AI 分层：每个 AI 一套人物图）。
 *
 * 为什么按 aiId 缓存：月蚀会接入更多 AI；全局一份图片会让所有房间长得一样。
 * 取数顺序由主进程负责（`<data>/room/AI{aiId}/mascot/` 优先，空则回落全局
 * `<data>/room/mascot/`，兼容 0.53.4 之前已经放好的图）。
 *
 * 为什么不是推送：目录是用户手动丢文件的地方，主进程没有可靠的文件事件源
 * （Windows 上 `fs.watch` 对「整目录替换」的语义很脆），而这件事**本来就是一个刻意的动作**
 * ——「我放了图 → 点一下重新读取」。与设备扫描同口径：**按钮触发**，不猜。
 *
 * 不轮询（本仓硬口径）：只在挂载、`avatarRev` 变化（AI 重画过）与手动重载时取数。
 */
import { useSyncExternalStore } from 'react'
import { DEFAULT_AI_ID } from '@shared/types'
import { validateMascotSheet, type MascotSheet, type MascotSkip } from '@shared/room/mascot'

export interface MascotState {
  /** 帧名 → `data:image/png;base64,…`（空表 = 用内置像素画） */
  frames: Record<string, string>
  /** 放了但没生效的文件 + 原因（**不静默**） */
  skipped: MascotSkip[]
  /** 当前 AI 的立绘目录（界面显示；未登录/未就绪时为 null） */
  dir: string | null
  /** 是否取过一次（区分「还没取」与「取了但目录是空的」） */
  loaded: boolean
  /**
   * 读取失败的**原因**（IPC 抛错 / 主进程未就绪 / 桥接方法缺失）。
   * 为什么单独记：以前失败会静默回落成空表，界面只会显示像素画，
   * 用户看到的是「我放了图但不生效」而没有任何线索。
   */
  error: string | null
}

const EMPTY: MascotState = { frames: {}, skipped: [], dir: null, loaded: false, error: null }

const states = new Map<number, MascotState>()
const inFlight = new Map<number, Promise<void>>()
const listeners = new Map<number, Set<() => void>>()

function stateOf(aiId: number): MascotState {
  return states.get(aiId) ?? EMPTY
}

function emit(aiId: number): void {
  for (const l of listeners.get(aiId) ?? []) l()
}

function subscribe(aiId: number, cb: () => void): () => void {
  let set = listeners.get(aiId)
  if (!set) {
    set = new Set()
    listeners.set(aiId, set)
  }
  set.add(cb)
  return () => {
    set?.delete(cb)
  }
}

/** 重新读取指定 AI 的图片看板娘（同 AI 并发调用合并成一次）。 */
export function reloadMascot(aiId: number = DEFAULT_AI_ID): Promise<void> {
  const existing = inFlight.get(aiId)
  if (existing) return existing
  const p = (async () => {
    try {
      const r = await window.lunareclipse?.roomMascotGet?.(aiId)
      if (!r?.ok) {
        states.set(aiId, { ...EMPTY, loaded: true, error: '读取图片立绘失败：主进程未就绪或该通道不可用' })
      } else {
        // IPC 回来的东西也要过一遍校验（渲染侧永远不信任跨进程数据）
        const v = validateMascotSheet(r.sheet)
        states.set(aiId, {
          frames: v.ok ? v.sheet.frames : {},
          skipped: Array.isArray(r.skipped) ? r.skipped : [],
          dir: typeof r.dir === 'string' ? r.dir : null,
          loaded: true,
          error: v.ok ? null : `图片立绘表未通过校验：${v.error}`
        })
      }
    } catch (err) {
      states.set(aiId, {
        ...EMPTY,
        loaded: true,
        error: `读取图片立绘失败：${err instanceof Error ? err.message : String(err)}`
      })
    } finally {
      inFlight.delete(aiId)
      emit(aiId)
    }
  })()
  inFlight.set(aiId, p)
  return p
}

/** 订阅指定 AI 的看板娘（`getSnapshot` 只在取数完成时换引用）。 */
export function useMascot(aiId: number = DEFAULT_AI_ID): MascotState {
  return useSyncExternalStore(
    (cb) => subscribe(aiId, cb),
    () => stateOf(aiId),
    () => stateOf(aiId)
  )
}

/** 测试用：把状态复位（模块级缓存，用例之间必须隔离） */
export function __resetMascotForTest(): void {
  states.clear()
  inFlight.clear()
  listeners.clear()
}

/** 该帧有没有图（渲染侧的分支点） */
export function mascotSrcFor(sheet: MascotState, frameName: string | null): string | null {
  if (!frameName) return null
  return sheet.frames[frameName] ?? null
}

/** 供类型收窄用：把 `MascotSheet` 与状态对齐（两者形状一致，仅 `loaded` 不同） */
export type MascotFrames = MascotSheet['frames']
