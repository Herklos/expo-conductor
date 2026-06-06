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
  type DeviceContext,
  type ExpoConductorModuleEvents,
  type RegisteredTask,
  type ResourceBudget,
  type TaskDefinition,
  TaskResult,
  type Trigger,
} from './ExpoConductor.types';
import { evaluate } from './web/engine/policy';
import { nextRun } from './web/engine/recurrence';
import { TaskRegistry } from './web/engine/registry';
import { admit, type WeightedTask } from './web/engine/weight';
import { computeNextRunAt, normalize } from './web/normalize';

type Listeners = {
  [E in keyof ExpoConductorModuleEvents]: Set<ExpoConductorModuleEvents[E]>;
};

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
}

export class WebSchedulerEngine implements ConductorBackend {
  private registry = new TaskRegistry();
  private timers = new Map<string, unknown>();
  private attempts = new Map<string, number>();
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

  constructor(options: WebSchedulerOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.setTimer =
      options.setTimer ?? ((cb, ms) => setTimeout(cb, ms) as unknown);
    this.clearTimer =
      options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.deviceContext = options.deviceContext ?? (() => DEFAULT_CONTEXT);
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
    return this.registry.remove(id);
  }

  async getTasksAsync(): Promise<RegisteredTask[]> {
    return this.registry.all();
  }

  async runTaskAsync(id: string): Promise<void> {
    const task = this.registry.get(id);
    if (task) this.fire(task, true);
  }

  async setResourceBudgetAsync(budget: ResourceBudget): Promise<void> {
    this.budget = budget;
  }

  async pauseAsync(): Promise<void> {
    this.paused = true;
    for (const id of this.timers.keys()) this.clearTimerFor(id);
  }

  async resumeAsync(): Promise<void> {
    this.paused = false;
    for (const task of this.registry.all()) this.scheduleTimer(task);
  }

  async reportResultAsync(id: string, result: TaskResult): Promise<void> {
    const task = this.registry.get(id);
    if (!task) return;
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
      };
      const { admitted } = admit(this.budget, [candidate]);
      if (!admitted.includes(task.id)) {
        this.emit('onTaskSkipped', { taskId: task.id, reason: 'DEFERRED_BY_BUDGET' });
        this.reschedule(task, now);
        return;
      }
    }

    // Schedule the next occurrence first, so that if the handler reports a
    // failure synchronously the retry timer is not clobbered by rescheduling.
    if (!manual) this.reschedule(task, now);

    const attempt = (this.attempts.get(task.id) ?? 0) + 1;
    this.attempts.set(task.id, attempt);
    this.emit('onTaskExecute', {
      taskId: task.id,
      triggerType: task.triggers[0]?.type ?? 'time',
      firedAt: now,
      attempt,
    });
  }

  private reschedule(task: RegisteredTask, now: number): void {
    const next = task.recurrence
      ? nextRun(task.recurrence, now)
      : computeNextRunAt(futureTriggers(task.triggers, now), undefined, now);
    const updated: RegisteredTask = { ...task, nextRunAt: next };
    this.registry.upsert(updated);
    this.scheduleTimer(updated);
  }

  private handleRetry(task: RegisteredTask): void {
    const retry = task.policy.retry;
    const attempt = this.attempts.get(task.id) ?? 1;
    if (!retry || attempt >= retry.maxAttempts) {
      this.attempts.delete(task.id);
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
