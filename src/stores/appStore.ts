/**
 * 为什么存在：zustand store 体量膨胀后按域拆成五个 slice，本文件保留
 * 装配层以保证对外 API 契约不变（同时规避 React 19 下 zustand combine 的组合 bug）。
 * @category 前端状态
 * @summary appStore 主文件：按域拆分为 chat/browser/sandbox/lilith/system 五个 zustand slice。
 * 本文件只保留「类型再导出 + trimMessagesForWs 再导出 + slice 组合 + useAppStore hook 装配」，
 * 所有业务实现迁移到 slices/ 目录（共享常量/运行时状态在 slices/appStore-shared.ts）。
 * 对外 API 契约不变：useAppStore、AppState/ActiveToolCall/PlanTodoItem/RightPanelTabId、
 * trimMessagesForWs 仍从 './appStore' 路径导出。
 */
import { create } from 'zustand'
import { useSyncExternalStore, useRef } from 'react'
import type { AppState } from './appStore-types'
import { createChatSlice } from './slices/chatSlice'
import { createBrowserSlice } from './slices/browserSlice'
import { createSandboxSlice } from './slices/sandboxSlice'
import { createLilithSlice } from './slices/lilithSlice'
import { createSystemSlice } from './slices/systemSlice'

// 类型再导出：保持既有 from './appStore' 的引用路径不变
export type { AppState, ActiveToolCall, PlanTodoItem, RightPanelTabId } from './appStore-types'
// trimMessagesForWs 再导出：既有 from './appStore' 的引用路径不变
export { trimMessagesForWs } from './slices/appStore-shared'

const appStore = create<AppState>((set, get) => ({
  ...createChatSlice(set, get),
  ...createBrowserSlice(set, get),
  ...createSandboxSlice(set, get),
  ...createLilithSlice(set, get),
  ...createSystemSlice(set, get)
}))

// 绕开 zustand useStore 的 useCallback——React 19 组合 bug：
// areHookInputsEqual 收到 undefined deps → prevDeps.length 崩溃（发消息即渲染错误）。
// 改用 React 原生 useSyncExternalStore：getSnapshot 每次渲染新建，但返回 store 原始
// 引用（引用稳定），不触发 React 不稳定快照告警；订阅走 zustand vanilla subscribe（签名兼容）。
const useAppStoreHook = <T>(selector: (s: AppState) => T): T => {
  const prevRef = useRef<T>(undefined as T | undefined)
  return useSyncExternalStore(
    appStore.subscribe,
    () => {
      const next = selector(appStore.getState())
      if (prevRef.current !== undefined && Object.is(prevRef.current, next)) {
        return prevRef.current
      }
      prevRef.current = next
      return next
    },
    () => selector(appStore.getInitialState())
  )
}
// 挂 store api（兼容 useAppStore.getState()/setState()/subscribe() 等既有调用点）
export const useAppStore = Object.assign(useAppStoreHook, appStore)