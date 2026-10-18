/**
 * 地理位置服务：AI 感知当前时间和地区

 * 时间：每轮对话由调用方实时注入（new Date()），本服务不缓存时间。
 * 地区：单一系统坐标链路（config.geo.preciseLocationEnabled 显式开启后启用）：
 * 渲染进程 navigator.geolocation（Windows 走系统定位服务）
 * → 主进程注入的 positionProvider 拿到 {纬度, 经度, 精度(米)}
 * → photon.komoot.io 逆地理解析中文地址（国家/省/市/区/街道，免 key）
 * → open-meteo.com 按坐标取当前天气（wmo code → 中文描述，免 key）
 * 关闭时无任何定位来源：不发起任何外部定位请求（公共 IP 兜底链路已移除），
 * AI 上下文仅注入时区。内存缓存 6 小时（地区变化慢，避免频繁请求限流）。

 * 【数据驻留策略（月蚀）】定位缓存只在内存驻留，不落盘、进程结束即删：
 * 定位数据含经纬度/街道等地理位置隐私，属"启动时扫描物理地址、取得实际定位"的
 * 地址文件，用户明确要求只存内存、结束即删（重启后重新定位）。
 * 构造时若发现历史遗留的 {dataDir}/.geo_cache.json（旧版本落盘残片），立即删除，
 * 避免隐私数据残留在项目目录中。
 */
import { existsSync, rmSync } from 'fs'
import { join } from 'path'

export interface WeatherInfo {
  /** 摄氏温度 */
  温度C: number
  /** 中文天气描述（如 多云 / 小雨） */
  描述: string
  /** 风速 km/h */
  风速kmh: number
  /** 天气采集时间（ISO 字符串；注入时标注，供 AI 判断时效） */
  采集时间: string
}

export interface GeoInfo {
  /** 国家（如 中国 / China） */
  国家: string
  /** 地区/省（如 测试省，可能空） */
  地区: string
  /** 城市（如 测试市，可能空） */
  城市: string
  /** 区县/街道（photon 逆地理 district，可能空；仅系统定位有） */
  区县?: string
  /** 街道/地名（photon reverse name，可能空；仅系统定位有） */
  街道?: string
  /** 时区（如 Asia/Shanghai） */
  时区: string
  /** 纬度（系统定位有） */
  纬度?: number
  /** 经度（系统定位有） */
  经度?: number
  /** 定位精度（米，系统定位有） */
  精度?: number
  /** 当前天气（系统定位成功取到；定位失败时无） */
  天气?: WeatherInfo
  /** 获取时间（ISO） */
  获取时间: string
}

/** 系统级坐标（渲染进程 navigator.geolocation 返回） */
export interface SystemPosition {
  纬度: number
  经度: number
  /** 精度（米） */
  精度: number
}

/**
 * 坐标提供者：由主进程注入，负责从渲染进程获取系统级坐标。
 * 拿不到坐标（定位服务关闭/超时/无窗口）时返回 null，服务保留既有缓存、不触网。
 */
export type PositionProvider = () => Promise<SystemPosition | null>

/** 系统时区（Intl 本地时区，无需网络） */
export function getSystemTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || ''
  } catch {
    return ''
  }
}

/** 格式化当前日期为中文（日期级——整天字节稳定，供前缀缓存命中；精确时间由主链路时间工具实时注入） */
export function formatDateOnly(): string {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const week = ['日', '一', '二', '三', '四', '五', '六'][now.getDay()]
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} 星期${week}`
}

/** 网络请求超时（毫秒）：坐标/逆地理/天气共用 */
const GEO_FETCH_TIMEOUT_MS = 8000

/** 带超时的 fetch（AbortController 实现），失败抛错由调用方兜底 */
async function fetchWithTimeout(url: string, timeoutMs = GEO_FETCH_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

/**
 * WMO 天气码 → 中文描述（open-meteo weather_code 采用 WMO 4680 编码）。
 * 覆盖常用码：晴/多云/阴/雾/毛毛雨/雨/雪/阵雨/雷暴等；未收录码返回「未知」。
 */
export function wmoCodeToText(code: number): string {
  if (code === 0) return '晴'
  if (code === 1) return '基本晴'
  if (code === 2) return '多云'
  if (code === 3) return '阴'
  if (code === 45 || code === 48) return '雾'
  if (code === 51 || code === 53 || code === 55) return '毛毛雨'
  if (code === 56 || code === 57) return '冻毛毛雨'
  if (code === 61 || code === 63 || code === 65) return '雨'
  if (code === 66 || code === 67) return '冻雨'
  if (code === 71 || code === 73 || code === 75) return '雪'
  if (code === 77) return '雪粒'
  if (code === 80 || code === 81 || code === 82) return '阵雨'
  if (code === 85 || code === 86) return '阵雪'
  if (code === 95) return '雷暴'
  if (code === 96 || code === 99) return '雷暴伴冰雹'
  return '未知'
}

/** photon.komoot.io 逆地理响应单条 feature 的 properties */
interface PhotonProperties {
  name?: string
  street?: string
  city?: string
  county?: string
  state?: string
  district?: string
  country?: string
}

/**
 * 逆地理解析：把 photon.komoot.io 的响应解析为地址字段。
 * photon 不传 lang 时对国内坐标返回中文本地名（实测：测试省/测试市/测试街道）。
 */
export function parsePhotonReverse(data: Record<string, unknown>): {
  国家: string
  地区: string
  城市: string
  区县?: string
  街道?: string
} {
  const features = Array.isArray(data.features) ? (data.features as Array<{ properties?: PhotonProperties }>) : []
  const p = features[0]?.properties
  if (!p) return { 国家: '', 地区: '', 城市: '' }
  return {
    国家: String(p.country ?? ''),
    地区: String(p.state ?? ''),
    城市: String(p.city ?? p.county ?? ''),
    区县: p.district ? String(p.district) : undefined,
    街道: p.name && p.name !== p.city && p.name !== p.district ? String(p.name) : undefined
  }
}

/** 城市级地区名（国家/省/市，不含区县/街道）。
 * 隐私红线：精确地址（区县/街道）默认不得进入日志与 AI 上下文——
 * 所有对外可见的文本（日志、buildInjection）一律用城市级粒度。
 */
function buildCityLevelRegion(geo: Pick<GeoInfo, '国家' | '地区' | '城市'>): string {
  return [geo.国家, geo.地区, geo.城市].filter(Boolean).join(' ')
}

/** 错误消息裁剪：抹除 URL（外部 API 地址的查询参数可能携带坐标/用户信息），避免精确位置随错误进入日志 */
function sanitizeErrorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.replace(/https?:\/\/[^\s"'<>]+/g, '[url]')
}

export class GeoLocationService {
  private cache: GeoInfo | null = null
  private cacheFile: string
  /** 坐标提供者（由 server.ts 注入，从渲染进程取系统级坐标） */
  private positionProvider: PositionProvider | null
  /** 进行中的刷新任务（单飞：并发 refresh 共享同一任务，避免过期窗口内重复刷新） */
  private inflightRefresh: Promise<GeoInfo | null> | null = null
  /** 缓存有效期：6 小时 */
  private static readonly CACHE_TTL_MS = 6 * 60 * 60 * 1000
  /** 天气有效期：30 分钟（天气是小时级变化数据，与地址缓存解耦——评审 MAJOR-02） */
  private static readonly WEATHER_TTL_MS = 30 * 60 * 1000

  constructor(dataDir: string, positionProvider?: PositionProvider | null) {
    // 注意：传入的是 abyssac_data 根（paths.root 已含 abyssac_data），缓存文件历史遗留于此
    this.cacheFile = join(dataDir, '.geo_cache.json')
    this.positionProvider = positionProvider ?? null
    this.cleanupLegacyCacheFile()
  }

  /**
   * 清除历史遗留的磁盘缓存文件（旧版本 persist() 落盘的 .geo_cache.json）。
   * 【留存理由/为什么存在】定位缓存已改为只存内存、结束即删（用户隐私要求），
   * 但升级前旧版本可能已把含经纬度/IP 的缓存落盘；若不清理，隐私数据会残留在
   * 项目目录中，"结束即删"承诺便不完整。此清理是升级迁移的一次性动作，
   * 删除失败（文件被占用等）不阻断启动，下次启动再试。
   */
  private cleanupLegacyCacheFile(): void {
    try {
      if (existsSync(this.cacheFile)) {
        rmSync(this.cacheFile, { force: true })
        // 隐私红线：不打印完整缓存路径（dataDir 下含用户名等设备信息），仅输出文件名
        console.log('[geo] 已清除历史遗留地理缓存文件（.geo_cache.json，只存内存，结束即删）')
      }
    } catch (err) {
      // 清理是 best-effort：文件正被占用（块设备/杀软锁）时跳过，绝不因清理失败阻断定位服务
      console.warn(`[geo] 清除历史遗留缓存失败（跳过，下次启动重试）: ${sanitizeErrorMessage(err)}`)
    }
  }

  /** 读取缓存（未过期则用，否则触发一次网络刷新——异步不阻塞） */
  getCached(): GeoInfo | null {
    if (!this.cache) return null
    const age = Date.now() - new Date(this.cache.获取时间).getTime()
    // 无天气（定位失败或未取到）时不因天气过期触发刷新，避免每轮 getCached 都打外部 API
    const weatherAge = this.cache.天气 ? Date.now() - new Date(this.cache.天气.采集时间).getTime() : 0
    if (age > GeoLocationService.CACHE_TTL_MS || weatherAge > GeoLocationService.WEATHER_TTL_MS) {
      // 地址或天气过期：异步刷新（不阻塞注入）
      void this.refresh()
    }
    return this.cache
  }

  /**
   * 强制刷新：仅系统坐标链路（用户显式开启 preciseLocationEnabled 后存在 positionProvider）。
   * 无定位来源（开关关闭）时不发起任何外部请求，直接返回既有缓存/ null。
   * 刷新永不 reject：失败时保留既有缓存（若无缓存返回 null），
   * 避免调用方（getCached / server.ts 的 void refresh）产生 unhandled rejection。
   * 并发调用共享同一 in-flight 任务（单飞，防缓存过期窗口内多轮重复刷新）。
   */
  async refresh(): Promise<GeoInfo | null> {
    if (this.inflightRefresh) return this.inflightRefresh
    this.inflightRefresh = (async () => {
      try {
        if (!this.positionProvider) {
          // 无定位来源（用户未开启 preciseLocationEnabled）：不触网，仅返回既有缓存
          console.log('[geo] 定位未启用（preciseLocationEnabled=false），跳过刷新')
          return this.cache
        }
        try {
          const info = await this.refreshFromSystemPosition()
          if (info) return info
          console.log('[geo] 系统坐标定位不可用（定位服务关闭/超时/无窗口），跳过本次刷新')
        } catch (err) {
          console.log('[geo] 系统坐标定位失败（保留既有缓存）:', sanitizeErrorMessage(err))
        }
        return this.cache
      } finally {
        this.inflightRefresh = null
      }
    })()
    return this.inflightRefresh
  }

  /** 系统坐标链路：positionProvider → photon 逆地理 → open-meteo 天气 */
  private async refreshFromSystemPosition(): Promise<GeoInfo | null> {
    const pos = await this.positionProvider!()
    // 校验：数值必须是有限数且经纬度在合法范围内（超范围会让外部 API 直接 400）
    if (
      !pos ||
      !Number.isFinite(pos.纬度) ||
      !Number.isFinite(pos.经度) ||
      Math.abs(pos.纬度) > 90 ||
      Math.abs(pos.经度) > 180
    ) {
      return null
    }

    const base: GeoInfo = {
      国家: '',
      地区: '',
      城市: '',
      时区: getSystemTimezone(),
      纬度: pos.纬度,
      经度: pos.经度,
      精度: Number.isFinite(pos.精度) ? pos.精度 : 0,
      获取时间: new Date().toISOString()
    }

    // 逆地理（失败不阻断：至少有精确坐标）
    try {
      const res = await fetchWithTimeout(
        `https://photon.komoot.io/reverse?lat=${pos.纬度}&lon=${pos.经度}`
      )
      if (res.ok) {
        const data = (await res.json()) as Record<string, unknown>
        const addr = parsePhotonReverse(data)
        base.国家 = addr.国家
        base.地区 = addr.地区
        base.城市 = addr.城市
        base.区县 = addr.区县
        base.街道 = addr.街道
      }
    } catch (err) {
      console.log('[geo] 逆地理解析失败（保留精确坐标）:', sanitizeErrorMessage(err))
    }

    // 天气（失败不阻断）
    try {
      const wres = await fetchWithTimeout(
        `https://api.open-meteo.com/v1/forecast?latitude=${pos.纬度}&longitude=${pos.经度}&current=temperature_2m,weather_code,wind_speed_10m`
      )
      if (wres.ok) {
        const wdata = (await wres.json()) as {
          current?: { temperature_2m?: number; weather_code?: number; wind_speed_10m?: number }
        }
        const cur = wdata.current
        if (cur && typeof cur.temperature_2m === 'number') {
          base.天气 = {
            温度C: cur.temperature_2m,
            描述: wmoCodeToText(typeof cur.weather_code === 'number' ? cur.weather_code : -1),
            风速kmh: typeof cur.wind_speed_10m === 'number' ? cur.wind_speed_10m : 0,
            采集时间: new Date().toISOString()
          }
        }
      }
    } catch (err) {
      console.log('[geo] 天气获取失败（保留地址）:', sanitizeErrorMessage(err))
    }

    this.cache = base
    // 隐私红线：日志只输出城市级地区（国家/省/市），不输出经纬度、区县、街道
    console.log(
      `[geo] 定位成功（system）: ${buildCityLevelRegion(base)}` +
        (base.天气 ? `，天气：${base.天气.描述} ${base.天气.温度C}°C` : '')
    )
    return base
  }

  /** IP 兜底链路已移除（隐私红线整改：公共免费 API 的 IP 定位不再使用，默认不触网）。 */

  /** 组装注入文本（日期级时间 + 地区缓存；系统定位附加精确地址与天气） */
  buildInjection(): string {
    const tz = getSystemTimezone()
    const geo = this.getCached()
    const lines = [`## 当前日期：${formatDateOnly()}`]
    if (tz) lines.push(`- 时区：${tz}`)
    if (geo) {
      // 隐私红线：AI 上下文只注入城市级地区（国家/省/市，不含区县/街道），
      // 坐标/精度/街道默认不进入 AI 上下文；需要精确位置的场景走显式授权链路（见整改报告）。
      const region = buildCityLevelRegion(geo)
      if (region) {
        let line = `- 地点（系统定位）：${region}`
        if (geo.天气) {
          // 标注采集时间：天气是小时级数据，AI 需区分「采集时天气」与「当前天气」（评审 MAJOR-02）
          const t = new Date(geo.天气.采集时间)
          const hm = Number.isNaN(t.getTime())
            ? ''
            : `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`
          line += `，天气（${hm} 采集）：${geo.天气.描述} ${geo.天气.温度C}°C，风速 ${geo.天气.风速kmh} km/h`
        }
        lines.push(line)
      } else {
        lines.push('- 地区：定位不可用（系统定位未开启或定位失败）')
      }
    } else {
      lines.push('- 地区：定位不可用（系统定位未开启或定位失败）')
    }
    return lines.join('\n')
  }
}