/**
 * The contract every platform backend fulfills. The native modules (Kotlin /
 * Swift, surfaced through `requireNativeModule`) and the Web scheduler engine all
 * implement this shape, so {@link ConductorClient} is platform-agnostic.
 */
import type {
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
  /** Report the outcome of a JS handler back to the engine (drives retry/backoff). */
  reportResultAsync(id: string, result: TaskResult): Promise<void>;
  addListener<E extends keyof ExpoConductorModuleEvents>(
    event: E,
    listener: ExpoConductorModuleEvents[E],
  ): ConductorSubscription;
}
