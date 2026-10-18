/**
 * @category 工具
 * @summary 内置工具目录（shared，唯一真源）
 *
 * 为什么存在：内置工具的 id/名称/类别/风险/默认启用/能力标签是前端配置面板、工具集按策略过滤、工具调用可视化的共同依据，必须在前后端间保持单一数据源。
 * 不删理由：本模块由 `shared/tools/registry.ts` 按 ADR-06 拆分而来，宿主降级为 barrel
 * 保全部消费方零改动；职责单一化后，改动面互不干扰（原单文件同时承载类型/目录/动态注册/
 * 策略/标签五类职责，任一处改动都会与其它职责在 merge 上冲突）。
 *
 * 关键约束（协议面红线）：`TOOL_REGISTRY` 是**内置工具元数据的唯一真源**，其 `as const satisfies`
 * 声明与紧随其后的 `BuiltinToolId` / `BuiltinNonLilithToolId` 派生类型**必须同文件**——
 * 派生链断裂会让「新增工具漏登记实现」从编译期报错退化为运行时静默失效
 * （校验点：`electron/main/tools/tool-ctors.ts` 的正向 satisfies + 反向覆盖断言）。
 * 本文件是唯一随「新增工具」增长的文件。 */

import type { ToolMeta } from './meta'

/**
 * 全工具元数据 registry（统一工具池）。

 * agents 字段控制工具的默认归属：
 * - ['frontend']：仅前端 AI 可见（工作流编排、自我塑造、浏览器等用户交互工具）
 * - ['dmn']：仅记忆工作流可见（记忆系统、NNG 构建等后台自治工具）
 * - ['frontend', 'dmn']：前端 AI 和记忆工作流共享（文件读写、搜索等基础工具）

 * 实际启用由 createToolRegistry 的 toolsPolicy 配置决定。
 * 工具内部通过 ctx 检查处理上下文依赖（如 dmn_ask_user 检查 ctx.supervisor）。
 */
export const TOOL_REGISTRY = [
  // ===== 机制入口 =====
  { id: 'thinking_protocol', name: '思考记录', category: 'mechanism', description: '把需要留痕的思考流写进 thought，存入 thinking-log 日志供以后复盘；思考方法见系统提示词「输出纪律」段；需要留下可回看的思考记录时调用，无需留痕时不调用，思考照常进行', defaultEnabled: true, riskLevel: 'low', agents: ['frontend'] },

  // ===== 批量执行（1 个，仅前端 AI——把多次单工具调用合并为一次顺序批次，减少往返） =====
  // 不设 isMechanism：机制工具不构建提示词则 AI 看不到它，批量行为对 AI 不可编排，需求落空。
  { id: 'batch_tools', name: '批量执行', category: 'mechanism', description: '一次调用按顺序执行多个子工具（steps: [{tool, params}]）并合并返回——把多轮只读探查合并成一次调用，减少往返', defaultEnabled: true, riskLevel: 'low', agents: ['frontend'] },

  // ===== 基础文件（13 个，前端+记忆工作流共享） =====
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

  // ===== 图工具（3 个，前端+记忆工作流共享） =====
{ id: 'nng_graph', name: 'NNG 图', category: 'graph', description: '浏览 NNG 记忆图结构', defaultEnabled: true, riskLevel: 'low', agents: ['frontend', 'dmn'] },
  { id: 'cache_graph', name: '缓存图', category: 'graph', description: '浏览缓存记忆图结构', defaultEnabled: true, riskLevel: 'low', agents: ['frontend', 'dmn'] },
  { id: 'memory', name: '记忆系统', category: 'graph', description: '记忆系统统一操作入口', defaultEnabled: true, riskLevel: 'low', agents: ['frontend'] },

  // ===== 自我塑造（5 个，仅前端 AI——记忆工作流不应修改自我认知/名字/配置） =====
  { id: 'update_abyss_md', name: '更新自我认知', category: 'self-shape', description: '更新自我认知（写 ABYSS/U{uid}/AI{aiId}/AI.md 文件，注入 kernel 自我认知段）——AI 对自己的理解', defaultEnabled: true, riskLevel: 'low', agents: ['frontend'] },
  { id: 'update_ai_name', name: '改自己名字', category: 'self-shape', description: '更新自己的显示名字', defaultEnabled: true, riskLevel: 'low', agents: ['frontend'] },
{ id: 'update_user_preference', name: '更新用户偏好', category: 'self-shape', description: '更新用户个人资料卡（写 ABYSS/U{uid}/USER.md，所有 AI 会话共享）——只记录用户明确信息，字段表结构见工具 description', defaultEnabled: true, riskLevel: 'low', agents: ['frontend'] },
  { id: 'create_ai', name: '创建新 AI', category: 'self-shape', description: '创建新的自定义 AI（分身）；仅系统 AI 可创建（防递归），同名复用，上限 20 个', defaultEnabled: true, riskLevel: 'medium', agents: ['frontend'] },
  { id: 'config_patch', name: '配置覆盖层', category: 'self-shape', description: '管理配置覆盖层（AI 调整配置的正规通道，写 abyssac_data/patch/，删除即恢复，禁止手改核心 config.json）', defaultEnabled: true, riskLevel: 'medium', agents: ['frontend'] },

  // ===== 账号检索（2 个，仅前端 AI——按姓名查 UID、按 UID 读 USER.md 资料，账号管理用途） =====
  { id: 'search_users', name: '检索账号', category: 'account', description: '按关键词检索本机账号列表（匹配用户名/昵称/USER.md 姓名，模糊包含），返回 UID 列表供账号管理与资料核对；不含密码等凭据信息', defaultEnabled: true, riskLevel: 'low', agents: ['frontend'] },
  { id: 'get_user_profile', name: '读取用户资料', category: 'account', description: '按 UID 读取指定账号的 USER.md 个人资料卡（姓名/职业/联系方式/联系人/偏好等；含个人信息仅供账号管理与资料核对，不得外泄）', defaultEnabled: true, riskLevel: 'medium', agents: ['frontend'] },

  // ===== 联网（1 个，仅前端 AI——记忆工作流无联网需求） =====
  { id: 'web_search', name: '联网搜索', category: 'network', description: '联网搜索实时信息', defaultEnabled: true, riskLevel: 'low', caps: ['network'], agents: ['frontend'], visible: (cfg) => cfg?.webSearchEnabled !== false },
  // ===== 多模态生成（4 个，前端+记忆工作流共享——L8 工作流的素材生成模板也要调用）；
  //      video/audio 按 generation.*.enabled 暴露，文稿归档即时可见 =====
  { id: 'image_gen', name: '图像生成', category: 'generation', description: '文生图（需配置 imageGen：OpenAI 兼容端点），产物存 generated/.../image/{日期}/', defaultEnabled: true, riskLevel: 'low', agents: ['frontend', 'dmn'], visible: (cfg) => cfg?.imageGen?.enabled === true },
  { id: 'video_gen', name: '视频生成', category: 'generation', description: '文生视频（需配置 generation.video：OpenAI 兼容端点），产物存 generated/.../video/{日期}/', defaultEnabled: true, riskLevel: 'low', agents: ['frontend', 'dmn'], visible: (cfg) => cfg?.generation?.video?.enabled === true },
  { id: 'audio_gen', name: '音频生成', category: 'generation', description: '文生音频/音乐（需配置 generation.audio：OpenAI 兼容端点），产物存 generated/.../audio/{日期}/', defaultEnabled: true, riskLevel: 'low', agents: ['frontend', 'dmn'], visible: (cfg) => cfg?.generation?.audio?.enabled === true },
  { id: 'create_document', name: '文稿归档', category: 'generation', description: '把 AI 起草的文稿存档到 generated/.../document/{日期}/（md/txt，即时可用）', defaultEnabled: true, riskLevel: 'low', agents: ['frontend', 'dmn'] },
  // ===== 系统调用（5 个，仅前端 AI——记忆工作流不应执行系统命令） =====
  { id: 'run_command', name: '执行命令', category: 'system', description: '执行系统命令', defaultEnabled: false, riskLevel: 'high', caps: ['system:exec'], agents: ['frontend'] },
  { id: 'launch_app', name: '启动应用', category: 'system', description: '启动外部应用', defaultEnabled: false, riskLevel: 'high', agents: ['frontend'] },
  { id: 'system_setting', name: '系统设置', category: 'system', description: '修改系统设置（音量/亮度等）', defaultEnabled: false, riskLevel: 'high', agents: ['frontend'] },
  { id: 'clipboard', name: '剪贴板', category: 'system', description: '读写系统剪贴板', defaultEnabled: false, riskLevel: 'medium', agents: ['frontend'] },
  { id: 'app_restart', name: '自我重启', category: 'system', description: '重启应用（绿通开启直接重启，否则需用户确认）', defaultEnabled: false, riskLevel: 'high', agents: ['frontend'] },

  // ===== 代码沙箱（1 个，仅前端 AI——记忆工作流无代码执行需求） =====
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

  // ===== Skills 系统（1 个，仅前端 AI——记忆工作流无 Skill 加载需求） =====
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

// ===== 记忆工作流专属（4 个，仅记忆工作流——前端 AI 不应直接操作记忆系统） =====
  { id: 'create_memory', name: '创建记忆', category: 'memory-workflow-exclusive', description: '创建新记忆', defaultEnabled: true, riskLevel: 'low', agents: ['dmn'] },
  { id: 'rename_raw_memory', name: 'RAW 重命名', category: 'memory-workflow-exclusive', description: 'RAW 记忆文件加关键词重命名（记忆工作流粗筛专用）', defaultEnabled: true, riskLevel: 'low', agents: ['dmn'] },
  { id: 'create_nng', name: '创建 NNG', category: 'memory-workflow-exclusive', description: '创建/更新 NNG 图', defaultEnabled: true, riskLevel: 'low', agents: ['dmn'] },
  { id: 'dmn_ask_user', name: '询问用户', category: 'memory-workflow-exclusive', description: '记忆工作流向用户提问', defaultEnabled: true, riskLevel: 'low', agents: ['dmn'] },

  // ===== L8 工作流引擎（8 个，仅前端 AI——记忆工作流不应编排工作流） =====
  { id: 'workflow_define', name: '定义工作流', category: 'workflow', description: '创建或更新工作流模板（AI 自主编排任务流程）', defaultEnabled: true, riskLevel: 'low', agents: ['frontend'] },
  { id: 'workflow_run', name: '运行工作流', category: 'workflow', description: '启动工作流实例执行', defaultEnabled: true, riskLevel: 'low', agents: ['frontend'] },
  { id: 'workflow_status', name: '查询实例状态', category: 'workflow', description: '查询工作流实例运行状态与输出（instanceId 必填；返回 status/currentNode/output/error，供 AI 等待或检查执行结果）', defaultEnabled: true, riskLevel: 'low', agents: ['frontend'] },
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
  { id: 'lan_control', name: '局域网启停', category: 'lan', description: '局域网协作开关：status 查询 / enable 开启 / disable 关闭。开启或关闭属 T1 显式授予能力（键 t1.lan-control），未获用户授予时会被拒绝并提示如何授予', defaultEnabled: true, riskLevel: 'medium', caps: ['network'], agents: ['frontend'] },
  { id: 'collect_environment', name: '采集环境', category: 'device', description: '采集本机环境状态（平台/CPU/内存/负载，只读元数据）与可选桌面截图，供 AI 感知运行环境。属 T1 显式授予能力（键 t1.collector），未获授予会被拒绝', defaultEnabled: true, riskLevel: 'medium', agents: ['frontend'] },

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
  // ===== 计划模式（2 个，仅前端 AI——复杂任务先只读探索+方案获批再动手） =====
  // 不设 isMechanism：机制工具不构建提示词则 AI 看不到它，计划模式对 AI 不可编排，需求落空（与 batch_tools 同理）。
  { id: 'enter_plan_mode', name: '进入计划模式', category: 'mechanism', description: '进入计划模式：切换到只读探索与设计阶段（复杂任务先摸清现状/识别模式/比较方案，动手前自动拦截写操作）', defaultEnabled: true, riskLevel: 'low', agents: ['frontend'] },
  { id: 'exit_plan_mode', name: '退出计划模式', category: 'mechanism', description: '退出计划模式：把已设计好的实现方案（可选 plan 全文）呈交用户批准，获批后自动退出计划模式恢复全部能力；取消则保持计划模式', defaultEnabled: true, riskLevel: 'low', agents: ['frontend'] },
  // ===== MCP 资源（2 个，仅前端 AI——先列出外部服务器可读资源，再按 uri 读取） =====
  // 与 MCP 工具同一数据通道（client-manager 的 resources 发现），只读、读取外部数据，风险 low。
  { id: 'list_mcp_resources', name: '列出 MCP 资源', category: 'system', description: '列出已连接 MCP 服务器的可读资源（uri/名称/描述/类型），供 read_mcp_resource 按 server+uri 读取', defaultEnabled: true, riskLevel: 'low', agents: ['frontend'] },
  { id: 'read_mcp_resource', name: '读取 MCP 资源', category: 'system', description: '读取指定 MCP 服务器的资源内容：文本资源返回全文，二进制资源返回类型与大小元信息', defaultEnabled: true, riskLevel: 'low', agents: ['frontend'] },
  // ===== MCP prompt 模板（2 个，仅前端 AI——先列出外部服务器提示模板，再按名获取展开内容） =====
  // 与 MCP 工具同一数据通道（client-manager 的 prompts 发现），只读、风险 low。
  { id: 'list_mcp_prompts', name: '列出 MCP prompt 模板', category: 'system', description: '列出已连接 MCP 服务器的可用 prompt 模板（名称/描述/参数），供 get_mcp_prompt 按 server+name 获取展开内容', defaultEnabled: true, riskLevel: 'low', agents: ['frontend'] },
  { id: 'get_mcp_prompt', name: '获取 MCP prompt 模板', category: 'system', description: '获取指定 MCP 服务器的 prompt 模板内容：传入 server 与 name（可选 arguments 键值对），返回模板展开后的消息序列', defaultEnabled: true, riskLevel: 'low', agents: ['frontend'] },
  // ===== MCP 服务器状态（1 个，仅前端 AI——调用 mcp_<server>__<tool> 前先确认服务器连接状态） =====
  // 与前端 IPC mcp:getStatuses 同一数据源（client-manager 的 servers/status），只读、风险 low。
  // 连接/断开等写操作由前端 MCP 面板（IPC mcp:connect/mcp:disconnect）管理，工具面不重复建设。
  { id: 'mcp_list_servers', name: '列出 MCP 服务器状态', category: 'system', description: '列出已启用 MCP 服务器的运行状态摘要（连接状态/工具数/最近错误），供调用 mcp_<server>__<tool> 前核对服务器是否已连接', defaultEnabled: true, riskLevel: 'low', agents: ['frontend'] },
  // ===== 自动编辑模式（2 个，仅前端 AI——模式级授权：文件编辑工具免逐次确认，仍受 deny/治理 hook 约束） =====
  // 不设 isMechanism：机制工具不构建提示词则 AI 看不到它，模式入口对 AI 不可编排（与计划模式同理）。
  { id: 'enter_accept_edits_mode', name: '进入自动编辑模式', category: 'mechanism', description: '进入自动编辑模式：对文件编辑类工具（Edit/Write/NotebookEdit）自动接受逐次授权请求，不再打断用户。仍受安全策略与治理规则约束（管理员禁用工具、权限收紧等优先）；删除文件/移动/命令执行等破坏性操作不受影响，仍按原审批。批量编辑完成后调用 exit_accept_edits_mode 退出恢复逐次确认', defaultEnabled: true, riskLevel: 'low', agents: ['frontend'] },
  { id: 'exit_accept_edits_mode', name: '退出自动编辑模式', category: 'mechanism', description: '退出自动编辑模式：文件编辑类工具恢复逐次授权确认。适用于批量改完后想恢复严格确认、或误入模式需手动退出', defaultEnabled: true, riskLevel: 'low', agents: ['frontend'] },
  // ===== 自动权限模式（2 个，仅前端 AI——主模型代判 require-approval 工具的逐次授权，deny 优先、失败回退人工审批） =====
  // 不设 isMechanism：机制工具不构建提示词则 AI 看不到它，模式入口对 AI 不可编排（与计划/自动编辑模式同理）。
  { id: 'enter_auto_permission_mode', name: '进入自动权限模式', category: 'mechanism', description: '进入自动权限模式：本会话内被配置为"每次调用需授权"（require-approval）的工具，逐次授权由主模型自动分类——allow 放行、deny 拒绝、review 才回人工审批。仍受 deny 策略与治理 Hook 约束；LLM 不可用或分类失败自动回退人工审批（绝不意外放行）。需恢复严格确认时调用 exit_auto_permission_mode 退出', defaultEnabled: true, riskLevel: 'low', agents: ['frontend'] },
  { id: 'exit_auto_permission_mode', name: '退出自动权限模式', category: 'mechanism', description: '退出自动权限模式：require-approval 工具恢复每次调用都请求用户授权。适用于不再需要主模型代判权限、或需恢复严格人工确认时', defaultEnabled: true, riskLevel: 'low', agents: ['frontend'] },
  // ===== Notebook 编辑（延迟披露：低频特化工具，Jupyter .ipynb 结构化编辑，AI 先用 tool_search 发现） =====
  { id: 'NotebookEdit', name: '编辑 Notebook', category: 'file-write', description: '按单元格编辑 Jupyter notebook（.ipynb）：edit_mode=replace 重写指定单元格源码（cell_id 或 cell_index 定位）；edit_mode=insert 在定位后插入新单元格（cell_type 必填 code/markdown）；edit_mode=delete 删除定位单元格。参数：notebook_path（必填，绝对路径）/ edit_mode（默认 replace）/ cell_id / cell_index / cell_type（insert 必填，replace 可选改类型）/ new_source（replace/insert 必填）', defaultEnabled: true, riskLevel: 'medium', agents: ['frontend', 'dmn'], deferred: true },
  // ===== 轻量代码智能（1 个，延迟披露：低频特化工具，TS/JS 代码四查询，AI 先用 tool_search 发现） =====
  // 零外部二进制：复用依赖内 typescript 编译器 API，不起外部语言服务器；只读（file-read），与 NotebookEdit 同 deferred 机制。
  { id: 'code_intel', name: '轻量代码智能', category: 'file-read', description: '对 TypeScript/JavaScript 代码提供 LSP 式查询（基于 typescript 编译器 API，零外部二进制）：documentSymbol 顶层符号树 / goToDefinition 跳转定义（支持相对/绝对 import 跨文件）/ findReferences 当前文件引用 / hover 签名摘要。参数：operation（必填，四种其一）/ file_path（必填，绝对路径）/ symbol（符号名）/ line / character（1-based 光标位置）。覆盖 .ts/.tsx/.js/.jsx，其他类型明确提示；纯只读、单文件上限 10MB', defaultEnabled: true, riskLevel: 'low', agents: ['frontend', 'dmn'], deferred: true },
] as const satisfies readonly ToolMeta[]

/**
 * 内置工具 id 字面量联合（由 TOOL_REGISTRY 派生，含 lilith 专属）。
 * electron/main/tools/tool-ctors.ts 用它做编译期一致性校验：ALL_TOOL_CTORS 登记表的 id 必须命中
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

