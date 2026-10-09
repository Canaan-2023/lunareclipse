/**
 * sub-agent-engine / async-delegation.ts
 * 异步委托

 * 核心价值：子 agent 后台跑，父对话不阻塞——这是月蚀子 agent"性能差"的解药。
 * 配套机制：
 * 1. dispatchAsync：后台启动子 agent，立即返回委托记录
 * 2. 完成事件推送（EventEmitter）：父对话监听 'completed'/'failed'/'interrupted'
 * 3. 生命周期查询：listActive / get
 * 4. 中断/引导透传
 * 5. 持久化恢复：崩溃后 recoverAbandoned（遗留委托不续跑但留痕）

* 与 engine.ts 的关系：engine 提供核心机制（注册表/心跳），本文件提供
 * 异步调度层（把子 agent 跑在独立 Promise 里，不阻塞调用方）。
 * 注意：不做工具级审批（工具高危拦截由 run_command 的 security-engine 承担，
 * 引擎级 ApprovalManager 未接线，见 engine.ts 留存说明）。
 */

import { EventEmitter } from 'events';
import { writeFileSync, existsSync, readFileSync, renameSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import {
  SubAgentRegistry,
  HeartbeatMonitor,
  IterationBudget,
} from './engine';
import { globalSubAgentScheduler } from '../../services/subagent-scheduler';

// ==================== 类型定义 ====================

/** 委托记录 */
export interface DelegationRecord {
  id: string;
  parentId: string | null;
  task: string;
  status: 'running' | 'completed' | 'failed' | 'interrupted' | 'timed_out';
  startedAt: number;
  finishedAt?: number;
  result?: string;
  error?: string;
  /** 迭代预算：跨轮累计已用 / 上限 */
  iterationsUsed?: number;
  maxIterations?: number;
}

/** 执行器签名——由月蚀侧注入（llmClient.streamWithTools 的封装） */
export type SubAgentRunner = (
  record: DelegationRecord,
  signal: AbortSignal,
  budget: IterationBudget,
) => Promise<string>;

/** 异步委托管理器配置 */
export interface AsyncDelegationOptions {
  runner: SubAgentRunner;
  /** 心跳监控配置 */
  heartbeatTimeoutMs?: number;
  /** 委托记录持久化路径（可选，启用 durable 恢复） */
  persistencePath?: string;
}

// ==================== 事件 ====================

export interface AsyncDelegationEvents {
  completed: (record: DelegationRecord) => void;
  failed: (record: DelegationRecord, error: string) => void;
  interrupted: (record: DelegationRecord) => void;
  timed_out: (record: DelegationRecord) => void;
}

// ==================== 管理器 ====================

export class AsyncDelegationManager {
  private registry: SubAgentRegistry;
  private monitor: HeartbeatMonitor;
  private runner: SubAgentRunner;
  private persistencePath?: string;
  private emitter = new EventEmitter();
  private records = new Map<string, DelegationRecord>();
  /** 进行中的 abort 控制器：中断/超时用 */
  private controllers = new Map<string, AbortController>();
  private persistenceTimer: ReturnType<typeof setInterval> | null = null;

  constructor(registry: SubAgentRegistry, opts: AsyncDelegationOptions) {
    this.registry = registry;
    this.runner = opts.runner;
    this.persistencePath = opts.persistencePath;
    this.monitor = new HeartbeatMonitor(registry, {
      timeoutMs: opts.heartbeatTimeoutMs ?? 300_000,
      onTimeout: (agent) => {
        const record = this.records.get(agent.id);
        if (!record) return;
        const ctrl = this.controllers.get(agent.id);
        ctrl?.abort();
        record.status = 'timed_out';
        record.finishedAt = Date.now();
        record.error = agent.note ?? 'heartbeat timeout';
        this.emitter.emit('timed_out', record);
        this.persist();
      },
    });
    this.monitor.start();
    this.persistenceTimer = setInterval(() => {
      this.persist();
    }, 30_000);
  }

  // ----- 事件订阅（父对话用） -----

  on<K extends keyof AsyncDelegationEvents>(event: K, listener: AsyncDelegationEvents[K]): void {
    this.emitter.on(event, listener as (...args: unknown[]) => void);
  }

  off<K extends keyof AsyncDelegationEvents>(event: K, listener: AsyncDelegationEvents[K]): void {
    this.emitter.off(event, listener as (...args: unknown[]) => void);
  }

  // ----- 调度 -----

  /**
   * 异步委托：后台启动子 agent，立即返回记录 id。
   * 父对话不阻塞；完成/失败/中断通过事件通知。
   * @param task 任务描述
   * @param parentId 父 id
* @param maxIterations 迭代预算上限（2026-10-02 默认取消：MAX_SAFE_INTEGER 表示不限制；JSON 持久化不能用 Infinity，否则读回成 null 破坏预算判定）
    * @param explicitId 显式任务 id（①④：长期 mission 复用同一 id，跨段累计预算/失败计数）
    */
  dispatch(task: string, parentId: string | null = null, maxIterations = Number.MAX_SAFE_INTEGER, explicitId?: string): string {
    const id = explicitId && explicitId.trim() ? explicitId.trim() : `sub_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const record: DelegationRecord = {
      id,
      parentId,
      task,
      status: 'running',
      startedAt: Date.now(),
      iterationsUsed: 0,
      maxIterations,
    };
    this.records.set(id, record);
    this.persist();

    // 注册到心跳注册表（诊断/生命周期查询可见）
    this.registry.register({
      id,
      parentId,
      status: 'running',
      task,
      prompt: task,
      createdAt: Date.now(),
      lastHeartbeat: Date.now(),
      childIds: [],
    });

    const ctrl = new AbortController();
    this.controllers.set(id, ctrl);
    this.monitor.registerAbort(id, () => ctrl.abort());
    const budget = new IterationBudget(maxIterations);

    void this.runBackground(record, ctrl, budget);
    return id;
  }

  private async runBackground(record: DelegationRecord, ctrl: AbortController, budget: IterationBudget): Promise<void> {
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    // 是否成功获得全局调度槽位：只有 acquire 成功才允许 release，防止未占槽时误放行排队任务
    let admittedSlot = false;
    try {
      heartbeatTimer = setInterval(() => {
        this.registry.heartbeat(record.id);
      }, 10_000);

      // 全局调度器排队：与同步 SubAgentManager 共享同一并发预算（机器配置自动计算上限），
      // 机器资源（CPU/内存）不足时按 FIFO 等待空位而不是直接叠加并发打爆机器。
      // 为什么在启动后、执行前：dispatch 只登记不阻塞（后台任务的卖点），
      // 真正占资源的是 runner（LLM 流式会话 + 工具进程），所以在跑执行器前申请槽位。
      // 排队期间被 interrupt（ctrl.signal abort）时 acquire 返回 false：按中断处理，
      // 不进执行器、不占槽位，由下方 ctrl.signal.aborted 分支统一收尾。
      admittedSlot = await globalSubAgentScheduler.acquire(ctrl.signal);
      if (!admittedSlot) {
        // 排队中被中断：interrupt()/心跳超时已同步置状态并发过事件（interrupted/timed_out），
        // 这里只做资源清理，不再重复 emit，也不覆盖 timeout 语义。
        // 仅当外部发起中断时未落状态（防御性兜底，正常流程不会走到）才自置 interrupted。
        if (record.status === 'running') {
          record.status = 'interrupted';
          record.finishedAt = Date.now();
          this.emitter.emit('interrupted', record);
        }
        this.registry.unregister(record.id);
        this.controllers.delete(record.id);
        this.persist();
        return;
      }

      const result = await this.runner(record, ctrl.signal, budget);

      if (ctrl.signal.aborted) {
        // 中断由 interrupt()/心跳超时前置处理：它们已置最终状态并 emit 事件，
        // 这里只清理资源。仅当状态仍是 running（防御性兜底）时才自置 interrupted 补发事件。
        if (record.status === 'running') {
          record.status = 'interrupted';
          record.finishedAt = Date.now();
          this.emitter.emit('interrupted', record);
        }
        this.registry.unregister(record.id);
        this.controllers.delete(record.id);
        this.persist();
        return;
      }
      record.iterationsUsed = budget.usedCount;
      if (budget.exhausted && record.status !== 'completed') {
        record.status = 'interrupted';
        record.finishedAt = Date.now();
        record.error = 'iteration_budget_exhausted';
        this.registry.unregister(record.id);
        this.controllers.delete(record.id);
        this.persist();
        this.emitter.emit('interrupted', record);
        return;
      }

      record.status = 'completed';
      record.result = result;
      record.iterationsUsed = budget.usedCount;
      record.finishedAt = Date.now();
      this.registry.complete(record.id, result);
      this.controllers.delete(record.id);
      this.persist();
      this.emitter.emit('completed', record);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      record.iterationsUsed = budget.usedCount;
      record.finishedAt = Date.now();
      this.controllers.delete(record.id);
      if (ctrl.signal.aborted) {
        // 中断由 interrupt()/心跳超时前置处理并已 emit；这里只清理，不重复发事件
        this.registry.unregister(record.id);
        this.persist();
        return;
      }
      // 非中止的运行时错误 = 真实失败：置 failed 并通知监听方
      record.status = 'failed';
      record.error = msg;
      this.registry.fail(record.id, msg);
      this.persist();
      this.emitter.emit('failed', record, msg);
    } finally {
      // 释放全局调度槽位：无论成功/失败/中断/超时，执行器结束后必须放行队首排队任务
      if (admittedSlot) globalSubAgentScheduler.release();
      if (heartbeatTimer) clearInterval(heartbeatTimer);
    }
  }

  // ----- 控制 -----

  /** 中断指定子 agent：abort 其 AbortController 并解除监控注册 */
  interrupt(id: string, reason = 'user interrupt'): boolean {
    const record = this.records.get(id);
    if (!record || record.status !== 'running') return false;
    const ctrl = this.controllers.get(id);
    ctrl?.abort();
    this.monitor.unregisterAbort(id);
    record.status = 'interrupted';
    record.finishedAt = Date.now();
    record.error = reason;
    this.persist();
    this.emitter.emit('interrupted', record);
    return true;
  }

  /** 引导子 agent 调整方向：向 registry 记录写入 [STEER] 方向注入信号 */
  steer(id: string, message: string): boolean {
    const record = this.records.get(id);
    if (!record || record.status !== 'running') return false;
    const agent = this.registry.get(id);
    if (!agent || agent.status !== 'running') return false;
    agent.note = `[STEER] ${message}`;
    this.persist();
    return true;
  }

  /** 中断全部活跃子 agent（父对话关闭/崩溃恢复前调用） */
  interruptAll(): void {
    for (const record of this.records.values()) {
      if (record.status === 'running') {
        this.interrupt(record.id, 'parent shutdown');
      }
    }
  }

  // ----- 查询 -----

  get(id: string): DelegationRecord | undefined {
    return this.records.get(id);
  }

  listActive(): DelegationRecord[] {
    return [...this.records.values()].filter((r) => r.status === 'running');
  }

  listAll(): DelegationRecord[] {
    return [...this.records.values()];
  }

  // ----- 持久化与恢复 -----

  /** 快照所有委托记录到磁盘（durable 持久化） */
  private persist(): void {
    if (!this.persistencePath) return;
    const dir = dirname(this.persistencePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const data = JSON.stringify([...this.records.values()], null, 2);
    const tmpPath = `${this.persistencePath}.tmp`;
    writeFileSync(tmpPath, data, 'utf-8');
    renameSync(tmpPath, this.persistencePath);
  }

/**
   * 崩溃恢复：读取上次持久化的委托记录，把 running 的标记为 interrupted
   *（崩溃后遗留的委托不能继续跑，但要留痕）。
   */
  recoverAbandoned(): DelegationRecord[] {
    if (!this.persistencePath) return [];
    if (!existsSync(this.persistencePath)) return [];
    const raw = readFileSync(this.persistencePath, 'utf-8');
    const saved = JSON.parse(raw) as DelegationRecord[];
    const abandoned: DelegationRecord[] = [];
    for (const rec of saved) {
      if (rec.status === 'running') {
        rec.status = 'interrupted';
        rec.finishedAt = Date.now();
        rec.error = 'recovered after crash (abandoned delegation)';
        abandoned.push(rec);
      }
      this.records.set(rec.id, rec);
    }
    return abandoned;
  }

  /** 关闭管理器：停心跳监控、停持久化、中断全部、收尾 */
  dispose(): void {
    this.monitor.stop();
    if (this.persistenceTimer) {
      clearInterval(this.persistenceTimer);
      this.persistenceTimer = null;
    }
    this.interruptAll();
    this.persist();
  }
}
