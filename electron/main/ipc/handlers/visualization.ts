/**
 * 可视化 IPC：前端可视化面板的监控状态、错误日志、记忆/NNG/工作流
 * 数据读取通道，按当前登录用户 + 指定 AI 编号取作用域数据，纯读取不落盘。
 */
import type { ipcMain as ipcMainType } from 'electron'
import type { BaseDataPaths, DataPaths } from '../../models/paths'
import { resolveScopePaths } from '../../models/paths'
import type { PathSyncMonitor } from '../../monitor/path-sync-monitor'
import type { HealthCheck } from '../../monitor/health-check'
import type { ModuleRegistry } from '../../monitor/module-registry'
import { DEFAULT_AI_ID } from '@shared/types'
import type { HealthCheckStatus } from '@shared/types'
import {
  readAllVisualizationData,
  listMemories,
  readNngTree,
  readMemoryContent,
  readNngContent,
  readWorkflowInstanceSummaries,
  readLatestRawMemory,
  getRawMemoryList,
  getMemoryDirectoryTree,
  getDirectoryChildren
} from '../../api/visualization-data'
import { safeHandle } from './safe-handle'
import { validateWithinDir } from '../../tools/security-engine/path-security'

export function registerVisualizationHandlers(
  ipc: typeof ipcMainType,
  getDataPaths: () => BaseDataPaths | null,
  getPathSyncMonitor: () => PathSyncMonitor | null,
  getHealthCheck: () => HealthCheck | null,
  getModuleRegistry: () => ModuleRegistry | null,
  getActivationManager: () => import('../../api/activation-manager').ActivationManager | null,
  getUserStore?: () => import('../../models/user-store').UserStore | null
): void {
  /** 当前作用域 paths（分层：可视化按 当前登录用户 + 指定 AI 编号 取数） */
  const scopedPaths = (aiId = DEFAULT_AI_ID): DataPaths | null => {
    const base = getDataPaths()
    if (!base) return null
    const user = getUserStore?.()?.getCurrentUser()
    return user ? resolveScopePaths(base, { uid: user.UID, aiId }) : (base as DataPaths)
  }

  safeHandle(
    ipc, 'viz:getAll',
    () => {
      const dataPaths = scopedPaths()
      if (!dataPaths) return null
      const errorLog = getPathSyncMonitor()?.getErrorLog()
      // 轻量版：去掉记忆类重数据（memories/nngTree/injections/rawMemoryList/directoryTree
      // 全是文件系统全量遍历，5s 轮询反复扫会拖慢监控面板）——记忆 tab 走 viz:memoryTab 按需加载
      const base = readAllVisualizationData(dataPaths, errorLog ? errorLog.list() : [])
      const { memories: _memories, nngTree: _nngTree, ...light } = base
      void _memories
      void _nngTree
      return {
        ...light,
        // 工作流引擎实例进度（记忆工作流迁移后真实进度）
        workflowInstances: readWorkflowInstanceSummaries(dataPaths),
        // 最新一条 raw_memory 摘要（监控面板 RAW 接口）
        latestRawMemory: readLatestRawMemory(dataPaths),
        // 健康检查模块状态（内存态快照，未初始化/打包环境为 null）
        healthCheck: getHealthCheck()?.getStatusSnapshot() ?? null,
        // 模块监控表：全架构模块清单 + 运行时状态（报错标红，可主动盘点）
        modules: getModuleRegistry()?.getSnapshot() ?? null,
        // AI 活跃倒计时（[TIMER:...] 设定，侧栏「定时任务」面板展示）
        timers: getActivationManager()?.getActiveTimers() ?? []
      }
    },
    null
  )

  // 记忆 tab 全量数据（从 viz:getAll 拆出，按需加载——文件系统遍历重，只在记忆 tab 激活时拉）
  // aiId 参数（多 AI）：前端切换 月蚀(1)/莉莉丝(2) 时传，各看各的记忆体系
  safeHandle(
    ipc, 'viz:memoryTab',
    (_event, aiId: unknown) => {
      const id = typeof aiId === 'number' && aiId >= 1 ? aiId : 1
      const dataPaths = scopedPaths(id)
      if (!dataPaths) return null
      return {
        memories: listMemories(dataPaths),
        nngTree: readNngTree(dataPaths),
        rawMemoryList: getRawMemoryList(dataPaths),
        directoryTree: getMemoryDirectoryTree(dataPaths)
      }
    },
    null
  )

  // 目录树懒加载：某目录的直接子节点（只扫这一层，不递归）
  // 路径校验：限制在当前作用域 dataPaths.root 内
  safeHandle(
    ipc, 'viz:directoryChildren',
    (_event, absPath: unknown) => {
      if (typeof absPath !== 'string' || !absPath) return []
      const dataPaths = scopedPaths()
      if (!dataPaths) return []
      const err = validateWithinDir(absPath, dataPaths.root)
      if (err) return []
      return getDirectoryChildren(absPath)
    },
    []
  )

  // 手动触发一轮健康检查（监控面板「立即检查」按钮），返回最新快照
  safeHandle<HealthCheckStatus | null>(
    ipc, 'viz:healthCheckRun',
    async () => {
      const hc = getHealthCheck()
      if (!hc) return null
      await hc.runNow()
      return hc.getStatusSnapshot()
    },
    null
  )

  // 一键引用：用户在模块监控面板点击「发送给 AI」，将模块数据推送到对话上下文
  safeHandle<boolean>(
    ipc, 'viz:referenceModule',
    (_event, moduleId: unknown) => {
      const am = getActivationManager()
      const reg = getModuleRegistry()
      if (!am || !reg) return false
      if (typeof moduleId !== 'string' || !moduleId) return false
      const snapshot = reg.getSnapshot().find((m) => m.id === moduleId)
      if (!snapshot) return false
      const lines = [
        `模块：${snapshot.name}（${snapshot.category}）`,
        `ID：${snapshot.id}`,
        `功能：${snapshot.description}`,
        `关键文件：${snapshot.keyFiles.join(', ')}`,
        `运行时状态：${snapshot.ok === false ? '异常' : snapshot.ok === true ? '健康' : '未知'}`,
        snapshot.error ? `最近错误：${snapshot.error}` : ''
      ].filter(Boolean)
      am.pushExternalEvent(`用户从监控面板引用了模块「${snapshot.name}」：\n${lines.join('\n')}\n\n请查看该模块状态，如有异常请排查修复。`, true)
      return true
    },
    false
  )

  // 取消 AI 倒计时（监控面板「定时器」tab 取消按钮），返回取消后的活跃列表
  safeHandle<Array<{ id: string; task: string; fireAt: number; remainingMs: number }>>(
    ipc, 'viz:timerCancel',
    (_event, ...args) => {
      const am = getActivationManager()
      if (!am) return []
      const id = args[0]
      if (typeof id === 'string') am.cancelTimer(id)
      return am.getActiveTimers()
    },
    []
  )

  safeHandle(
    ipc, 'viz:memories',
    () => {
      const dataPaths = scopedPaths()
      if (!dataPaths) return []
      return listMemories(dataPaths)
    },
    []
  )

safeHandle(
    ipc, 'viz:nngTree',
    () => {
      const dataPaths = scopedPaths()
      if (!dataPaths) return []
      return readNngTree(dataPaths)
    },
    []
  )

  // 文档 2.1/2.2：记忆/NNG 完整内容读取（路径校验：限制在 dataPaths.root 内）
  safeHandle(
    ipc, 'viz:memoryContent',
    (_event, path: unknown) => {
      const p = path as string
      if (!p) return null
      const dataPaths = scopedPaths()
      if (!dataPaths) return null
      const err = validateWithinDir(p, dataPaths.root)
      if (err) return null
      return readMemoryContent(p)
    },
    null
  )

  safeHandle(
    ipc, 'viz:nngContent',
    (_event, path: unknown) => {
      const p = path as string
      if (!p) return null
      const dataPaths = scopedPaths()
      if (!dataPaths) return null
      const err = validateWithinDir(p, dataPaths.root)
      if (err) return null
      return readNngContent(p)
    },
    null
  )

}
