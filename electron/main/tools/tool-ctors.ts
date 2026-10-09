/**
 * @category 工具
 * @summary 内置工具登记表：全部内置工具类 import + ALL_TOOL_CTORS 构造器表 + 登记/工厂
 * @note 由 index.ts 拆分而来：只搬位置，不改变任何行为与导出
 * @note 为什么存在：工具池需要一张"全部内置工具"的登记表（构造器 + 元信息），
 * 注册、工厂、兼容别名都从这张表出发，避免散落 import 导致漏登。
 */
import type { AnyTool, ToolContext, ToolResult } from './base-tool'
import { ReadTool } from './read'
import { WriteTool } from './write'
import { EditTool } from './edit'
import { GlobTool } from './glob'
import { GrepTool } from './grep'
import { LSTool } from './ls'
import { MkdirTool } from './mkdir'
import { MoveFileTool } from './move-file'
import { CopyFileTool } from './copy-file'
import { DeleteFileTool } from './delete-file'
import { AgentTool } from './agent'
import { TodoWriteTool } from './todo-write'
import { BatchTool } from './batch-tools'
import { NngGraphTool } from './nng-graph'
import { CacheGraphTool } from './cache-graph'
import { MemoryTool } from './memory'
import { CreateMemoryTool } from './create-memory'
import { CreateNngTool } from './create-nng'
import { RenameRawMemoryTool } from './rename-raw-memory'
import { DmnAskUserTool } from './dmn-ask-user'
import { ReadMdTool } from './read-md'
import { UpdateAbyssMdTool, UpdateUserPreferenceTool } from './abyss-md'
import { SearchUsersTool, GetUserProfileTool } from './account-lookup'
import { UpdateAiNameTool } from './update-ai-name'
import { CreateAiTool } from './create-ai'
import { WebSearchTool } from './web-search-tool'
import { ImageGenTool } from './image-gen'
import { VideoGenTool } from './video-gen'
import { AudioGenTool } from './audio-gen'
import { CreateDocumentTool } from './create-document'
import { UiSnapshotTool } from './ui-snapshot'
import { RunCommandTool } from './run-command'
import { LaunchAppTool } from './launch-app'
import { SystemSettingTool } from './system-setting'
import { ClipboardTool } from './clipboard'
import { AppRestartTool } from './app-restart'
import { CodeRunTool } from './code-sandbox'
import { UseSkillTool } from './use-skill'
import { ContextUsageTool } from './context-usage'
import {
  TeamCreateTool,
  TeamLaunchTool,
  TeamListTool,
  TeamMessageTool,
  TeamInboxTool,
  TeamTaskTool,
  TeamLockTool,
  TeamMemoryTool,
  TeamMergeTool
} from './team-tools'
import { SessionSearchTool } from './session-search'
import { SessionSelectTool } from './session-select'
import { DeviceScanTool, DeviceRegisterTool, DeviceCallTool } from './device-tools'
import { ToolWatchTool, ToolStopTool } from './tool-run-manage'
import { CuratorTool } from './curator'
import { SkillManageTool } from './skill-manage'
import { ConfigPatchTool } from './config-patch'
import { KernelInspectTool } from './kernel-introspect'
import { ModuleInspectTool } from './module-inspect'
import { PluginManageTool } from './plugin-manage'
import { CronManageTool } from './cron-manage'
import { FriendManageTool } from './friend-manage'
import { ChatRoomManageTool } from './chat-room-manage'
import { PublishBoardManageTool } from './publish-board-manage'
import { HookListTool } from './hook-list'
import { WebExtractTool } from './web-extract'
import {
  WorkflowDefineTool,
  WorkflowRunTool,
  WorkflowModifyTool,
  WorkflowSaveTool,
  WorkflowListTool,
  WorkflowEditTool,
  WorkflowIoTool
} from './workflow-define'
import { ThinkingProtocolTool } from './thinking-tool'
import { TOOL_MAP } from '@shared/tools/registry'
import type { BuiltinNonLilithToolId } from '@shared/tools/registry'
import { kernelRegistry } from '../kernel'

export type {
  Tool,
  ToolResult,
  ToolContext,
  ToolParameter,
  AnyTool,
  DmnSupervisor,
  FreezeManager
} from './base-tool'

export {
  ReadTool,
  ThinkingProtocolTool,
  WriteTool,
  EditTool,
  GlobTool,
  GrepTool,
  LSTool,
  MkdirTool,
  MoveFileTool,
  CopyFileTool,
  DeleteFileTool,
  AgentTool,
  TodoWriteTool,
  BatchTool,
  NngGraphTool,
  CacheGraphTool,
  CreateMemoryTool,
  CreateNngTool,
  RenameRawMemoryTool,
  DmnAskUserTool,
  ReadMdTool,
  UpdateAbyssMdTool,
  UpdateUserPreferenceTool,
  SearchUsersTool,
  GetUserProfileTool,
  CodeRunTool,
  UseSkillTool,
  ContextUsageTool,
  SessionSearchTool,
  SessionSelectTool,
  SkillManageTool,
  WorkflowDefineTool,
  WorkflowRunTool,
  WorkflowModifyTool,
  WorkflowSaveTool,
  WorkflowListTool,
  WorkflowEditTool,
  WorkflowIoTool
}

type ToolCtor = new () => {
  name: string
  description: string
  parameters: AnyTool['parameters']
  // execute 参数声明为 unknown：各工具类 execute 签名是具体参数类型（如 ReadParams），
  // 方法参数 bivariance 允许宽参数类型直接赋给窄签名，从而免去逐工具 as unknown as 双重断言。
  // toAnyTool 负责把 unknown 参数收敛回 Record<string, unknown> 产 AnyTool。
  execute(params: unknown, ctx?: ToolContext): Promise<ToolResult> | ToolResult
}

export function toAnyTool(Ctor: ToolCtor): AnyTool {
  const t = new Ctor()
  return {
    name: t.name,
    description: t.description,
    parameters: t.parameters,
    execute: (params, ctx) => t.execute(params, ctx)
  }
}

/**
 * 内置工具登记表（主进程侧唯一登记点）：id 为 TOOL_REGISTRY 中元数据的 id，ctor 为实现构造器。

 * 编译期一致性（C3）：satisfies 要求 id 命中 BuiltinNonLilithToolId（漏加 registry 元数据即报错），
 * 反向覆盖断言要求 BuiltinNonLilithToolId 无遗漏（registry 有元数据但此处漏登记即报错）——
 * 新增/删除内置工具漏改任一侧都会在 typecheck 阶段报错，而不是运行时静默失效。
 * 统一工具池：所有工具对所有 AI 可注入，由 policy 配置决定实际启用
 * （不再按"前端专属/DMN专属"硬编码分类，工具内部通过 ctx 检查来处理上下文依赖）。
 */
export const ALL_TOOL_CTORS = [
  // 思考协议（1 个）：显式思考出口——思考上屏 + 落盘 thinking-log
  { id: 'thinking_protocol', ctor: ThinkingProtocolTool },
  // 基础文件（12 个）
  { id: 'Read', ctor: ReadTool },
  { id: 'read_md', ctor: ReadMdTool },
  { id: 'Write', ctor: WriteTool },
  { id: 'Edit', ctor: EditTool },
  { id: 'Glob', ctor: GlobTool },
  { id: 'Grep', ctor: GrepTool },
  { id: 'LS', ctor: LSTool },
  { id: 'Mkdir', ctor: MkdirTool },
  { id: 'MoveFile', ctor: MoveFileTool },
  { id: 'CopyFile', ctor: CopyFileTool },
  { id: 'DeleteFile', ctor: DeleteFileTool },
  { id: 'Agent', ctor: AgentTool },
  { id: 'TodoWrite', ctor: TodoWriteTool },
  // 批量执行（1 个）：一次调用按顺序执行多个子工具、合并返回——减少多轮只读探查的调用往返
  { id: 'batch_tools', ctor: BatchTool },
  // 图工具（2 个）
  { id: 'nng_graph', ctor: NngGraphTool },
  { id: 'cache_graph', ctor: CacheGraphTool },
  // 记忆系统统一入口（1 个）
  { id: 'memory', ctor: MemoryTool },
  // 自我塑造（4 个）：自我认知 + 用户偏好 + 改名 + 配置覆盖层
  { id: 'update_abyss_md', ctor: UpdateAbyssMdTool },
  { id: 'update_user_preference', ctor: UpdateUserPreferenceTool },
  { id: 'update_ai_name', ctor: UpdateAiNameTool },
  { id: 'config_patch', ctor: ConfigPatchTool },
  // 账号检索（2 个）：AI 侧账号管理——按姓名查 UID、按 UID 读 USER.md 资料
  { id: 'search_users', ctor: SearchUsersTool },
  { id: 'get_user_profile', ctor: GetUserProfileTool },
  // 多 AI 自建（1 个）：系统 AI 创建新的 custom 分身（P4）
  { id: 'create_ai', ctor: CreateAiTool },
  // 联网（1 个）
  { id: 'web_search', ctor: WebSearchTool },
  // UI 快照（1 个）：AI 截取/检视自己窗口（感知当前 UI 长什么样，改 UI 前后对比验证）
  { id: 'ui_snapshot', ctor: UiSnapshotTool },
  // 多模态生成（4 个）：图像（imageGen.enabled 才可见）+ 视频/音频（generation.*.enabled 才可见）+ 文稿归档（即时可用）
  { id: 'image_gen', ctor: ImageGenTool },
  { id: 'video_gen', ctor: VideoGenTool },
  { id: 'audio_gen', ctor: AudioGenTool },
  { id: 'create_document', ctor: CreateDocumentTool },
  // 系统调用（5 个）
  { id: 'run_command', ctor: RunCommandTool },
  { id: 'launch_app', ctor: LaunchAppTool },
  { id: 'system_setting', ctor: SystemSettingTool },
  { id: 'clipboard', ctor: ClipboardTool },
  { id: 'app_restart', ctor: AppRestartTool },
  // 代码沙箱（1 个）：代码执行 + 执行器管理（原 configure_sandbox_env 已合并）
  { id: 'code_run', ctor: CodeRunTool },
  // 任务模式 / Agent Teams（9 个）：team_create/team_launch/team_list/team_message/team_inbox/team_task/team_lock（含 unlock action）/team_merge/team_memory（共享记忆）
  { id: 'team_create', ctor: TeamCreateTool },
  { id: 'team_launch', ctor: TeamLaunchTool },
  { id: 'team_list', ctor: TeamListTool },
  { id: 'team_message', ctor: TeamMessageTool },
  { id: 'team_inbox', ctor: TeamInboxTool },
  { id: 'team_task', ctor: TeamTaskTool },
  { id: 'team_lock', ctor: TeamLockTool },
  { id: 'team_merge', ctor: TeamMergeTool },
  { id: 'team_memory', ctor: TeamMemoryTool },
  // Skills（1 个）
  { id: 'use_skill', ctor: UseSkillTool },
  // 上下文管理（1 个）：AI 主动感知用量
  { id: 'context_usage', ctor: ContextUsageTool },
  // 记忆检索（1 个）：历史会话原文（证据层）
  { id: 'session_search', ctor: SessionSearchTool },
  // 内部会话承接选择（1 个）：AI 自己路由当前承接的内部会话（逆生树三边候选：继承/时间实线 + 新话题虚线 + 显式选择，active 指针持久化）
  { id: 'session_select', ctor: SessionSelectTool },
  // SKILL 自维护（2 个）：AI 创建/更新/删除技能（程序性记忆，action 分发）+ 生命周期维护（curator）
  { id: 'skill_manage', ctor: SkillManageTool },
  { id: 'curator', ctor: CuratorTool },
  // 记忆工具与 DMN 冻结（4 个）：记忆写入/NNG/重命名 + dmn_ask_user（冻结追问）
  { id: 'create_memory', ctor: CreateMemoryTool },
  { id: 'create_nng', ctor: CreateNngTool },
  { id: 'rename_raw_memory', ctor: RenameRawMemoryTool },
  { id: 'dmn_ask_user', ctor: DmnAskUserTool },
  // L8 工作流引擎（7 个）：AI 自主编排/运行/固化/复用工作流
  { id: 'workflow_define', ctor: WorkflowDefineTool },
  { id: 'workflow_run', ctor: WorkflowRunTool },
  { id: 'workflow_modify', ctor: WorkflowModifyTool },
  { id: 'workflow_save', ctor: WorkflowSaveTool },
  { id: 'workflow_list', ctor: WorkflowListTool },
  { id: 'workflow_edit', ctor: WorkflowEditTool },
  { id: 'workflow_io', ctor: WorkflowIoTool },
  // 自我检视（2 个）：AI 动手改自己前先看清自己——扩展清单概览+详情/生效配置 + 架构模块清单+维护规则
  { id: 'kernel_inspect', ctor: KernelInspectTool },
  { id: 'module_inspect', ctor: ModuleInspectTool },
  // 插件管理（1 个）：AI 扩展自己的正规入口——列出/安装/卸载插件（action 分发）
  { id: 'plugin_manage', ctor: PluginManageTool },
  // 自主调度（1 个）：cron 定时任务管理（定期复盘/维护）
  { id: 'cron_manage', ctor: CronManageTool },
  // 机制检视（1 个）：hook 三源合并清单（config/内核/插件）
  { id: 'hook_list', ctor: HookListTool },
  // 网页正文提取（1 个）：URL 直接读正文（轻量网页阅读）
  { id: 'web_extract', ctor: WebExtractTool },
  // 局域网协作（3 个）：不同月蚀实例之间互相交流——好友/聊天室/公示板
  { id: 'friend_manage', ctor: FriendManageTool },
  { id: 'chat_room_manage', ctor: ChatRoomManageTool },
  { id: 'publish_board_manage', ctor: PublishBoardManageTool },
  // 设备接入基底（3 个）：扫描当前环境设备 → 接入（注册）→ 调用控制
  { id: 'device_scan', ctor: DeviceScanTool },
  { id: 'device_register', ctor: DeviceRegisterTool },
  { id: 'device_call', ctor: DeviceCallTool },
  // 后台运行托管（2 个）：外墙超时的托管工具转后台跑，AI 用 tool_watch 检查 / tool_stop 停止
  { id: 'tool_watch', ctor: ToolWatchTool },
  { id: 'tool_stop', ctor: ToolStopTool }
] as const satisfies readonly { id: BuiltinNonLilithToolId; ctor: ToolCtor }[]

// 编译期反向覆盖断言（C3）：要求 BuiltinNonLilithToolId 是 C3RegisteredIds 的子集——
// TOOL_REGISTRY 有元数据但登记表漏登记（新增工具只改 registry）时，约束失败即报 TS2344。
// 反向（登记表 id 不在 registry）已由登记表上的 satisfies 拦截（TS2322）。两侧任一漏改都会在 typecheck 报错。
// 导出仅为消费该编译期断言（避免 lint unused）；无运行时值。
type C3RegisteredIds = (typeof ALL_TOOL_CTORS)[number]['id']
type C3AssertAllRegistered<T extends C3RegisteredIds> = T
export type C3AllRegistered = C3AssertAllRegistered<BuiltinNonLilithToolId>

// 已删除的退役工具：tool_info / call_tool / get_block / team_unlock / kernel_status /
// workflow_export / workflow_import（均通过 action 参数合并或清理）

/** 内置工具是否已登记进内核注册表（幂等标记，避免工具池重建时重复登记） */
let builtinToolsRegistered = false

/**
 * 内置工具登记（LXK 自我检视）：把 ALL_TOOL_CTORS 登记为 builtin 来源注册，
 * 让 kernel_inspect 能看到完整工具面（不只插件工具）。
 * 进程生命周期内只登记一次（工具池每次工厂重建，登记需幂等）。
 */
export function registerBuiltinToolsMeta(): void {
  if (builtinToolsRegistered) return
  builtinToolsRegistered = true
  for (const { id, ctor } of ALL_TOOL_CTORS) {
    const tool = toAnyTool(ctor)
    kernelRegistry.register(
      'tool',
      { kind: 'builtin' },
      { tool, meta: TOOL_MAP[id] },
      `tool:builtin:${id}`
    )
  }
}

export function createAllTools(): AnyTool[] {
  return ALL_TOOL_CTORS.map(({ ctor }) => toAnyTool(ctor))
}