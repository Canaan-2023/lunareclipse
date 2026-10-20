/**
 * 采集器扩展（B11）回归测试：后台进程扫描 + 上传/下载监控。
 *
 * 为什么存在：用户要求采集器「不光要屏幕采集，还有当前的后台进程有什么，当前的上传和下载都要有所监控」。
 * 这两段都是**解析 + 差分**型逻辑（解析错一个字段就报错数、差分错就报假速率），必须有回归网。
 *
 * 覆盖：tasklist CSV 解析（引号/千分位/排序/截断/非法行）/ 非 Windows 返回空 /
 * 网络速率差分（首次 null、二次算速率、计数器回绕不报负速率、采样失败 null）/ 适配器 JSON 解析。
 */
import { describe, it, expect } from 'vitest'
import { parseTasklistCsv, collectProcesses, DEFAULT_PROCESS_LIMIT } from '../electron/main/room/process-scan'
import { createNetMonitor, parseAdapterStatistics } from '../electron/main/room/net-monitor'

const CSV = [
  '"Image Name","PID","Session Name","Session#","Mem Usage"',
  '"chrome.exe","1234","Console","1","1,234,567 K"',
  '"node.exe","42","Console","1","512 K"',
  '"explorer.exe","9","Console","1","200,000 K"',
  'bad line without enough columns'
].join('\r\n')

describe('parseTasklistCsv：进程列表解析', () => {
  it('解析名称/PID/内存并**按内存降序**', () => {
    const rows = parseTasklistCsv(CSV)
    expect(rows.map((r) => r.name)).toEqual(['chrome.exe', 'explorer.exe', 'node.exe'])
    expect(rows[0]).toMatchObject({ pid: 1234 })
    expect(rows[0].memMB).toBe(Math.round(1234567 / 1024))
  })

  it('列数不足的行被丢弃', () => {
    expect(parseTasklistCsv(CSV).some((r) => r.name.startsWith('bad'))).toBe(false)
  })

  it('按 limit 截断（默认取内存最高的 N 条）', () => {
    expect(parseTasklistCsv(CSV, 1)).toHaveLength(1)
    expect(parseTasklistCsv(CSV, 1)[0].name).toBe('chrome.exe')
    expect(DEFAULT_PROCESS_LIMIT).toBeGreaterThan(0)
  })

  it('空输入 / 全非法 → 空数组', () => {
    expect(parseTasklistCsv('')).toEqual([])
    expect(parseTasklistCsv('a,b')).toEqual([])
  })
})

describe('collectProcesses：非 Windows 不猜命令', () => {
  it('当前平台非 win32 时返回空数组（本机为 Windows 时应调用注入的 runner）', async () => {
    let called = 0
    const run = async (): Promise<string> => {
      called++
      return CSV
    }
    const rows = await collectProcesses(run)
    if (process.platform === 'win32') {
      expect(called).toBe(1)
      expect(rows.length).toBeGreaterThan(0)
    } else {
      expect(called).toBe(0)
      expect(rows).toEqual([])
    }
  })

  it('runner 抛错 → 空数组（采集失败不阻断循环）', async () => {
    if (process.platform !== 'win32') return
    const rows = await collectProcesses(async () => {
      throw new Error('boom')
    })
    expect(rows).toEqual([])
  })
})

describe('createNetMonitor：速率差分', () => {
  function monitorWith(seq: Array<{ rxBytes: number; txBytes: number } | null>, times: number[]) {
    let i = 0
    let t = 0
    return createNetMonitor({
      readCounters: async () => seq[i++] ?? null,
      now: () => times[t++] ?? 0
    })
  }

  it('首次采样 → 速率为 null（不假装 0）', async () => {
    const m = monitorWith([{ rxBytes: 1000, txBytes: 2000 }], [1000])
    const r = await m.read()
    expect(r.rxBytesPerSec).toBeNull()
    expect(r.txBytesPerSec).toBeNull()
    expect(r.rxTotalMB).toBeGreaterThanOrEqual(0)
  })

  it('二次采样 → 按时间差算速率', async () => {
    const m = monitorWith(
      [
        { rxBytes: 0, txBytes: 0 },
        { rxBytes: 2000, txBytes: 4000 }
      ],
      [1000, 3000] // 2 秒
    )
    await m.read()
    const r = await m.read()
    expect(r.rxBytesPerSec).toBe(1000)
    expect(r.txBytesPerSec).toBe(2000)
  })

  it('计数器回绕（差值负）→ 本次不报速率（不是负速率）', async () => {
    const m = monitorWith(
      [
        { rxBytes: 5000, txBytes: 5000 },
        { rxBytes: 100, txBytes: 100 }
      ],
      [1000, 2000]
    )
    await m.read()
    const r = await m.read()
    expect(r.rxBytesPerSec).toBeNull()
    expect(r.txBytesPerSec).toBeNull()
  })

  it('采样失败（null）→ 全 null，不抛错', async () => {
    const m = monitorWith([null], [1000])
    const r = await m.read()
    expect(r.rxBytesPerSec).toBeNull()
    expect(r.rxTotalMB).toBe(0)
  })

  it('附带本应用传输摘要', async () => {
    const m = createNetMonitor({
      readCounters: async () => null,
      readAppTransfers: () => ({ activeLanStreams: 2, relayPending: 1 }),
      now: () => 1
    })
    const r = await m.read()
    expect(r.app).toEqual({ activeLanStreams: 2, relayPending: 1 })
  })
})

describe('parseAdapterStatistics：网卡 JSON 解析', () => {
  it('数组 → 求和', () => {
    expect(parseAdapterStatistics('[{"ReceivedBytes":100,"SentBytes":200},{"ReceivedBytes":1,"SentBytes":2}]')).toEqual({
      rxBytes: 101,
      txBytes: 202
    })
  })

  it('单对象 → 直接取', () => {
    expect(parseAdapterStatistics('{"ReceivedBytes":10,"SentBytes":20}')).toEqual({ rxBytes: 10, txBytes: 20 })
  })

  it('非法 JSON / 无字段 → null', () => {
    expect(parseAdapterStatistics('{ broken')).toBeNull()
    expect(parseAdapterStatistics('{}')).toBeNull()
  })
})
