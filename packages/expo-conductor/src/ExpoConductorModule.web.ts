import { registerWebModule, NativeModule } from 'expo';

import type { ConductorBackend, ConductorSubscription } from './ConductorBackend';
import type {
  ConductorStatus,
  ExpoConductorModuleEvents,
  RegisteredTask,
  ResourceBudget,
  TaskDefinition,
  TaskExecutionEvent,
  TaskResult,
} from './ExpoConductor.types';
import { WebSchedulerEngine, type WebSchedulerOptions } from './WebSchedulerEngine';

/**
 * Web implementation of the native module. Delegates to {@link WebSchedulerEngine}
 * (the pure-TS scheduler) and re-emits its events through the Expo web-module
 * event system so the JS API is identical across platforms.
 */
class ExpoConductorWebModule
  extends NativeModule<ExpoConductorModuleEvents>
  implements ConductorBackend
{
  private engine = new WebSchedulerEngine(this.webOptions());

  private webOptions(): WebSchedulerOptions {
    return {
      deviceContext: () => ({
        batteryLevel: 1,
        charging: true,
        networkType:
          typeof navigator !== 'undefined' && navigator.onLine === false ? 'none' : 'unmetered',
        idle: true,
      }),
    };
  }

  constructor() {
    super();
    // Bridge engine events to Expo's web-module emitter.
    (['onTaskExecute', 'onTaskComplete', 'onTaskError', 'onTaskSkipped'] as const).forEach(
      (event) => {
        this.engine.addListener(event, ((payload: unknown) =>
          this.emit(event, payload as never)) as never);
      },
    );
  }

  registerTaskAsync(definition: TaskDefinition): Promise<RegisteredTask> {
    return this.engine.registerTaskAsync(definition);
  }
  cancelTaskAsync(id: string): Promise<boolean> {
    return this.engine.cancelTaskAsync(id);
  }
  getTasksAsync(): Promise<RegisteredTask[]> {
    return this.engine.getTasksAsync();
  }
  runTaskAsync(id: string): Promise<void> {
    return this.engine.runTaskAsync(id);
  }
  runDueTasksAsync(): Promise<number> {
    return this.engine.runDueTasksAsync();
  }
  setResourceBudgetAsync(budget: ResourceBudget): Promise<void> {
    return this.engine.setResourceBudgetAsync(budget);
  }
  pauseAsync(): Promise<void> {
    return this.engine.pauseAsync();
  }
  resumeAsync(): Promise<void> {
    return this.engine.resumeAsync();
  }
  getStatusAsync(): Promise<ConductorStatus> {
    return this.engine.getStatusAsync();
  }
  requestPermissionsAsync(): Promise<boolean> {
    return this.engine.requestPermissionsAsync();
  }
  reportResultAsync(id: string, result: TaskResult, error?: string): Promise<void> {
    return this.engine.reportResultAsync(id, result, error);
  }
  addListener<E extends keyof ExpoConductorModuleEvents>(
    event: E,
    listener: ExpoConductorModuleEvents[E],
  ): ConductorSubscription {
    return this.engine.addListener(event, listener);
  }
  getHistoryAsync(): Promise<TaskExecutionEvent[]> {
    return this.engine.getHistoryAsync();
  }
  clearHistoryAsync(): Promise<void> {
    return this.engine.clearHistoryAsync();
  }
}

export default registerWebModule(ExpoConductorWebModule, 'ExpoConductorModule');
