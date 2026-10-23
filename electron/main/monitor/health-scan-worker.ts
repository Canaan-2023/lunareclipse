/**
 * 健康检查语义扫描 worker 入口（0.53.10）。
 *
 * 为什么存在：`scanCodeReviewIssues` / `scanUiUxIssues` 是同步 `readdir/readFile` 实现，
 * 在 Electron 主线程上跑会冻结 IPC/WS/渲染。放到 worker_threads 后主线程保持响应，
 * 且主线程可以 `worker.terminate()` 实施**抢占式硬超时**（同步代码无法被 JS 定时器中断）。
 *
 * 输入：`{ kind: 'code-review' | 'uiux', root, deadlineMs }`
 * 输出：`SemanticScanResult`（与同步扫描完全同构）。
 */
import { parentPort, workerData } from 'worker_threads'
import {
  scanCodeReviewIssues,
  scanUiUxIssues,
  type SemanticScanResult
} from './health-semantic-scan'

interface ScanWorkerData {
  kind: 'code-review' | 'uiux'
  root: string
  deadlineMs: number
}

const data = workerData as ScanWorkerData
const result: SemanticScanResult =
  data.kind === 'code-review'
    ? scanCodeReviewIssues(data.root, { deadlineMs: data.deadlineMs })
    : scanUiUxIssues(data.root, { deadlineMs: data.deadlineMs })

parentPort?.postMessage(result)
