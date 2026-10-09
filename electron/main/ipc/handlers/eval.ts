/**
 * 评测 IPC：把 eval 套件（列套件/跑套件/取上次结果）暴露给渲染进程
 * 的「自评」UI；运行中的套件串行互斥，防止并发跑坏共享状态。
 */
import type { ipcMain as ipcMainType } from 'electron'
import type { EvalHarness } from '../../eval/harness'
import { listSuites, loadSuite } from '../../eval'
import type { SuiteResult, SuiteMeta } from '../../eval'
import { safeHandle } from './safe-handle'

/**
 * 验证层：IPC 处理器

 * 通道设计（延续 hooks-* / mcp-* IPC 模式）：
 * - eval:listSuites：列出可用套件（前端 UI 渲染用）
 * - eval:runSuite：运行指定套件，返回 SuiteResult
 * - eval:getLastResult：获取上次运行结果（前端刷新时恢复）

 * HumanGrader 的 eval:submitHumanGrade 在 HumanGrader 构造时直接注册（不在此处），
 * 因为它需要访问 HumanGrader 内部 pendingRequests Map。
 */
export function registerEvalHandlers(
  ipc: typeof ipcMainType,
  getHarness: (suite?: string) => EvalHarness | null
): void {
  /** 列出可用套件 */
  safeHandle(
    ipc, 'eval:listSuites',
    (): SuiteMeta[] => listSuites(),
    [] as SuiteMeta[]
  )

  /** 运行指定套件 */
  safeHandle(
    ipc, 'eval:runSuite',
    async (_event, ...args: unknown[]): Promise<{ ok: boolean; result?: SuiteResult; error?: string }> => {
      const suite = args[0] as string
      if (running) {
        return { ok: false, error: '已有评测任务运行中，请等待完成' }
      }
      running = true
      let timer: NodeJS.Timeout | null = null
      try {
        const harness = getHarness(suite)
        if (!harness) {
          return { ok: false, error: 'Harness 未初始化' }
        }
        const tasks = loadSuite(suite)
        const timeoutPromise = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('评测套件执行超时')), SUITE_TIMEOUT_MS)
        })
        const result = await Promise.race([harness.runSuite(suite, tasks), timeoutPromise])
        lastResult = result
        return { ok: true, result }
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      } finally {
        if (timer) clearTimeout(timer)
        running = false
      }
    },
    { ok: false, error: '评测运行失败' }
  )

  /** 获取上次运行结果（前端刷新时恢复显示） */
  safeHandle(
    ipc, 'eval:getLastResult',
    (): SuiteResult | null => lastResult,
    null as SuiteResult | null
  )
}

// 模块级缓存：上次运行结果（进程内单例）
let lastResult: SuiteResult | null = null
// 并发保护：防止多个 suite 同时运行
let running = false
// 单次评测超时（5 分钟）
const SUITE_TIMEOUT_MS = 300_000
