/**
 * 统一工具池元数据注册表（shared）。
 * 为什么存在：工具的类别/风险/默认归属 agent/能力标签是前端配置面板、工具集按 policy 过滤、
 * 工具调用可视化三处的共同依据，必须在前后端间保持单一数据源。
 * 作用：导出 ToolMeta/McpToolMeta/PluginToolMeta 元数据模型、内置 TOOL_REGISTRY、动态注册
 * 查询函数、各端默认工具策略与分类标签常量。
 */
import type { ToolCategory, ToolPolicy } from '../types'

/**
 * 工具元数据。前后端共享单一数据源，用于：
 * - 配置面板展示工具列表（id/name/category）
 * - 工具集构造按 policy 过滤
 * - 工具调用可视化时的分类+中文标签

 * fullDescription 不存此处（太长），运行时从工具实例的 description 属性获取。
 */
export interface ToolMeta {
  id: string
  name: string
  category: ToolCategory
  description: string
  defaultEnabled: boolean
  riskLevel: 'low' | 'medium' | 'high'
  isMechanism?: boolean
  /**
   * 该工具的默认归属 agent（仅影响 UI 配置面板默认展示分组，不影响工厂函数注入）。
   * 统一工具池后，所有工具对所有 AI 可注入，由 toolsPolicy 配置决定实际启用。
* 'frontend' = 前端 AI 默认启用；'dmn' = DMN 默认启用；'lilith' = 莉莉丝专属（工具边界隔离）；
   * 两者/三者都列 = 对应端默认启用。
   */
  agents: readonly ('frontend' | 'dmn' | 'lilith')[]
  /**
   * 声明式能力标签（如 'system:input'、'filesystem:write'、'network'）。
   * CapabilityGuard 按此做结构化拦截：denyCaps 命中任一则拦、allowCaps 白名单模式。
   */
  caps?: readonly string[]
/**
    * 可见性条件：满足条件才出现在 system prompt / tool_info 中。
   * 与 policy 开关的区别：policy 控制"启不启用"，visible 控制"配置不允许时根本不暴露"——
   * 避免 AI 看到工具描述却调用必失败（如关闭联网后 web_search 仍列出）。
   * 不传 config 或条件返回非 false 时可见（默认可见，向后兼容）。
   */
  visible?: (cfg?: { webSearchEnabled?: boolean; imageGen?: { enabled?: boolean }; aiAssist?: { platforms?: Array<{ enabled?: boolean }> }; aiMode?: string; generation?: { video?: { enabled?: boolean }; audio?: { enabled?: boolean } } }) => boolean
}

/**
 * MCP 工具适配后的元数据（扩展 ToolMeta）。
 * 定义在 shared 层（不依赖 MCP SDK），供 registry 动态注册使用。
 */
export interface McpToolMeta extends ToolMeta {
  /** 工具源：builtin 或 mcp */
  source: 'builtin' | 'mcp'
  /** MCP server 名称（source=mcp 时有效） */
  mcpServer?: string
  /** MCP 原始工具名（source=mcp 时有效，不含命名空间） */
  mcpToolName?: string
}

/**
 * 插件工具适配后的元数据（扩展 ToolMeta）。
 * 定义在 shared 层，供 registry 动态注册使用（与 MCP 工具同机制）。
 */
export interface PluginToolMeta extends ToolMeta {
  /** 工具源：plugin */
  source: 'plugin'
  /** 所属插件目录名 */
  plugin: string
}

/**
 * 全工具元数据 registry（统一工具池）。

 * agents 字段控制工具的默认归属：
 * - ['frontend']：仅前端 AI 可见（工作流编排、自我塑造、浏览器等用户交互工具）
 * - ['dmn']：仅 DMN 可见（记忆系统、NNG 构建等后台自治工具）
 * - ['frontend', 'dmn']：前端 AI 和 DMN 共享（文件读写、搜索等基础工具）

 * 实际启用由 createToolRegistry 的 toolsPolicy 配置决定。
 * 工具内部通过 ctx 检查处理上下文依赖（如 dmn_ask_user 检查 ctx.supervisor）。
 */
export const TOOL_REGISTRY = [
  // ===== 机制入口 =====
  { id: 'thinking_protocol', name: '思考记录', category: 'mechanism', description: '把需要留痕的思考流写进 thought，存入 thinking-log 日志供以后复盘；思考方法见系统提示词「输出纪律」段；需要留下可回看的思考记录时调用，无需留痕时不调用，思考照常进行', defaultEnabled: true, riskLevel: 'low', agents: ['frontend'] },

  // ===== 批量执行（1 个，仅前端 AI——把多次单工具调用合并为一次顺序批次，减少往返） =====
  // 不设 isMechanism：机制工具不构建提示词则 AI 看不到它，批量行为对 AI 不可编排，需求落空。
  { id: 'batch_tools', name: '批量执行', category: 'mechanism', description: '一次调用按顺序执行多个子工具（steps: [{tool, params}]）并合并返回——把多轮只读探查合并成一次调用，减少往返', defaultEnabled: true, riskLevel: 'low', agents: ['frontend'] },

  // ===== 基础文件（13 个，前端+DMN 共享） =====
  { id: 'Read', name: '读取文件', category: 'file-read', description: '读取文件内容（原始格式）', defaultEnabled: true, riskLevel: 'low', agents: ['frontend', 'dmn'] },
  { id: 'read_md', name: 'MD 视图读取', category: 'file-read', description: '读取 JSON 文件（记忆/NNG/缓存）并转为 MD 视图：字段全保留、数组每项一行、路径/网址原样', defaultEnabled: true, riskLevel: 'low', agents: ['frontend', 'dmn'] },
  { id: 'Write', name: '写入文件', category: 'file-write', description: '写入文件（覆盖）', defaultEnabled: true, riskLevel: 'medium', agents: ['frontend', 'dmn'] },
  { id: 'Edit', name: '编辑文件', category: 'file-write', description: '字符串替换编辑', defaultEnabled: true, riskLevel: 'medium', agents: ['frontend', 'dmn'] },
  { id: 'Glob', name: '查找文件', category: 'file-read', description: '按模式匹配文件路径', defaultEnabled: true, riskLevel: 'low', agents: ['frontend', 'dmn'] },
  { id: 'Grep', name: '搜索内容', category: 'file-read', description: '正则搜索文件内容', defaultEnabled: true, riskLevel: 'low', agents: ['frontend', 'dmn'] },
  { id: 'LS', name: '列出目录', category: 'file-read', description: '列出目录内容', defaultEnabled: true, riskLevel: 'low', agents: ['frontend', 'dmn'] },
  { id: 'Mkdir', name: '创建目录', category: 'file-write', description: '创建目录', defaultEnabled: true, riskLevel: 'low', agents: ['frontend', 'dmn'] },
  { id: 'MoveFile', name: '移动文件', category: 'file-write', description: '移动/重命名文件', defaultEnabled: true, riskLevel: 'medium', agents: ['frontend', 'dmn'] },
  { id: 'CopyFile', name: '复制文件', category: 'file-write', description: '复制文件', defaultEnabled: true, riskLevel: 'low', agents: ['frontend', 'dmn'] },
  { id: 'DeleteFile', name: '删除文件', category: 'file-write', description: '删除文件', defaultEnabled: false, riskLevel: 'high', agents: ['frontend', 'dmn'] },
  { id: 'Agent', name: '派发子任务', category: 'mechanism', description: '派发独立子 agent 执行子任务', defaultEnabled: true, riskLevel: 'low', agents: ['frontend'] },
  { id: 'TodoWrite', name: '任务清单', category: 'mechanism', description: '管理编排任务清单', defaultEnabled: true, riskLevel: 'low', agents: ['frontend', 'dmn'] },

  // ===== 图工具（3 个，前端+DMN 共享） =====
{ id: 'nng_graph', name: 'NNG 图', category: 'graph', description: '浏览 NNG 记忆图结构', defaultEnabled: true, riskLevel: 'low', agents: ['frontend', 'dmn'] },
  { id: 'cache_graph', name: '缓存图', category: 'graph', description: '浏览缓存记忆图结构', defaultEnabled: true, riskLevel: 'low', agents: ['frontend', 'dmn'] },
  { id: 'memory', name: '记忆系统', category: 'graph', description: '记忆系统统一操作入口', defaultEnabled: true, riskLevel: 'low', agents: ['frontend'] },

  // ===== 自我塑造（5 个，仅前端 AI——DMN 不应修改自我认知/名字/配置） =====
  { id: 'update_abyss_md', name: '更新自我认知', category: 'self-shape', description: '更新自我认知（写 ABYSS/U{uid}/AI{aiId}/AI.md 文件，注入 kernel 自我认知段）——AI 对自己的理解', defaultEnabled: true, riskLevel: 'low', agents: ['frontend'] },
  { id: 'update_ai_name', name: '改自己名字', category: 'self-shape', description: '更新自己的显示名字', defaultEnabled: true, riskLevel: 'low', agents: ['frontend'] },
{ id: 'update_user_preference', name: '更新用户偏好', category: 'self-shape', description: '更新用户个人资料卡（写 ABYSS/U{uid}/USER.md，所有 AI 会话共享）——只记录用户明确信息，字段表结构见工具 description', defaultEnabled: true, riskLevel: 'low', agents: ['frontend'] },
  { id: 'create_ai', name: '创建新 AI', category: 'self-shape', description: '创建新的自定义 AI（分身）；仅系统 AI 可创建（防递归），同名复用，上限 20 个', defaultEnabled: true, riskLevel: 'medium', agents: ['frontend'] },
  { id: 'config_patch', name: '配置覆盖层', category: 'self-shape', description: '管理配置覆盖层（AI 调整配置的正规通道，写 abyssac_data/patch/，删除即恢复，禁止手改核心 config.json）', defaultEnabled: true, riskLevel: 'medium', agents: ['frontend'] },

  // ===== 账号检索（2 个，仅前端 AI——按姓名查 UID、按 UID 读 USER.md 资料，账号管理用途） =====
  { id: 'search_users', name: '检索账号', category: 'account', description: '按关键词检索本机账号列表（匹配用户名/昵称/USER.md 姓名，模糊包含），返回 UID 列表供账号管理与资料核对；不含密码等凭据信息', defaultEnabled: true, riskLevel: 'low', agents: ['frontend'] },
  { id: 'get_user_profile', name: '读取用户资料', category: 'account', description: '按 UID 读取指定账号的 USER.md 个人资料卡（姓名/职业/联系方式/联系人/偏好等；含个人信息仅供账号管理与资料核对，不得外泄）', defaultEnabled: true, riskLevel: 'medium', agents: ['frontend'] },

  // ===== 联网（1 个，仅前端 AI——DMN 无联网需求） =====
  { id: 'web_search', name: '联网搜索', category: 'network', description: '联网搜索实时信息', defaultEnabled: true, riskLevel: 'low', caps: ['network'], agents: ['frontend'], visible: (cfg) => cfg?.webSearchEnabled !== false },
  // ===== 多模态生成（4 个，前端+DMN 共享——L8 工作流的素材生成模板也要调用）；
  //      video/audio 按 generation.*.enabled 暴露，文稿归档即时可见 =====
  { id: 'image_gen', name: '图像生成', category: 'generation', description: '文生图（需配置 imageGen：OpenAI 兼容端点），产物存 generated/.../image/{日期}/', defaultEnabled: true, riskLevel: 'low', agents: ['frontend', 'dmn'], visible: (cfg) => cfg?.imageGen?.enabled === true },
  { id: 'video_gen', name: '视频生成', category: 'generation', description: '文生视频（需配置 generation.video：OpenAI 兼容端点），产物存 generated/.../video/{日期}/', defaultEnabled: true, riskLevel: 'low', agents: ['frontend', 'dmn'], visible: (cfg) => cfg?.generation?.video?.enabled === true },
  { id: 'audio_gen', name: '音频生成', category: 'generation', description: '文生音频/音乐（需配置 generation.audio：OpenAI 兼容端点），产物存 generated/.../audio/{日期}/', defaultEnabled: true, riskLevel: 'low', agents: ['frontend', 'dmn'], visible: (cfg) => cfg?.generation?.audio?.enabled === true },
  { id: 'create_document', name: '文稿归档', category: 'generation', description: '把 AI 起草的文稿存档到 generated/.../document/{日期}/（md/txt，即时可用）', defaultEnabled: true, riskLevel: 'low', agents: ['frontend', 'dmn'] },
  // ===== 系统调用（5 个，仅前端 AI——DMN 不应执行系统命令） =====
  { id: 'run_command', name: '执行命令', category: 'system', description: '执行系统命令', defaultEnabled: false, riskLevel: 'high', caps: ['system:exec'], agents: ['frontend'] },
  { id: 'launch_app', name: '启动应用', category: 'system', description: '启动外部应用', defaultEnabled: false, riskLevel: 'high', agents: ['frontend'] },
  { id: 'system_setting', name: '系统设置', category: 'system', description: '修改系统设置（音量/亮度等）', defaultEnabled: false, riskLevel: 'high', agents: ['frontend'] },
  { id: 'clipboard', name: '剪贴板', category: 'system', description: '读写系统剪贴板', defaultEnabled: false, riskLevel: 'medium', agents: ['frontend'] },
  { id: 'app_restart', name: '自我重启', category: 'system', description: '重启应用（绿通开启直接重启，否则需用户确认）', defaultEnabled: false, riskLevel: 'high', agents: ['frontend'] },

  // ===== 代码沙箱（1 个，仅前端 AI——DMN 无代码执行需求） =====
  { id: 'code_run', name: '代码工坊', category: 'system', description: '执行代码（JS 走 worker 隔离，其他语言走子进程）+ 执行器管理（增删改查）', defaultEnabled: true, riskLevel: 'medium', agents: ['frontend'] },

  // ===== 任务模式 / Agent Teams（9 个，仅前端 AI）：Lead 拆任务建团队 + 成员并行协作 =====
  { id: 'team_create', name: '创建团队', category: 'task-mode', description: '任务模式：Team Lead 拆解需求创建 AI 团队（成员+任务板，纯本地文件）', defaultEnabled: true, riskLevel: 'low', agents: ['frontend'], visible: (cfg) => cfg?.aiMode === 'task' },
  { id: 'team_launch', name: '启动团队', category: 'task-mode', description: '任务模式：并行启动团队所有成员干活（独立上下文+工具，成员间可通信）', defaultEnabled: true, riskLevel: 'medium', agents: ['frontend'], visible: (cfg) => cfg?.aiMode === 'task' },
  { id: 'team_list', name: '团队状态', category: 'task-mode', description: '任务模式：查看团队/成员/任务板/消息/锁状态', defaultEnabled: true, riskLevel: 'low', agents: ['frontend'], visible: (cfg) => cfg?.aiMode === 'task' },
  { id: 'team_message', name: '团队消息', category: 'task-mode', description: '任务模式：给团队成员发消息（成员间直接通信，to=成员id 或 all）', defaultEnabled: true, riskLevel: 'low', agents: ['frontend'], visible: (cfg) => cfg?.aiMode === 'task' },
  { id: 'team_inbox', name: '收件箱', category: 'task-mode', description: '任务模式：查看自己的团队收件箱（别人发来的消息）', defaultEnabled: true, riskLevel: 'low', agents: ['frontend'], visible: (cfg) => cfg?.aiMode === 'task' },
  { id: 'team_task', name: '团队任务板', category: 'task-mode', description: '任务模式：查看/认领/完成/更新团队任务板', defaultEnabled: true, riskLevel: 'low', agents: ['frontend'], visible: (cfg) => cfg?.aiMode === 'task' },
  { id: 'team_lock', name: '文件锁', category: 'task-mode', description: '任务模式：文件锁管理（action=lock 锁定/unlock 解锁，防并发写冲突）', defaultEnabled: true, riskLevel: 'low', agents: ['frontend'], visible: (cfg) => cfg?.aiMode === 'task' },
  { id: 'team_merge', name: '汇总团队', category: 'task-mode', description: '任务模式：Team Lead 汇总所有成员产出（任务状态+消息流+锁清理）', defaultEnabled: true, riskLevel: 'low', agents: ['frontend'], visible: (cfg) => cfg?.aiMode === 'task' },
  { id: 'team_memory', name: '团队共享记忆', category: 'task-mode', description: '任务模式：读写团队共享记忆（规范/决策/教训跨成员复用，成员开局自动注入最近 20 条）', defaultEnabled: true, riskLevel: 'low', agents: ['frontend'], visible: (cfg) => cfg?.aiMode === 'task' },

  // ===== Skills 系统（1 个，仅前端 AI——DMN 无 Skill 加载需求） =====
  { id: 'use_skill', name: '加载 Skill', category: 'system', description: '加载指定 Skill 的详细操作指令到上下文', defaultEnabled: true, riskLevel: 'low', agents: ['frontend'] },

  // ===== 上下文管理（1 个，仅前端 AI——AI 主动感知用量） =====
  { id: 'context_usage', name: '上下文用量', category: 'mechanism', description: '查询当前会话上下文用量（token/预算/剩余/摘要状态）', defaultEnabled: true, riskLevel: 'low', agents: ['frontend'] },

// ===== 记忆检索（session_search 前端专属——历史会话原文证据层；记忆库读取走 read_md/nng_graph/cache_graph） =====
  { id: 'session_search', name: '检索会话', category: 'graph', description: '按关键词检索历史会话原文（溯源原话/时间线/历史决策，与记忆库互补）', defaultEnabled: true, riskLevel: 'low', agents: ['frontend'] },

  // ===== 内部会话承接选择（session_select 前端专属——AI 自己路由当前承接的内部会话） =====
  // 逆生树双轴候选（继承轴向下 parentId/gen + 时间轴向右 timeBranchId/timeSourceId/isTimeFork），
  // 摆放结构规则在工具 description 内（AI 直接可见）；选择结果持久化为 active 指针，
  // resolveStreamSessionContext 显式选择优先、未选择时自动路由兜底。
  { id: 'session_select', name: '会话选择', category: 'graph', description: '选择/新建/释放当前承接的内部会话（AI 自己路由；list 查看逆生树候选清单，select/create/release/update-summary 决定承接；create=从可写尾端分叉出原样继承其内容的新会话，选择持久化生效）', defaultEnabled: true, riskLevel: 'low', agents: ['frontend'] },

  // ===== 莉莉丝专属（工具边界隔离：与月蚀的工具面分开，不再互相串） =====
  // lilith_player_memory / lilith_lore_query / lilith_emotion = 莉莉丝自己的工具（agents ['lilith']，月蚀的列表不再显示、月蚀不可调用）。
  // lilith_emotion = 莉莉丝自己控制自己的情绪/动画（用户 明确：莉莉丝控制莉莉丝，不归月蚀）。
  { id: 'lilith_player_memory', name: '玩家记忆', category: 'graph', description: '读写玩家记忆（她记得关于玩家的事：喜好/约定/忌讳）', defaultEnabled: false, riskLevel: 'low', agents: ['lilith'] },
  { id: 'lilith_lore_query', name: 'lore 查询', category: 'graph', description: '查询原作 lore 知识库（设定/世界观/共同经历）', defaultEnabled: false, riskLevel: 'low', agents: ['lilith'] },
  { id: 'lilith_emotion', name: '莉莉丝情绪', category: 'graph', description: '控制自己的情绪/动画（下一条回复按指定情绪表达，让陪伴更灵动）', defaultEnabled: false, riskLevel: 'low', agents: ['lilith'] },

  // ===== SKILL 自维护（2 个，仅前端 AI——AI 自主维护程序性记忆） =====
  { id: 'skill_manage', name: '技能管理', category: 'system', description: '管理技能（程序性记忆）：action=create/update/delete（delete 需用户确认）', defaultEnabled: true, riskLevel: 'low', agents: ['frontend'] },
  { id: 'curator', name: '技能库维护', category: 'system', description: '技能生命周期维护：查看使用统计/归档闲置技能', defaultEnabled: true, riskLevel: 'low', agents: ['frontend'] },

// ===== DMN 专属（4 个，仅 DMN——前端 AI 不应直接操作记忆系统） =====
  { id: 'create_memory', name: '创建记忆', category: 'dmn-exclusive', description: '创建新记忆', defaultEnabled: true, riskLevel: 'low', agents: ['dmn'] },
  { id: 'rename_raw_memory', name: 'RAW 重命名', category: 'dmn-exclusive', description: 'RAW 记忆文件加关键词重命名（记忆工作流粗筛专用）', defaultEnabled: true, riskLevel: 'low', agents: ['dmn'] },
  { id: 'create_nng', name: '创建 NNG', category: 'dmn-exclusive', description: '创建/更新 NNG 图', defaultEnabled: true, riskLevel: 'low', agents: ['dmn'] },
  { id: 'dmn_ask_user', name: '询问用户', category: 'dmn-exclusive', description: 'DMN 向用户提问', defaultEnabled: true, riskLevel: 'low', agents: ['dmn'] },

  // ===== L8 工作流引擎（7 个，仅前端 AI——DMN 不应编排工作流） =====
  { id: 'workflow_define', name: '定义工作流', category: 'workflow', description: '创建或更新工作流模板（AI 自主编排任务流程）', defaultEnabled: true, riskLevel: 'low', agents: ['frontend'] },
  { id: 'workflow_run', name: '运行工作流', category: 'workflow', description: '启动工作流实例执行', defaultEnabled: true, riskLevel: 'low', agents: ['frontend'] },
  { id: 'workflow_modify', name: '修改实例', category: 'workflow', description: '运行时动态调整工作流（暂停/恢复/取消/更新context）', defaultEnabled: true, riskLevel: 'low', agents: ['frontend'] },
  { id: 'workflow_save', name: '保存模板', category: 'workflow', description: '固化已编排的工作流供复用', defaultEnabled: true, riskLevel: 'low', agents: ['frontend'] },
  { id: 'workflow_list', name: '列出工作流', category: 'workflow', description: '查询已保存的工作流模板', defaultEnabled: true, riskLevel: 'low', agents: ['frontend'] },
  { id: 'workflow_edit', name: '编辑模板', category: 'workflow', description: '增量编辑已有工作流模板', defaultEnabled: true, riskLevel: 'low', agents: ['frontend'] },
{ id: 'workflow_io', name: '工作流导出导入', category: 'workflow', description: '导出模板为 JSON 或从 JSON 导入（分享/复用）', defaultEnabled: true, riskLevel: 'low', agents: ['frontend'] },

  // ===== UI 快照（1 个，仅前端 AI——AI 感知自己窗口长什么样，改 UI 前后对比验证） =====
  { id: 'ui_snapshot', name: 'UI 快照', category: 'system', description: '截取月蚀自身窗口快照（截图存 PNG / 提取可见 UI 结构清单），改 UI 前后对比验证', defaultEnabled: true, riskLevel: 'low', agents: ['frontend'] },

  // ===== 自我认知与机制自省（6 个，仅前端 AI——AI 查看自身扩展清单/生效配置/架构模块/插件/定时任务/hook/网页提取） =====
  { id: 'kernel_inspect', name: '自我检视', category: 'system', description: '自我检视：action=overview 扩展清单概览 / detail 按类别列出注册条目 / effective 当前生效配置结构', defaultEnabled: true, riskLevel: 'low', agents: ['frontend'] },
  { id: 'module_inspect', name: '模块自省', category: 'system', description: '查看架构模块：action=overview 全量清单+状态 / detail 模块详情+维护规则 / maintain 维护指导', defaultEnabled: true, riskLevel: 'low', agents: ['frontend'] },
  { id: 'plugin_manage', name: '插件管理', category: 'system', description: '管理插件：action=list 列出 / install 创建骨架 / uninstall 卸载（不可恢复）', defaultEnabled: true, riskLevel: 'medium', agents: ['frontend'] },
  { id: 'cron_manage', name: '定时任务', category: 'system', description: '管理 cron 定时任务（list/upsert/delete/toggle）', defaultEnabled: true, riskLevel: 'medium', agents: ['frontend'] },
  { id: 'hook_list', name: '机制清单', category: 'system', description: '列出全部生效 hook（config/内核治理/插件三源）', defaultEnabled: true, riskLevel: 'low', agents: ['frontend'] },
  { id: 'web_extract', name: '网页提取', category: 'system', description: 'URL 正文提取（轻量网页阅读，SSRF 防护）', defaultEnabled: true, riskLevel: 'low', agents: ['frontend'] },

  // ===== 局域网协作（3 个，仅前端 AI——不同月蚀实例之间互相交流） =====
  // 建立在 L0 局域网底座之上：好友（L1 点对点私聊）/ 聊天室（L2 多方群聊）/ 公示板（L3 公告栏）。
  // AI 通过这三个工具自主与其他机器上的月蚀建立联系、交换消息、发布与评论文章。
  { id: 'friend_manage', name: '好友管理', category: 'lan', description: '局域网好友（L1）：list/candidates/search/request/accept/reject/block/unblock/remove/update/messages/send——与其他月蚀建立点对点关系并私聊', defaultEnabled: true, riskLevel: 'medium', caps: ['network'], agents: ['frontend'] },
{ id: 'chat_room_manage', name: '聊天室管理', category: 'lan', description: '局域网聊天室（L2）：建室/邀请/加入/退出/群聊/search/AI 发言身份/自动回复开关——多个月蚀多方交流', defaultEnabled: true, riskLevel: 'medium', caps: ['network'], agents: ['frontend'] },
  { id: 'publish_board_manage', name: '公示板管理', category: 'lan', description: '局域网公示板（L3）：建板/发布文章/搜索/评论/置顶/同步——月蚀之间发布公告与沉淀协作信息', defaultEnabled: true, riskLevel: 'medium', caps: ['network'], agents: ['frontend'] },

  // ===== 设备接入基底（3 个，仅前端 AI——扫描/接入/调用当前环境连接的外部设备） =====
  // T3：扫描本机/局域网/蓝牙设备 → 抽象能力接口 → AI 接入（注册）并控制。
  // device_scan 只读（真发现即真扫描）；device_register 写注册表（持久化）；
  // device_call 控制类动作默认关闭（需用户授权），避免 AI 静默操作外部设备。
  { id: 'device_scan', name: '设备扫描', category: 'device', description: '扫描当前环境连接的设备（本机/局域网主机/蓝牙设备/已注册设备），返回设备列表与能力接口（可调用 action 清单）', defaultEnabled: true, riskLevel: 'low', agents: ['frontend'], caps: ['network'] },
  { id: 'device_register', name: '设备接入', category: 'device', description: '把外部设备接入 AI 可控制的设备清单：声明端点（HTTP/WS）与能力接口，之后 device_call 可调用该设备', defaultEnabled: false, riskLevel: 'medium', agents: ['frontend'], caps: ['network'] },
  { id: 'device_call', name: '设备调用', category: 'device', description: '调用设备的动作接口：info 动作只读直接执行；control 动作请求用户授权后执行（控制外部设备）', defaultEnabled: false, riskLevel: 'high', agents: ['frontend'], caps: ['network'] },
  // T3 软超时托管（2 个）：外墙对托管工具超时后不 abort、转后台跑，AI 用这对工具检查/停止。
  // 语义：tool_watch = 设定新检查时间（到期未完成返回 running，可继续 watch 或 stop）；
  // tool_stop = AI 主动停止（abort → run_command killTree 收尸）。两者都必须对 AI 可见（非 mechanism）。
  { id: 'tool_watch', name: '检查后台任务', category: 'mechanism', description: '检查后台托管任务进度：传入 taskId 与等待时长 waitMs，任务落定返回完整结果，超时仍未完成返回 running（可续查或 tool_stop 停止）', defaultEnabled: true, riskLevel: 'low', agents: ['frontend'] },
  { id: 'tool_stop', name: '停止后台任务', category: 'mechanism', description: '主动停止仍在后台运行的托管任务：传入 taskId，底层进程树被清理，不留孤儿', defaultEnabled: true, riskLevel: 'medium', agents: ['frontend'] },
] as const satisfies readonly ToolMeta[]

/**
 * 内置工具 id 字面量联合（由 TOOL_REGISTRY 派生，含 lilith 专属）。
 * tools/index.ts 用它做编译期一致性校验：ALL_TOOL_CTORS 登记表的 id 必须命中
 * BuiltinNonLilithToolId，且 TOOL_REGISTRY 中的每个非 lilith 内置工具都必须有实现登记——
 * 新增/删除内置工具漏改任一侧都会在 typecheck 阶段报错，而不是运行时静默失效。
 */
export type BuiltinToolId = (typeof TOOL_REGISTRY)[number]['id']

/** 非 lilith 的内置工具 id（lilith 专属工具面由外部注入实现，不要求 ALL_TOOL_CTORS 登记） */
export type BuiltinNonLilithToolId = Exclude<
  BuiltinToolId,
  Extract<BuiltinToolId, 'lilith_player_memory' | 'lilith_lore_query' | 'lilith_emotion'>
>

/** 工具 id → 元数据 映射，O(1) 查找 */
export const TOOL_MAP: Record<string, ToolMeta> = Object.fromEntries(
  TOOL_REGISTRY.map((t) => [t.id, t])
)

// ===== MCP / 插件 动态工具注册（运行时可变，与 TOOL_REGISTRY 合并查询） =====

/** 动态工具元数据（MCP server 连接后 / 插件加载后注册，断开/卸载后移除） */
const dynamicToolMetas: Array<McpToolMeta | PluginToolMeta> = []

/** 注册 MCP 工具元数据（运行时动态注册）。同 server 的旧元数据会先被移除 */
export function registerMcpToolMetas(metas: McpToolMeta[]): void {
  if (metas.length === 0) return
  // 先移除同 server 的旧元数据
  const servers = new Set(metas.map((m) => m.mcpServer).filter(Boolean) as string[])
  for (const server of servers) {
    for (let i = dynamicToolMetas.length - 1; i >= 0; i--) {
      const m = dynamicToolMetas[i]
      if (m.source === 'mcp' && m.mcpServer === server) {
        dynamicToolMetas.splice(i, 1)
      }
    }
  }
  // 追加新元数据
  dynamicToolMetas.push(...metas)
}

/** 注销指定 server 的所有工具元数据 */
export function unregisterMcpServerTools(serverName: string): void {
  for (let i = dynamicToolMetas.length - 1; i >= 0; i--) {
    const m = dynamicToolMetas[i]
    if (m.source === 'mcp' && m.mcpServer === serverName) {
      dynamicToolMetas.splice(i, 1)
    }
  }
}

/** 注册插件工具元数据（运行时动态注册）。同插件的旧元数据会先被移除 */
export function registerPluginToolMetas(metas: PluginToolMeta[]): void {
  if (metas.length === 0) return
  // 先移除同插件的旧元数据
  const plugins = new Set(metas.map((m) => m.plugin).filter(Boolean) as string[])
  for (const plugin of plugins) {
    for (let i = dynamicToolMetas.length - 1; i >= 0; i--) {
      const m = dynamicToolMetas[i]
      if (m.source === 'plugin' && m.plugin === plugin) {
        dynamicToolMetas.splice(i, 1)
      }
    }
  }
  // 追加新元数据
  dynamicToolMetas.push(...metas)
}

/** 注销指定插件的所有工具元数据 */
export function unregisterPluginTools(plugin: string): void {
  for (let i = dynamicToolMetas.length - 1; i >= 0; i--) {
    const m = dynamicToolMetas[i]
    if (m.source === 'plugin' && m.plugin === plugin) {
      dynamicToolMetas.splice(i, 1)
    }
  }
}

/** 清空全部动态元数据（重启/测试用） */
export function clearDynamicToolMetas(): void {
  dynamicToolMetas.length = 0
}

/** 注销所有 MCP 动态工具元数据（全量同步时使用，不碰插件元数据） */
export function unregisterAllMcpTools(): void {
  for (let i = dynamicToolMetas.length - 1; i >= 0; i--) {
    if (dynamicToolMetas[i].source === 'mcp') {
      dynamicToolMetas.splice(i, 1)
    }
  }
}

/** 获取所有工具元数据（内置 + MCP 动态注册） */
export function getAllToolMetas(): ToolMeta[] {
  return [...TOOL_REGISTRY, ...dynamicToolMetas]
}

/** 获取前端 AI 工具列表（含 MCP 动态注册的工具） */
export function getFrontendTools(): ToolMeta[] {
  return getAllToolMetas().filter((t) => t.agents.includes('frontend'))
}

/**
 * 月蚀专属排除清单（用户"角色塑造是给月蚀的"——莉莉丝工具面收窄）：
 * 这些是月蚀的系统管理/自我管理工具，莉莉丝（角色）不该有：
 * - 自我塑造：设定角色/更新角色设定/改自己名字（月蚀改自己 persona 的通道）
 * - AI 自我管理：用户档案/轻量记忆/SKILL 维护/自我安全/自我重启
 * - 任务编排：派发子任务/任务清单/上下文管理
 * - 工作流编排：workflow_* 7 个
 * 保留：莉莉丝专属（lilith_*）+ 记忆/文件/浏览器/联网 + 有授权通道的高风险工具（run_command 等，
 * 依授权体系保留而非默认排除——高危工具在角色不擅权的边界内仍可执行系统操作）
 */
const LILITH_EXCLUDED_TOOLS = new Set([
  'update_abyss_md', 'update_ai_name',
  'create_ai',
  'search_users', 'get_user_profile',
  'skill_manage', 'use_skill', 'curator',
  'app_restart',
  'kernel_inspect', 'module_inspect',
  'Agent', 'TodoWrite', 'context_usage',
  'batch_tools', // 批量执行依赖前端主链路的 executeSubTool 注入（toolExecutorsRef），莉莉丝侧无此注入
  'workflow_define', 'workflow_run', 'workflow_modify', 'workflow_save',
  'workflow_list', 'workflow_edit', 'workflow_io'
])

/** 获取莉莉丝工具列表（边界隔离：前端工具 = 她的能力面 + 莉莉丝专属工具 = 她的记忆工具；排除月蚀专属管理类） */
export function getLilithTools(): ToolMeta[] {
  return getAllToolMetas().filter(
    (t) => (t.agents.includes('frontend') || t.agents.includes('lilith')) && !LILITH_EXCLUDED_TOOLS.has(t.id)
  )
}

/** 获取 DMN 工具列表（含 MCP 动态注册的工具） */
export function getDmnTools(): ToolMeta[] {
  return getAllToolMetas().filter((t) => t.agents.includes('dmn'))
}

/** 查工具元数据（静态 TOOL_MAP + MCP 动态注册，新增——MCP 工具运行时注册，静态表查不到） */
function findToolMeta(toolId: string): ToolMeta | undefined {
  return TOOL_MAP[toolId] ?? dynamicToolMetas.find((m) => m.id === toolId)
}

/** 工具是否启用（policy 优先，未配置则用 defaultEnabled） */
export function isToolEnabled(
  toolId: string,
  policy: Record<string, { enabled: boolean }>
): boolean {
  const meta = findToolMeta(toolId)
  // 修复（前H4）：原实现 `if (!meta) return false`——MCP 工具是运行时动态注册的，
  // 不在静态 TOOL_MAP → 恒 false → MCP 工具整体无法注入（已购死 bug）。
  // 查不到元数据时回退"策略显式配置优先，否则默认启用"（MCP server 配了就是要用其工具；
  // 未知 id 不在任何工具池里，默认启用无实际风险）。
  if (!meta) return policy[toolId] ? policy[toolId].enabled : true
  if (meta.isMechanism) return true // 机制入口由全局开关控制，不受 per-tool policy 影响
  const entry = policy[toolId]
  return entry ? entry.enabled : meta.defaultEnabled
}

/**
 * 工具是否对指定 agent 可见（基于 agents 字段）

 * 在 isToolEnabled 之前过滤：先判断工具归属，再判断启用策略。
 * - 前端 AI 只能看到 agents 含 'frontend' 的工具
 * - DMN 只能看到 agents 含 'dmn' 的工具
 * - 莉莉丝（'lilith'）看到 前端工具 + 莉莉丝专属工具（边界隔离：
 *   她的能力面 = 前端全量（agent 模式/白名单），外加她自己的记忆工具 lilith_*）

 * @param toolId 工具 id
 * @param agent 'frontend' | 'dmn' | 'lilith'
 */
export function isToolForAgent(toolId: string, agent: 'frontend' | 'dmn' | 'lilith'): boolean {
  // 修复（前#25 配套）：MCP 动态工具同样可判定（findToolMeta 查静态 + 动态）
  const meta = findToolMeta(toolId)
  if (!meta) return false
  if (agent === 'lilith') {
    // 莉莉丝工具面 = 前端工具 + 莉莉丝专属工具，排除月蚀专属管理类（用户"角色塑造是给月蚀的"）
    return (meta.agents.includes('frontend') || meta.agents.includes('lilith')) && !LILITH_EXCLUDED_TOOLS.has(toolId)
  }
  return meta.agents.includes(agent)
}

/**
 * 构建莉莉丝工具策略（用户需求：工具可配置，与常规线路连通）。
 * 与 DMN 同一套白名单机制：仅启用指定工具，禁用其余前端可用工具。
 * 默认白名单 = 记忆/情绪/浏览器类（memory/lilith_player_memory/lilith_lore_query/lilith_emotion/browser_*——她会"记得"事）；用户在设置页可增删。
 */
export function buildLilithToolPolicy(enabledTools: string[]): Record<string, { enabled: boolean }> {
  const enabledSet = new Set(enabledTools)
  const policy: Record<string, { enabled: boolean }> = {}
for (const tool of TOOL_REGISTRY as readonly ToolMeta[]) {
    // 莉莉丝工具集 = 前端可用工具 + 莉莉丝专属工具（边界隔离后 lilith_* 标 agents ['lilith']），
    // 排除月蚀专属管理类（LILITH_EXCLUDED_TOOLS）
    if ((tool.agents.includes('frontend') || tool.agents.includes('lilith')) && !tool.isMechanism && !LILITH_EXCLUDED_TOOLS.has(tool.id)) {
      policy[tool.id] = { enabled: enabledSet.has(tool.id) }
    }
  }
  return policy
}

/** 莉莉丝默认工具策略（记忆类 + 浏览器类 + 情绪控制白名单；用户配置覆盖） */
export const DEFAULT_LILITH_TOOL_POLICIES: Record<string, { enabled: boolean }> = buildLilithToolPolicy([
  // 记忆类（她会"记得"事）
  'memory',
  'lilith_player_memory', 'lilith_lore_query',
  // 情绪控制（用户明确：莉莉丝控制莉莉丝——她自己控制 LIVE2D 情绪/动画）
  'lilith_emotion',
  // 浏览器类（用户需求："解除一点限制，让她能完整操控浏览器，输出保持风格"）
  // 注意：browser_* 是 bundled/headless-browser 插件动态注册的工具，不在静态 TOOL_REGISTRY 中，
  // buildLilithToolPolicy 只遍历静态表，以下 id 实际不会生成 policy 条目——插件工具默认启用由其
  // meta.defaultEnabled（=true）决定，并经 tool-registry 的 isToolEnabled 过滤支持设置页开关。
  // 此处保留真实存在的 8 个 id 作语义白名单文档，便于读者核对插件工具面。
  'browser_navigate', 'browser_snapshot', 'browser_click', 'browser_type',
  'browser_scroll', 'browser_evaluate', 'browser_status', 'browser_takeover'
])

/** 合并莉莉丝工具策略：默认白名单基础上应用用户配置（用户可启用额外工具或关闭记忆类） */
export function mergeLilithToolPolicy(userPolicy?: Record<string, ToolPolicy>): Record<string, { enabled: boolean }> {
  const merged: Record<string, { enabled: boolean }> = { ...DEFAULT_LILITH_TOOL_POLICIES }
  if (userPolicy) {
    for (const [id, p] of Object.entries(userPolicy)) {
      merged[id] = { enabled: p.enabled }
    }
  }
  return merged
}

/**
 * 构建 DMN 工具策略：仅启用指定工具，禁用其余 DMN 可用工具

 * 用于为每个 DMN 生成精确的工具集，避免 DMN 看到无关工具导致误用。
 * 机制入口（tool_info/call_tool）不受此策略影响（由全局开关控制）。

 * @param enabledTools 需要启用的工具 id 列表
 * @returns ToolPolicy 记录，包含所有 DMN 可用工具的启用/禁用状态
 */
export function buildDmnToolPolicy(enabledTools: string[]): Record<string, { enabled: boolean }> {
  const enabledSet = new Set(enabledTools)
  const policy: Record<string, { enabled: boolean }> = {}
for (const tool of TOOL_REGISTRY as readonly ToolMeta[]) {
    // 只为 DMN 可用的非机制工具生成策略
    if (tool.agents.includes('dmn') && !tool.isMechanism) {
      policy[tool.id] = { enabled: enabledSet.has(tool.id) }
    }
  }
  return policy
}

/**
 * 记忆处理工作流各阶段的默认工具策略

 * 设计原则：每个阶段只拿到它职责所需的工具，避免看到无关工具导致误用或困惑。
 * 用户可在设置页调整，也可通过"一键重置"恢复到此默认配置。

 * 记忆处理已合并为 MEMORY_PIPELINE_TEMPLATE 工作流，工具策略通过 mergeDmnToolPolicies()
 * 取并集后下发给工作流引擎（确保工作流任意节点所需工具都可用）。
 * 这里的 memory_filter/memory_dedup 等键是工作流各阶段工具策略的命名沿用
 * （对应 filter/dedup/contradict 等节点 ID），不代表独立 agent。
 */
export const DEFAULT_DMN_TOOL_POLICIES: Record<string, Record<string, { enabled: boolean }>> = {
// 过滤与归档：将对齐对话归档为记忆和 NNG
  memory_filter: buildDmnToolPolicy([
    'create_memory', 'create_nng', 'rename_raw_memory',
    'nng_graph', 'cache_graph',
    'Read', 'read_md', 'Edit', 'Write', 'Glob', 'Grep', 'LS',
    'MoveFile', 'DeleteFile',
    'TodoWrite',
    'dmn_ask_user'
  ]),
  // 重复归档与归并：检测重复并归档/归并/合并 NNG
  memory_dedup: buildDmnToolPolicy([
    'create_memory', 'create_nng',
    'nng_graph',
    'Read', 'Edit', 'Glob', 'Grep', 'LS',
    'MoveFile', 'DeleteFile',
    'TodoWrite',
    'dmn_ask_user'
  ]),
  // 矛盾归档：检测矛盾记忆并归档旧版本
  memory_contradict: buildDmnToolPolicy([
    'Read', 'Edit', 'Write',
    'TodoWrite',
    'dmn_ask_user'
  ]),
  // 张力处理：检测张力/跨领域关系，建 high/meta NNG
  memory_tension: buildDmnToolPolicy([
    'create_memory', 'create_nng',
    'nng_graph',
    'Read', 'Edit', 'Write', 'Glob', 'Grep', 'LS',
    'MoveFile', 'DeleteFile',
    'TodoWrite',
    'dmn_ask_user'
  ]),
  // 统一检查：审查各阶段工作质量并决策重做
  memory_qa: buildDmnToolPolicy([
    'Read', 'Edit', 'Write',
    'TodoWrite',
    'dmn_ask_user'
  ])
}

/**
 * 合并所有记忆工作流阶段的默认工具策略为并集（任一阶段启用的工具即启用）。

 * 用于工作流引擎等跨阶段场景：工作流可执行任意记忆处理任务（filter/dedup 等节点），
 * 工具集必须覆盖所有阶段所需，而不是只匹配某一个阶段的精简策略。
 * 否则 defaultEnabled=false 的高风险工具（如 DeleteFile）会被 isToolEnabled
 * 回退逻辑过滤掉，导致工作流 LLM 节点报"未注册"警告且工具不可用。
 */
export function mergeDmnToolPolicies(): Record<string, { enabled: boolean }> {
  const merged: Record<string, { enabled: boolean }> = {}
  for (const key of Object.keys(DEFAULT_DMN_TOOL_POLICIES)) {
    const policy = DEFAULT_DMN_TOOL_POLICIES[key]
    for (const [toolId, entry] of Object.entries(policy)) {
      // 任一阶段启用则启用；已有 true 的保留不被覆盖
      if (!merged[toolId] || entry.enabled) {
        merged[toolId] = { enabled: entry.enabled }
      }
    }
  }
  // 多模态生成工具：agents 含 'dmn' 后会被各记忆阶段策略显式置 false（不在阶段清单里），
  // 但它们 defaultEnabled=true 且低风险——通用工作流（素材生成等）需要，恢复默认启用
  for (const toolId of ['image_gen', 'video_gen', 'audio_gen', 'create_document']) {
    merged[toolId] = { enabled: true }
  }
  return merged
}

/** 工具分类的中文名（用于配置面板分组标题） */
export const CATEGORY_LABELS: Record<ToolCategory, string> = {
  'file-read': '读取文件',
  'file-write': '修改文件',
  browser: '浏览器',
'self-shape': '自我塑造',
  account: '账号管理',
  system: '系统调用',
  network: '联网',
  graph: '图工具',
  mechanism: '机制入口',
  'dmn-exclusive': 'DMN 专属',
  workflow: '工作流',
  plugin: '插件',
  'task-mode': '任务模式',
  generation: '内容生成',
  lan: '局域网协作',
  device: '设备接入',
}

/** 工具分类的图标（emoji，用于卡片汇总条） */
export const CATEGORY_ICONS: Record<ToolCategory, string> = {
  'file-read': '📄',
  'file-write': '✏️',
  browser: '🌐',
'self-shape': '🎭',
  account: '👤',
  system: '⚙️',
  network: '🔗',
  graph: '📊',
  mechanism: '🔧',
  'dmn-exclusive': '🧩',
  workflow: '🔄',
  plugin: '🧰',
  'task-mode': '👥',
  generation: '🎬',
  lan: '📡',
  device: '🖥️',
}
