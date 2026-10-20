import { describe, it, expect } from 'vitest'
import { mkdtempSync, existsSync, readdirSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomBytes } from 'crypto'
import { BackupStreamSink, BACKUP_STREAM_PREFIX } from '../electron/main/multi-instance/master/backup-stream-sink'
import type { LanStreamBeginMeta } from '../electron/main/multi-instance/lan/lan-stream'

/**
 * 备份包收件器（backup_dl）测试：非 backup: 流整流跳过 / transferId 白名单 /
 * 正常收流落盘 + awaitZipReady 契约 / 终校验失败与 abort 的 reject / ready 幂等。
 * 收端契约：awaitZipReady 要么等到完整落盘的 zip 路径，要么被显式 reject——没有超时分支。
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function meta(name: string, size: number, transferId?: string): LanStreamBeginMeta {
  const m: LanStreamBeginMeta = {
    name,
    size,
    chunkSize: 1024,
    chunkCount: Math.max(1, Math.ceil(size / 1024)),
    totalSha256: ''
  }
  if (transferId !== undefined) m.transferId = transferId
  return m
}

/** 完整收一条流：begin + 分两次 data + end */
function feed(sink: BackupStreamSink, peerUid: number, streamId: number, name: string, payload: Buffer, transferId?: string): void {
  sink.onBegin(peerUid, streamId, meta(name, payload.length, transferId))
  const half = Math.floor(payload.length / 2)
  sink.onData(peerUid, streamId, 0, payload.subarray(0, half))
  sink.onData(peerUid, streamId, half, payload.subarray(half))
  sink.onEnd(peerUid, streamId, { name, size: payload.length })
}

/** backup_dl 根下正式 zip（排除 .part） */
function listZips(root: string): string[] {
  const dir = join(root, 'backup_dl')
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter((f) => !f.endsWith('.part'))
}

describe('backup-stream-sink 备份包收件器', () => {
  it('正常收流：按 transferId 落 backup_dl/{transferId}.zip，awaitZipReady 返回该路径且字节一致', async () => {
    const root = mkdtempSync(join(tmpdir(), 'backup-sink-ok-'))
    const sink = new BackupStreamSink({ root })
    const payload = randomBytes(3000)
    const tid = `backup-7-2026-10-04-123456-1a2b3c4d`
    const ready = sink.awaitZipReady(tid)
    feed(sink, 99, 1, `${BACKUP_STREAM_PREFIX}2026-10-04`, payload, tid)
    await sleep(80)
    const path = await ready
    expect(path).toBe(join(root, 'backup_dl', `${tid}.zip`))
    expect(readFileSync(path).equals(payload)).toBe(true)
    expect(listZips(root)).toEqual([`${tid}.zip`])
    rmSync(root, { recursive: true, force: true })
  })

  it('awaitZipReady 先于 onBegin 注册也能等到（竞态覆盖），且同一 transferId 二次等待命中 ready 缓存', async () => {
    const root = mkdtempSync(join(tmpdir(), 'backup-sink-race-'))
    const sink = new BackupStreamSink({ root })
    const payload = randomBytes(1024)
    const tid = `backup-7-2026-10-04-555-abc`
    // 先注册等待（模拟 HTTP 响应先于 LAN 流到达的极端时序），再灌流
    const ready = sink.awaitZipReady(tid)
    const ready2 = sink.awaitZipReady(tid)
    feed(sink, 99, 1, `${BACKUP_STREAM_PREFIX}2026-10-04`, payload, tid)
    const [p1, p2] = await Promise.all([ready, ready2])
    expect(p1).toBe(p2)
    // 收完后再等一次：ready 缓存直接命中，不挂起
    const p3 = await sink.awaitZipReady(tid)
    expect(p3).toBe(p1)
    rmSync(root, { recursive: true, force: true })
  })

  it('非 backup: 前缀流整流跳过：不落盘、不 resolve 任何等待者', async () => {
    const root = mkdtempSync(join(tmpdir(), 'backup-sink-other-'))
    const sink = new BackupStreamSink({ root })
    const payload = randomBytes(64)
    feed(sink, 99, 1, 'sync:XX-123456:m@1/k', payload, `backup-7-x`)
    feed(sink, 99, 2, 'friend-upload.bin', payload)
    await sleep(80)
    expect(listZips(root)).toEqual([])
    rmSync(root, { recursive: true, force: true })
  })

  it('transferId 缺失或非法（路径穿越素材）：整流拒绝，不落盘', async () => {
    const root = mkdtempSync(join(tmpdir(), 'backup-sink-tid-'))
    const sink = new BackupStreamSink({ root })
    const payload = randomBytes(64)
    // 缺 transferId
    sink.onBegin(99, 1, meta(`${BACKUP_STREAM_PREFIX}2026-10-04`, payload.length))
    sink.onEnd(99, 1, { name: `${BACKUP_STREAM_PREFIX}2026-10-04`, size: payload.length })
    // transferId 含路径穿越素材
    feed(sink, 99, 2, `${BACKUP_STREAM_PREFIX}2026-10-04`, payload, '../../escape')
    await sleep(80)
    expect(listZips(root)).toEqual([])
    expect(existsSync(join(root, 'escape.zip'))).toBe(false)
    rmSync(root, { recursive: true, force: true })
  })

  it('终校验失败（onEnd error）：.part 删除、不产出正式文件、awaitZipReady reject', async () => {
    const root = mkdtempSync(join(tmpdir(), 'backup-sink-hashfail-'))
    const sink = new BackupStreamSink({ root })
    const payload = randomBytes(64)
    const tid = `backup-7-2026-10-04-1-bad`
    const ready = sink.awaitZipReady(tid)
    sink.onBegin(99, 1, meta(`${BACKUP_STREAM_PREFIX}2026-10-04`, payload.length, tid))
    sink.onData(99, 1, 0, payload)
    sink.onEnd(99, 1, { name: `${BACKUP_STREAM_PREFIX}2026-10-04`, size: payload.length }, '整体 sha256 校验失败')
    await expect(ready).rejects.toThrow(/校验失败/)
    await sleep(80)
    expect(listZips(root)).toEqual([])
    expect(existsSync(join(root, 'backup_dl')) ? readdirSync(join(root, 'backup_dl')).filter((f) => f.endsWith('.part')) : []).toEqual([])
    rmSync(root, { recursive: true, force: true })
  })

  it('onAbort：.part 清理、不产出正式文件、awaitZipReady reject', async () => {
    const root = mkdtempSync(join(tmpdir(), 'backup-sink-abort-'))
    const sink = new BackupStreamSink({ root })
    const payload = randomBytes(64)
    const tid = `backup-7-2026-10-04-2-ab`
    const ready = sink.awaitZipReady(tid)
    sink.onBegin(99, 1, meta(`${BACKUP_STREAM_PREFIX}2026-10-04`, payload.length, tid))
    sink.onData(99, 1, 0, payload.subarray(0, 16))
    sink.onAbort(99, 1, '对端重置连接')
    await expect(ready).rejects.toThrow(/中止/)
    await sleep(80)
    expect(listZips(root)).toEqual([])
    rmSync(root, { recursive: true, force: true })
  })
})