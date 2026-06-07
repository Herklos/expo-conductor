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
  it('a non-leader defers every occurrence with DEFERRED_BY_LEADER (no execute)', async () => {
    const e = makeElection();
    const { engine, h, fired, skipped } = makeEngine(e.election);
    await engine.registerTaskAsync({
      id: 'tick',
      triggers: [{ type: 'recurrence', recurrence: { kind: 'interval', everyMs: 1000 } }],
      policy: { singleFlight: true },
    });
    h.advanceTo(3500);
    expect(fired).toHaveLength(0);
    // Exactly the three occurrences at 1000/2000/3000 are deferred (the cadence keeps
    // advancing while non-leader, in lockstep with the leader's schedule).
    expect(skipped).toEqual([
      { taskId: 'tick', reason: 'DEFERRED_BY_LEADER' },
      { taskId: 'tick', reason: 'DEFERRED_BY_LEADER' },
      { taskId: 'tick', reason: 'DEFERRED_BY_LEADER' },
    ]);
  });

  it('keeps grid cadence after a handoff catch-up (no drift)', async () => {
    const e = makeElection();
    const { engine, h, fired } = makeEngine(e.election);
    await engine.registerTaskAsync({
      id: 'tick',
      triggers: [{ type: 'recurrence', recurrence: { kind: 'interval', everyMs: 1000 } }],
      policy: { singleFlight: true },
    });
    h.advanceTo(3500); // three deferred occurrences while non-leader
    e.setLeader('tick', true); // hand off mid-interval → exactly one catch-up fire
    expect(fired).toHaveLength(1);
    h.advanceTo(4000); // next fire lands on the original grid boundary (4000), not 4500
    expect(fired.map((f) => f.firedAt)).toEqual([3500, 4000]);
  });

  it('does NOT replay a one-shot deferred while non-leader on handoff', async () => {
    const e = makeElection();
    const { engine, h, fired, skipped } = makeEngine(e.election);
    await engine.registerTaskAsync({
      id: 'once',
      triggers: [{ type: 'time', at: 1000 }],
      policy: { singleFlight: true },
    });
    h.advanceTo(1000); // non-leader: the one-shot occurrence is deferred (skipped), not run
    expect(fired).toHaveLength(0);
    expect(skipped).toEqual([{ taskId: 'once', reason: 'DEFERRED_BY_LEADER' }]);

    e.setLeader('once', true); // becoming leader must NOT replay the elapsed one-shot
    expect(fired).toHaveLength(0); // the leader already ran it — replaying would double-run
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

  it('a manual runNow on a deferred task is not replayed by a later leadership gain', async () => {
    const e = makeElection();
    const { engine, h, fired } = makeEngine(e.election);
    await engine.registerTaskAsync({
      id: 'tick',
      triggers: [{ type: 'recurrence', recurrence: { kind: 'interval', everyMs: 1000 } }],
      policy: { singleFlight: true },
    });
    h.advanceTo(1500); // deferred while non-leader (marked for catch-up)
    await engine.runTaskAsync('tick'); // manual run handles the occurrence now
    expect(fired).toHaveLength(1);

    e.setLeader('tick', true); // the manual run must have cleared the deferred marker…
    expect(fired).toHaveLength(1); // …so leadership gain does NOT replay it (no double-fire)
  });

  it('releases leadership on pause and re-acquires + fires on resume', async () => {
    const e = makeElection();
    const { engine, h, fired } = makeEngine(e.election);
    await engine.registerTaskAsync({
      id: 'tick',
      triggers: [{ type: 'recurrence', recurrence: { kind: 'interval', everyMs: 1000 } }],
      policy: { singleFlight: true },
    });
    e.setLeader('tick', true);
    h.advanceTo(1000);
    expect(fired).toHaveLength(1);

    await engine.pauseAsync();
    expect(e.releases()).toBe(1); // the claim is dropped so a non-paused instance can lead
    h.advanceTo(5000);
    expect(fired).toHaveLength(1); // paused → no fires

    await engine.resumeAsync(); // re-acquires the claim (still leader)
    h.advanceTo(6000);
    expect(fired.length).toBeGreaterThan(1); // resumed leader fires again
  });

  it('on re-register with a changed key, releases the old leader and claims the new', async () => {
    const e = makeElection();
    const { engine, h, fired } = makeEngine(e.election);
    const recur = { type: 'recurrence', recurrence: { kind: 'interval', everyMs: 1000 } } as const;

    await engine.registerTaskAsync({ id: 'x', triggers: [recur], policy: { singleFlight: 'A' } });
    expect(e.releases()).toBe(0);

    await engine.registerTaskAsync({ id: 'x', triggers: [recur], policy: { singleFlight: 'B' } });
    expect(e.releases()).toBe(1); // old key 'A' released

    h.advanceTo(1500); // non-leader on 'B' → deferred
    expect(fired).toHaveLength(0);
    e.setLeader('A', true); // the OLD key no longer gates 'x' → no fire
    expect(fired).toHaveLength(0);
    e.setLeader('B', true); // the NEW key fires the catch-up
    expect(fired).toHaveLength(1);

    // Dropping singleFlight entirely releases the claim and fires unconditionally.
    await engine.registerTaskAsync({ id: 'x', triggers: [recur] });
    expect(e.releases()).toBe(2);
    h.advanceTo(3000);
    expect(fired.length).toBeGreaterThan(1);
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
