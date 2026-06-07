/**
 * The contract every platform backend fulfills. The native modules (Kotlin /
 * Swift, surfaced through `requireNativeModule`) and the Web scheduler engine all
 * implement this shape, so {@link ConductorClient} is platform-agnostic.
 */
import type {
  ConductorStatus,
  ExpoConductorModuleEvents,
  RegisteredTask,
  ResourceBudget,
  TaskDefinition,
  TaskResult,
} from './ExpoConductor.types';

export interface ConductorSubscription {
  remove(): void;
}

export interface ConductorBackend {
  registerTaskAsync(definition: TaskDefinition): Promise<RegisteredTask>;
  cancelTaskAsync(id: string): Promise<boolean>;
  getTasksAsync(): Promise<RegisteredTask[]>;
  runTaskAsync(id: string): Promise<void>;
  setResourceBudgetAsync(budget: ResourceBudget): Promise<void>;
  pauseAsync(): Promise<void>;
  resumeAsync(): Promise<void>;
  /** Whether background execution is currently permitted on this device. */
  getStatusAsync(): Promise<ConductorStatus>;
  /**
   * Request notification permission (required for notification/time/alarm triggers to be
   * delivered). Resolves to whether permission is granted. On Android &lt; 13 and where the
   * platform cannot prompt, resolves to the current grant state.
   */
  requestPermissionsAsync(): Promise<boolean>;
  /**
   * Report the outcome of a JS handler back to the engine (drives retry/backoff).
   * Pass `error` when the handler threw, to surface an `onTaskError` event.
   */
  reportResultAsync(id: string, result: TaskResult, error?: string): Promise<void>;
  addListener<E extends keyof ExpoConductorModuleEvents>(
    event: E,
    listener: ExpoConductorModuleEvents[E],
  ): ConductorSubscription;
}
