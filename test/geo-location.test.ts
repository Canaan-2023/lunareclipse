/**
 * 地理位置服务测试：单一系统坐标链路（无 IP 兜底）+ 逆地理 + 天气注入。

 * 覆盖：系统坐标链路（photon 逆地理中文地址解析、Open-Meteo 天气 WMO 映射）、
 *       无定位来源（preciseLocationEnabled=false）时不触网、旧缓存兼容（构造时清理，不读取）、
 *       注入文本只含城市级地区（不下发坐标/区县/街道）。
 * 全部网络调用通过 mock fetch 完成，不触网；公共免费 API 的 IP 兜底链路已移除，
 * 无 positionProvider 时必须零网络请求。
 * 数据全部为虚构占位（测试省/测试市/测试街道/测试大道、坐标 0.0000、IP 203.0.113.1 RFC 5737），
 * 不引入任何真实地理或隐私数据。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  GeoLocationService,
  parsePhotonReverse,
  wmoCodeToText,
  getSystemTimezone,
  type PositionProvider
} from '../electron/main/services/geo-location'

/** 根据 URL 分发 mock 响应 */
type FetchMock = (url: string) => Promise<unknown>

function installFetchMock(handler: FetchMock): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      const body = await handler(url)
      return {
        ok: true,
        status: 200,
        json: async () => body
      } as Response
    })
  )
}

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'geo-test-'))
}

/** 系统坐标场景的默认 mock：photon 逆地理中文地址 + open-meteo 天气 */
function installSystemPositionMocks(): void {
  installFetchMock((url) => {
    if (url.includes('photon.komoot.io')) {
      return Promise.resolve({
        features: [
          {
            properties: {
              name: '测试大道',
              country: '中国',
              state: '测试省',
              city: '测试市',
              district: '测试街道'
            }
          }
        ]
      })
    }
    if (url.includes('api.open-meteo.com')) {
      return Promise.resolve({
        current: { temperature_2m: 6.2, weather_code: 2, wind_speed_10m: 7.8 }
      })
    }
    throw new Error(`unexpected url: ${url}`)
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('wmoCodeToText：WMO 天气码映射', () => {
  it('全部已收录码映射为中文描述', () => {
    // 覆盖实现全部 21 个分支（WMO 4680 编码）
    expect(wmoCodeToText(0)).toBe('晴')
    expect(wmoCodeToText(1)).toBe('基本晴')
    expect(wmoCodeToText(2)).toBe('多云')
    expect(wmoCodeToText(3)).toBe('阴')
    expect(wmoCodeToText(45)).toBe('雾')
    expect(wmoCodeToText(48)).toBe('雾')
    expect(wmoCodeToText(51)).toBe('毛毛雨')
    expect(wmoCodeToText(53)).toBe('毛毛雨')
    expect(wmoCodeToText(55)).toBe('毛毛雨')
    expect(wmoCodeToText(56)).toBe('冻毛毛雨')
    expect(wmoCodeToText(57)).toBe('冻毛毛雨')
    expect(wmoCodeToText(61)).toBe('雨')
    expect(wmoCodeToText(63)).toBe('雨')
    expect(wmoCodeToText(65)).toBe('雨')
    expect(wmoCodeToText(66)).toBe('冻雨')
    expect(wmoCodeToText(67)).toBe('冻雨')
    expect(wmoCodeToText(71)).toBe('雪')
    expect(wmoCodeToText(73)).toBe('雪')
    expect(wmoCodeToText(75)).toBe('雪')
    expect(wmoCodeToText(77)).toBe('雪粒')
    expect(wmoCodeToText(80)).toBe('阵雨')
    expect(wmoCodeToText(81)).toBe('阵雨')
    expect(wmoCodeToText(82)).toBe('阵雨')
    expect(wmoCodeToText(85)).toBe('阵雪')
    expect(wmoCodeToText(86)).toBe('阵雪')
    expect(wmoCodeToText(95)).toBe('雷暴')
    expect(wmoCodeToText(96)).toBe('雷暴伴冰雹')
    expect(wmoCodeToText(99)).toBe('雷暴伴冰雹')
  })

  it('未收录码返回未知', () => {
    expect(wmoCodeToText(-1)).toBe('未知')
    expect(wmoCodeToText(50)).toBe('未知')
    expect(wmoCodeToText(60)).toBe('未知')
    expect(wmoCodeToText(70)).toBe('未知')
    expect(wmoCodeToText(90)).toBe('未知')
    expect(wmoCodeToText(120)).toBe('未知')
    expect(wmoCodeToText(999)).toBe('未知')
  })
})

describe('parsePhotonReverse：逆地理解析', () => {
  it('解析中文地址字段（国家/省/市/区/街道）', () => {
    const addr = parsePhotonReverse({
      features: [
        {
          properties: {
            name: '测试大道',
            country: '中国',
            state: '测试省',
            city: '测试市',
            district: '测试街道'
          }
        }
      ]
    })
    expect(addr).toEqual({
      国家: '中国',
      地区: '测试省',
      城市: '测试市',
      区县: '测试街道',
      街道: '测试大道'
    })
  })

  it('无 features 时返回空字段（不抛错）', () => {
    expect(parsePhotonReverse({ features: [] })).toEqual({ 国家: '', 地区: '', 城市: '' })
    expect(parsePhotonReverse({})).toEqual({ 国家: '', 地区: '', 城市: '' })
    expect(parsePhotonReverse({ features: 'not-array' })).toEqual({ 国家: '', 地区: '', 城市: '' })
  })

  it('features[0] 无 properties 时返回空字段（不抛错）', () => {
    expect(parsePhotonReverse({ features: [{}] })).toEqual({ 国家: '', 地区: '', 城市: '' })
    expect(parsePhotonReverse({ features: [{ properties: undefined }] })).toEqual({ 国家: '', 地区: '', 城市: '' })
  })

  it('name 与城市相同时不重复作为街道', () => {
    const addr = parsePhotonReverse({
      features: [{ properties: { country: '中国', state: '测试省', city: '测试市', name: '测试市' } }]
    })
    expect(addr.街道).toBeUndefined()
    expect(addr.城市).toBe('测试市')
  })

  it('name 与区县相同时不重复作为街道', () => {
    const addr = parsePhotonReverse({
      features: [
        {
          properties: {
            country: '中国',
            state: '测试省',
            city: '测试市',
            district: '测试街道',
            name: '测试街道'
          }
        }
      ]
    })
    expect(addr.街道).toBeUndefined()
    expect(addr.区县).toBe('测试街道')
  })

  it('city 缺省时用 county 兜底', () => {
    const addr = parsePhotonReverse({
      features: [{ properties: { country: '中国', state: '测试省', county: '测试市', name: '测试大道' } }]
    })
    expect(addr.城市).toBe('测试市')
    expect(addr.街道).toBe('测试大道')
  })

  it('街道为空串时按无街道处理（不输出空街道）', () => {
    const addr = parsePhotonReverse({
      features: [{ properties: { country: '中国', state: '测试省', city: '测试市', name: '' } }]
    })
    expect(addr.城市).toBe('测试市')
    // 实现：name 为空串 → 不满足 truthy → 街道 undefined
    expect(addr.街道).toBeUndefined()
  })
})

describe('GeoLocationService：系统坐标链路（IP 兜底已移除）', () => {
  let dir: string

  beforeEach(() => {
    dir = makeTempDir()
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('系统坐标链路：逆地理中文地址 + 天气进内存缓存', async () => {
    installSystemPositionMocks()
    const provider: PositionProvider = async () => ({ 纬度: 0, 经度: 0, 精度: 50 })
    const service = new GeoLocationService(dir, provider)

    const info = await service.refresh()
    expect(info).not.toBeNull()
    expect(info!.国家).toBe('中国')
    expect(info!.地区).toBe('测试省')
    expect(info!.城市).toBe('测试市')
    expect(info!.区县).toBe('测试街道')
    expect(info!.街道).toBe('测试大道')
    expect(info!.纬度).toBe(0)
    expect(info!.经度).toBe(0)
    expect(info!.精度).toBe(50)
    expect(info!.时区).toBe(getSystemTimezone())
    // 获取时间为 ISO 字符串（缓存 TTL 判断依赖它）
    expect(new Date(info!.获取时间).getTime()).not.toBeNaN()
    // 天气带采集时间（注入时标注，供 AI 判断时效）
    expect(info!.天气).toEqual({ 温度C: 6.2, 描述: '多云', 风速kmh: 7.8, 采集时间: expect.any(String) })
    expect(new Date(info!.天气!.采集时间).getTime()).not.toBeNaN()

    // 【数据驻留（月蚀）】定位缓存只存内存、结束即删：不再落盘 .geo_cache.json
    expect(existsSync(join(dir, '.geo_cache.json'))).toBe(false)
    // 内存缓存同样可读（同一实例内生效）
    expect(service.getCached()).not.toBeNull()
    expect(service.getCached()!.天气!.描述).toBe('多云')
  })

  it('系统坐标不可用（provider 返回 null）：不触网，保留既有缓存', async () => {
    // 先成功定位一次进入内存缓存
    installSystemPositionMocks()
    let provider: PositionProvider = async () => ({ 纬度: 0, 经度: 0, 精度: 50 })
    const service = new GeoLocationService(dir, () => provider())
    await service.refresh()
    expect(service.buildInjection()).toContain('系统定位')

    // 系统定位不可用：无 IP 兜底（已移除），refresh 不触网（fetch 抛错也不应被调用到定位 API），
    // 保留既有内存缓存，且 resolve 不 reject
    provider = async () => null
    let fetchCount = 0
    installFetchMock((url) => {
      fetchCount += 1
      throw new Error(`unexpected network call: ${url}`)
    })
    await expect(service.refresh()).resolves.not.toBeNull()
    expect(fetchCount).toBe(0)
    expect(service.buildInjection()).toContain('系统定位')
  })

  it('系统坐标非法范围（纬度 > 90）视为不可用：不触网、无缓存返回 null', async () => {
    let fetchCount = 0
    installFetchMock((url) => {
      fetchCount += 1
      throw new Error(`unexpected network call: ${url}`)
    })
    const provider: PositionProvider = async () => ({ 纬度: 91, 经度: 0, 精度: 50 })
    const service = new GeoLocationService(dir, provider)

    const info = await service.refresh()
    expect(info).toBeNull()
    // 非法坐标不触发任何网络请求（IP 兜底已移除）
    expect(fetchCount).toBe(0)
  })

  it('无 positionProvider（preciseLocationEnabled=false）时零网络请求，返回 null', async () => {
    let fetchCount = 0
    installFetchMock((url) => {
      fetchCount += 1
      throw new Error(`unexpected network call: ${url}`)
    })
    const service = new GeoLocationService(dir)

    const info = await service.refresh()
    expect(info).toBeNull()
    // 无定位来源时不得触网：不请求任何 IP 定位 / 逆地理 / 天气 API
    expect(fetchCount).toBe(0)
  })

  it('系统定位缓存：无天气时不因「天气过期」反复触发刷新（评审回归）', async () => {
    let fetchCount = 0
    installFetchMock((url) => {
      fetchCount += 1
      if (url.includes('photon.komoot.io')) {
        return Promise.resolve({
          features: [{ properties: { country: '中国', state: '测试省', city: '测试市', name: '-' } }]
        })
      }
      // 逆地理成功但天气失败（网络 down）→ 缓存无天气但仍缓存地址
      throw new Error(`network down: ${url}`)
    })
    const provider: PositionProvider = async () => ({ 纬度: 0, 经度: 0, 精度: 50 })
    const service = new GeoLocationService(dir, provider)
    await service.refresh()
    const afterRefresh = fetchCount

    // 多次 getCached：地址未过期（6h）、无天气 → 不应触发任何刷新
    service.getCached()
    service.getCached()
    service.getCached()
    expect(fetchCount).toBe(afterRefresh)
  })

  it('injection 文本：系统定位只注入城市级地区与天气（隐私红线：不下发坐标/精度/街道）', async () => {
    installSystemPositionMocks()
    const provider: PositionProvider = async () => ({ 纬度: 0, 经度: 0, 精度: 50 })
    const service = new GeoLocationService(dir, provider)
    await service.refresh()

    const text = service.buildInjection()
    expect(text).toContain('地点（系统定位）')
    // 城市级地区（国家/省/市）保留
    expect(text).toContain('中国 测试省 测试市')
    // 隐私红线：区县/街道（精确地址）与坐标/精度不得进入 AI 上下文
    expect(text).not.toContain('测试街道')
    expect(text).not.toContain('测试大道')
    expect(text).not.toContain('0.0000')
    expect(text).not.toContain('精度')
    // 天气标注采集时间（AI 区分当前天气与采集时天气）
    expect(text).toMatch(/天气（\d{2}:\d{2} 采集）：多云 6\.2°C，风速 7\.8 km\/h/)
    expect(text).not.toContain('IP 定位')
  })

  it('injection 文本：无定位来源时不推断地区（无 IP 兜底），仅注入时区', async () => {
    // 定位未启用（无 provider）：不发生请求、不注入任何地区文本（IP 兜底已移除）
    installFetchMock((url) => {
      throw new Error(`unexpected network call: ${url}`)
    })
    const service = new GeoLocationService(dir, null)
    await service.refresh()

    const text = service.buildInjection()
    expect(text).toContain('时区')
    // 无任何地区推断：不出现 IP 定位、系统定位地点行、城市名或 IP（引导文案除外）
    expect(text).not.toContain('IP 定位')
    expect(text).not.toContain('地点（系统定位）')
    expect(text).not.toContain('测试市')
    expect(text).not.toMatch(/（IP [\d.:]+）/)
    expect(text).not.toContain('203.0.113.1')
    expect(text).toContain('定位不可用')
  })

  it('历史遗留磁盘缓存文件在构造时被清理（不再读取旧缓存）', async () => {
    writeFileSync(
      join(dir, '.geo_cache.json'),
      JSON.stringify({
        国家: '中国',
        地区: '测试省',
        城市: '测试市',
        时区: 'Asia/Shanghai',
        IP: '203.0.113.1',
        来源: 'ip',
        获取时间: new Date().toISOString()
      }),
      'utf-8'
    )
    const service = new GeoLocationService(dir, null)
    // 【数据驻留（月蚀）】旧版本落盘的缓存残片在构造时删除（best-effort），
    // 不再读取磁盘缓存——定位数据只存内存，结束即删，重启后重新定位。
    expect(existsSync(join(dir, '.geo_cache.json'))).toBe(false)
    expect(service.getCached()).toBeNull()
  })

  it('历史遗留无来源旧缓存：构造时同样清理，注入不出现旧地址', async () => {
    // 兼容性验证：无来源字段的旧版缓存（按 ip 处理）同样属于隐私残留，构造时清理
    writeFileSync(
      join(dir, '.geo_cache.json'),
      JSON.stringify({
        国家: '中国',
        地区: '测试省',
        城市: '测试市',
        时区: 'Asia/Shanghai',
        IP: '203.0.113.1',
        获取时间: new Date().toISOString()
      }),
      'utf-8'
    )
    const service = new GeoLocationService(dir, null)
    expect(existsSync(join(dir, '.geo_cache.json'))).toBe(false)
    expect(service.getCached()).toBeNull()
    expect(service.buildInjection()).not.toContain('测试市')
  })

  it('逆地理/天气失败不阻断：仍保留精确坐标，注入给出定位不可用引导', async () => {
    installFetchMock((url) => {
      throw new Error(`network down: ${url}`)
    })
    const provider: PositionProvider = async () => ({ 纬度: 0, 经度: 0, 精度: 100 })
    const service = new GeoLocationService(dir, provider)

    const info = await service.refresh()
    expect(info!.纬度).toBe(0)
    expect(info!.经度).toBe(0)
    expect(info!.精度).toBe(100)
    expect(info!.天气).toBeUndefined()
    // 地址字段为空但坐标保留
    expect(info!.国家).toBe('')

    // 无地址文本时注入不输出空地点行，而给"定位不可用"引导
    const text = service.buildInjection()
    expect(text).toContain('定位不可用')
    expect(text).not.toContain('地点（系统定位）：')
    expect(text).not.toContain('国家')
  })

  it('系统定位刷新失败时保留既有缓存（不 reject，MAJOR 修复验证）', async () => {
    // 先成功定位一次（进入实例内存缓存）；positionProvider 后续可切换为失效状态
    installSystemPositionMocks()
    let provider: PositionProvider = async () => ({ 纬度: 0, 经度: 0, 精度: 50 })
    // 注意闭包要调用 provider() 而非返回 provider 函数本身：
    // PositionProvider 的调用结果必须是坐标对象，返回函数对象会让坐标校验失败
    const service = new GeoLocationService(dir, () => provider())
    await service.refresh()
    expect(service.buildInjection()).toContain('系统定位')

    // 之后系统定位失效（provider 返回 null）：无 IP 兜底，
    // refresh 必须 resolve（不 reject）且保留本实例内存缓存（不返回 null 践踏 cache）
    provider = async () => null
    installFetchMock((url) => {
      throw new Error(`network down: ${url}`)
    })
    // 注意：同一实例内存缓存跨连续 refresh 保留；不能新建服务实例（新实例无磁盘缓存，重建即清空）
    await expect(service.refresh()).resolves.not.toBeNull()
    // 内存缓存的注入文本仍在（含坐标与天气）
    expect(service.buildInjection()).toContain('系统定位')
    expect(service.buildInjection()).toContain('天气')
  })

  it('定位未启用且无旧缓存：refresh 返回 null 而不 reject', async () => {
    const service = new GeoLocationService(dir, null)
    // 无定位来源（preciseLocationEnabled=false）：不触网也不 reject
    // 不安装任何 fetch mock：若实现误触网，global fetch 缺失会让 refresh 失败重试，仍不能 resolve null
    await expect(service.refresh()).resolves.toBeNull()
    // 注入缺省文本（无缓存时给出引导说明）
    expect(service.buildInjection()).toBeTruthy()
    expect(service.buildInjection()).toContain('定位不可用')
  })

  it('并发 refresh 单飞：共享同一 in-flight 任务，网络只请求一次', async () => {
    let fetchCount = 0
    installFetchMock((url) => {
      fetchCount += 1
      if (url.includes('photon.komoot.io')) {
        return Promise.resolve({
          features: [{ properties: { country: '中国', state: '测试省', city: '测试市', name: '-' } }]
        })
      }
      if (url.includes('api.open-meteo.com')) {
        return Promise.resolve({
          current: { temperature_2m: 6.2, weather_code: 2, wind_speed_10m: 7.8 }
        })
      }
      throw new Error(`unexpected url: ${url}`)
    })
    const provider: PositionProvider = async () => ({ 纬度: 0, 经度: 0, 精度: 50 })
    const service = new GeoLocationService(dir, provider)

    const [a, b, c] = await Promise.all([service.refresh(), service.refresh(), service.refresh()])
    expect(a).not.toBeNull()
    expect(b).toBe(a) // 同一任务
    expect(c).toBe(a)
    // photon + open-meteo 各一次，无重复请求
    expect(fetchCount).toBe(2)
  })
})