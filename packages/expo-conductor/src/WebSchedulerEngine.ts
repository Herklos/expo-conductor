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
  type TriggerType,
} from './ExpoConductor.types';
import {
  type AppStateSource,
  type AppStateTransition,
  defaultAppStateSource,
} from './web/engine/appState';
import {
  defaultLeaderElection,
  type LeaderElection,
  type LeaderHandle,
} from './web/engine/leader';
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
  /** Cross-instance leader election backing `policy.singleFlight` (default: Web Locks when
   *  available, else always-leader). Injectable for deterministic tests. */
  leaderElection?: LeaderElection;
  /** Source of foreground/background transitions driving the `appState` trigger (default:
   *  `visibilitychange` + window focus/blur; a no-op under Node/SSR). */
  appStateSource?: AppStateSource;
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
  private readonly leaderElection: LeaderElection;
  private readonly appStateUnsub: () => void;
  /** Per-task single-flight leadership claim (id -> {handle, key}); see `policy.singleFlight`. */
  private readonly leaderClaims = new Map<string, { handle: LeaderHandle; key: string }>();
  /** Tasks whose current occurrence this instance skipped for not being the leader; fired
   *  as a catch-up once leadership is gained (see onLeadershipGain). */
  private readonly deferredByLeader = new Set<string>();

  constructor(options: WebSchedulerOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.setTimer =
      options.setTimer ?? ((cb, ms) => setTimeout(cb, ms) as unknown);
    this.clearTimer =
      options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.deviceContext = options.deviceContext ?? (() => DEFAULT_CONTEXT);
    this.deferRetryMs = options.deferRetryMs ?? 60_000;
    this.leaderElection = options.leaderElection ?? defaultLeaderElection();
    // Re-arm timers (and re-claim single-flight leadership) for tasks restored from
    // persistence — otherwise web persistence is write-only (tasks survive reload but never
    // fire). A task whose nextRunAt is already past fires on the next tick (catch-up).
    if (!this.paused) {
      for (const task of this.registry.all()) {
        this.scheduleTimer(task);
        this.acquireLeaderIfNeeded(task);
      }
    }
    // Drive `appState` triggers from foreground/background transitions.
    this.appStateUnsub = (options.appStateSource ?? defaultAppStateSource()).subscribe((state) =>
      this.onAppState(state),
    );
  }

  // --- ConductorBackend ----------------------------------------------------

  async registerTaskAsync(definition: TaskDefinition): Promise<RegisteredTask> {
    const task = normalize(definition, this.now());
    this.registry.upsert(task);
    this.scheduleTimer(task);
    this.acquireLeaderIfNeeded(task);
    return task;
  }

  async cancelTaskAsync(id: string): Promise<boolean> {
    this.clearTimerFor(id);
    this.releaseLeader(id);
    this.attempts.delete(id);
    this.running.delete(id);
    this.deferredByLeader.delete(id);
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
    // Drop leadership while paused so a non-paused instance can take over the work.
    for (const id of [...this.leaderClaims.keys()]) this.releaseLeader(id);
    // Discard deferred-by-leader markers too: their occurrences are stale once paused, and
    // a re-grant after resume must not replay them (it fires on the fresh schedule instead).
    this.deferredByLeader.clear();
  }

  async resumeAsync(): Promise<void> {
    this.paused = false;
    for (const task of this.registry.all()) {
      this.scheduleTimer(task);
      this.acquireLeaderIfNeeded(task);
    }
  }

  /** Tear down the engine's listeners and in-flight state (timers, single-flight locks,
   *  the appState subscription). The web module holds a long-lived singleton, so this is
   *  mainly for tests / embedders that spin up transient engines and must not leak DOM
   *  listeners or Web Locks. */
  dispose(): void {
    for (const id of [...this.timers.keys()]) this.clearTimerFor(id);
    for (const id of [...this.leaderClaims.keys()]) this.releaseLeader(id);
    this.appStateUnsub();
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

  /** Fire a task: enforce single-flight + policy + budget, then emit execute, then
   *  reschedule. `firedBy` overrides the reported trigger type (e.g. an `appState` fire of
   *  a task whose first trigger is a recurrence). */
  private fire(task: RegisteredTask, manual: boolean, firedBy?: TriggerType): void {
    const now = this.now();
    const ctx: DeviceContext = { ...this.deviceContext(), now };

    if (!manual) {
      // Single-flight: only the elected leader acts. A non-leader defers this occurrence
      // and catches up if/when it later becomes the leader (see onLeadershipGain).
      if (!this.isLeaderFor(task)) {
        this.emit('onTaskSkipped', { taskId: task.id, reason: 'DEFERRED_BY_LEADER' });
        // Mark for catch-up on handoff ONLY for repeating / appState work. A pure one-shot
        // (time/alarm/notification) is intentionally NOT replayed: the leader already ran
        // its occurrence, so replaying here would be the cross-instance double-run that
        // single-flight exists to prevent (see policy.singleFlight docs).
        if (isReplayableOnHandoff(task)) this.deferredByLeader.add(task.id);
        this.reschedule(task, now);
        return;
      }

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

    // This occurrence is now being handled (by the leader, or a manual run) — drop any
    // deferred-by-leader marker so a leadership grant on a later microtask can't replay it.
    this.deferredByLeader.delete(task.id);

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
      triggerType: firedBy ?? task.triggers[0]?.type ?? 'time',
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

  // --- single-flight (leader election) -------------------------------------

  /** Claim (or refresh) single-flight leadership for a task that opted in. Ref-counted by
   *  key inside the election, so tasks sharing a key share one underlying lock. A no-op
   *  while paused or when the task didn't set `policy.singleFlight`. */
  private acquireLeaderIfNeeded(task: RegisteredTask): void {
    if (this.paused) return;
    const key = leaderKeyOf(task);
    const claim = this.leaderClaims.get(task.id);
    if (claim) {
      if (claim.key === key) return; // unchanged — keep the lock we already hold
      claim.handle.release(); // key changed on re-register → drop the stale claim
      this.leaderClaims.delete(task.id);
    }
    if (key == null) return;
    const handle = this.leaderElection.acquire(key, (leader) => {
      if (leader) this.onLeadershipGain(key);
    });
    this.leaderClaims.set(task.id, { handle, key });
  }

  private releaseLeader(id: string): void {
    const claim = this.leaderClaims.get(id);
    if (!claim) return;
    claim.handle.release();
    this.leaderClaims.delete(id);
  }

  /** Whether this instance may fire `task` now: always true unless it opted into
   *  single-flight, in which case only the current lock holder may. A task with no live
   *  claim (e.g. while paused) is not blocked. */
  private isLeaderFor(task: RegisteredTask): boolean {
    if (leaderKeyOf(task) == null) return true;
    const claim = this.leaderClaims.get(task.id);
    return claim ? claim.handle.isLeader() : true;
  }

  /** On gaining leadership for `key`, catch up every task under that key that this instance
   *  deferred while a non-leader, or that has since come due. Tasks still on their normal
   *  schedule aren't fired, so the initial (uncontended) grant fires nothing early. */
  private onLeadershipGain(key: string): void {
    if (this.paused) return;
    const now = this.now();
    for (const task of this.registry.all()) {
      if (leaderKeyOf(task) !== key) continue;
      const due = task.nextRunAt != null && task.nextRunAt <= now;
      if (this.deferredByLeader.has(task.id) || due) {
        this.deferredByLeader.delete(task.id);
        this.fire(task, false);
      }
    }
  }

  // --- app-state triggers --------------------------------------------------

  /** Fire every task with an `appState` trigger matching this foreground/background
   *  transition (subject to the same single-flight + policy + budget gating).
   *
   *  Note: an appState fire and a recurrence-timer fire are not atomic — a task carrying
   *  both could, in the rare case they coincide in one tick, emit two `onTaskExecute`s
   *  (two attempts). Handlers should be idempotent (e.g. dedup on content); the engine does
   *  not collapse them, since `running` is cleared only when the consumer reports a result. */
  private onAppState(state: AppStateTransition): void {
    if (this.paused) return;
    for (const task of this.registry.all()) {
      if (task.triggers.some((t) => t.type === 'appState' && t.on === state)) {
        this.fire(task, false, 'appState');
      }
    }
  }
}

/** Whether a task deferred while a non-leader should be replayed when this instance later
 *  gains leadership: true for repeating (recurrence) or event (appState) work, false for a
 *  pure one-shot (time/alarm/notification), whose occurrence the leader already ran. */
function isReplayableOnHandoff(task: RegisteredTask): boolean {
  if (task.recurrence != null) return true;
  return task.triggers.some((t) => t.type === 'recurrence' || t.type === 'appState');
}

/** Resolve a task's single-flight leader key, or null when it didn't opt in. */
function leaderKeyOf(task: RegisteredTask): string | null {
  const sf = task.policy.singleFlight;
  if (!sf) return null;
  return sf === true ? task.id : sf;
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
