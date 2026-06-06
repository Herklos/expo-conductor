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
  type ExpoConductorModuleEvents,
  type JsTaskHandler,
  type RegisteredTask,
  type ResourceBudget,
  type TaskDefinition,
  type TaskExecutionContext,
  TaskResult,
} from './ExpoConductor.types';

export class ConductorClient {
  private handlers = new Map<string, JsTaskHandler>();
  /** Maps a task id to the name of the handler it should dispatch to. */
  private taskHandlerNames = new Map<string, string>();
  private executeSub?: ConductorSubscription;

  constructor(private readonly backend: ConductorBackend) {}

  /**
   * Register a JS handler for a task. The first registration lazily wires the
   * `onTaskExecute` listener that dispatches to handlers.
   */
  defineTask(name: string, handler: JsTaskHandler): void {
    this.handlers.set(name, handler);
    this.ensureDispatch();
  }

  /** Remove a previously registered JS handler. */
  undefineTask(name: string): void {
    this.handlers.delete(name);
  }

  /** Register (or replace) a task definition with the engine. */
  async defineTaskDefinition(definition: TaskDefinition): Promise<RegisteredTask> {
    this.taskHandlerNames.set(definition.id, definition.handler?.name ?? definition.id);
    return this.backend.registerTaskAsync(definition);
  }

  /** Convenience: register a JS handler and its task definition together. */
  async schedule(definition: TaskDefinition, handler?: JsTaskHandler): Promise<RegisteredTask> {
    const name = definition.handler?.name ?? definition.id;
    if (handler && (definition.handler?.type ?? 'js') === 'js') {
      this.defineTask(name, handler);
    }
    this.taskHandlerNames.set(definition.id, name);
    return this.backend.registerTaskAsync(definition);
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

  setResourceBudget(budget: ResourceBudget): Promise<void> {
    return this.backend.setResourceBudgetAsync(budget);
  }

  pause(): Promise<void> {
    return this.backend.pauseAsync();
  }

  resume(): Promise<void> {
    return this.backend.resumeAsync();
  }

  addListener<E extends keyof ExpoConductorModuleEvents>(
    event: E,
    listener: ExpoConductorModuleEvents[E],
  ): ConductorSubscription {
    return this.backend.addListener(event, listener);
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
    if (!handler) return; // native handler or no JS handler registered
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
    } catch {
      await this.backend.reportResultAsync(payload.taskId, TaskResult.FAILED);
    }
  }
}
