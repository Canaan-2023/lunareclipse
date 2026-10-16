// ============================================================
// 模块注册表：月蚀系统全架构模块清单 + 运行时状态
// ------------------------------------------------------------
// 背景（设计动机）：
// 让 AI「全盘掌握自己」——所有属于月蚀的架构模块纳入一张表格，
// 表格记录每个模块会做什么、关键入口，固定在监控面板里展示；
// 系统报错监控到异常就在表格对应行反馈（标红 + 错误摘要），
// 有报错就注入事件提醒 AI 读取，没有就不提醒；AI 也可主动读取盘点自己。
//
// 结构：
// - MODULE_DEFS：静态模块清单（盘点产物，随架构演进维护）
// - ModuleRegistry：运行时状态（ok/error/null + 最近错误 + 更新时间）
// - 状态来源：HealthCheck 检查项失败 / 运行时崩溃事件 → reportIssue 标红
// → 恢复 → markRecovered 变绿
// ============================================================

import { mkdirSync, writeFileSync } from 'fs'
import { dirname } from 'path'

/** 模块大类 */
export type ModuleCategory =
  | '核心'
  | '工具'
  | '记忆系统'
  | '监控'
  | '渲染'
  | '基础设施'

/** 模块静态定义（清单行） */
export interface ModuleDef {
  id: string
  name: string
  category: ModuleCategory
  /** 功能一句话（会做什么） */
  description: string
  /** 关键文件（1-3 个，相对 app 目录） */
  keyFiles: string[]
}

/** 模块运行时状态（动态反馈） */
export interface ModuleStatusEntry {
  id: string
  /** true=健康 / false=有异常 / null=未知（未出过错也未检查过） */
  ok: boolean | null
  /** 最近错误摘要（ok 或 null 时为空串） */
  error: string
  /** 最近一次状态变更时间戳（从未变更 null） */
  updatedAt: number | null
}

/**
 * 模块清单（盘点产物）。
 * 覆盖主进程 / 渲染进程 / 工具 / 记忆系统 / 监控 / 基础设施全部架构模块。
 */
export const MODULE_DEFS: ModuleDef[] = [
  // ===== 核心 =====
  { id: 'main', name: '主进程入口', category: '核心', description: '应用生命周期、模块组装、userData 重定向、崩溃监听注册', keyFiles: ['electron/main/index.ts'] },
  { id: 'window', name: '窗口管理', category: '核心', description: 'BrowserWindow 创建/管理、加载渲染进程', keyFiles: ['electron/main/window.ts'] },
  { id: 'llm', name: 'LLM 客户端', category: '核心', description: '模型调用、流式输出、工具调用（含断因兜底）', keyFiles: ['electron/main/api/llm.ts'] },
  { id: 'activation', name: '激活管理器', category: '核心', description: '事件队列、定时器、自主唤醒（外部/倒计时/DMN/中断恢复）', keyFiles: ['electron/main/api/activation-manager.ts'] },
  { id: 'session', name: '会话存储', category: '核心', description: '会话持久化、消息历史管理', keyFiles: ['electron/main/api/session-store.ts'] },
  { id: 'config', name: '配置存储', category: '核心', description: '应用配置读写（用户设置持久化）', keyFiles: ['electron/main/api/config-store.ts'] },

  // ===== 工具 =====
  { id: 'tools', name: '工具注册表', category: '工具', description: '40+ AI 工具：文件读写/搜索/命令/剪贴板/系统设置等', keyFiles: ['electron/main/tools/index.ts'] },
  { id: 'browser', name: '浏览器工具', category: '工具', description: 'Playwright 浏览器管理（withPage 互斥锁）+ 浏览器面板', keyFiles: ['electron/main/tools/browser-manager.ts', 'electron/main/tools/browser-view-manager.ts'] },
  { id: 'web-search', name: '网络搜索', category: '工具', description: '普通搜索/深度搜索（Playwright 降级）/读网页', keyFiles: ['electron/main/api/web-search.ts'] },
  { id: 'mcp', name: 'MCP 客户端', category: '工具', description: '外部 MCP server 接入、工具元数据同步', keyFiles: ['electron/main/mcp/client-manager.ts'] },
  { id: 'hooks', name: 'Hook 系统', category: '工具', description: '工具调用前后钩子（权限拦截/审计）', keyFiles: ['electron/main/hooks/hook-manager.ts'] },
  { id: 'sub-agent', name: '子 Agent', category: '工具', description: '隔离执行子任务（独立上下文，并发≤10）', keyFiles: ['electron/main/sub-agent/manager.ts'] },
  { id: 'workflow', name: '工作流引擎', category: '工具', description: '工作流编排/运行/持久化（chatflow + workflow 模式）', keyFiles: ['electron/main/workflow/engine.ts'] },
  { id: 'skills', name: 'Skills 系统', category: '工具', description: '知识包按需加载（SOP 渐进披露）', keyFiles: ['electron/main/skills/loader.ts'] },
  { id: 'prompts', name: '提示词系统', category: '工具', description: '前端/DMN/共享提示词加载', keyFiles: ['electron/main/prompts/loader.ts'] },

  // ===== 记忆系统 =====
  { id: 'memory', name: '记忆模型', category: '记忆系统', description: '记忆/NNG/缓存数据模型、数据目录初始化', keyFiles: ['electron/main/models/memory.ts', 'electron/main/models/nng.ts'] },
  { id: 'dmn', name: 'DMN 后端', category: '记忆系统', description: '记忆处理流水线（筛选/归档/矛盾/张力/质检）', keyFiles: ['electron/main/monitor/dmn-runner.ts'] },
  { id: 'memory-sync', name: '记忆同步', category: '记忆系统', description: '记忆/NNG/缓存文件同步、孤儿检测', keyFiles: ['electron/main/monitor/memory-sync.ts', 'electron/main/monitor/nng-sync.ts'] },
  { id: 'raw-memory', name: '原始记忆', category: '记忆系统', description: 'RAW 对话落盘、批次读取', keyFiles: ['electron/main/services/raw-memory-writer.ts'] },

  // ===== 监控 =====
  { id: 'health-check', name: '健康检查', category: '监控', description: '定时自检 typecheck/test/files + 运行时崩溃监控 + AlertGate 防死循环', keyFiles: ['electron/main/monitor/health-check.ts'] },
  { id: 'supervisor', name: '监督器', category: '监控', description: 'DMN 上下文管理、子任务调度', keyFiles: ['electron/main/monitor/supervisor.ts'] },
  { id: 'watchdog', name: '看门狗', category: '监控', description: '冻结检测、异常恢复', keyFiles: ['electron/main/monitor/watchdog.ts'] },
  { id: 'timer', name: '定时器注册表', category: '监控', description: '全局定时器统一管理（setTimeout/setInterval）', keyFiles: ['electron/main/monitor/timer-registry.ts'] },
  { id: 'error-log', name: '错误日志', category: '监控', description: '崩溃日志、错误记录（main-errors.log）', keyFiles: ['electron/main/services/crash-logger.ts', 'electron/main/monitor/error-log.ts'] },

  // ===== 渲染 =====
  { id: 'render-ui', name: '渲染界面', category: '渲染', description: 'React UI：聊天/输入/角色/设置/监控面板等全部组件', keyFiles: ['src/App.tsx', 'src/components/'] },
  { id: 'render-store', name: '前端状态', category: '渲染', description: 'Zustand stores：appStore/会话/可视化状态', keyFiles: ['src/stores/'] },
  { id: 'preload', name: 'Preload 桥', category: '渲染', description: 'IPC 安全暴露（window.api），主进程 <-> 渲染进程通信面', keyFiles: ['electron/preload/'] },

  // ===== 基础设施 =====
  { id: 'ipc', name: 'IPC 通道', category: '基础设施', description: '14 个 handler 组：会话/配置/DMN/可视化/工作流/窗口等', keyFiles: ['electron/main/ipc/handlers/'] },
  { id: 'eval', name: '评估框架', category: '基础设施', description: 'Eval harness + graders + suites（AI 能力评估）', keyFiles: ['electron/main/eval/harness.ts'] },
  { id: 'code-sandbox', name: '代码沙箱', category: '基础设施', description: 'JS/Python 隔离沙箱执行', keyFiles: ['electron/main/tools/code-sandbox.ts'] },
  { id: 'workspace', name: '工作区服务', category: '基础设施', description: '工作区配置/状态/预览文件', keyFiles: ['electron/main/services/workspace-config.ts', 'electron/main/services/workspace-state.ts'] }
]

/** 模块 ID 集合（校验用） */
const MODULE_IDS = new Set(MODULE_DEFS.map((m) => m.id))

/**
 * 模块注册表：持有运行时状态，供 HealthCheck 等报错来源标记标红/恢复。
 * 前端通过 viz:getAll 附带 getSnapshot() 读取。
 * 可选持久化：构造时传 statusFile，每次状态变更同步写 JSON，
 * 让 AI 可通过 Read 文件查看最新模块监控状态（清单 + 标红/恢复）。
 */
export class ModuleRegistry {
  private statuses = new Map<string, ModuleStatusEntry>()
  /** 可选：状态持久化文件路径（AI 可读） */
  private statusFile: string | null

  constructor(opts?: { statusFile?: string }) {
    this.statusFile = opts?.statusFile ?? null
  }

  /**
   * 上报模块异常（标红）。模块 id 必须在 MODULE_DEFS 中。
   * 同 id 重复上报覆盖 error（保留最近一次）。
   */
  reportIssue(moduleId: string, error: string): void {
    if (!MODULE_IDS.has(moduleId)) {
      console.warn(`[module-registry] 未知模块 id: ${moduleId}，忽略`)
      return
    }
    this.statuses.set(moduleId, { id: moduleId, ok: false, error, updatedAt: Date.now() })
    this.persist()
  }

  /** 标记模块恢复（变绿/清除异常）。仅当该模块曾有异常时才写状态。 */
  markRecovered(moduleId: string): void {
    if (!MODULE_IDS.has(moduleId)) return
    if (this.statuses.has(moduleId)) {
      this.statuses.set(moduleId, { id: moduleId, ok: true, error: '', updatedAt: Date.now() })
      this.persist()
    }
  }

  /** 持久化当前快照到 statusFile（失败仅告警，不影响主流程）。 */
  private persist(): void {
    if (!this.statusFile) return
    try {
      mkdirSync(dirname(this.statusFile), { recursive: true })
      writeFileSync(this.statusFile, JSON.stringify(this.getSnapshot(), null, 2), 'utf-8')
    } catch (err) {
      console.warn(`[module-registry] 状态持久化失败: ${err}`)
    }
  }

  /** 当前全部模块状态快照（清单 + 运行时状态合并，供面板展示） */
  getSnapshot(): Array<ModuleDef & ModuleStatusEntry> {
    return MODULE_DEFS.map((def) => ({
      ...def,
      ...(this.statuses.get(def.id) ?? { ok: null, error: '', updatedAt: null })
    }))
  }

  /** 当前有异常（ok=false）的模块 id 列表 */
  failingModuleIds(): string[] {
    return Array.from(this.statuses.entries())
      .filter(([, s]) => s.ok === false)
      .map(([id]) => id)
  }
}
