/**
 * sub-agent-engine 单测
 * 覆盖：注册表 / 审批流（保留扩展点）/ 心跳监控 / 异步委托 / 迭代预算 / 崩溃恢复
 * 注：interruptSubAgent/steerSubAgent/applySummaryBudget/buildChildAgentConfig 及
 *     AsyncDelegationManager 的 approval 参数已在 2026-09 审查中按"死代码不留存"删除，
 *     相应测试块随删除（见 tools/sub-agent-engine/engine.ts 留存说明）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  SubAgentRegistry,
  ApprovalManager,
  HeartbeatMonitor,
  IterationBudget,
} from '../app/electron/main/tools/sub-agent-engine/engine';
import {
  AsyncDelegationManager,
  DelegationRecord,
} from '../app/electron/main/tools/sub-agent-engine/async-delegation';

// ==================== 注册表 ====================

describe('SubAgentRegistry', () => {
  let registry: SubAgentRegistry;

  beforeEach(() => {
    registry = new SubAgentRegistry();
  });

  it('register/get/list 基本生命周期', () => {
    registry.register({
      id: 'a1', parentId: null, status: 'running', task: 't',
      prompt: 'p', createdAt: 1, lastHeartbeat: 1, childIds: [],
    });
    expect(registry.get('a1')?.status).toBe('running');
    expect(registry.list()).toHaveLength(1);
    expect(registry.listActive()).toHaveLength(1);
  });

  it('heartbeat 刷新 lastHeartbeat', () => {
    registry.register({
      id: 'a1', parentId: null, status: 'running', task: 't',
      prompt: 'p', createdAt: 1, lastHeartbeat: 1, childIds: [],
    });
    expect(registry.heartbeat('a1')).toBe(true);
    expect(registry.get('a1')!.lastHeartbeat).toBeGreaterThan(1);
    expect(registry.heartbeat('nonexistent')).toBe(false);
  });

  it('isExpired 过期检测', () => {
    registry.register({
      id: 'a1', parentId: null, status: 'running', task: 't',
      prompt: 'p', createdAt: 1, lastHeartbeat: Date.now() - 5000, childIds: [],
    });
    expect(registry.isExpired('a1', 1000)).toBe(true);
    expect(registry.isExpired('a1', 10000)).toBe(false);
  });

  it('complete / fail 状态迁移', () => {
    registry.register({
      id: 'a1', parentId: null, status: 'running', task: 't',
      prompt: 'p', createdAt: 1, lastHeartbeat: 1, childIds: [],
    });
    expect(registry.complete('a1', 'done')).toBe(true);
    expect(registry.get('a1')?.status).toBe('completed');
    expect(registry.get('a1')?.result).toBe('done');
    expect(registry.listActive()).toHaveLength(0);
    expect(registry.fail('a1', 'boom')).toBe(true);
    expect(registry.get('a1')?.status).toBe('failed');
  });
});

// ==================== 审批流 ====================

describe('ApprovalManager', () => {
  let approvals: ApprovalManager;

  beforeEach(() => {
    approvals = new ApprovalManager();
  });

  it('allow 策略直接放行', () => {
    approvals.setToolPolicy('run_command', 'allow');
    expect(approvals.request('a1', 'worker', 'run_command', { cmd: 'ls' })).toBe('approved');
    expect(approvals.listPending()).toHaveLength(0);
  });

  it('deny 策略直接拒绝', () => {
    approvals.setToolPolicy('danger', 'deny');
    expect(approvals.request('a1', 'worker', 'danger', {})).toBe('denied');
    expect(approvals.listPending()).toHaveLength(0);
  });

  it('ask 策略挂起，父级裁决', () => {
    approvals.setToolPolicy('file_write', 'ask');
    expect(approvals.request('a1', 'worker', 'file_write', { path: '/x' })).toBe('pending');
    const pending = approvals.listPending();
    expect(pending).toHaveLength(1);
    const reqId = `a1:file_write:${pending[0].requestedAt}`;
    expect(approvals.decide(reqId, true, 'parent')).toBe(true);
    expect(approvals.get(reqId)?.status).toBe('approved');
    expect(approvals.decide(reqId, true)).toBe(false); // 已决不可重复裁决
  });

  it('pending 超时自动拒绝', () => {
    approvals.setToolPolicy('file_write', 'ask');
    approvals.pendingTimeoutMs = 10;
    approvals.request('a1', 'worker', 'file_write', { path: '/x' });
    const pending = approvals.listPending();
    const reqId = `a1:file_write:${pending[0].requestedAt}`;
    // 等待超时后查询，应自动转 denied
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(approvals.get(reqId)?.status).toBe('denied');
        expect(approvals.get(reqId)?.reason).toBe('approval_timeout');
        resolve();
      }, 30);
    });
  });

  it('prune 清理已决请求', () => {
    approvals.setToolPolicy('run_command', 'allow');
    approvals.request('a1', 'worker', 'run_command', { cmd: 'ls' });
    approvals.prune(0);
    expect(approvals.listPending()).toHaveLength(0);
  });
});

// ==================== 心跳监控 ====================

describe('HeartbeatMonitor', () => {
  it('过期 agent 被硬中断并生成诊断', () => {
    const registry = new SubAgentRegistry();
    registry.register({
      id: 'a1', parentId: null, status: 'running', task: 't',
      prompt: 'do the thing', createdAt: 1, lastHeartbeat: Date.now() - 10_000, childIds: [],
    });
    const onTimeout = vi.fn();
    const monitor = new HeartbeatMonitor(registry, {
      timeoutMs: 1000,
      onTimeout,
    });
    monitor.scan();
    const agent = registry.get('a1')!;
    expect(agent.status).toBe('timed_out');
    expect(agent.diagnostics).toContain('do the thing');
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it('存活 agent 不被误杀', () => {
    const registry = new SubAgentRegistry();
    registry.register({
      id: 'a1', parentId: null, status: 'running', task: 't',
      prompt: 'p', createdAt: 1, lastHeartbeat: Date.now(), childIds: [],
    });
    const monitor = new HeartbeatMonitor(registry, { timeoutMs: 1000 });
    monitor.scan();
    expect(registry.get('a1')?.status).toBe('running');
  });
});

// ==================== 异步委托 ====================

describe('AsyncDelegationManager', () => {
  let manager: AsyncDelegationManager;
  let registry: SubAgentRegistry;

  beforeEach(() => {
    registry = new SubAgentRegistry();
  });

  afterEach(() => {
    manager?.dispose();
  });

  it('dispatch 立即返回 id（不阻塞），完成事件触发', async () => {
    const runner = vi.fn(async (_rec: DelegationRecord, signal: AbortSignal) => {
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      if (signal.aborted) throw new Error('aborted');
      return 'task done';
    });
    manager = new AsyncDelegationManager(registry, { runner });

    const completed = new Promise<void>((resolve) => {
      manager.on('completed', (rec) => {
        expect(rec.status).toBe('completed');
        expect(rec.result).toBe('task done');
        resolve();
      });
    });

    const id = manager.dispatch('my task');
    expect(id).toBeTruthy();
    expect(manager.get(id)?.status).toBe('running');
    // dispatch 后立即返回——父对话不阻塞（runner 还没跑完）
    await completed;
    expect(manager.get(id)?.status).toBe('completed');
    expect(registry.get(id)?.status).toBe('completed');
  });

  it('interrupt 中断运行中的子 agent', async () => {
    const runner = vi.fn(async (_rec: DelegationRecord, signal: AbortSignal) => {
      await new Promise<void>((resolve) => setTimeout(resolve, 200));
      if (signal.aborted) throw new Error('aborted');
      return 'done';
    });
    manager = new AsyncDelegationManager(registry, { runner });
    const interrupted = new Promise<void>((resolve) => {
      manager.on('interrupted', (rec) => {
        expect(rec.status).toBe('interrupted');
        resolve();
      });
    });
    const id = manager.dispatch('task');
    // 立即中断
    expect(manager.interrupt(id, 'user cancel')).toBe(true);
    await interrupted;
    expect(manager.get(id)?.status).toBe('interrupted');
  });

  it('runner 抛错 → failed 事件 + 注册表留痕', async () => {
    const runner = vi.fn(async () => {
      throw new Error('boom');
    });
    manager = new AsyncDelegationManager(registry, { runner });
    const failed = new Promise<void>((resolve) => {
      manager.on('failed', (rec, err) => {
        expect(err).toBe('boom');
        resolve();
      });
    });
    manager.dispatch('task');
    await failed;
    const records = manager.listAll();
    expect(records[0].status).toBe('failed');
    expect(registry.get(records[0].id)?.status).toBe('failed');
  });

  it('持久化 + 崩溃恢复：running 标记为 interrupted', () => {
    const tmpPath = join(tmpdir(), `subagent-test-${Date.now()}.json`);
    const runner = vi.fn(async () => 'done');
    manager = new AsyncDelegationManager(registry, { runner, persistencePath: tmpPath });

    // 手动塞一条 running 记录（模拟崩溃前的现场）
    const fake: DelegationRecord = {
      id: 'old_1', parentId: null, task: 'abandoned', status: 'running',
      startedAt: Date.now(),
    };
    writeFileSync(tmpPath, JSON.stringify([fake]), 'utf-8');

    const abandoned = manager.recoverAbandoned();
    expect(abandoned).toHaveLength(1);
    expect(abandoned[0].status).toBe('interrupted');
    expect(abandoned[0].error).toContain('recovered');

    manager.dispose();
    unlinkSync(tmpPath);
  });
});

// ==================== 迭代预算（2026-08-19）====================

describe('IterationBudget', () => {
  it('consume 累计，超限返回 false', () => {
    const b = new IterationBudget(3);
    expect(b.consume()).toBe(true);
    expect(b.consume()).toBe(true);
    expect(b.consume()).toBe(true);
    expect(b.consume()).toBe(false); // 第 4 次超限
    expect(b.exhausted).toBe(true);
    expect(b.usedCount).toBe(3);
    expect(b.remaining).toBe(0);
  });

  it('refund 退还', () => {
    const b = new IterationBudget(3);
    b.consume();
    b.consume();
    b.refund();
    expect(b.usedCount).toBe(1);
    expect(b.remaining).toBe(2);
    expect(b.exhausted).toBe(false);
  });
});

describe('AsyncDelegationManager 迭代预算（2026-08-19）', () => {
  let manager: AsyncDelegationManager;
  let registry: SubAgentRegistry;

  beforeEach(() => {
    registry = new SubAgentRegistry();
  });

  afterEach(() => {
    manager?.dispose();
  });

  it('预算耗尽 → 任务被标记 interrupted(iteration_budget_exhausted)，不执行', async () => {
    // maxIterations=0：runner 第一轮 consume 即失败 → 整段终止
    const runner = async (_rec: DelegationRecord, _signal: AbortSignal, budget: IterationBudget) => {
      if (!budget.consume()) {
        return '';
      }
      throw new Error('不该执行');
    };
    manager = new AsyncDelegationManager(registry, { runner });
    const interrupted = new Promise<void>((resolve) => {
      manager.on('interrupted', (rec) => {
        expect(rec.error).toBe('iteration_budget_exhausted');
        resolve();
      });
    });
    manager.dispatch('task', null, 0); // 预算 0
    await interrupted;
    const rec = manager.listAll()[0];
    expect(rec.status).toBe('interrupted');
    expect(rec.error).toBe('iteration_budget_exhausted');
  });

  it('预算被消耗时记账到 record.iterationsUsed', async () => {
    const runner = async (_rec: DelegationRecord, _signal: AbortSignal, budget: IterationBudget) => {
      budget.consume();
      budget.consume();
      return 'ok';
    };
    manager = new AsyncDelegationManager(registry, { runner });
    const completed = new Promise<void>((resolve) => {
      manager.on('completed', () => resolve());
    });
    manager.dispatch('task', null, 10);
    await completed;
    const rec = manager.listAll()[0];
    expect(rec.status).toBe('completed');
    expect(rec.iterationsUsed).toBe(2);
    expect(rec.maxIterations).toBe(10);
  });

  it('持久化保存迭代计数，崩溃恢复保留 budget 字段', () => {
    const tmpPath = join(tmpdir(), `subagent-budget-${Date.now()}.json`);
    const runner = async () => 'done';
    manager = new AsyncDelegationManager(registry, { runner, persistencePath: tmpPath });

    // 模拟一个已耗 3/50 预算的 running 任务中途崩溃
    const fake: DelegationRecord = {
      id: 'b1', parentId: null, task: 'long mission', status: 'running',
      startedAt: Date.now(), iterationsUsed: 3, maxIterations: 50,
    };
    writeFileSync(tmpPath, JSON.stringify([fake]), 'utf-8');

    const abandoned = manager.recoverAbandoned();
    expect(abandoned).toHaveLength(1);
    expect(abandoned[0].status).toBe('interrupted');
    expect(abandoned[0].iterationsUsed).toBe(3);
    expect(abandoned[0].maxIterations).toBe(50);

    manager.dispose();
    unlinkSync(tmpPath);
  });
});
