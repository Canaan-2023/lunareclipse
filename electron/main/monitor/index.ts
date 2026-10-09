/**
 * @category 监控
 * @summary 监控体系：健康检查/看门狗/模块注册表/错误日志
 * 为什么存在：监控体系各组件相互依赖且由上层统一装配，需要集中出口导出实例与类型，避免调用方分散构造。
 */
export { StateStore } from './state-store'
export type { FreezeRecord } from './state-store'
export { DmnMutex } from './mutex'
export { FreezeManagerImpl } from './freeze-manager'
export type { FreezeManagerCallbacks } from './freeze-manager'
export { DmnRunner } from './dmn-runner'
export type { DmnRunOptions, DmnRunResult } from './dmn-runner'
export { Watchdog } from './watchdog'
export type { WatchdogCallbacks } from './watchdog'
export { Supervisor } from './supervisor'
export type { SupervisorCallbacks, DmnStatus } from './supervisor'
export {
  loadMonitorConfig,
  saveMonitorConfig,
  DEFAULT_MONITOR_CONFIG
} from './monitor-config'
export type { MonitorConfig } from './monitor-config'
export { PathSyncMonitor } from './path-sync-monitor'
export type { PathSyncConfig } from './path-sync-monitor'
export { DEFAULT_PATH_SYNC_CONFIG } from './path-sync-monitor'
export { ErrorLog } from './error-log'
export type { ErrorLogEntry, ErrorLogTask, ErrorLogConfig } from './error-log'
export { OrphanCheck } from './orphan-check'
export { MemorySync } from './memory-sync'
export { NngSync } from './nng-sync'
export { CacheSync } from './cache-sync'
export { IndexSync } from './index-sync'
export { Handler } from './handler'
export { StartupCheck } from './startup-check'
export { TimerRegistry, getGlobalTimerRegistry } from './timer-registry'
export type { TimerHandle } from './timer-registry'
export { SubAgentLauncher } from './sub-agent-launcher'
export { HealthCheck, AlertGate, hashFingerprint, truncate, DEFAULT_HEALTH_CHECK_CONFIG } from './health-check'
export type {
  HealthCheckConfig,
  HealthCheckKey,
  HealthCheckResult,
  HealthReport,
  AlertDecision,
  HealthCheckOptions
} from './health-check'
