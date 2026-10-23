/**
 * 系统级坐标提供者：在主窗口渲染进程调用 navigator.geolocation（Windows 走系统定位服务）。
 * 为什么存在：仅当用户显式开启 geo.preciseLocationEnabled 后，GeoLocationService
 * 才会注入本 provider 并启用系统坐标链路；公共 IP 兜底链路已移除（隐私红线整改），
 * 未开启时无任何定位来源、不发起任何外部定位请求。
 * 作用：为主窗口渲染进程发出 geolocation 请求并返回 {纬度, 经度, 精度}。
 * 权限策略（隐私红线整改后）：Electron 权限请求默认拒绝，仅主进程
 * defaultSession 的 permissionRequestHandler 对「受信应用本地窗口」（主窗口/overlay，
 * origin 为本地渲染层）放行 geolocation；内置浏览器面板用独立 partition，外部网页
 * 默认无法获得系统定位（仅用户在内置浏览器设置中显式开启后放行，详见
 * electron/main/index.ts 与 browser-view-manager.ts）。
 * 拿不到坐标（无窗口/超时/系统定位关闭）返回 null，由 GeoLocationService 保留既有缓存、不触网。
 * 定位为真实系统数据：不伪造、不模拟；失败即如实降级。
 */
import { BrowserWindow } from 'electron'
import type { PositionProvider } from './geo-location'

export const detectSystemPosition: PositionProvider = async () => {
  const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && !w.webContents.isDestroyed())
  if (!win) return null
  try {
    const result = (await win.webContents.executeJavaScript(
      `new Promise((resolve) => {
        if (typeof navigator === 'undefined' || !navigator.geolocation) return resolve(null)
        navigator.geolocation.getCurrentPosition(
          (pos) => resolve({
            纬度: pos.coords.latitude,
            经度: pos.coords.longitude,
            精度: pos.coords.accuracy
          }),
          () => resolve(null),
          { enableHighAccuracy: true, timeout: 8000, maximumAge: 600000 }
        )
      })`,
      true
    )) as { 纬度?: number; 经度?: number; 精度?: number } | null
    if (result && typeof result.纬度 === 'number' && typeof result.经度 === 'number') {
      return {
        纬度: result.纬度,
        经度: result.经度,
        精度: typeof result.精度 === 'number' ? result.精度 : 0
      }
    }
    return null
  } catch {
    // executeJavaScript 失败（页面未就绪等）不阻断，返回 null（服务端保留既有缓存）
    return null
  }
}