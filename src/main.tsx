/**
 * @category 渲染
 * @summary 渲染进程入口：React UI、错误边界与全局样式
 */
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import './styles/globals.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  // 移除 StrictMode——React 19 的 StrictMode double-render + useSyncExternalStore
  // 不稳定 getSnapshot 组合触发 hook deps 崩溃（areHookInputsEqual 收到 undefined → .length 崩）。
  // StrictMode 只在开发模式生效，移除不影响生产。
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
)
