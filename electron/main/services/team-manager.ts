/**
 * 任务模式（Agent Teams）——TeamManager

 * 多 agent 协作设计 + 月蚀"文件即真相源"哲学：
 * - 纯文件系统实现，无端口无进程：{root}/teams/{teamId}/
 * - config.json 团队配置（成员列表/职责/任务板）
 * - inbox/{id}.json 每个成员一个收件箱（JSON 数组，消息 {from,to,text,ts}）
 * - tasks/{id}.json 任务板（每任务 {id,title,status,assignee,dependsOn,output}）
 * - locks/{path-hash}.lock 文件锁（防两成员同时改同一文件）
 * - 成员身份经 AsyncLocalStorage 注入（同构 sub-agent/manager.ts 的 depth storage）：
 * team_* 工具执行时从 storage 读 {teamId, memberId}，子 agent 内部自动携带
 * - 复用 SubAgentManager.launchBatch(parallel) 跑成员：每个成员独立上下文 + 工具过滤
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, renameSync } from 'fs'
import { join, dirname, basename } from 'path'
import { AsyncLocalStorage } from 'async_hooks'

/** 文件锁过期时间：成员超时/崩溃后残留锁超此时间可被接管，防永久死锁 */
const LOCK_TTL_MS = 60 * 60 * 1000
/** 收件箱消息上限：保留最近 100 条，防历史消息无限累积撑爆成员上下文 */
const MAX_INBOX_MESSAGES = 100
/** 共享记忆条目上限：保留最近 200 条，防团队沉淀无限膨胀（与收件箱上限同理，控制文件体积与注入成本） */
const MAX_MEMORY_ENTRIES = 200

// ===== 类型 =====

/** 团队成员 */
export interface TeamMember {
  id: string
  /** 展示名（如"前端工程师"） */
  name: string
  /** 职责描述（进入成员 systemPrompt） */
  role: string
}

/** 团队任务板条目 */
export interface TeamTask {
  id: string
  title: string
  description?: string
  /** pending=待认领 in_progress=进行中 completed=完成 blocked=依赖未满足 */
  status: 'pending' | 'in_progress' | 'completed' | 'blocked'
  /** 认领成员 id（未认领为空） */
  assignee?: string
  /** 依赖任务 id 列表（全完成后本任务才可认领） */
  dependsOn?: string[]
  /** 成员完成时写入的产出摘要 */
  output?: string
}

/** 团队配置文件（{root}/teams/{teamId}/config.json） */
export interface TeamConfig {
  teamId: string
  name: string
  createdAt: number
  /** Lead 提示词（主对话注入用） */
  leadPrompt?: string
  members: TeamMember[]
  tasks: TeamTask[]
  /** 团队成员共享的目标上下文（目标目录/约束，进每个成员 systemPrompt） */
  goal?: string
}

/** 收件箱消息 */
export interface TeamMessage {
  from: string
  to: string
  text: string
  ts: number
}

/** 团队共享记忆条目（跨成员沉淀的技术规范/决策/偏好，注入每个成员 context） */
export interface TeamMemoEntry {
  /** 稳定 id（写入时生成，防重复注入去重用） */
  id: string
  /** 记忆键（如 "coding-convention" / "api-design"），覆盖写入同名键 */
  key: string
  /** 记忆内容（一句话沉淀：规范/决策/教训） */
  content: string
  /** 写入成员 id（'lead' = 主对话 Lead） */
  author: string
  ts: number
}

/** 当前团队上下文（AsyncLocalStorage 注入，team_* 工具读取） */
export interface TeamContext {
  teamId: string
  memberId: string
}

// ===== AsyncLocalStorage：成员身份注入 =====

const teamContextStorage = new AsyncLocalStorage<TeamContext>()

/** 在团队上下文内执行（SubAgentManager.launchOne 包装用；子 agent 的 async 链自动携带） */
export function runWithTeamContext<T>(ctx: TeamContext, fn: () => Promise<T>): Promise<T> {
  return teamContextStorage.run(ctx, fn)
}

/** 读取当前团队上下文（team_* 工具入口；主对话/非团队成员调用返回 null） */
export function getTeamContext(): TeamContext | null {
  return teamContextStorage.getStore() ?? null
}

// ===== TeamManager =====

export class TeamManager {
  constructor(private teamsRoot: string) {}

  /** 团队根目录 */
  get root(): string {
    return this.teamsRoot
  }

  /** 团队目录 */
  teamDir(teamId: string): string {
    return join(this.teamsRoot, teamId)
  }

/** 成员收件箱路径 */
  inboxPath(teamId: string, memberId: string): string {
    return join(this.teamDir(teamId), 'inbox', `${memberId}.json`)
  }

  /** 共享记忆文件路径（纯文件实现延续月蚀"文件即真相源"哲学；单文件集中，避免碎片化） */
  memoryPath(teamId: string): string {
    return join(this.teamDir(teamId), 'memory.json')
  }

  /** 任务文件路径 */
  taskPath(teamId: string, taskId: string): string {
    return join(this.teamDir(teamId), 'tasks', `${taskId}.json`)
  }

  /** 文件锁路径（按目标文件绝对路径 hash，防跨成员并发写同一文件） */
  lockPath(teamId: string, targetFile: string): string {
    const h = hashString(targetFile)
    return join(this.teamDir(teamId), 'locks', `${h}.lock`)
  }

  // ===== 团队 CRUD =====

  /** 创建团队（建目录 + config.json + 空 inbox/tasks），返回 config */
  createTeam(cfg: Omit<TeamConfig, 'createdAt'>): TeamConfig {
    const dir = this.teamDir(cfg.teamId)
    mkdirSync(join(dir, 'inbox'), { recursive: true })
    mkdirSync(join(dir, 'tasks'), { recursive: true })
    mkdirSync(join(dir, 'locks'), { recursive: true })
    const full: TeamConfig = { ...cfg, createdAt: Date.now() }
    // 每个成员建空收件箱
    for (const m of cfg.members) {
      const p = this.inboxPath(cfg.teamId, m.id)
      if (!existsSync(p)) writeFileSync(p, '[]', 'utf-8')
    }
    // 任务板落盘
    for (const t of cfg.tasks) {
      this.writeTask(cfg.teamId, t)
    }
    this.writeConfig(full)
    return full
  }

  /** 读团队配置（不存在返回 null） */
  readConfig(teamId: string): TeamConfig | null {
    const p = join(this.teamDir(teamId), 'config.json')
    if (!existsSync(p)) return null
    return JSON.parse(readFileSync(p, 'utf-8')) as TeamConfig
  }

  writeConfig(cfg: TeamConfig): void {
    mkdirSync(this.teamDir(cfg.teamId), { recursive: true })
    writeFileSync(join(this.teamDir(cfg.teamId), 'config.json'), JSON.stringify(cfg, null, 2), 'utf-8')
  }

  /** 列出所有团队 */
  listTeams(): TeamConfig[] {
    if (!existsSync(this.teamsRoot)) return []
    return readdirSync(this.teamsRoot)
      .filter((d) => existsSync(join(this.teamsRoot, d, 'config.json')))
      .map((d) => this.readConfig(d))
      .filter((c): c is TeamConfig => c !== null)
  }

  /** 删除团队（整个目录） */
  deleteTeam(teamId: string): boolean {
    const dir = this.teamDir(teamId)
    if (!existsSync(dir)) return false
    rmSync(dir, { recursive: true, force: true })
    return true
  }

  // ===== 任务板 =====

  /** 读单个任务 */
  readTask(teamId: string, taskId: string): TeamTask | null {
    const p = this.taskPath(teamId, taskId)
    if (!existsSync(p)) return null
    return JSON.parse(readFileSync(p, 'utf-8')) as TeamTask
  }

  /** 写任务（原子：先 .tmp 再 rename） */
  writeTask(teamId: string, task: TeamTask): void {
    mkdirSync(dirname(this.taskPath(teamId, task.id)), { recursive: true })
    const p = this.taskPath(teamId, task.id)
    writeFileSync(p + '.tmp', JSON.stringify(task, null, 2), 'utf-8')
    try {
      // Windows 同盘 rename 原子
      renameSync(p + '.tmp', p)
    } catch {
      writeFileSync(p, JSON.stringify(task, null, 2), 'utf-8')
    }
  }

  /** 读全部任务 */
  readTasks(teamId: string): TeamTask[] {
    const dir = join(this.teamDir(teamId), 'tasks')
    if (!existsSync(dir)) return []
    return readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf-8')) as TeamTask)
      .filter((t): t is TeamTask => t !== null)
  }

  /**
   * 任务状态更新（带依赖校验 + 认领人校验）：
   * - 认领：pending → in_progress（assignee 写入；依赖未完成 → blocked）
   * - 完成：in_progress → completed（需 assignee 匹配；写入 output）
   * - 更新 assignee/output/description 打补丁
   */
  updateTask(
    teamId: string,
    taskId: string,
    patch: { status?: TeamTask['status']; assignee?: string; output?: string; description?: string },
    operator: string
  ): { ok: boolean; error?: string; task?: TeamTask } {
    const task = this.readTask(teamId, taskId)
    if (!task) return { ok: false, error: `任务不存在: ${taskId}` }

    // 认领校验：改状态必须认领人 = 操作者（Lead 操作员豁免）
    if (patch.status && operator !== 'lead' && task.assignee && task.assignee !== operator) {
      return { ok: false, error: `任务 ${taskId} 已被 ${task.assignee} 认领，你（${operator}）不能修改` }
    }

    const next: TeamTask = { ...task }

    if (patch.assignee !== undefined) next.assignee = patch.assignee
    if (patch.output !== undefined) next.output = patch.output
    if (patch.description !== undefined) next.description = patch.description

    if (patch.status) {
          if (patch.status === 'in_progress') {
            // 终态守卫：已完成任务不可再认领
            if (task.status === 'completed') {
              return { ok: false, error: `任务 ${taskId} 已完成（终态），不能重复认领；如需返工请 Lead 用 update 指派返工` }
            }
            // 认领：检查依赖
            const deps = task.dependsOn ?? []
        const unmet = deps.filter((d) => this.readTask(teamId, d)?.status !== 'completed')
        if (unmet.length > 0) {
          next.status = 'blocked'
          next.assignee = next.assignee ?? operator
          this.writeTask(teamId, next)
          return { ok: false, error: `依赖未完成（${unmet.join(', ')}），任务置为 blocked`, task: next }
        }
        next.status = 'in_progress'
        next.assignee = next.assignee ?? operator
      } else if (patch.status === 'completed') {
        if (next.status !== 'in_progress' && next.status !== 'blocked') {
          return { ok: false, error: `任务 ${taskId} 未认领，不能直接完成` }
        }
        next.status = 'completed'
      } else {
        next.status = patch.status
      }
    }
    this.writeTask(teamId, next)
    return { ok: true, task: next }
  }

  // ===== 收件箱 =====

/** 读成员收件箱（只返回最近 MAX_INBOX_MESSAGES 条，防历史膨胀） */
  readInbox(teamId: string, memberId: string): TeamMessage[] {
    const p = this.inboxPath(teamId, memberId)
    if (!existsSync(p)) return []
    try {
      const box = JSON.parse(readFileSync(p, 'utf-8')) as TeamMessage[]
      return box.length > MAX_INBOX_MESSAGES ? box.slice(-MAX_INBOX_MESSAGES) : box
    } catch {
      return []
    }
  }

  /** 发消息（写入目标成员收件箱；to='all' 广播全员） */
  sendMessage(teamId: string, cfg: TeamConfig, msg: Omit<TeamMessage, 'ts'>): { ok: boolean; error?: string; delivered: string[] } {
    const targets = msg.to === 'all' ? cfg.members.map((m) => m.id) : [msg.to]
    const delivered: string[] = []
    for (const tid of targets) {
      if (!cfg.members.some((m) => m.id === tid)) {
        return { ok: false, error: `成员不存在: ${tid}`, delivered }
      }
const p = this.inboxPath(teamId, tid)
      mkdirSync(dirname(p), { recursive: true })
      const box = this.readInbox(teamId, tid)
      box.push({ ...msg, to: tid, ts: Date.now() })
      // 写入时也截断（readInbox 只截读取视图；这里防文件本身无限膨胀）
      const trimmed = box.length > MAX_INBOX_MESSAGES ? box.slice(-MAX_INBOX_MESSAGES) : box
      writeFileSync(p, JSON.stringify(trimmed, null, 2), 'utf-8')
      delivered.push(tid)
    }
    return { ok: true, delivered }
  }

/** 清空成员收件箱（读后清，防重复处理） */
  clearInbox(teamId: string, memberId: string): void {
    writeFileSync(this.inboxPath(teamId, memberId), '[]', 'utf-8')
  }

  // ===== 共享记忆 =====
  //
  // 为什么存在：成员子 agent 各自独立上下文，消息/任务板只覆盖"当前协作过程"，
  // 跨成员沉淀的规范/决策/教训（如"统一用 TS strict 模式""auth 接口返回格式为 X"）
  // 无处落地，下一次任务又会重复踩坑。共享记忆给出团队级持久化 + 成员开局注入，
  // 对齐 2026 主流多 agent 框架的团队记忆能力（业界通行的共享记忆模式）。
  // 留存理由：低风险纯文件读写（无新依赖/无网络），对团队协作价值大。

  /** 读全部共享记忆（返回最近 MAX_MEMORY_ENTRIES 条，防文件/注入膨胀） */
  readMemos(teamId: string): TeamMemoEntry[] {
    const p = this.memoryPath(teamId)
    if (!existsSync(p)) return []
    try {
      const memos = JSON.parse(readFileSync(p, 'utf-8')) as TeamMemoEntry[]
      if (!Array.isArray(memos)) return []
      return memos.length > MAX_MEMORY_ENTRIES ? memos.slice(-MAX_MEMORY_ENTRIES) : memos
    } catch {
      // 记忆文件损坏（手改/中断写）：不抛错拖垮团队，视为无记忆；下次写入重建
      return []
    }
  }

  /**
   * 写入一条共享记忆（按 key 覆盖旧值，防同名条目堆积；同 key 更新只是换 content，不新增行）。
   * 为什么存在：记忆要有"修正/演进"能力（规范改版直接覆盖，而不是 1.0/2.0 并存），
   * 且按 key 去重控制注入体积。返回整列表最新视图供工具直接透出。
   */
  writeMemo(
    teamId: string,
    memo: { key: string; content: string; author: string }
  ): { ok: boolean; error?: string; memos?: TeamMemoEntry[] } {
    const key = memo.key.trim()
    const content = memo.content.trim()
    if (!key || !content) return { ok: false, error: 'memo key 和 content 不能为空' }
    // key 只允许安全字符（防路径穿越/注入特殊字符污染 prompt 结构）
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(key)) {
      return { ok: false, error: 'memo key 只允许字母数字 _ -（最长 64）' }
    }
    const list = this.readMemos(teamId)
    const prev = list.find((m) => m.key === key)
    const entry: TeamMemoEntry = {
      id: prev?.id ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      key,
      content,
      author: memo.author.trim() || 'unknown',
      ts: Date.now()
    }
    // 覆盖同名 key（保持 id 稳定）或追加新条目
    const next = prev ? list.map((m) => (m.key === key ? entry : m)) : [...list, entry]
    const trimmed = next.length > MAX_MEMORY_ENTRIES ? next.slice(-MAX_MEMORY_ENTRIES) : next
    try {
      mkdirSync(this.teamDir(teamId), { recursive: true })
      const p = this.memoryPath(teamId)
      // 原子写：先 .tmp 再 rename（与 writeTask 同模式，防中断写坏记忆文件）
      writeFileSync(p + '.tmp', JSON.stringify(trimmed, null, 2), 'utf-8')
      try {
        renameSync(p + '.tmp', p)
      } catch {
        writeFileSync(p, JSON.stringify(trimmed, null, 2), 'utf-8')
      }
      return { ok: true, memos: trimmed }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  }

  /** 按 key 精确读一条记忆（工具查询用；无则 null） */
  readMemo(teamId: string, key: string): TeamMemoEntry | null {
    return this.readMemos(teamId).find((m) => m.key === key) ?? null
  }

  // ===== 文件锁 =====

/** 获取文件锁（认领独占写权限）。锁有过期时间（LOCK_TTL_MS）：成员超时/崩溃后残留锁可被接管，防永久死锁。
   * @returns ok=true 成功；ok=false 已锁（error 说明持有者）；已过期时自动接管并返回 ok=true
   */
  acquireLock(teamId: string, targetFile: string, holder: string): { ok: boolean; error?: string; lock?: { path: string; holder: string; ts: number } } {
    const p = this.lockPath(teamId, targetFile)
    mkdirSync(dirname(p), { recursive: true })
    if (existsSync(p)) {
      const l = JSON.parse(readFileSync(p, 'utf-8')) as { holder: string; ts: number }
      // TTL 过期：锁 ts 距今超 LOCK_TTL_MS 视为崩溃残留，接管覆盖（返回提示不阻断）
      if (Date.now() - (l.ts ?? 0) < LOCK_TTL_MS) {
        return { ok: false, error: `文件已被 ${l.holder} 锁定（${basename(targetFile)}）`, lock: { path: p, holder: l.holder, ts: l.ts } }
      }
    }
    const lock = { path: p, holder, ts: Date.now(), targetFile }
    writeFileSync(p, JSON.stringify(lock, null, 2), 'utf-8')
    return { ok: true, lock }
  }

  /** 释放文件锁 */
  releaseLock(teamId: string, targetFile: string, holder: string): { ok: boolean; error?: string } {
    const p = this.lockPath(teamId, targetFile)
    if (!existsSync(p)) return { ok: true }
    const l = JSON.parse(readFileSync(p, 'utf-8')) as { holder: string }
    if (l.holder !== holder) return { ok: false, error: `锁属于 ${l.holder}，你不能释放` }
    rmSync(p, { force: true })
    return { ok: true }
  }

  /** 列出当前全部锁 */
  listLocks(teamId: string): Array<{ targetFile: string; holder: string; ts: number }> {
    const dir = join(this.teamDir(teamId), 'locks')
    if (!existsSync(dir)) return []
    return readdirSync(dir)
      .filter((f) => f.endsWith('.lock'))
      .map((f) => {
        try {
          return JSON.parse(readFileSync(join(dir, f), 'utf-8')) as { targetFile?: string; holder: string; ts: number }
        } catch {
          return null
        }
      })
      .filter((l): l is { targetFile?: string; holder: string; ts: number } => l !== null)
      .map((l) => ({ targetFile: l.targetFile ?? '', holder: l.holder, ts: l.ts }))
  }
}

/** 简易字符串 hash（文件锁路径用，稳定即可） */
function hashString(s: string): string {
  let h = 0
  for (let i = 0; i < s.length; i++) {
    h = (h << 5) - h + s.charCodeAt(i)
    h |= 0
  }
  return Math.abs(h).toString(36)
}

/** 默认团队根目录（{root}/teams） */
export function defaultTeamsRoot(dataRoot: string): string {
  return join(dataRoot, 'teams')
}

/** 时间戳可读化 */
export function fmtTs(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 校验 teamId 合法（防路径穿越：只允许字母数字-_） */
export function isValidTeamId(id: string): boolean {
  return /^[a-zA-Z0-9_-]{1,64}$/.test(id)
}

/** 校验成员 id 合法 */
export function isValidMemberId(id: string): boolean {
  return /^[a-zA-Z0-9_-]{1,64}$/.test(id)
}
