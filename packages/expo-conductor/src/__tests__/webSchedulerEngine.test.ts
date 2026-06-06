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
