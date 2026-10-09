/**
 * 任务模式（Agent Teams）——团队工具集

 * 角色模型：
 * - Lead（主对话月蚀）：team_create 拆任务建团队 → team_launch 并行启动成员 → team_merge 汇总
 * - Member（子 agent）：team_inbox 读消息 / team_message 发消息 / team_task 认领与完成任务 / team_lock 文件锁

 * 身份机制：成员子 agent 由 SubAgentManager.launchOne 经 runWithTeamContext 注入
 * {teamId, memberId}（AsyncLocalStorage），team_* 工具执行时从 getTeamContext() 读取。
 * Lead 操作（主对话上下文无 teamContext）必须显式传 teamId，operator 视为 'lead'。
 */
import type { Tool, ToolResult, ToolContext } from './base-tool'
import {
  TeamManager,
  getTeamContext,
  isValidTeamId,
  isValidMemberId,
  fmtTs,
type TeamConfig,
  type TeamTask,
  type TeamMember
} from '../services/team-manager'
// 成员提示词统一集中管理（prompts/team.ts），本文件只保留工具执行逻辑
import { buildMemberPrompt } from '../prompts/team'

const MEMBER_DEFAULT_TIMEOUT_MS = 600000  // 10 分钟（团队任务需读多文件+写文件+成员通信）
const MEMBER_DISALLOWED_TOOLS = ['app_restart']

/** 取 TeamManager（ctx 注入；缺失报错） */
function getManager(ctx?: ToolContext): TeamManager {
  if (!ctx?.teamManager) {
    throw new Error('TeamManager 未注入（任务模式未启用？）')
  }
  return ctx.teamManager
}

/** 从上下文或显式参数解析团队身份；返回 { teamId, memberId | 'lead' } */
function resolveIdentity(
  ctx: ToolContext,
  explicitTeamId?: string,
  explicitMemberId?: string
): { teamId: string; memberId: string } {
  const tc = getTeamContext()
  if (tc) {
    return { teamId: explicitTeamId ?? tc.teamId, memberId: explicitMemberId ?? tc.memberId }
  }
  // 主对话（Lead）操作：必须显式传 teamId，memberId 视为 'lead'
  if (!explicitTeamId) {
    throw new Error('缺少 teamId（主对话操作必须显式传团队 id；团队成员操作由系统自动注入身份）')
  }
  return { teamId: explicitTeamId, memberId: explicitMemberId ?? 'lead' }
}

/** 校验团队存在 + 读配置 */
function requireConfig(manager: TeamManager, teamId: string): TeamConfig {
  const cfg = manager.readConfig(teamId)
  if (!cfg) {
    throw new Error(`团队不存在: ${teamId}（先 team_create 创建，或查 team_list）`)
  }
  return cfg
}

// ===== team_create：Lead 拆任务、建团队、初始化任务板 =====

interface TeamCreateParams {
  name: string
  goal?: string
  members: Array<{ id?: string; name: string; role: string }>
  tasks: Array<{ id?: string; title: string; description?: string; dependsOn?: string[] }>
}

export class TeamCreateTool implements Tool<TeamCreateParams> {
  name = 'team_create'
  description =
    '任务模式：作为 Team Lead 创建一支 AI 团队（纯本地文件，成员由 team_launch 并行启动）。参数：name（团队名）/ goal（团队共同目标，进每个成员上下文）/ members（必填，成员数组 [{name: 成员名, role: 职责描述}]，id 可省略自动生成）/ tasks（必填，任务板 [{title, description?, dependsOn? 依赖任务 id 数组}]，id 可省略自动生成）。返回 teamId + 成员 id 映射 + 任务 id 映射。创建后调用 team_launch 启动成员并行执行。'
  parameters = [
    { name: 'name', type: 'string' as const, description: '团队名（如"重构团队"）', required: true },
    { name: 'goal', type: 'string' as const, description: '团队共同目标（进每个成员 systemPrompt，如"把认证模块重构为 TypeScript"）', required: false },
    { name: 'members', type: 'array' as const, description: '成员数组，每项 {name: 成员名, role: 职责描述}，id 可省略自动生成', required: true },
    { name: 'tasks', type: 'array' as const, description: '任务板数组，每项 {title: 任务标题, description?: 任务详情, dependsOn?: 依赖任务 id 数组}', required: true }
  ]

  async execute(params: TeamCreateParams, ctx?: ToolContext): Promise<ToolResult> {
    try {
      const manager = getManager(ctx)
      if (!params.name?.trim()) return { ok: false, error: 'name 不能为空' }
      if (!Array.isArray(params.members) || params.members.length === 0) {
        return { ok: false, error: 'members 必须是非空数组' }
      }
      if (!Array.isArray(params.tasks) || params.tasks.length === 0) {
        return { ok: false, error: 'tasks 必须是非空数组（先拆解任务再建团队）' }
      }

      const teamId = `team_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
      const members: TeamMember[] = params.members.map((m, i) => ({
        id: m.id && isValidMemberId(m.id) ? m.id : `m${i + 1}`,
        name: m.name?.trim() || `成员${i + 1}`,
        role: m.role?.trim() || ''
      }))
      const tasks: TeamTask[] = params.tasks.map((t, i) => ({
        id: t.id && isValidMemberId(t.id) ? t.id : `t${i + 1}`,
        title: t.title?.trim() || `任务${i + 1}`,
        description: t.description,
        status: 'pending' as const,
        dependsOn: t.dependsOn
      }))

      const cfg = manager.createTeam({ teamId, name: params.name.trim(), goal: params.goal, members, tasks })
      return {
        ok: true,
        data: {
          teamId,
          name: cfg.name,
          members: members.map((m) => ({ id: m.id, name: m.name, role: m.role })),
          tasks: tasks.map((t) => ({ id: t.id, title: t.title, status: t.status, dependsOn: t.dependsOn })),
          inboxDir: manager.inboxPath(teamId, members[0]?.id ?? ''),
          hint: '现在调用 team_launch { teamId } 并行启动成员执行'
        }
      }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  }
}

// ===== team_launch：Lead 并行启动所有成员（复用 SubAgentManager.launchBatch parallel） =====

interface TeamLaunchParams {
  teamId: string
  /** 每成员最大轮次（2026-10-02 取消默认上限：不传即不限制，由超时兜底） */
  maxTurns?: number
  /** 每成员超时毫秒（默认 10 分钟；团队任务要读多文件+写文件+成员通信，3 分钟太紧会被硬掐断，与全局子 agent 兜底一致） */
  timeoutMs?: number
  /** 给所有成员的附加指令（追加到成员 systemPrompt 尾部） */
  extraInstruction?: string
}

export class TeamLaunchTool implements Tool<TeamLaunchParams> {
  name = 'team_launch'
  description =
    '任务模式：Team Lead 并行启动团队所有成员干活（复用子 agent 引擎，每个成员独立上下文 + 完整工具，成员间用 team_message/team_inbox 通信、team_task 认领任务、team_lock 文件锁）。参数：teamId（team_create 返回的团队 id）/ maxTurns 每成员最大轮次（默认不限制，由超时兜底）/ timeoutMs 每成员超时毫秒默认 600000=10 分钟 / extraInstruction 给所有成员的附加指令。成员完成或超时后返回各成员输出数组。所有成员结束后调用 team_merge 汇总。'
  parameters = [
    { name: 'teamId', type: 'string' as const, description: '团队 id（team_create 返回）', required: true },
    { name: 'maxTurns', type: 'number' as const, description: '每成员最大轮次（默认不限制，由 timeoutMs 兜底）', required: false },
    { name: 'timeoutMs', type: 'number' as const, description: '每成员超时毫秒（默认 600000=10 分钟）', required: false },
    { name: 'extraInstruction', type: 'string' as const, description: '给所有成员的附加指令', required: false }
  ]

  async execute(params: TeamLaunchParams, ctx?: ToolContext): Promise<ToolResult> {
    try {
      const manager = getManager(ctx)
      if (!isValidTeamId(params.teamId)) return { ok: false, error: 'teamId 非法' }
      const cfg = requireConfig(manager, params.teamId)
      if (!ctx?.launchSubAgent) return { ok: false, error: 'launchSubAgent 未初始化' }

// 构造每个成员的 SubAgentTask：独立 systemPrompt（角色 + 目标 + 任务板 + 协作工具用法 + 共享记忆）
      // 默认超时 10 分钟：团队任务要读多文件+写文件+成员通信，3 分钟太紧会被硬掐断；需更短可显式传 timeoutMs
      const memberTimeoutMs = params.timeoutMs ?? MEMBER_DEFAULT_TIMEOUT_MS
      // 启动时快照共享记忆一次性注入（成员各自读盘会读到别的成员中途写入的新记忆，导致上下文漂移；
      // 开局快照 + 工具可实时读写，兼顾一致性与灵活性）
      const memos = manager.readMemos(cfg.teamId)
      const tasks = cfg.members.map((m) => ({
        prompt: buildMemberPrompt(cfg, m, memos),
        teamContext: { teamId: cfg.teamId, memberId: m.id },
        maxTurns: params.maxTurns,
        timeoutMs: memberTimeoutMs,
        // 成员工具白名单：文件/搜索/记忆基础 + 团队协作工具 + 浏览器等（复用默认全量，仅排除危险写系统工具）
        disallowedTools: MEMBER_DISALLOWED_TOOLS
      }))

      const outputs = await ctx.launchSubAgent(tasks, 'parallel')
      const results = cfg.members.map((m, i) => {
        const r = outputs[i] as { output?: string; timedOut?: boolean; error?: string; turns?: number } | undefined
        return {
          memberId: m.id,
          name: m.name,
          output: r?.output ?? '',
          // 透传超时/错误给 Lead
          timedOut: r?.timedOut ?? false,
          error: r?.error,
          turns: r?.turns
        }
      })

// 更新任务板：成员输出回填到其认领的任务（completed 任务）。
      // 为什么不截断：完整输出直接写入任务板/回传 Lead，不再做 2000 字符硬截断；
      // 原 MEMBER_OUTPUT_TRUNCATE=2000 会把成员长输出悄悄丢掉，团队模式下"成员写了什么"必须可复用，故删除该截断。
      // 超时/报错成员不覆盖产出摘要（避免把失败碎片当真成果）
      const taskBoard = manager.readTasks(cfg.teamId)
      for (const r of results) {
        if (r.timedOut || r.error) continue
        const owned = taskBoard.filter((t) => t.assignee === r.memberId && t.status === 'completed')
        for (const t of owned) {
          manager.updateTask(cfg.teamId, t.id, { output: r.output ?? '' }, r.memberId)
        }
      }

      return { ok: true, data: { teamId: cfg.teamId, members: results } }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  }
}

// ===== team_list：查看团队/成员/任务板状态 =====

interface TeamListParams {
  teamId?: string
}

export class TeamListTool implements Tool<TeamListParams> {
  name = 'team_list'
  description =
    '任务模式：查看团队状态。参数：teamId（选填；填了返回该团队详细状态（成员/任务板/消息/锁），不填返回全部团队列表）。'
  parameters = [{ name: 'teamId', type: 'string' as const, description: '团队 id（选填）', required: false }]

  async execute(params: TeamListParams, ctx?: ToolContext): Promise<ToolResult> {
    try {
      const manager = getManager(ctx)
      if (params.teamId) {
        if (!isValidTeamId(params.teamId)) return { ok: false, error: 'teamId 非法' }
        const cfg = requireConfig(manager, params.teamId)
        const tasks = manager.readTasks(cfg.teamId)
        const inboxes = cfg.members.map((m) => ({
          memberId: m.id,
          name: m.name,
          messages: manager.readInbox(cfg.teamId, m.id)
        }))
        const locks = manager.listLocks(cfg.teamId)
        return {
          ok: true,
          data: {
            teamId: cfg.teamId,
            name: cfg.name,
            goal: cfg.goal,
            createdAt: fmtTs(cfg.createdAt),
            members: cfg.members,
            tasks,
            inboxes: inboxes.map((b) => ({
              memberId: b.memberId,
              name: b.name,
              unread: b.messages.length,
              messages: b.messages.map((msg) => ({ from: msg.from, to: msg.to, text: msg.text, ts: fmtTs(msg.ts) }))
            })),
            locks: locks.map((l) => ({ targetFile: l.targetFile, holder: l.holder, ts: fmtTs(l.ts) }))
          }
        }
      }
      const teams = manager.listTeams().map((t) => ({
        teamId: t.teamId,
        name: t.name,
        memberCount: t.members.length,
        taskCount: t.tasks.length,
        createdAt: fmtTs(t.createdAt)
      }))
      return { ok: true, data: { teams } }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  }
}

// ===== team_message：成员间通信 =====

interface TeamMessageParams {
  teamId?: string
  to: string
  text: string
}

export class TeamMessageTool implements Tool<TeamMessageParams> {
  name = 'team_message'
  description =
    '任务模式：给团队成员发消息（成员间直接通信，写目标成员收件箱；主对话 Lead 也可用）。参数：to（必填，目标成员 id 或 all 广播全员）/ text（必填，消息内容）/ teamId（主对话 Lead 操作时必填，成员操作自动识别）。'
  parameters = [
    { name: 'teamId', type: 'string' as const, description: '团队 id（主对话 Lead 操作时必填；成员操作自动识别可省略）', required: false },
    { name: 'to', type: 'string' as const, description: '目标成员 id（如 m2），或 all 广播全员', required: true },
    { name: 'text', type: 'string' as const, description: '消息内容', required: true }
  ]

  async execute(params: TeamMessageParams, ctx?: ToolContext): Promise<ToolResult> {
    try {
      const manager = getManager(ctx)
      const { teamId, memberId } = resolveIdentity(ctx!, params.teamId)
      if (!isValidTeamId(teamId)) return { ok: false, error: 'teamId 非法' }
      if (!params.to?.trim() || !params.text?.trim()) return { ok: false, error: 'to 和 text 不能为空' }
      const cfg = requireConfig(manager, teamId)
      const res = manager.sendMessage(teamId, cfg, { from: memberId, to: params.to.trim(), text: params.text.trim() })
      if (!res.ok) return { ok: false, error: res.error ?? '发送失败' }
      return { ok: true, data: { delivered: res.delivered } }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  }
}

// ===== team_inbox：读收件箱 =====

interface TeamInboxParams {
  teamId?: string
  /** 清空收件箱（读完清理防重复处理；默认 false） */
  clear?: boolean
}

export class TeamInboxTool implements Tool<TeamInboxParams> {
  name = 'team_inbox'
  description =
    '任务模式：查看自己的收件箱（别人发来的消息，含历史；成员每次干活前先看）。参数：clear（选填，true=读完清空防重复处理，默认 false）/ teamId（主对话 Lead 查任意成员时需显式传，成员操作自动识别）。返回消息数组 [{from,to,text,ts}]。'
  parameters = [
    { name: 'teamId', type: 'string' as const, description: '团队 id（成员操作自动识别可省略；Lead 查询需显式传）', required: false },
    { name: 'clear', type: 'boolean' as const, description: 'true=读完清空收件箱（默认 false）', required: false }
  ]

  async execute(params: TeamInboxParams, ctx?: ToolContext): Promise<ToolResult> {
    try {
      const manager = getManager(ctx)
      const { teamId, memberId } = resolveIdentity(ctx!, params.teamId)
      if (!isValidTeamId(teamId)) return { ok: false, error: 'teamId 非法' }
      requireConfig(manager, teamId)
      const messages = manager.readInbox(teamId, memberId)
      if (params.clear === true) manager.clearInbox(teamId, memberId)
      return {
        ok: true,
        data: {
          memberId,
          messages: messages.map((m) => ({ from: m.from, to: m.to, text: m.text, ts: fmtTs(m.ts) }))
        }
      }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  }
}

// ===== team_task：任务板认领/更新/完成 =====

interface TeamTaskParams {
  teamId?: string
  action: 'list' | 'claim' | 'complete' | 'update'
  taskId?: string
  /** complete/update 时的产出摘要 */
  output?: string
  /** update 时改描述 */
  description?: string
}

export class TeamTaskTool implements Tool<TeamTaskParams> {
  name = 'team_task'
  description =
    '任务模式：操作团队任务板。参数：action（必填，list=查看全部任务 / claim=认领任务 / complete=完成任务 / update=更新任务描述或产出）/ taskId（claim/complete/update 时必填）/ output（complete 时必填，产出摘要）/ description（update 时可选，新描述）/ teamId（主对话 Lead 操作时必填）。认领依赖未完成的任务会被置为 blocked。'
  parameters = [
    { name: 'teamId', type: 'string' as const, description: '团队 id（主对话 Lead 操作时必填；成员操作自动识别可省略）', required: false },
    { name: 'action', type: 'string' as const, description: 'list / claim / complete / update', required: true },
    { name: 'taskId', type: 'string' as const, description: '任务 id（claim/complete/update 时必填）', required: false },
    { name: 'output', type: 'string' as const, description: 'complete 时必填：产出摘要', required: false },
    { name: 'description', type: 'string' as const, description: 'update 时可选：新描述', required: false }
  ]

  async execute(params: TeamTaskParams, ctx?: ToolContext): Promise<ToolResult> {
    try {
      const manager = getManager(ctx)
      const { teamId, memberId } = resolveIdentity(ctx!, params.teamId)
      if (!isValidTeamId(teamId)) return { ok: false, error: 'teamId 非法' }
      requireConfig(manager, teamId)

      if (params.action === 'list' || !params.action) {
        const tasks = manager.readTasks(teamId)
        return {
          ok: true,
          data: {
            tasks: tasks.map((t) => ({
              id: t.id,
              title: t.title,
              status: t.status,
              assignee: t.assignee,
              dependsOn: t.dependsOn,
              output: t.output
            }))
          }
        }
      }

      if (!params.taskId) return { ok: false, error: `action=${params.action} 需要 taskId` }

      switch (params.action) {
        case 'claim': {
          const res = manager.updateTask(teamId, params.taskId, { status: 'in_progress' }, memberId)
          if (!res.ok && res.error?.includes('依赖')) {
            return { ok: true, data: { task: res.task, blocked: true, message: res.error } }
          }
          if (!res.ok) return { ok: false, error: res.error }
          return { ok: true, data: { task: { id: res.task!.id, title: res.task!.title, status: res.task!.status, assignee: res.task!.assignee } } }
        }
        case 'complete': {
          if (!params.output?.trim()) return { ok: false, error: 'complete 需要 output（产出摘要）' }
          const res = manager.updateTask(teamId, params.taskId, { status: 'completed', output: params.output.trim() }, memberId)
          if (!res.ok) return { ok: false, error: res.error }
          return { ok: true, data: { task: { id: res.task!.id, title: res.task!.title, status: res.task!.status } } }
        }
        case 'update': {
          const patch: { description?: string; output?: string } = {}
          if (params.description !== undefined) patch.description = params.description
          if (params.output !== undefined) patch.output = params.output
          if (Object.keys(patch).length === 0) return { ok: false, error: 'update 需要 description 或 output' }
          const res = manager.updateTask(teamId, params.taskId, patch, memberId)
          if (!res.ok) return { ok: false, error: res.error }
          return { ok: true, data: { task: res.task } }
        }
        default:
          return { ok: false, error: `未知 action: ${params.action}` }
      }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  }
}

// ===== team_lock：文件锁管理（lock/unlock 合一，防并发写同一文件） =====

interface TeamLockParams {
  teamId?: string
  filePath: string
}

export class TeamLockTool implements Tool<TeamLockParams> {
  name = 'team_lock'
  description =
    '任务模式：文件锁管理（防成员并发写同一文件冲突）。action=lock（默认，写文件前调用）/ unlock（写完后释放）。参数：filePath（必填）/ action（可选，默认 lock）/ teamId（主对话 Lead 操作时必填）。lock 时若文件已被他人锁定返回持有者；unlock 时只有锁持有者能释放。'
  parameters = [
    { name: 'action', type: 'string' as const, description: 'lock（锁定，默认）或 unlock（解锁）', required: false },
    { name: 'teamId', type: 'string' as const, description: '团队 id（成员操作自动识别可省略）', required: false },
    { name: 'filePath', type: 'string' as const, description: '目标文件绝对路径', required: true }
  ]

  async execute(params: TeamLockParams & { action?: string }, ctx?: ToolContext): Promise<ToolResult> {
    try {
      const manager = getManager(ctx)
      const { teamId, memberId } = resolveIdentity(ctx!, params.teamId)
      if (!isValidTeamId(teamId)) return { ok: false, error: 'teamId 非法' }
      requireConfig(manager, teamId)
      if (!params.filePath?.trim()) return { ok: false, error: 'filePath 不能为空' }
      const action = params.action === 'unlock' ? 'unlock' : 'lock'
      if (action === 'lock') {
        const res = manager.acquireLock(teamId, params.filePath.trim(), memberId)
        if (!res.ok) return { ok: false, error: res.error ?? '锁定失败' }
        return { ok: true, data: { locked: true, holder: memberId, targetFile: params.filePath.trim() } }
      } else {
        const res = manager.releaseLock(teamId, params.filePath.trim(), memberId)
        if (!res.ok) return { ok: false, error: res.error }
        return { ok: true, data: { locked: false, targetFile: params.filePath.trim() } }
      }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  }
}

// ===== team_memory：团队共享记忆（读写团队级沉淀，业界通行的团队共享记忆机制） =====

interface TeamMemoryParams {
  teamId?: string
  action: 'list' | 'set' | 'get'
  key?: string
  content?: string
}

export class TeamMemoryTool implements Tool<TeamMemoryParams> {
  name = 'team_memory'
  description =
    '任务模式：读写团队共享记忆（团队级持久沉淀，跨成员复用规范/决策/教训，成员开局会自动收到最近 20 条）。参数：action（必填，list=查看全部 / set=写入一条 / get=按 key 精确查）/ key（set/get 时必填，仅字母数字_ -）/ content（set 时必填，沉淀内容）/ teamId（主对话 Lead 操作时必填）。写相同 key 覆盖旧值（演进式更新）。'
  parameters = [
    { name: 'teamId', type: 'string' as const, description: '团队 id（主对话 Lead 操作时必填；成员操作自动识别可省略）', required: false },
    { name: 'action', type: 'string' as const, description: 'list / set / get', required: true },
    { name: 'key', type: 'string' as const, description: '记忆键（set/get 时必填，仅字母数字_ -，最长 64）', required: false },
    { name: 'content', type: 'string' as const, description: 'set 时必填：要沉淀的内容（规范/决策/教训一句话）', required: false }
  ]

  async execute(params: TeamMemoryParams, ctx?: ToolContext): Promise<ToolResult> {
    try {
      const manager = getManager(ctx)
      const { teamId, memberId } = resolveIdentity(ctx!, params.teamId)
      if (!isValidTeamId(teamId)) return { ok: false, error: 'teamId 非法' }
      requireConfig(manager, teamId)

      switch (params.action) {
        case 'list': {
          const memos = manager.readMemos(teamId)
          return {
            ok: true,
            data: {
              memos: memos.map((mm) => ({ key: mm.key, content: mm.content, author: mm.author, ts: fmtTs(mm.ts) }))
            }
          }
        }
        case 'set': {
          if (!params.key || !params.content?.trim()) return { ok: false, error: 'set 需要 key 和 content' }
          const res = manager.writeMemo(teamId, { key: params.key, content: params.content, author: memberId })
          if (!res.ok) return { ok: false, error: res.error }
          return {
            ok: true,
            data: { key: params.key, written: true, total: res.memos?.length ?? 0 }
          }
        }
        case 'get': {
          if (!params.key) return { ok: false, error: 'get 需要 key' }
          const mm = manager.readMemo(teamId, params.key)
          if (!mm) return { ok: true, data: { key: params.key, found: false } }
          return { ok: true, data: { key: mm.key, content: mm.content, author: mm.author, ts: fmtTs(mm.ts), found: true } }
        }
        default:
          return { ok: false, error: `未知 action: ${params.action}` }
      }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  }
}

// ===== team_merge：Lead 汇总所有成员产出 =====

interface TeamMergeParams {
  teamId: string
}

export class TeamMergeTool implements Tool<TeamMergeParams> {
  name = 'team_merge'
  description =
    '任务模式：Team Lead 汇总团队成果——收集所有成员输出 + 任务板状态 + 成员消息流，生成合并报告。参数：teamId（必填）。所有成员执行结束后调用（team_launch 返回后）。'
  parameters = [{ name: 'teamId', type: 'string' as const, description: '团队 id', required: true }]

  async execute(params: TeamMergeParams, ctx?: ToolContext): Promise<ToolResult> {
    try {
      const manager = getManager(ctx)
      if (!isValidTeamId(params.teamId)) return { ok: false, error: 'teamId 非法' }
      const cfg = requireConfig(manager, params.teamId)
      const tasks = manager.readTasks(cfg.teamId)
      const inboxes = cfg.members.map((m) => ({
        memberId: m.id,
        name: m.name,
        messages: manager.readInbox(cfg.teamId, m.id)
      }))

      const report = {
        teamId: cfg.teamId,
        name: cfg.name,
        goal: cfg.goal,
        members: cfg.members,
        taskSummary: tasks.map((t) => ({
          id: t.id,
          title: t.title,
          status: t.status,
          assignee: t.assignee,
          output: t.output ?? null
        })),
        completed: tasks.filter((t) => t.status === 'completed').length,
        total: tasks.length,
        messageFlow: inboxes
          .map((b) => b.messages.map((msg) => ({ from: msg.from, to: msg.to, text: msg.text, ts: msg.ts, box: b.memberId })))
          .flat()
          .sort((a, b) => a.ts - b.ts)
          .map((m) => ({ from: m.from, to: m.to, text: m.text, ts: fmtTs(m.ts), box: m.box })),
        locks: manager.listLocks(cfg.teamId)
      }

      // 汇总后清理锁（团队收尾）
      for (const l of report.locks) {
        manager.releaseLock(cfg.teamId, l.targetFile, l.holder)
      }

      return { ok: true, data: report }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  }
}
