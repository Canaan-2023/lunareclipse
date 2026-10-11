/**
 * preload 入口（v2 域拆分架构的组装层）。
 * 为什么存在：Electron 渲染进程运行在无 Node 权限的沙箱中，preload（contextBridge 白名单
 * 桥）是渲染侧访问 ipcRenderer 的主进程能力唯一合法入口；按 IPC 域拆分模块使通道声明与
 * 业务一一对应、避免单一巨型文件，再在此统一组装。
 * 作用：将 domains/ 下各分域 api 组合为扁平对象并 exposeInMainWorld 为 window.lunareclipse，
 * 同时导出 LunareclipseAPI 声明类型。
 */
import { contextBridge } from 'electron'

// =============================================================================
// Preload 入口（v2：按 IPC 域拆分）
// 每个 domain 模块只 import 自身需要的类型与 ipcRenderer；
// 此处用 spread 组合回同一扁平对象，保证 window.lunareclipse 暴露形状
// 与旧版逐字段等价（方法名/签名/通道名全部保留，未做任何改动）。
// 新增 IPC 域方法 → 在 domains/ 下新建或扩展对应模块，无需改动本文件。
// =============================================================================
import { api as coreApi } from './domains/core' // 系统/配置/会话/窗口/LLM
import { api as authApi } from './domains/auth' // 账号 + 主分系统
import { api as socialApi } from './domains/social' // 好友/聊天室/AI 代理/发布板
import { api as monitorApi } from './domains/monitor' // 记忆工作流/DMN/日记/可视化
import { api as shellApi } from './domains/shell' // 文件/工作区/权限/显示在文件夹中
import { api as browserApi } from './domains/browser' // 浏览器面板 + 本地浏览器桥（CDP）
import { api as codeApi } from './domains/code' // 文件工坊代码执行（含流式输出）
import { api as mcpHooksApi } from './domains/mcp-hooks' // MCP 服务 + Hooks 管理
import { api as evalWorkflowApi } from './domains/eval-workflow' // 评测套件 + 工作流引擎（L8）
import { api as skillWorkspaceApi } from './domains/skill-workspace' // SKILL 管理 + 工作区管理
import { api as lilithMessagingApi } from './domains/lilith-messaging' // 莉莉丝桌宠 + 消息接入
import { api as pluginsApi } from './domains/plugins' // 模块系统 + 函数面板
import { api as cronCalendarApi } from './domains/cron-calendar' // 定时任务 + 日历系统
import { api as overlayApi } from './domains/overlay' // 聊天悬浮小窗
import { api as aiApi } from './domains/ai' // AI 管理（多 AI 子系统）
import { api as instanceApi } from './domains/instance' // 多实例多开（P5）
import { api as profileApi } from './domains/profile' // 个人中心（昵称/头像 + USER.md 用户资料文件）

const api = {
  ...coreApi,
  ...authApi,
  ...socialApi,
  ...monitorApi,
  ...shellApi,
  ...browserApi,
  ...codeApi,
  ...mcpHooksApi,
  ...evalWorkflowApi,
  ...skillWorkspaceApi,
  ...lilithMessagingApi,
  ...pluginsApi,
  ...cronCalendarApi,
  ...overlayApi,
  ...aiApi,
  ...instanceApi,
  ...profileApi,
}

contextBridge.exposeInMainWorld('lunareclipse', api)

export type LunareclipseAPI = typeof api