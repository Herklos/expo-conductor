import {
  type DeviceContext,
  type TaskEventPayload,
  type TaskSkippedEventPayload,
  TaskResult,
} from '../ExpoConductor.types';
import { WebSchedulerEngine } from '../WebSchedulerEngine';

/** Deterministic virtual clock + timer queue. */
function makeHarness() {
  let current = 0;
  let nextId = 1;
  const timers = new Map<number, { cb: () => void; time: number }>();

  const setTimer = (cb: () => void, ms: number) => {
    const id = nextId++;
    timers.set(id, { cb, time: current + ms });
    return id;
  };
  const clearTimer = (h: unknown) => timers.delete(h as number);
  const now = () => current;

  const advanceTo = (t: number) => {
    for (let guard = 0; guard < 10_000; guard++) {
      let earliest: { id: number; time: number } | undefined;
      for (const [id, timer] of timers) {
        if (timer.time <= t && (!earliest || timer.time < earliest.time)) {
          earliest = { id, time: timer.time };
        }
      }
      if (!earliest) break;
      const timer = timers.get(earliest.id)!;
      timers.delete(earliest.id);
      current = timer.time;
      timer.cb();
    }
    current = t;
  };

  return { setTimer, clearTimer, now, advanceTo };
}

describe('WebSchedulerEngine', () => {
  it('fires a one-shot time trigger at the scheduled moment', async () => {
    const h = makeHarness();
    const engine = new WebSchedulerEngine({ now: h.now, setTimer: h.setTimer, clearTimer: h.clearTimer });
    const fired: TaskEventPayload[] = [];
    engine.addListener('onTaskExecute', (p) => fired.push(p));

    await engine.registerTaskAsync({ id: 'a', triggers: [{ type: 'time', at: 5000 }] });
    h.advanceTo(4999);
    expect(fired).toHaveLength(0);
    h.advanceTo(5000);
    expect(fired).toHaveLength(1);
    expect(fired[0].taskId).toBe('a');
  });

  it('skips a task whose policy is not satisfied', async () => {
    const h = makeHarness();
    const ctx: Omit<DeviceContext, 'now'> = {
      batteryLevel: 0.1,
      charging: false,
      networkType: 'unmetered',
      idle: true,
    };
    const engine = new WebSchedulerEngine({
      now: h.now,
      setTimer: h.setTimer,
      clearTimer: h.clearTimer,
      deviceContext: () => ctx,
    });
    const skipped: TaskSkippedEventPayload[] = [];
    engine.addListener('onTaskSkipped', (p) => skipped.push(p));

    await engine.registerTaskAsync({
      id: 'a',
      triggers: [{ type: 'time', at: 1000 }],
      policy: { constraints: { minBatteryLevel: 0.5 } },
    });
    h.advanceTo(1000);
    expect(skipped).toEqual([{ taskId: 'a', reason: 'BATTERY_TOO_LOW' }]);
  });

  it('defers a task that exceeds the resource budget', async () => {
    const h = makeHarness();
    const engine = new WebSchedulerEngine({ now: h.now, setTimer: h.setTimer, clearTimer: h.clearTimer });
    await engine.setResourceBudgetAsync({ cpu: 0.5, network: 1, battery: 1, memory: 1 });
    const skipped: TaskSkippedEventPayload[] = [];
    engine.addListener('onTaskSkipped', (p) => skipped.push(p));

    await engine.registerTaskAsync({
      id: 'heavy',
      weight: { cpu: 0.9, network: 0.1, battery: 0.1, memory: 0.1 },
      triggers: [{ type: 'time', at: 1000 }],
    });
    h.advanceTo(1000);
    expect(skipped).toEqual([{ taskId: 'heavy', reason: 'DEFERRED_BY_BUDGET' }]);
  });

  it('reschedules a recurring task', async () => {
    const h = makeHarness();
    const engine = new WebSchedulerEngine({ now: h.now, setTimer: h.setTimer, clearTimer: h.clearTimer });
    const fired: TaskEventPayload[] = [];
    engine.addListener('onTaskExecute', (p) => fired.push(p));

    await engine.registerTaskAsync({
      id: 'tick',
      triggers: [{ type: 'recurrence', recurrence: { kind: 'interval', everyMs: 1000 } }],
    });
    h.advanceTo(3500);
    expect(fired.map((f) => f.taskId)).toEqual(['tick', 'tick', 'tick']);
  });

  it('runNow bypasses policy and budget', async () => {
    const h = makeHarness();
    const engine = new WebSchedulerEngine({
      now: h.now,
      setTimer: h.setTimer,
      clearTimer: h.clearTimer,
      deviceContext: () => ({ batteryLevel: 0, charging: false, networkType: 'none', idle: false }),
    });
    const fired: TaskEventPayload[] = [];
    engine.addListener('onTaskExecute', (p) => fired.push(p));

    await engine.registerTaskAsync({
      id: 'a',
      triggers: [{ type: 'time', at: 999_999 }],
      policy: { constraints: { requiresCharging: true } },
    });
    await engine.runTaskAsync('a');
    expect(fired).toHaveLength(1);
  });

  it('cancel removes the task and its timer', async () => {
    const h = makeHarness();
    const engine = new WebSchedulerEngine({ now: h.now, setTimer: h.setTimer, clearTimer: h.clearTimer });
    const fired: TaskEventPayload[] = [];
    engine.addListener('onTaskExecute', (p) => fired.push(p));

    await engine.registerTaskAsync({ id: 'a', triggers: [{ type: 'time', at: 5000 }] });
    expect(await engine.cancelTaskAsync('a')).toBe(true);
    h.advanceTo(6000);
    expect(fired).toHaveLength(0);
    expect(await engine.getTasksAsync()).toHaveLength(0);
  });

  it('emits onTaskComplete with the reported result', async () => {
    const h = makeHarness();
    const engine = new WebSchedulerEngine({ now: h.now, setTimer: h.setTimer, clearTimer: h.clearTimer });
    const completed: { taskId: string; result: TaskResult }[] = [];
    engine.addListener('onTaskComplete', (p) => completed.push({ taskId: p.taskId, result: p.result }));

    await engine.registerTaskAsync({ id: 'a', triggers: [{ type: 'time', at: 1000 }] });
    await engine.runTaskAsync('a');
    await engine.reportResultAsync('a', TaskResult.NEW_DATA);
    expect(completed).toEqual([{ taskId: 'a', result: TaskResult.NEW_DATA }]);
  });

  it('emits onTaskError when a result is reported with an error', async () => {
    const h = makeHarness();
    const engine = new WebSchedulerEngine({ now: h.now, setTimer: h.setTimer, clearTimer: h.clearTimer });
    const errors: { taskId: string; error: string }[] = [];
    engine.addListener('onTaskError', (p) => errors.push({ taskId: p.taskId, error: p.error }));

    await engine.registerTaskAsync({ id: 'a', triggers: [{ type: 'time', at: 1000 }] });
    await engine.reportResultAsync('a', TaskResult.FAILED, 'boom');
    expect(errors).toEqual([{ taskId: 'a', error: 'boom' }]);
  });

  it('manual runNow does not perturb the retry attempt counter', async () => {
    const h = makeHarness();
    const engine = new WebSchedulerEngine({ now: h.now, setTimer: h.setTimer, clearTimer: h.clearTimer });
    const attempts: number[] = [];
    engine.addListener('onTaskExecute', (p) => attempts.push(p.attempt));

    await engine.registerTaskAsync({
      id: 'a',
      triggers: [{ type: 'time', at: 1000 }],
      policy: { retry: { maxAttempts: 3, backoffMs: 500 } },
    });
    await engine.runTaskAsync('a'); // manual
    await engine.runTaskAsync('a'); // manual again — must still report attempt 1
    h.advanceTo(1000); // scheduled fire — should be attempt 1, not inflated by the manual runs
    expect(attempts).toEqual([1, 1, 1]);
  });

  it('a failed manual run does not arm a retry timer or perturb the schedule', async () => {
    const h = makeHarness();
    const engine = new WebSchedulerEngine({ now: h.now, setTimer: h.setTimer, clearTimer: h.clearTimer });
    const fired: number[] = [];
    engine.addListener('onTaskExecute', (p) => fired.push(p.firedAt));

    await engine.registerTaskAsync({
      id: 'a',
      triggers: [{ type: 'time', at: 10_000 }],
      policy: { retry: { maxAttempts: 3, backoffMs: 500 } },
    });
    await engine.runTaskAsync('a'); // manual fire at t=0
    await engine.reportResultAsync('a', TaskResult.FAILED); // manual failure must NOT schedule a retry

    h.advanceTo(2000); // a backoff retry (if wrongly armed) would fire around t=500
    expect(fired.map(() => 'manual-only')).toEqual(['manual-only']); // only the manual run so far
    h.advanceTo(10_000); // the real scheduled fire still happens on time
    expect(fired).toEqual([0, 10_000]);
  });

  it('chains timers for a far-future task instead of firing immediately (setTimeout overflow)', async () => {
    const h = makeHarness();
    const engine = new WebSchedulerEngine({ now: h.now, setTimer: h.setTimer, clearTimer: h.clearTimer });
    const fired: number[] = [];
    engine.addListener('onTaskExecute', (p) => fired.push(p.firedAt));

    const fortyDays = 40 * 24 * 3600 * 1000; // > setTimeout's ~24.8-day (2^31 ms) limit
    await engine.registerTaskAsync({ id: 'far', triggers: [{ type: 'time', at: fortyDays }] });

    h.advanceTo(30 * 24 * 3600 * 1000); // 30 days: must NOT have fired yet
    expect(fired).toEqual([]);
    h.advanceTo(fortyDays); // now it fires, exactly once
    expect(fired).toEqual([fortyDays]);
  });

  it('defers a due task when an in-flight task already consumes the budget', async () => {
    const h = makeHarness();
    const engine = new WebSchedulerEngine({
      now: h.now,
      setTimer: h.setTimer,
      clearTimer: h.clearTimer,
      deferRetryMs: 500,
    });
    await engine.setResourceBudgetAsync({ cpu: 1, network: 1, battery: 1, memory: 1 });
    const fired: string[] = [];
    const skipped: TaskSkippedEventPayload[] = [];
    engine.addListener('onTaskExecute', (p) => fired.push(p.taskId));
    engine.addListener('onTaskSkipped', (p) => skipped.push(p));

    // Two heavy tasks due at the same instant; together they exceed the cpu budget.
    await engine.registerTaskAsync({
      id: 'first',
      weight: { cpu: 0.7, network: 0.1, battery: 0.1, memory: 0.1 },
      triggers: [{ type: 'time', at: 1000 }],
    });
    await engine.registerTaskAsync({
      id: 'second',
      weight: { cpu: 0.7, network: 0.1, battery: 0.1, memory: 0.1 },
      triggers: [{ type: 'time', at: 1000 }],
    });
    h.advanceTo(1000); // 'first' runs and stays in-flight (no result reported)
    expect(fired).toEqual(['first']);
    expect(skipped).toEqual([{ taskId: 'second', reason: 'DEFERRED_BY_BUDGET' }]);

    // Once 'first' completes, the freed budget lets 'second' run on its retry.
    await engine.reportResultAsync('first', TaskResult.SUCCESS);
    h.advanceTo(2000);
    expect(fired).toContain('second');
  });

  it('enforces maxConcurrent across in-flight tasks', async () => {
    const h = makeHarness();
    const engine = new WebSchedulerEngine({ now: h.now, setTimer: h.setTimer, clearTimer: h.clearTimer });
    const fired: string[] = [];
    const skipped: TaskSkippedEventPayload[] = [];
    engine.addListener('onTaskExecute', (p) => fired.push(p.taskId));
    engine.addListener('onTaskSkipped', (p) => skipped.push(p));

    const light = { cpu: 0.1, network: 0.1, battery: 0.1, memory: 0.1 };
    await engine.registerTaskAsync({
      id: 'a',
      weight: light,
      policy: { maxConcurrent: 1 },
      triggers: [{ type: 'time', at: 1000 }],
    });
    await engine.registerTaskAsync({
      id: 'b',
      weight: light,
      policy: { maxConcurrent: 1 },
      triggers: [{ type: 'time', at: 1000 }],
    });
    h.advanceTo(1000);
    expect(fired).toEqual(['a']);
    expect(skipped).toEqual([{ taskId: 'b', reason: 'DEFERRED_BY_BUDGET' }]);
  });

  it('runDueTasksAsync fires due tasks (priority order) and skips not-yet-due ones', async () => {
    // Timers disabled so dispatch happens only through the explicit due-pass.
    const engine = new WebSchedulerEngine({ now: () => 5000, setTimer: () => 0, clearTimer: () => {} });
    const fired: string[] = [];
    engine.addListener('onTaskExecute', (p) => fired.push(p.taskId));

    await engine.registerTaskAsync({ id: 'x', priority: 1, triggers: [{ type: 'time', at: 1000 }] });
    await engine.registerTaskAsync({ id: 'y', priority: 9, triggers: [{ type: 'time', at: 1000 }] });
    await engine.registerTaskAsync({ id: 'later', triggers: [{ type: 'time', at: 9_999_999 }] });

    const count = await engine.runDueTasksAsync();
    expect(count).toBe(2); // x and y are due; 'later' is not
    expect(fired).toEqual(['y', 'x']); // highest priority first
  });

  it('getStatusAsync reports available on web', async () => {
    const h = makeHarness();
    const engine = new WebSchedulerEngine({ now: h.now, setTimer: h.setTimer, clearTimer: h.clearTimer });
    expect(await engine.getStatusAsync()).toBe('available');
  });

  it('keeps a recurring task alive after its retries are exhausted', async () => {
    const h = makeHarness();
    const engine = new WebSchedulerEngine({ now: h.now, setTimer: h.setTimer, clearTimer: h.clearTimer });
    const fired: TaskEventPayload[] = [];
    engine.addListener('onTaskExecute', (p) => {
      fired.push(p);
      // Always fail; maxAttempts=1 means each occurrence immediately exhausts retries.
      void engine.reportResultAsync(p.taskId, TaskResult.FAILED);
    });

    await engine.registerTaskAsync({
      id: 'tick',
      triggers: [{ type: 'recurrence', recurrence: { kind: 'interval', everyMs: 1000 } }],
      policy: { retry: { maxAttempts: 1, backoffMs: 100 } },
    });
    h.advanceTo(3500);
    // Without the fix the recurrence would be dropped after the first failure.
    expect(fired.map((f) => f.taskId)).toEqual(['tick', 'tick', 'tick']);
  });

  it('honors a one-shot trigger alongside a recurrence after rescheduling', async () => {
    const h = makeHarness();
    const engine = new WebSchedulerEngine({ now: h.now, setTimer: h.setTimer, clearTimer: h.clearTimer });
    const fired: number[] = [];
    engine.addListener('onTaskExecute', (p) => fired.push(p.firedAt));

    await engine.registerTaskAsync({
      id: 'mix',
      recurrence: { kind: 'interval', everyMs: 10_000 },
      triggers: [
        { type: 'recurrence', recurrence: { kind: 'interval', everyMs: 10_000 } },
        { type: 'alarm', at: 3000 },
      ],
    });
    h.advanceTo(12_000);
    // alarm at 3000, then recurrence at 10000 (both honored after reschedule).
    expect(fired).toContain(3000);
    expect(fired).toContain(10_000);
  });

  it('retries a failed task with backoff', async () => {
    const h = makeHarness();
    const engine = new WebSchedulerEngine({ now: h.now, setTimer: h.setTimer, clearTimer: h.clearTimer });
    const fired: TaskEventPayload[] = [];
    engine.addListener('onTaskExecute', (p) => {
      fired.push(p);
      // Report failure for the first attempt only.
      if (p.attempt === 1) void engine.reportResultAsync(p.taskId, TaskResult.FAILED);
    });

    await engine.registerTaskAsync({
      id: 'a',
      triggers: [{ type: 'time', at: 1000 }],
      policy: { retry: { maxAttempts: 3, backoffMs: 500 } },
    });
    h.advanceTo(1000); // attempt 1 -> fails -> schedules retry at 1500
    h.advanceTo(2000); // attempt 2 -> success
    expect(fired.map((f) => f.attempt)).toEqual([1, 2]);
  });
});
