import { describe, it, expect } from 'vitest'
import {
  isHeavyCommand
} from '../electron/main/tools/run-command'
import {
  runHeavyExclusive,
  getHeavySchedulerStatus
} from '../electron/main/tools/heavy-mutex'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('isHeavyCommand 重活识别', () => {
  it('识别 CPU 密集命令为重型', () => {
    expect(isHeavyCommand('tsc --noEmit -p tsconfig.node.json --composite false')).toBe(true)
    expect(isHeavyCommand('npm run typecheck')).toBe(true)
    expect(isHeavyCommand('npm run typecheck:node')).toBe(true)
    expect(isHeavyCommand('npm test')).toBe(true)
    expect(isHeavyCommand('vitest run')).toBe(true)
    expect(isHeavyCommand('electron-vite build')).toBe(true)
    expect(isHeavyCommand('node scripts/run-eval.mjs --suite=abc')).toBe(true)
  })

  it('识别 node/python 脚本执行为重型（AI 批量脚本会吃 CPU）', () => {
    expect(isHeavyCommand('node scripts/clean-fields.js')).toBe(true)
    expect(isHeavyCommand('node ./tmp/touch-memory.mjs')).toBe(true)
    expect(isHeavyCommand('node -e "for(let i=0;i<1e9;i++){}"')).toBe(true)
    expect(isHeavyCommand('node -c "const x=1"')).toBe(true)
    expect(isHeavyCommand('python scripts/batch.py')).toBe(true)
    expect(isHeavyCommand('python3 -c "import time; time.sleep(10)"')).toBe(true)
    expect(isHeavyCommand('py main.py')).toBe(true)
  })

  it('轻量命令不识别为重型', () => {
    expect(isHeavyCommand('echo hello')).toBe(false)
    expect(isHeavyCommand('dir')).toBe(false)
    expect(isHeavyCommand('Get-Content file.txt')).toBe(false)
    expect(isHeavyCommand('Read')).toBe(false)
    // 版本探测是轻量命令，不排队
    expect(isHeavyCommand('node --version')).toBe(false)
    expect(isHeavyCommand('node -v')).toBe(false)
    expect(isHeavyCommand('python --version')).toBe(false)
    expect(isHeavyCommand('py --help')).toBe(false)
  })
})

describe('runHeavyExclusive 互斥队列', () => {
  it('并发重型任务串行执行，任意时刻最多一个运行', async () => {
    let concurrent = 0
    let maxConcurrent = 0
    const task = async () => {
      concurrent++
      maxConcurrent = Math.max(maxConcurrent, concurrent)
      await sleep(30)
      concurrent--
    }
    await Promise.all([runHeavyExclusive(task), runHeavyExclusive(task), runHeavyExclusive(task)])
    expect(maxConcurrent).toBe(1) // 互斥：绝不并发
  })

  it('调度状态：排队数/累计执行数正确', async () => {
    const task = async () => {
      await sleep(20)
    }
    const before = getHeavySchedulerStatus()
    const p1 = runHeavyExclusive(task)
    const p2 = runHeavyExclusive(task) // 排在 p1 后面
    await sleep(5) // 等微任务链推进：p1 开始执行、p2 进入队列
    const mid = getHeavySchedulerStatus()
    expect(mid.running).toBe(true)
    expect(mid.queued).toBeGreaterThanOrEqual(1)
    await Promise.all([p1, p2])
    const after = getHeavySchedulerStatus()
    expect(after.running).toBe(false)
    expect(after.queued).toBe(0)
    expect(after.totalExecuted).toBe(before.totalExecuted + 2)
  })

  it('任务抛错不破坏队列（后续任务仍能执行）', async () => {
    const before = getHeavySchedulerStatus()
    await expect(
      runHeavyExclusive(async () => {
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')
    await runHeavyExclusive(async () => {
      await sleep(10)
    })
    const after = getHeavySchedulerStatus()
    expect(after.totalExecuted).toBe(before.totalExecuted + 1)
    expect(after.running).toBe(false)
  })
})
