import {
  type TaskEventPayload,
  type TaskSkippedEventPayload,
} from '../ExpoConductor.types';
import type { LeaderElection } from '../web/engine/leader';
import { WebSchedulerEngine } from '../WebSchedulerEngine';

/** Deterministic virtual clock + timer queue (mirrors webSchedulerEngine.test.ts). */
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

/** Controllable leader election: every key starts NON-leader; `setLeader` flips it and
 *  fires the listeners (modelling a real lock handoff). Records release() calls. */
function makeElection() {
  const keys = new Map<string, { leader: boolean; listeners: Set<(l: boolean) => void> }>();
  let releases = 0;
  const election: LeaderElection = {
    acquire(key, onChange) {
      let s = keys.get(key);
      if (!s) {
        s = { leader: false, listeners: new Set() };
        keys.set(key, s);
      }
      if (onChange) s.listeners.add(onChange);
      return {
        isLeader: () => keys.get(key)?.leader ?? false,
        release: () => {
          releases += 1;
          if (onChange) keys.get(key)?.listeners.delete(onChange);
        },
      };
    },
  };
  return {
    election,
    setLeader(key: string, leader: boolean) {
      const s = keys.get(key);
      if (!s) return;
      const was = s.leader;
      s.leader = leader;
      if (leader && !was) for (const l of [...s.listeners]) l(true);
    },
    releases: () => releases,
  };
}

function makeEngine(election: LeaderElection, h = makeHarness()) {
  const engine = new WebSchedulerEngine({
    now: h.now,
    setTimer: h.setTimer,
    clearTimer: h.clearTimer,
    leaderElection: election,
  });
  const fired: TaskEventPayload[] = [];
  const skipped: TaskSkippedEventPayload[] = [];
  engine.addListener('onTaskExecute', (p) => fired.push(p));
  engine.addListener('onTaskSkipped', (p) => skipped.push(p));
  return { engine, h, fired, skipped };
}

describe('WebSchedulerEngine single-flight (policy.singleFlight)', () => {
  it('a non-leader defers its occurrence with DEFERRED_BY_LEADER (no execute)', async () => {
    const e = makeElection();
    const { engine, h, fired, skipped } = makeEngine(e.election);
    await engine.registerTaskAsync({
      id: 'tick',
      triggers: [{ type: 'recurrence', recurrence: { kind: 'interval', everyMs: 1000 } }],
      policy: { singleFlight: true },
    });
    h.advanceTo(3500);
    expect(fired).toHaveLength(0);
    expect(skipped.every((s) => s.reason === 'DEFERRED_BY_LEADER')).toBe(true);
    expect(skipped.length).toBeGreaterThan(0);
  });

  it('the leader fires the task on schedule', async () => {
    const e = makeElection();
    const { engine, h, fired } = makeEngine(e.election);
    await engine.registerTaskAsync({
      id: 'tick',
      triggers: [{ type: 'recurrence', recurrence: { kind: 'interval', everyMs: 1000 } }],
      policy: { singleFlight: true },
    });
    e.setLeader('tick', true); // leader before any occurrence is due → fires nothing early
    expect(fired).toHaveLength(0);
    h.advanceTo(3500);
    expect(fired.map((f) => f.taskId)).toEqual(['tick', 'tick', 'tick']);
  });

  it('catches up a deferred occurrence the moment leadership is gained (handoff)', async () => {
    const e = makeElection();
    const { engine, h, fired, skipped } = makeEngine(e.election);
    await engine.registerTaskAsync({
      id: 'tick',
      triggers: [{ type: 'recurrence', recurrence: { kind: 'interval', everyMs: 1000 } }],
      policy: { singleFlight: true },
    });
    h.advanceTo(1500); // non-leader: occurrence at 1000 is deferred
    expect(fired).toHaveLength(0);
    expect(skipped).toHaveLength(1);

    e.setLeader('tick', true); // another tab closed → we become leader
    expect(fired).toHaveLength(1); // the deferred occurrence is fired immediately, not a full interval later
    expect(fired[0].taskId).toBe('tick');
  });

  it('does not fire on the initial (uncontended) grant when nothing was deferred', async () => {
    const e = makeElection();
    const { engine, fired } = makeEngine(e.election);
    await engine.registerTaskAsync({
      id: 'tick',
      triggers: [{ type: 'recurrence', recurrence: { kind: 'interval', everyMs: 1000 } }],
      policy: { singleFlight: true },
    });
    e.setLeader('tick', true); // grant with no due/deferred occurrence
    expect(fired).toHaveLength(0);
  });

  it('runNow bypasses the leader gate', async () => {
    const e = makeElection();
    const { engine, fired } = makeEngine(e.election); // never a leader
    await engine.registerTaskAsync({
      id: 'a',
      triggers: [{ type: 'time', at: 999_999 }],
      policy: { singleFlight: true },
    });
    await engine.runTaskAsync('a');
    expect(fired).toHaveLength(1); // manual run ignores single-flight
  });

  it('shares one leader across tasks keyed on the same string', async () => {
    const e = makeElection();
    const { engine, h, fired } = makeEngine(e.election);
    for (const id of ['a', 'b']) {
      await engine.registerTaskAsync({
        id,
        triggers: [{ type: 'recurrence', recurrence: { kind: 'interval', everyMs: 1000 } }],
        policy: { singleFlight: 'shared-key' },
      });
    }
    h.advanceTo(1500); // both defer their occurrence (non-leader)
    expect(fired).toHaveLength(0);

    e.setLeader('shared-key', true); // one grant covers both tasks
    expect(fired.map((f) => f.taskId).sort()).toEqual(['a', 'b']);
  });

  it('releases the lock when the task is cancelled', async () => {
    const e = makeElection();
    const { engine } = makeEngine(e.election);
    await engine.registerTaskAsync({
      id: 'a',
      triggers: [{ type: 'recurrence', recurrence: { kind: 'interval', everyMs: 1000 } }],
      policy: { singleFlight: true },
    });
    expect(e.releases()).toBe(0);
    await engine.cancelTaskAsync('a');
    expect(e.releases()).toBe(1);
  });

  it('a task without singleFlight is unaffected (always fires)', async () => {
    const e = makeElection();
    const { engine, h, fired } = makeEngine(e.election); // election never grants leadership
    await engine.registerTaskAsync({
      id: 'plain',
      triggers: [{ type: 'recurrence', recurrence: { kind: 'interval', everyMs: 1000 } }],
    });
    h.advanceTo(2500);
    expect(fired.map((f) => f.taskId)).toEqual(['plain', 'plain']);
  });
});
