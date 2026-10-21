/**
 * 语义扫描 worker 调度回归（0.53.10）。
 *
 * 锁定：
 * 1. 测试/未构建环境回退同步扫描（worker=false，但结果完整）；
 * 2. 真实 worker 产物存在时在 worker 中执行（主线程不被同步扫描阻塞）；
 * 3. 硬超时会 terminate worker 并返回 timedOut（同步代码唯一可靠的抢占方式）；
 * 4. worker 异常会返回 failed，而不是伪装成「0 问题通过」。
 */
import { describe, it, expect, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runSemanticScan } from '../electron/main/monitor/health-scan-runner'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

function makeSrc(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hc-scan-runner-'))
  dirs.push(dir)
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 1\n')
  return dir
}

describe('runSemanticScan', () => {
  it('未构建（vitest）→ 同步回退，结果完整且 files>0', async () => {
    const root = makeSrc()
    const r = await runSemanticScan({ kind: 'code-review', root, timeoutMs: 5_000 })
    expect(r.worker).toBe(false)
    expect(r.failed).toBe(false)
    expect(r.timedOut).toBe(false)
    expect(r.complete).toBe(true)
    expect(r.files).toBeGreaterThan(0)
  })

  const BUILT_WORKER = join(__dirname, '..', 'out', 'main', 'health-scan-worker.js')
  it.skipIf(!existsSync(BUILT_WORKER))('真实构建产物存在时在 worker 中执行', async () => {
    const root = makeSrc()
    const r = await runSemanticScan({
      kind: 'code-review',
      root,
      timeoutMs: 10_000,
      workerPath: BUILT_WORKER
    })
    expect(r.worker).toBe(true)
    expect(r.failed).toBe(false)
    expect(r.complete).toBe(true)
    expect(r.files).toBeGreaterThan(0)
  })

  it('worker 卡死 → 硬超时 terminate，返回 timedOut（不伪装成通过）', async () => {
    const root = makeSrc()
    const hang = join(root, 'hang-worker.js')
    writeFileSync(hang, 'setTimeout(() => {}, 60000)\n')
    const r = await runSemanticScan({ kind: 'uiux', root, timeoutMs: 50, workerPath: hang })
    // 50ms 超时 + 2s terminate 宽限
    expect(r.timedOut).toBe(true)
    expect(r.complete).toBe(false)
    expect(r.files).toBe(0)
  })

  it('worker 抛错 → failed=true，不返回「0 问题通过」', async () => {
    const root = makeSrc()
    const boom = join(root, 'boom-worker.js')
    writeFileSync(boom, "throw new Error('boom')\n")
    const r = await runSemanticScan({ kind: 'code-review', root, timeoutMs: 5_000, workerPath: boom })
    expect(r.failed).toBe(true)
    expect(r.complete).toBe(false)
  })
})
