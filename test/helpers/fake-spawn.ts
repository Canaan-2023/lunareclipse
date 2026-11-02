/**
 * 为什么存在：run_command 的策略/权限用例只需要确认「命令是否进入执行阶段」，
 * 不需要真实 PowerShell 输出；真实进程创建在并行跑全量用例时会因 Windows 进程
 * 抢占而随机超出全局超时。用内存假进程替代 spawn，断言语义不变且完全确定。
 * 作用：构造一个与 run_command 调用点兼容的 ChildProcess 替身，异步吐出可选输出后以指定退出码关闭。
 */
import { EventEmitter } from 'events'
import type { ProcessSpawner } from '../../electron/main/tools/run-command'

export interface FakeProcessResult {
  stdout?: string
  stderr?: string
  exitCode?: number
}

export function createFakeSpawn(result: FakeProcessResult = {}): ProcessSpawner {
  const spawnImpl: ProcessSpawner = () => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter
      stderr: EventEmitter
      pid: number
      kill: () => boolean
    }
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.pid = 4242
    child.kill = () => true
    // 异步关闭：保证调用方先挂好 data/close 监听器，再收到输出与退出码。
    queueMicrotask(() => {
      if (result.stdout) child.stdout.emit('data', Buffer.from(result.stdout, 'utf-8'))
      if (result.stderr) child.stderr.emit('data', Buffer.from(result.stderr, 'utf-8'))
      child.emit('close', result.exitCode ?? 0)
    })
    return child as unknown as ReturnType<ProcessSpawner>
  }
  return spawnImpl
}
