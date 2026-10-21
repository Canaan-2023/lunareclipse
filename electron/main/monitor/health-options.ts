/**
 * HealthCheck 构造选项（从 health-check.ts 拆出，0.53.10 体量让位）。
 * 只放类型，不放逻辑；消费方仍从 health-check re-export 取。
 */
import type { ActivationManager } from '../api/activation-manager'
import type { TimerRegistry } from './timer-registry'
import type { ModuleRegistry } from './module-registry'

export interface HealthCheckOptions {
  /** 工作区目录（含 package.json，如 app.getAppPath()） */
  workDir: string
  /** 配置目录（如 {dataDir}/.health_check） */
  configDir: string
  /** 数据目录根（files 检查在打包态扫这里；asar 只读、不能作为扫描/落盘目标） */
  dataRoot?: string
  /** 注入外部事件唤醒前端 AI（可选：未提供则只写日志） */
  activationManager?: ActivationManager | null
  timerRegistry?: TimerRegistry | null
  /** 模块注册表（可选：检查项失败/恢复时同步标红模块监控表） */
  moduleRegistry?: ModuleRegistry | null
  /** 静态语义扫描的硬超时（毫秒，测试/嵌入可覆盖；缺省由 MAX_SCAN_FILES 推导为 25s） */
  staticScanBudgetMs?: number
  /** 打包态覆盖（测试/嵌入用；缺省按 electron app.isPackaged + workDir 以 app.asar 结尾判定） */
  packaged?: boolean
  /**
   * 运行时事件（uncaughtException/unhandledRejection/render-process-gone）的稳定恢复窗口（毫秒）。
   * 缺省 = max(2×检查间隔, 30min)：这段时间内没有再次崩溃，且至少一轮健康检查通过，
   * 才把模块表恢复为绿色。仅测试/嵌入需要覆盖。
   */
  runtimeEventStableMs?: number
}
