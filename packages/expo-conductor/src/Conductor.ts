/**
 * Public, platform-agnostic API for expo-conductor.
 *
 * `ConductorClient` wraps any {@link ConductorBackend} (native module or web
 * engine), maintains the JS handler registry, and bridges the native
 * `onTaskExecute` event to the right JS handler — reporting the normalized result
 * back so retry/backoff and budgeting work uniformly. Native handlers run on the
 * native side and never reach JS.
 */
import type { ConductorBackend, ConductorSubscription } from './ConductorBackend';
import {
  type ConductorStatus,
  type ExpoConductorModuleEvents,
  type JsTaskHandler,
  type RegisteredTask,
  type ResourceBudget,
  type TaskDefinition,
  type TaskExecutionContext,
  type TaskExecutionEvent,
  TaskResult,
} from './ExpoConductor.types';
import { assertValidRecurrence, recurrenceFor } from './web/normalize';

export class ConductorClient {
  private handlers = new Map<string, JsTaskHandler>();
  /** Maps a task id to the name of the handler it should dispatch to. */
  private taskHandlerNames = new Map<string, string>();
  private executeSub?: ConductorSubscription;

  constructor(private readonly backend: ConductorBackend) {}

  /**
   * Register a JS handler for a task. The first registration lazily wires the
   * `onTaskExecute` listener that dispatches to handlers.
   *
   * IMPORTANT: like `expo-task-manager`'s `defineTask`, call this at **module (global)
   * scope** — not inside a React component, effect, or callback. When the OS relaunches
   * the app headlessly to run a background/alarm/push task, no components mount, so a
   * handler registered inside a component would be missing and the task would not run.
   * For work that must run while the app is terminated, use a native handler instead
   * (`handler.type: 'native'`).
   */
  defineTask(name: string, handler: JsTaskHandler): void {
    this.handlers.set(name, handler);
    this.ensureDispatch();
  }

  /** Remove a previously registered JS handler. */
  undefineTask(name: string): void {
    this.handlers.delete(name);
  }

  /** Whether a JS handler with this name is currently registered. */
  isTaskDefined(name: string): boolean {
    return this.handlers.has(name);
  }

  /** Names of all currently-registered JS handlers. */
  getDefinedTaskNames(): string[] {
    return [...this.handlers.keys()];
  }

  /** Register (or replace) a task definition with the engine. */
  async defineTaskDefinition(definition: TaskDefinition): Promise<RegisteredTask> {
    // Validate the recurrence up front so a malformed cron fails fast on EVERY platform.
    // Previously this guard lived only inside the Web backend's normalize, so native
    // registration silently accepted (or even fired) an invalid cron. ConductorClient is the
    // single registration entry point for all backends, so this makes the guard platform-agnostic.
    assertValidRecurrence(recurrenceFor(definition));
    this.taskHandlerNames.set(definition.id, definition.handler?.name ?? definition.id);
    this.warnIfHandlerMissing(definition);
    return this.backend.registerTaskAsync(definition);
  }

  /** Convenience: register a JS handler and its task definition together. */
  async schedule(definition: TaskDefinition, handler?: JsTaskHandler): Promise<RegisteredTask> {
    assertValidRecurrence(recurrenceFor(definition)); // fail fast on a malformed cron, all platforms
    const name = definition.handler?.name ?? definition.id;
    if (handler && (definition.handler?.type ?? 'js') === 'js') {
      this.defineTask(name, handler);
    }
    this.taskHandlerNames.set(definition.id, name);
    this.warnIfHandlerMissing(definition);
    return this.backend.registerTaskAsync(definition);
  }

  /**
   * Warn when a task with a JS handler that can fire while the app is terminated has no
   * handler registered — a strong signal the handler was defined in component scope.
   * Native and Rust handlers run on the native side and never need a JS registration.
   */
  private warnIfHandlerMissing(definition: TaskDefinition): void {
    const type = definition.handler?.type ?? 'js';
    if (type !== 'js') return;
    const name = definition.handler?.name ?? definition.id;
    if (this.handlers.has(name)) return;
    const headlessCapable = definition.triggers.some(
      (t) => t.type === 'background' || t.type === 'alarm' || t.type === 'push',
    );
    if (!headlessCapable) return;
    console.warn(
      `[expo-conductor] Task "${definition.id}" has a JS handler "${name}" that is not ` +
        `registered, but can fire while the app is terminated. Register it at module scope ` +
        `via Conductor.defineTask("${name}", fn), or use a native handler for headless work.`,
    );
  }

  cancelTask(id: string): Promise<boolean> {
    this.taskHandlerNames.delete(id);
    return this.backend.cancelTaskAsync(id);
  }

  getTasks(): Promise<RegisteredTask[]> {
    return this.backend.getTasksAsync();
  }

  runNow(id: string): Promise<void> {
    return this.backend.runTaskAsync(id);
  }

  /**
   * Run every currently-due task through the normal admission/dispatch path. Intended for
   * a background tick (see the optional `expo-background-task` integration) so one OS wake
   * can drive the engine. Returns the number of tasks fired.
   */
  runDueTasks(): Promise<number> {
    return this.backend.runDueTasksAsync();
  }

  setResourceBudget(budget: ResourceBudget): Promise<void> {
    return this.backend.setResourceBudgetAsync(budget);
  }

  pause(): Promise<void> {
    return this.backend.pauseAsync();
  }

  resume(): Promise<void> {
    return this.backend.resumeAsync();
  }

  /** Whether background execution is currently permitted on this device. */
  getStatus(): Promise<ConductorStatus> {
    return this.backend.getStatusAsync();
  }

  /**
   * Request notification permission (needed for notification/time/alarm triggers to
   * surface). Resolves to whether permission is granted.
   */
  requestPermissions(): Promise<boolean> {
    return this.backend.requestPermissionsAsync();
  }

  addListener<E extends keyof ExpoConductorModuleEvents>(
    event: E,
    listener: ExpoConductorModuleEvents[E],
  ): ConductorSubscription {
    return this.backend.addListener(event, listener);
  }

  /**
   * Return all persisted execution events from the ring buffer (oldest first).
   * Fold them into {@link TaskExecutionRecord}s with `foldHistory()` from
   * `expo-conductor`.
   */
  getHistory(): Promise<TaskExecutionEvent[]> {
    return this.backend.getHistoryAsync();
  }

  /** Clear the execution-event ring buffer. */
  clearHistory(): Promise<void> {
    return this.backend.clearHistoryAsync();
  }

  private ensureDispatch(): void {
    if (this.executeSub) return;
    this.executeSub = this.backend.addListener('onTaskExecute', (payload) => {
      void this.dispatch(payload);
    });
  }

  private async dispatch(payload: {
    taskId: string;
    triggerType: TaskExecutionContext['triggerType'];
    firedAt: number;
    attempt: number;
    data?: Record<string, unknown>;
  }): Promise<void> {
    // Resolve the task id to its handler name (they differ when several tasks
    // share one handler, e.g. dynamic ids). Falls back to the task id itself.
    const handlerName = this.taskHandlerNames.get(payload.taskId) ?? payload.taskId;
    const handler = this.handlers.get(handlerName);
    if (!handler) return; // native/rust handler, or no JS handler registered
    const ctx: TaskExecutionContext = {
      taskId: payload.taskId,
      triggerType: payload.triggerType,
      firedAt: payload.firedAt,
      attempt: payload.attempt,
      data: payload.data,
    };
    try {
      const result = (await handler(ctx)) ?? TaskResult.SUCCESS;
      await this.backend.reportResultAsync(payload.taskId, result);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await this.backend.reportResultAsync(payload.taskId, TaskResult.FAILED, message);
    }
  }
}
