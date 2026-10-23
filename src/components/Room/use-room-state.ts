/**
 * 房间运行态的**唯一取数点**（React hook）：挂载时读一次 + 订阅主进程推送。
 *
 * 为什么独立成模块：`RoomView`（会话页原位视图）与 `RoomApp`（旧独立窗口回滚分支）两个根组件
 * 都需要同一份运行态；取数逻辑写在任一组件里，另一个就得复制一份——那正是「同一通道被问两遍」
 * 的来源。这里集中一处，两个根各调一次。
 *
 * 为什么是「一次读取 + 推送」而不是轮询（用户裁决，勿回退）：
 * 自主模式大部分时间是安静的（待机 / 空闲）。轮询在「什么都没发生」时也在消耗——与采集器的
 * 裁决同源（「采集器只能是条件激活，不能是定时激活…其余时间都是浪费」）。状态**变了才推**：
 * 安静期零开销，有事时**立即**到界面（轮询还多一个周期的延迟）。
 * 挂载时那一次读取不是轮询——它只回答「我进来时是什么状态」，此后全靠推送。
 *
 * 不删理由：删掉即两个根组件各自复制取数与订阅（重复轮询 / 重复订阅的旧病复发）。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { EMPTY_ROOM_SNAPSHOT, toRoomSnapshot, type RoomRuntimeSnapshot } from './room-status'

/**
 * 取某 AI 房间的运行态快照。`aiId` 变化（换房间所属 AI）时重新读取并重新订阅。
 * 推送按 `aiId` 过滤：主窗口可能承载不同 AI 的房间视图，不该被别的房间的状态顶掉。
 */
export function useRoomRuntimeState(aiId: number): RoomRuntimeSnapshot {
  const [state, setState] = useState<RoomRuntimeSnapshot>(EMPTY_ROOM_SNAPSHOT)
  /**
   * 请求令牌：切 AI 时旧的 `roomRuntimeState` 可能后返回。
   * 没有它就会出现「已经切到 AI2，顶栏/画面短暂显示 AI1 的状态」——SRE 评审 P1。
   */
  const reqRef = useRef(0)

  // 一次性读取（挂载 / 换 AI）：**采样时刻在这里取一次**，全快照的消费者共享同一时刻
  const refresh = useCallback(() => {
    const id = ++reqRef.current
    void window.lunareclipse?.roomRuntimeState?.(aiId).then((r) => {
      if (id !== reqRef.current) return
      if (r?.ok) setState(toRoomSnapshot(r.state, Date.now()))
    })
  }, [aiId])

  useEffect(() => {
    refresh()
    const off = window.lunareclipse?.onRoomState?.((payload) => {
      if (payload.aiId !== aiId) return
      setState(toRoomSnapshot(payload.state, Date.now()))
    })
    return () => {
      // 让在途请求作废（卸载 / 切 AI 后不再回填旧状态）
      reqRef.current += 1
      off?.()
    }
  }, [aiId, refresh])

  return state
}
