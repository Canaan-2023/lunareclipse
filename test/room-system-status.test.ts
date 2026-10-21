/**
 * 电脑状态采集（B12）回归测试：磁盘与 GPU 解析。
 *
 * 为什么存在：用户要求采集「CPU/GPU/内存/磁盘状态」。这两项都靠解析 WMI 的 JSON——
 * 解析错一个字段就会报出假容量/假占用（比「没有数据」更危险）。必须有回归网。
 *
 * 覆盖：磁盘解析（数组/单对象/已用百分比/非法项丢弃/空）/
 * GPU 解析（数组/AdapterRAM 为 0 或负 → vramGB 为 null，不臆造）/ 非 Windows 不猜命令。
 */
import { describe, it, expect } from 'vitest'
import { parseDisksJson, parseGpusJson, collectDisks, collectGpus } from '../electron/main/room/system-status'

const GB = 1024 ** 3

describe('parseDisksJson：磁盘解析', () => {
  it('数组 → 盘符/总量/剩余/已用百分比', () => {
    const json = JSON.stringify([
      { DeviceID: 'C:', Size: 500 * GB, FreeSpace: 100 * GB },
      { DeviceID: 'D:', Size: 1000 * GB, FreeSpace: 1000 * GB }
    ])
    const out = parseDisksJson(json)
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({ drive: 'C:', totalGB: 500, freeGB: 100, usedPercent: 80 })
    expect(out[1].usedPercent).toBe(0)
  })

  it('单对象 → 一条', () => {
    expect(parseDisksJson(JSON.stringify({ DeviceID: 'C:', Size: 100 * GB, FreeSpace: 50 * GB }))).toHaveLength(1)
  })

  it('非法项被丢弃（缺盘符 / 容量非法）', () => {
    const json = JSON.stringify([
      { Size: 100 * GB, FreeSpace: 0 },
      { DeviceID: 'X:', Size: 0, FreeSpace: 0 },
      { DeviceID: 'C:', Size: 100 * GB, FreeSpace: 0 }
    ])
    expect(parseDisksJson(json).map((d) => d.drive)).toEqual(['C:'])
  })

  it('非法 JSON / 空 → 空数组', () => {
    expect(parseDisksJson('{ broken')).toEqual([])
    expect(parseDisksJson('[]')).toEqual([])
  })
})

describe('parseGpusJson：GPU 解析', () => {
  it('数组 → 名称与显存', () => {
    const json = JSON.stringify([{ Name: 'NVIDIA GeForce RTX 4090', AdapterRAM: 24 * GB }])
    expect(parseGpusJson(json)).toEqual([{ name: 'NVIDIA GeForce RTX 4090', vramGB: 24 }])
  })

  it('AdapterRAM 为 0 / 负（WMI 32 位回绕）→ vramGB 为 null（不臆造）', () => {
    expect(parseGpusJson(JSON.stringify({ Name: 'GPU A', AdapterRAM: 0 }))[0].vramGB).toBeNull()
    expect(parseGpusJson(JSON.stringify({ Name: 'GPU B', AdapterRAM: -1 }))[0].vramGB).toBeNull()
  })

  it('缺名称 → 丢弃；非法 JSON → 空', () => {
    expect(parseGpusJson(JSON.stringify({ AdapterRAM: 100 }))).toEqual([])
    expect(parseGpusJson('nope')).toEqual([])
  })
})

describe('collectDisks / collectGpus：非 Windows 不猜命令', () => {
  it('非 win32 返回空且不调用 runner', async () => {
    let called = 0
    const run = async (): Promise<string> => {
      called++
      return '[]'
    }
    const [disks, gpus] = await Promise.all([collectDisks(run), collectGpus(run)])
    if (process.platform === 'win32') {
      expect(called).toBe(2)
    } else {
      expect(called).toBe(0)
      expect(disks).toEqual([])
      expect(gpus).toEqual([])
    }
  })

  it('runner 抛错 → 空数组（采集失败不阻断循环）', async () => {
    if (process.platform !== 'win32') return
    const boom = async (): Promise<string> => {
      throw new Error('boom')
    }
    expect(await collectDisks(boom)).toEqual([])
    expect(await collectGpus(boom)).toEqual([])
  })
})
