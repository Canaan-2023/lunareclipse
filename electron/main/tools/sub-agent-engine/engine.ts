/**
 * sub-agent-engine / engine.ts
 * 子 agent 引擎核心
 * 为什么存在：子 agent 的健康运转需要生命周期/心跳/预算的统一管理，否则"后台跑的任务"
 * 会变成失控黑洞；本模块为子 agent 基础设施提供这一层保障。

 * 核心能力：
 * 1. 生命周期注册表（list_active_subagents / register / unregister / heartbeat /
 * interruptTree 递归中断 / complete / fail）
 * 2. 心跳保活 + 过期检测 + 超时硬中断 + 诊断 dump（HeartbeatMonitor）
 * 3. 迭代预算（IterationBudget：跨轮累计，防无限烧）
 * 4. 审批流基础类型与 ApprovalManager（保留为扩展点，当前未接线——子 agent 工具
 * 执行路径不走审批，高危拦截由 run_command 的 security-engine 承担）

 * 设计原则：纯 TS、无运行时依赖、与月蚀现有调用方（manager.ts / server.ts / team-manager.ts）
 * 通过接口对接，不改变现有成功路径行为。
 */

// ==================== 类型定义 ====================

export type SubAgentStatus =
  | 'running'
  | 'paused'
  | 'completed'
  | 'interrupted'
  | 'timed_out'
  | 'failed';

/** 注册表条目*/
export interface SubAgentRecord {
  id: string;
  parentId: string | null;
  status: SubAgentStatus;
  task: string;
  /** 子 agent 的 system prompt（诊断用） */
  prompt: string;
  createdAt: number;
  lastHeartbeat: number;
  /** 子 agent 再派生的子 agent */
  childIds: string[];
  /** 最终输出 */
  result?: string;
  /** 中断原因 / 引导消息 / 错误信息 */
  note?: string;
  /** 超时诊断 dump */
  diagnostics?: string;
}

/** 审批请求 */
export type ApprovalPolicy = 'allow' | 'deny' | 'ask';
export type ApprovalStatus = 'pending' | 'approved' | 'denied';

export interface ApprovalRequest {
  agentId: string;
  /** 子 agent 名（诊断用） */
  agentName: string;
  toolName: string;
  args: unknown;
  requestedAt: number;
  status: ApprovalStatus;
  /** 命中策略：allow=自动放行 deny=自动拒绝 ask=请求父级 */
  policy: ApprovalPolicy;
  decidedAt?: number;
  decidedBy?: string;
  reason?: string;
}

// ==================== 注册表 ====================

/**
 * 子 agent 生命周期注册表
 * 所有活跃子 agent 都在这里登记，支持 list / heartbeat / 过期检测。
 */
export class SubAgentRegistry {
  private agents = new Map<string, SubAgentRecord>();

  register(record: SubAgentRecord): void {
    this.agents.set(record.id, record);
  }

  unregister(id: string): boolean {
    return this.agents.delete(id);
  }

  get(id: string): SubAgentRecord | undefined {
    return this.agents.get(id);
  }

  list(): SubAgentRecord[] {
    return [...this.agents.values()];
  }

  /** 仅活跃（running/paused）的子 agent */
  listActive(): SubAgentRecord[] {
    return [...this.agents.values()].filter(
      (a) => a.status === 'running' || a.status === 'paused',
    );
  }

  /** 心跳保活：重置 lastHeartbeat */
  heartbeat(id: string): boolean {
    const agent = this.agents.get(id);
    if (!agent) return false;
    agent.lastHeartbeat = Date.now();
    return true;
  }

  /** 过期检测：距上次心跳超过 timeoutMs 视为失联 */
  isExpired(id: string, timeoutMs: number): boolean {
    const agent = this.agents.get(id);
    if (!agent) return false;
    return Date.now() - agent.lastHeartbeat > timeoutMs;
  }

  /** 子 agent 完成：登记结果、回收子级。不覆盖已终态状态 */
  complete(id: string, result: string): boolean {
    const agent = this.agents.get(id);
    if (!agent) return false;
    if (agent.status !== 'running' && agent.status !== 'paused') return false;
    agent.status = 'completed';
    agent.result = result;
    agent.lastHeartbeat = Date.now();
    return true;
  }

  /** 标记失败并留 note。允许 completed→failed，不覆盖 failed/interrupted */
  fail(id: string, note: string): boolean {
    const agent = this.agents.get(id);
    if (!agent) return false;
    if (agent.status === 'failed' || agent.status === 'interrupted') return false;
    agent.status = 'failed';
    agent.note = note;
    agent.lastHeartbeat = Date.now();
    return true;
  }

  /** 递归中断：标记 agent 及其所有后代为 interrupted */
  interruptTree(id: string, reason: string): void {
    const agent = this.agents.get(id);
    if (!agent) return;
    if (agent.status === 'running' || agent.status === 'paused') {
      agent.status = 'interrupted';
      agent.note = reason;
    }
    for (const childId of agent.childIds) {
      this.interruptTree(childId, reason);
    }
  }
}

// ==================== 审批流 ====================

/**
 * 审批管理器（auto_deny / auto_approve / ask）。
 * 子 agent 执行高危工具前调用 request()，按策略自动放行/拒绝或挂起等父级决定。
 * 父级通过 decide() 作出裁决；pending 请求超时自动拒绝（安全默认）。

 * 【留存说明】当前未接线：AsyncDelegationManager 不调用 request/decide。
 * 工具级高危拦截已由 run_command 的 security-engine 危险检测 + 灰名单
 * requestPermission（fail-closed）承担，故本类仅作为未来审批流扩展点保留，
 * 不作为现有安全边界的一部分。
 */
export class ApprovalManager {
  private requests = new Map<string, ApprovalRequest>();
  /** 工具 → 默认策略 */
  private toolPolicies = new Map<string, ApprovalPolicy>();
  /** 全局默认策略（未单独配置的工具） */
  defaultPolicy: ApprovalPolicy = 'ask';
  /** pending 请求超时（ms），超时自动拒绝 */
  pendingTimeoutMs = 30_000;

  /** 配置某工具的策略：allow=自动放行 deny=自动拒绝 ask=请求父级 */
  setToolPolicy(toolName: string, policy: ApprovalPolicy): void {
    this.toolPolicies.set(toolName, policy);
  }

  /** 批量配置（如 { run_command: 'ask', file_write: 'allow' }） */
  setToolPolicies(policies: Record<string, ApprovalPolicy>): void {
    for (const [tool, policy] of Object.entries(policies)) {
      this.toolPolicies.set(tool, policy);
    }
  }

  private resolvePolicy(toolName: string): ApprovalPolicy {
    return this.toolPolicies.get(toolName) ?? this.defaultPolicy;
  }

  /**
   * 子 agent 请求执行工具。返回 'approved' | 'denied' | 'pending'。
   * - allow → 直接 approved（记 auto_approved）
   * - deny → 直接 denied（记 auto_denied）
   * - ask → 挂起，等待父级 decide；超时自动 denied
   */
  request(agentId: string, agentName: string, toolName: string, args: unknown): ApprovalStatus {
    const policy = this.resolvePolicy(toolName);
    const req: ApprovalRequest = {
      agentId,
      agentName,
      toolName,
      args,
      requestedAt: Date.now(),
      status: policy === 'allow' ? 'approved' : policy === 'deny' ? 'denied' : 'pending',
      policy,
      decidedAt: policy === 'ask' ? undefined : Date.now(),
      decidedBy: policy === 'ask' ? undefined : 'auto',
      reason: policy === 'allow' ? 'auto_approved' : policy === 'deny' ? 'auto_denied' : undefined,
    };
    const reqId = `${agentId}:${toolName}:${req.requestedAt}`;
    this.requests.set(reqId, req);
    return req.status;
  }

  /** 父级裁决 pending 请求 */
  decide(reqId: string, approved: boolean, by = 'parent', reason?: string): boolean {
    const req = this.requests.get(reqId);
    if (!req || req.status !== 'pending') return false;
    req.status = approved ? 'approved' : 'denied';
    req.decidedAt = Date.now();
    req.decidedBy = by;
    req.reason = reason ?? (approved ? 'approved_by_parent' : 'denied_by_parent');
    return true;
  }

  /** 查询单个请求（含超时自动拒绝的惰性检查） */
  get(reqId: string): ApprovalRequest | undefined {
    const req = this.requests.get(reqId);
    if (req && req.status === 'pending' && Date.now() - req.requestedAt > this.pendingTimeoutMs) {
      req.status = 'denied';
      req.decidedAt = Date.now();
      req.decidedBy = 'timeout';
      req.reason = 'approval_timeout';
    }
    return req;
  }

  /** 列出 pending 请求（父级轮询用） */
  listPending(): ApprovalRequest[] {
// 先做超时惰性回收
    for (const [, req] of this.requests) {
      if (req.status === 'pending' && Date.now() - req.requestedAt > this.pendingTimeoutMs) {
        req.status = 'denied';
        req.decidedAt = Date.now();
        req.decidedBy = 'timeout';
        req.reason = 'approval_timeout';
      }
    }
    return [...this.requests.values()].filter((r) => r.status === 'pending');
  }

  /** 清理已决请求（防内存泄漏） */
  prune(olderThanMs = 60_000): void {
    const cutoff = Date.now() - olderThanMs;
    for (const [id, req] of this.requests) {
      if ((req.status !== 'pending' && (req.decidedAt ?? 0) < cutoff)) {
        this.requests.delete(id);
      }
    }
  }
}

// ==================== 心跳监控 ====================

export class HeartbeatMonitor {
  private registry: SubAgentRegistry;
  heartbeatIntervalMs: number;
  timeoutMs: number;
  onTimeout?: (agent: SubAgentRecord) => void;
  /** 注册 abort 回调：agent id → abort 函数，scan 超时时直接调用 */
  private abortFns = new Map<string, () => void>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    registry: SubAgentRegistry,
    opts: {
      heartbeatIntervalMs?: number;
      timeoutMs?: number;
      onTimeout?: (agent: SubAgentRecord) => void;
    } = {},
  ) {
    this.registry = registry;
    this.heartbeatIntervalMs = opts.heartbeatIntervalMs ?? 30_000;
    this.timeoutMs = opts.timeoutMs ?? 300_000;
    this.onTimeout = opts.onTimeout;
  }

  /** 注册 abort 回调，让 scan 能在超时时直接中止 agent */
  registerAbort(id: string, abortFn: () => void): void {
    this.abortFns.set(id, abortFn);
  }

  unregisterAbort(id: string): void {
    this.abortFns.delete(id);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.scan(), this.heartbeatIntervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  scan(): void {
    for (const agent of this.registry.listActive()) {
      if (this.registry.isExpired(agent.id, this.timeoutMs)) {
        const abortFn = this.abortFns.get(agent.id);
        agent.status = 'timed_out';
        agent.note = `heartbeat timeout after ${this.timeoutMs}ms`;
        agent.diagnostics = this.buildDiagnostics(agent);
        if (abortFn) abortFn();
        this.abortFns.delete(agent.id);
        this.onTimeout?.(agent);
      }
    }
  }

  /** 诊断 dump——把 agent 快照转成可读文本留痕 */
  buildDiagnostics(agent: SubAgentRecord): string {
    const lines = [
      `=== subagent diagnostics (${new Date().toISOString()}) ===`,
      `id: ${agent.id}`,
      `parent: ${agent.parentId ?? 'root'}`,
      `status: ${agent.status}`,
      `task: ${agent.task}`,
      `created: ${new Date(agent.createdAt).toISOString()}`,
      `last_heartbeat: ${new Date(agent.lastHeartbeat).toISOString()}`,
      `note: ${agent.note ?? '-'}`,
      `--- prompt ---`,
      agent.prompt.slice(0, 2000),
      `--- children ---`,
      agent.childIds.length ? agent.childIds.join(', ') : '(none)',
    ];
    return lines.join('\n');
  }
}

// ==================== 迭代预算 ====================

/**
 * 迭代预算：一个自主任务（mission / 委托）的总迭代闸门：
 * - 跨轮累计（不是单次 streamWithTools 的 maxRounds 上限）
 * - 每次消耗 1 个预算；超限返回 false → 上层终止该任务（防无限烧）
 * 2026-10-02 默认上限取消：调用方不传时以 MAX_SAFE_INTEGER 构造（等价不限制），
 * 防失控由护栏/超时承担；显式传预算仍生效。
 */
export class IterationBudget {
  private used = 0

  constructor(private maxTotal: number) {}

  consume(): boolean {
    if (this.used >= this.maxTotal) return false
    this.used += 1
    return true
  }

  refund(): void {
    if (this.used > 0) this.used -= 1
  }

  get usedCount(): number {
    return this.used
  }

get remaining(): number {
    return Math.max(0, this.maxTotal - this.used)
  }

  get exhausted(): boolean {
    return this.used >= this.maxTotal
  }
}
