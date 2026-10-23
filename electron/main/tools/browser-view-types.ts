/**
 * 浏览器视图类型定义：为什么存在——浏览器视图的操作历史与事件回调跨模块传递，
 * 需要集中定义类型避免字符串与结构散落。
 * 作用：定义 BrowserHistoryEntry（操作历史条目）与 BrowserEvent（视图事件）类型。
 */
/** 浏览器操作历史条目 */
export interface BrowserHistoryEntry {
  id: string
  timestamp: number
  /** 动作类型：navigate/click/type/scroll/snapshot/screenshot/evaluate/close */
  action: string
  /** 关键参数（URL / selector / text / direction 等） */
  detail: string
  /** 执行结果：success / error */
  result: 'success' | 'error'
  /** 错误消息（result=error 时有值） */
  errorMessage?: string
  /** 执行耗时（毫秒） */
  durationMs: number
}

/** 浏览器事件推送给前端 */
export type BrowserEvent =
  | { type: 'browser:state'; visible: boolean; url: string; title: string; loading: boolean; canGoBack: boolean; canGoForward: boolean }
  | { type: 'browser:closed' }
  | { type: 'browser:history'; entry: BrowserHistoryEntry }
  | { type: 'browser:actionStart'; action: string; detail: string; selector?: string }
  | { type: 'browser:actionEnd'; id: string; result: 'success' | 'error'; errorMessage?: string }
| { type: 'browser:highlight'; selector: string; rect: { x: number; y: number; width: number; height: number } }
  | { type: 'browser:mouseMove'; from: { x: number; y: number }; to: { x: number; y: number } }
  | { type: 'browser:label'; text: string; durationMs: number }
