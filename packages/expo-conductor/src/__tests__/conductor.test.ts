import { ConductorClient } from '../Conductor';
import type { ConductorBackend, ConductorSubscription } from '../ConductorBackend';
import {
  type ExpoConductorModuleEvents,
  type RegisteredTask,
  type TaskEventPayload,
  TaskResult,
} from '../ExpoConductor.types';

/** In-memory backend that lets tests emit events and observe reported results. */
class MockBackend implements ConductorBackend {
  registered: RegisteredTask[] = [];
  results: { id: string; result: TaskResult }[] = [];
  private executeListeners = new Set<(p: TaskEventPayload) => void>();

  async registerTaskAsync(definition: { id: string }): Promise<RegisteredTask> {
    const task = {
      id: definition.id,
      handler: { name: definition.id, type: 'js' as const },
      triggers: [],
      priority: 0,
      weight: { cpu: 0, network: 0, battery: 0, memory: 0 },
      policy: {},
      nextRunAt: null,
      createdAt: 0,
    };
    this.registered.push(task);
    return task;
  }
  async cancelTaskAsync(): Promise<boolean> {
    return true;
  }
  async getTasksAsync(): Promise<RegisteredTask[]> {
    return this.registered;
  }
  async runTaskAsync(): Promise<void> {}
  async setResourceBudgetAsync(): Promise<void> {}
  async pauseAsync(): Promise<void> {}
  async resumeAsync(): Promise<void> {}
  async reportResultAsync(id: string, result: TaskResult): Promise<void> {
    this.results.push({ id, result });
  }
  addListener<E extends keyof ExpoConductorModuleEvents>(
    event: E,
    listener: ExpoConductorModuleEvents[E],
  ): ConductorSubscription {
    if (event === 'onTaskExecute') {
      this.executeListeners.add(listener as (p: TaskEventPayload) => void);
    }
    return { remove: () => this.executeListeners.delete(listener as (p: TaskEventPayload) => void) };
  }

  emitExecute(taskId: string): void {
    const payload: TaskEventPayload = { taskId, triggerType: 'time', firedAt: 0, attempt: 1 };
    for (const l of this.executeListeners) l(payload);
  }
}

const flush = () => new Promise((r) => setImmediate(r));

describe('ConductorClient', () => {
  it('dispatches onTaskExecute to the registered JS handler and reports success', async () => {
    const backend = new MockBackend();
    const conductor = new ConductorClient(backend);
    const ran: string[] = [];
    conductor.defineTask('sync', (ctx) => {
      ran.push(ctx.taskId);
      return TaskResult.NEW_DATA;
    });

    backend.emitExecute('sync');
    await flush();

    expect(ran).toEqual(['sync']);
    expect(backend.results).toEqual([{ id: 'sync', result: TaskResult.NEW_DATA }]);
  });

  it('reports SUCCESS when a handler returns nothing', async () => {
    const backend = new MockBackend();
    const conductor = new ConductorClient(backend);
    conductor.defineTask('noop', () => {});
    backend.emitExecute('noop');
    await flush();
    expect(backend.results).toEqual([{ id: 'noop', result: TaskResult.SUCCESS }]);
  });

  it('reports FAILED when a handler throws', async () => {
    const backend = new MockBackend();
    const conductor = new ConductorClient(backend);
    conductor.defineTask('boom', () => {
      throw new Error('nope');
    });
    backend.emitExecute('boom');
    await flush();
    expect(backend.results).toEqual([{ id: 'boom', result: TaskResult.FAILED }]);
  });

  it('ignores events with no registered JS handler (native handler case)', async () => {
    const backend = new MockBackend();
    const conductor = new ConductorClient(backend);
    conductor.defineTask('known', () => {});
    backend.emitExecute('nativeOnly');
    await flush();
    expect(backend.results).toEqual([]);
  });

  it('schedule registers both the handler and the definition', async () => {
    const backend = new MockBackend();
    const conductor = new ConductorClient(backend);
    await conductor.schedule({ id: 'job', triggers: [{ type: 'time', inSeconds: 1 }] }, () => {});
    expect(backend.registered.map((t) => t.id)).toEqual(['job']);
    backend.emitExecute('job');
    await flush();
    expect(backend.results).toEqual([{ id: 'job', result: TaskResult.SUCCESS }]);
  });

  it('dispatches to the shared handler when task id differs from handler name', async () => {
    // Regression for the handler-name vs taskId mismatch: several dynamically-id'd
    // tasks all point at one named handler.
    const backend = new MockBackend();
    const conductor = new ConductorClient(backend);
    const ran: string[] = [];
    conductor.defineTask('sync', (ctx) => {
      ran.push(ctx.taskId);
      return TaskResult.SUCCESS;
    });
    await conductor.schedule({
      id: 'once-0',
      handler: { name: 'sync', type: 'js' },
      triggers: [{ type: 'time', inSeconds: 1 }],
    });
    await conductor.schedule({
      id: 'once-1',
      handler: { name: 'sync', type: 'js' },
      triggers: [{ type: 'time', inSeconds: 1 }],
    });

    backend.emitExecute('once-0');
    backend.emitExecute('once-1');
    await flush();

    expect(ran).toEqual(['once-0', 'once-1']);
    expect(backend.results).toEqual([
      { id: 'once-0', result: TaskResult.SUCCESS },
      { id: 'once-1', result: TaskResult.SUCCESS },
    ]);
  });
});
