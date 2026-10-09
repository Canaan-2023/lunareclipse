// ============================================================
// 崩溃日志服务：crashReporter 启动 + JS 异常持久化
// ------------------------------------------------------------
// 解决两个问题：
// 1. 原生崩溃（segfault/OOM/Chromium 级）无 dump、无线索 → 启用 crashReporter 写 dump
// 2. JS 层 uncaughtException/unhandledRejection 只 console.error 不持久化 → 写文件日志
// 重启后可回溯崩溃原因，定位"静默闪退"根因
// ============================================================

import { app, crashReporter, BrowserWindow } from 'electron'
import { join, dirname } from 'path'
import { existsSync, mkdirSync, appendFileSync } from 'fs'
import { nowIso } from '../models/memory'

let logFilePath: string | null = null

/**
 * 启动 crashReporter，捕获原生崩溃 dump。
 * 必须在 app.ready 之前调用（Electron 要求）。
 * dump 写入 {userData}/crashes 目录。
 */
export function startCrashReporter(): void {
  try {
    // userData 在 index.ts 顶部已 setPath，此时可直接获取
    const crashesDir = join(app.getPath('userData'), 'crashes')
    if (!existsSync(crashesDir)) {
      mkdirSync(crashesDir, { recursive: true })
    }
    // 设置 crash dump 输出目录（Electron 会在该目录写 .dmp 崩溃转储文件）
    app.setPath('crashDumps', crashesDir)
    crashReporter.start({
      productName: 'LunarEclipse',
      companyName: 'ABYSSAC',
      submitURL: '', // 不上传，仅本地存档
      uploadToServer: false
    })
    logFilePath = join(app.getPath('userData'), 'logs', 'main-errors.log')
    if (!existsSync(dirname(logFilePath))) {
      mkdirSync(dirname(logFilePath), { recursive: true })
    }
  } catch (err) {
    // crashReporter 启动失败不应阻塞应用启动，降级为仅 console
    console.error('[crash-logger] startCrashReporter failed:', err)
  }
}

/**
 * 持久化 JS 异常到日志文件（追加写入，避免缓冲丢失）。
 * 同时输出到 console，保留原有行为。

 * level 是分类标签（如 'uncaughtException' / 'ipc:session:list' / 'onBeforeQuit:supervisor.stop'），
 * 用于日志检索和过滤。放宽为 string 以支持各模块按需记录错误，不再局限于全局异常三类。
 */
export function logError(level: string, detail: unknown): void {
  const timestamp = nowIso()
  const text = formatError(level, detail)
  // 始终输出到 console
  console.error(`[${timestamp}] [${level}] ${text}`)

  // 持久化到文件（追加写入，进程意外退出时已写内容不丢）
  if (logFilePath) {
    try {
      appendFileSync(logFilePath, `[${timestamp}] [${level}] ${text}\n`, 'utf-8')
    } catch {
      // 写日志失败不能再抛，静默忽略
    }
  }
}

/**
 * 写入信息级事件到日志文件（与 logError 同文件、同格式，仅 console 用 log 而非 error）。
 * 用于记录非错误的生命周期事件（如流结束/中断原因）——正常收尾不该记为 error，
 * 但同样需要落盘，否则断流后无从回溯（此前 llm.ts 全走 console，日志零记录）。
 */
export function logInfo(level: string, detail: unknown): void {
  const timestamp = nowIso()
  const text = formatError(level, detail)
  console.log(`[${timestamp}] [${level}] ${text}`)
  if (logFilePath) {
    try {
      appendFileSync(logFilePath, `[${timestamp}] [${level}] ${text}\n`, 'utf-8')
    } catch {
      // 写日志失败不能再抛，静默忽略
    }
  }
}

/** 获取日志文件路径（供前端读取展示） */
export function getErrorLogPath(): string | null {
  return logFilePath
}

function formatError(level: string, detail: unknown): string {
  if (detail instanceof Error) {
    const stack = detail.stack || detail.message
    return `${detail.name}: ${stack}`
  }
  if (typeof detail === 'string') {
    return detail
  }
  try {
    return JSON.stringify(detail)
  } catch {
    return String(detail)
  }
}

/**
 * 安全地向渲染进程发送消息：检查窗口和 webContents 是否已销毁。
 * 避免在 DMN 心跳回调等异步上下文中向已销毁的 webContents 发消息导致
 * "Object has been destroyed" 异常（会刷大量 unhandledRejection 日志）。
 */
export function safeSend(win: BrowserWindow | null, channel: string, ...args: unknown[]): void {
  if (!win || win.isDestroyed()) return
  const wc = win.webContents
  if (wc.isDestroyed()) return
  try {
    wc.send(channel, ...args)
  } catch (err) {
    // send 仍可能因竞态失败，兜底记录不抛出
    logError('uncaughtException', `safeSend(${channel}) failed: ${(err as Error).message}`)
  }
}
