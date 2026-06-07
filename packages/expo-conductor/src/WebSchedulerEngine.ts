/**
 * Web orchestration engine: a timer-driven implementation of {@link ConductorBackend}.
 *
 * Pure TypeScript with no `expo` import so it runs under Node, the browser and
 * Jest. It composes the four engine concerns (recurrence, priority, weight,
 * policy) and the registry into a working scheduler. The native modules reproduce
 * this same orchestration in Kotlin/Swift on top of the OS schedulers.
 */
import type {
  ConductorBackend,
  ConductorSubscription,
} from './ConductorBackend';
import {
  type ConductorStatus,
  type DeviceContext,
  type ExpoConductorModuleEvents,
  type RegisteredTask,
  type ResourceBudget,
  type ResourceWeight,
  type TaskDefinition,
  TaskResult,
  type Trigger,
} from './ExpoConductor.types';
import { evaluate } from './web/engine/policy';
import { TaskRegistry } from './web/engine/registry';
import { admit, type WeightedTask } from './web/engine/weight';
import { computeNextRunAt, normalize } from './web/normalize';

type Listeners = {
  [E in keyof ExpoConductorModuleEvents]: Set<ExpoConductorModuleEvents[E]>;
};

/** Max delay setTimeout accepts before its signed-32-bit overflow (~24.8 days). */
const MAX_TIMER_DELAY = 2_147_483_647;

const DEFAULT_BUDGET: ResourceBudget = { cpu: 1, network: 1, battery: 1, memory: 1 };

const DEFAULT_CONTEXT: DeviceContext = {
  now: 0,
  batteryLevel: 1,
  charging: true,
  networkType: 'unmetered',
  idle: true,
};

export interface WebSchedulerOptions {
  /** Supplies live device conditions for policy evaluation. */
  deviceContext?: () => Omit<DeviceContext, 'now'>;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
  /** Injectable timer setters for deterministic tests. */
  setTimer?: (cb: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** Delay before retrying a task deferred by the resource budget (default 60s). */
  deferRetryMs?: number;
}

export class WebSchedulerEngine implements ConductorBackend {
  private registry = new TaskRegistry();
  private timers = new Map<string, unknown>();
  private attempts = new Map<string, number>();
  /** Weight of tasks currently executing (id -> weight), for cross-task budgeting. */
  private running = new Map<string, ResourceWeight>();
  private budget: ResourceBudget = DEFAULT_BUDGET;
  private paused = false;
  private readonly listeners: Listeners = {
    onTaskExecute: new Set(),
    onTaskComplete: new Set(),
    onTaskError: new Set(),
    onTaskSkipped: new Set(),
  };

  private readonly now: () => number;
  private readonly setTimer: (cb: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly deviceContext: () => Omit<DeviceContext, 'now'>;
  private readonly deferRetryMs: number;

  constructor(options: WebSchedulerOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.setTimer =
      options.setTimer ?? ((cb, ms) => setTimeout(cb, ms) as unknown);
    this.clearTimer =
      options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.deviceContext = options.deviceContext ?? (() => DEFAULT_CONTEXT);
    this.deferRetryMs = options.deferRetryMs ?? 60_000;
    // Re-arm timers for tasks restored from persistence (otherwise web persistence is
    // write-only — tasks survive reload but never fire). A task whose nextRunAt is already
    // past will fire on the next tick (catch-up).
    if (!this.paused) {
      for (const task of this.registry.all()) this.scheduleTimer(task);
    }
  }

  // --- ConductorBackend ----------------------------------------------------

  async registerTaskAsync(definition: TaskDefinition): Promise<RegisteredTask> {
    const task = normalize(definition, this.now());
    this.registry.upsert(task);
    this.scheduleTimer(task);
    return task;
  }

  async cancelTaskAsync(id: string): Promise<boolean> {
    this.clearTimerFor(id);
    this.attempts.delete(id);
    this.running.delete(id);
    return this.registry.remove(id);
  }

  async getTasksAsync(): Promise<RegisteredTask[]> {
    return this.registry.all();
  }

  async runTaskAsync(id: string): Promise<void> {
    const task = this.registry.get(id);
    if (task) this.fire(task, true);
  }

  async runDueTasksAsync(): Promise<number> {
    if (this.paused) return 0;
    const now = this.now();
    // Fire highest-priority-first so the shared budget is allocated fairly.
    const due = this.registry
      .all()
      .filter((t) => t.nextRunAt != null && t.nextRunAt <= now)
      .sort((a, b) => {
        if (a.priority !== b.priority) return b.priority - a.priority;
        const ad = a.nextRunAt ?? 0;
        const bd = b.nextRunAt ?? 0;
        if (ad !== bd) return ad - bd;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      });
    for (const task of due) this.fire(task, false);
    return due.length;
  }

  async setResourceBudgetAsync(budget: ResourceBudget): Promise<void> {
    this.budget = budget;
  }

  async pauseAsync(): Promise<void> {
    this.paused = true;
    for (const id of [...this.timers.keys()]) this.clearTimerFor(id);
  }

  async resumeAsync(): Promise<void> {
    this.paused = false;
    for (const task of this.registry.all()) this.scheduleTimer(task);
  }

  async getStatusAsync(): Promise<ConductorStatus> {
    // On web, timer-based scheduling works while the page is alive; true background
    // execution depends on Periodic Background Sync, which we don't require here.
    return 'available';
  }

  async requestPermissionsAsync(): Promise<boolean> {
    const N = (globalThis as { Notification?: { requestPermission?: () => Promise<string>; permission?: string } })
      .Notification;
    if (!N) return false;
    if (N.permission === 'granted') return true;
    if (typeof N.requestPermission === 'function') {
      return (await N.requestPermission()) === 'granted';
    }
    return false;
  }

  async reportResultAsync(id: string, result: TaskResult, error?: string): Promise<void> {
    // No longer occupies a concurrency/budget slot.
    this.running.delete(id);
    const task = this.registry.get(id);
    if (!task) return;
    const triggerType = task.triggers[0]?.type ?? 'time';
    const attempt = this.attempts.get(id) ?? 1;
    if (error != null) {
      this.emit('onTaskError', { taskId: id, triggerType, firedAt: this.now(), attempt, error });
    }
    this.emit('onTaskComplete', {
      taskId: id,
      triggerType,
      firedAt: this.now(),
      attempt,
      result,
    });
    if (result === TaskResult.FAILED) {
      this.handleRetry(task);
    } else {
      this.attempts.delete(id);
    }
  }

  addListener<E extends keyof ExpoConductorModuleEvents>(
    event: E,
    listener: ExpoConductorModuleEvents[E],
  ): ConductorSubscription {
    this.listeners[event].add(listener);
    return {
      remove: () => {
        this.listeners[event].delete(listener);
      },
    };
  }

  // --- internals -----------------------------------------------------------

  private emit<E extends keyof ExpoConductorModuleEvents>(
    event: E,
    payload: Parameters<ExpoConductorModuleEvents[E]>[0],
  ): void {
    for (const listener of this.listeners[event]) {
      (listener as (p: typeof payload) => void)(payload);
    }
  }

  private scheduleTimer(task: RegisteredTask): void {
    if (this.paused) return;
    this.clearTimerFor(task.id);
    if (task.nextRunAt == null) return;
    const delay = Math.max(0, task.nextRunAt - this.now());
    // setTimeout uses a signed 32-bit delay; anything larger overflows and fires almost
    // immediately. For far-future runs (e.g. weekly/monthly/cron) chain timers in
    // <=~24.8-day hops until the real fire time, then dispatch.
    if (delay > MAX_TIMER_DELAY) {
      const handle = this.setTimer(() => this.scheduleTimer(task), MAX_TIMER_DELAY);
      this.timers.set(task.id, handle);
      return;
    }
    const handle = this.setTimer(() => this.fire(task, false), delay);
    this.timers.set(task.id, handle);
  }

  private clearTimerFor(id: string): void {
    const handle = this.timers.get(id);
    if (handle !== undefined) {
      this.clearTimer(handle);
      this.timers.delete(id);
    }
  }

  /** Fire a task: enforce policy + budget, then emit execute, then reschedule. */
  private fire(task: RegisteredTask, manual: boolean): void {
    const now = this.now();
    const ctx: DeviceContext = { ...this.deviceContext(), now };

    if (!manual) {
      const decision = evaluate(task.policy.constraints ?? {}, ctx);
      if (!decision.eligible) {
        this.emit('onTaskSkipped', { taskId: task.id, reason: decision.reason });
        this.reschedule(task, now);
        return;
      }

      const candidate: WeightedTask = {
        id: task.id,
        priority: task.priority,
        dueAt: task.nextRunAt ?? now,
        weight: task.weight,
        maxConcurrent: task.policy.maxConcurrent,
      };
      // Admit against the budget/count already consumed by other in-flight tasks, so a
      // task yields when the device is busy with heavier or more important work.
      const { admitted } = admit(this.budget, [candidate], this.runningUsage(task.id));
      if (!admitted.includes(task.id)) {
        // Budget/concurrency deferral is transient — retry shortly rather than dropping the
        // occurrence (a one-shot has no future trigger to reschedule onto).
        this.emit('onTaskSkipped', { taskId: task.id, reason: 'DEFERRED_BY_BUDGET' });
        this.deferRetry(task, now);
        return;
      }
      // Mark running until the handler reports a result (drives cross-task budgeting).
      this.running.set(task.id, task.weight);
    }

    // Schedule the next occurrence first, so that if the handler reports a
    // failure synchronously the retry timer is not clobbered by rescheduling.
    if (!manual) this.reschedule(task, now);

    // A manual run must not perturb the retry/backoff attempt counter that the
    // scheduled path owns.
    const attempt = manual
      ? (this.attempts.get(task.id) ?? 0) + 1
      : (() => {
          const next = (this.attempts.get(task.id) ?? 0) + 1;
          this.attempts.set(task.id, next);
          return next;
        })();
    this.emit('onTaskExecute', {
      taskId: task.id,
      triggerType: task.triggers[0]?.type ?? 'time',
      firedAt: now,
      attempt,
    });
  }

  private reschedule(task: RegisteredTask, now: number): void {
    // Consider both the recurrence and any still-future one-shot triggers so a
    // task with e.g. a recurrence AND an alarm keeps honoring both.
    const next = computeNextRunAt(futureTriggers(task.triggers, now), task.recurrence, now);
    const updated: RegisteredTask = { ...task, nextRunAt: next };
    this.registry.upsert(updated);
    this.scheduleTimer(updated);
  }

  /** Re-arm a task that was deferred by the resource budget, after a short delay. */
  private deferRetry(task: RegisteredTask, now: number): void {
    const updated: RegisteredTask = { ...task, nextRunAt: now + this.deferRetryMs };
    this.registry.upsert(updated);
    this.scheduleTimer(updated);
  }

  /** Budget + count consumed by other in-flight tasks (excluding `excludeId`). */
  private runningUsage(excludeId: string): { running: number; used: ResourceWeight } {
    const used: ResourceWeight = { cpu: 0, network: 0, battery: 0, memory: 0 };
    let running = 0;
    for (const [id, weight] of this.running) {
      if (id === excludeId) continue;
      used.cpu += weight.cpu;
      used.network += weight.network;
      used.battery += weight.battery;
      used.memory += weight.memory;
      running += 1;
    }
    return { running, used };
  }

  private handleRetry(task: RegisteredTask): void {
    const retry = task.policy.retry;
    // Only scheduled fires populate `attempts`; a manual runNow does not. Skip retry
    // for a manual fire so it can't clobber the real schedule with a backoff timer.
    if (!this.attempts.has(task.id)) return;
    const attempt = this.attempts.get(task.id) ?? 1;
    if (!retry || attempt >= retry.maxAttempts) {
      // Retries exhausted (or none configured): drop the retry counter but keep
      // the task's recurrence/one-shot schedule alive instead of dropping it.
      this.attempts.delete(task.id);
      this.reschedule(task, this.now());
      return;
    }
    const backoff = Math.min(
      retry.backoffMs * 2 ** (attempt - 1),
      retry.maxBackoffMs ?? Number.MAX_SAFE_INTEGER,
    );
    const updated: RegisteredTask = { ...task, nextRunAt: this.now() + backoff };
    this.registry.upsert(updated);
    this.scheduleTimer(updated);
  }
}

/** Keep only one-shot triggers whose time is still in the future. */
function futureTriggers(triggers: Trigger[], now: number): Trigger[] {
  return triggers.filter((t) => {
    if ((t.type === 'time' || t.type === 'notification' || t.type === 'alarm') && t.at != null) {
      return t.at > now;
    }
    return t.type === 'recurrence';
  });
}
