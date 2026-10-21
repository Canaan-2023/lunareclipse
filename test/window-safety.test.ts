/**
 * 批次 A1：window.ts 外链协议白名单测试网
 *
 * 直接驱动纯函数 isSafeExternalUrl（不创建 BrowserWindow，避免 mock 整个窗口生命周期），
 * 覆盖：https/http/mailto 放行；file/ms-settings/javascript/data/无协议/畸形 URL 拒绝。
 * 背景：AI 生成的回复内容可包含任意协议链接，若不过白名单直接 shell.openExternal，
 * 会触发系统程序（资源管理器/设置页/自定义协议处理器）——这是 Electron 安全清单的越权路径。
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => {
  const win = {
    on: vi.fn(),
    show: vi.fn(),
    loadURL: vi.fn(),
    loadFile: vi.fn(),
    getBounds: () => ({ x: 0, y: 0, width: 1280, height: 800 }),
    setBounds: vi.fn(),
    webContents: {
      on: vi.fn(),
      setWindowOpenHandler: vi.fn()
    }
  }
  return {
    BrowserWindow: vi.fn(() => win),
    shell: { openExternal: vi.fn() },
    screen: {
      getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 } })
    }
  }
})

import { isSafeExternalUrl } from '../electron/main/window'

describe('isSafeExternalUrl - 协议白名单', () => {
  it('http/https 外链放行', () => {
    expect(isSafeExternalUrl('https://example.com/path?a=1')).toBe(true)
    expect(isSafeExternalUrl('http://localhost:5173/')).toBe(true)
  })

  it('mailto 放行', () => {
    expect(isSafeExternalUrl('mailto:dev@example.com')).toBe(true)
  })

  it('file:// 拒绝（防触达本地文件系统）', () => {
    expect(isSafeExternalUrl('file:///C:/Windows/system.ini')).toBe(false)
  })

  it('ms-settings: 拒绝（防唤起系统设置页）', () => {
    expect(isSafeExternalUrl('ms-settings:display')).toBe(false)
  })

  it('javascript:/data: 拒绝（防脚本/数据注入）', () => {
    expect(isSafeExternalUrl('javascript:alert(1)')).toBe(false)
    expect(isSafeExternalUrl('data:text/html,<script>alert(1)</script>')).toBe(false)
  })

  it('自定义协议拒绝（防唤起任意本地程序）', () => {
    expect(isSafeExternalUrl('steam://run/123')).toBe(false)
    expect(isSafeExternalUrl('vscode://file/C:/a')).toBe(false)
  })

  it('无协议/畸形 URL 拒绝', () => {
    expect(isSafeExternalUrl('example.com/path')).toBe(false)
    expect(isSafeExternalUrl('http://')).toBe(false)
    expect(isSafeExternalUrl('')).toBe(false)
  })
})