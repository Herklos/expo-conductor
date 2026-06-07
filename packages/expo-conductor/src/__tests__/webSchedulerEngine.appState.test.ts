import { type TaskEventPayload, type TaskSkippedEventPayload } from '../ExpoConductor.types';
import {
  type AppStateSource,
  type AppStateTransition,
  defaultAppStateSource,
  noopAppStateSource,
} from '../web/engine/appState';
import type { LeaderElection } from '../web/engine/leader';
import { WebSchedulerEngine } from '../WebSchedulerEngine';

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
        if (timer.time <= t && (!earliest || timer.time < earliest.time)) earliest = { id, time: timer.time };
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

/** Fake appState source the test drives directly. */
function makeAppState() {
  let listener: ((s: AppStateTransition) => void) | null = null;
  const source: AppStateSource = {
    subscribe(l) {
      listener = l;
      return () => {
        listener = null;
      };
    },
  };
  return {
    source,
    foreground: () => listener?.('foreground'),
    background: () => listener?.('background'),
  };
}

describe('WebSchedulerEngine appState trigger', () => {
  it('fires a foreground task on a foreground transition only', async () => {
    const h = makeHarness();
    const app = makeAppState();
    const engine = new WebSchedulerEngine({ ...h, appStateSource: app.source });
    const fired: TaskEventPayload[] = [];
    engine.addListener('onTaskExecute', (p) => fired.push(p));

    await engine.registerTaskAsync({ id: 'open', triggers: [{ type: 'appState', on: 'foreground' }] });

    app.background();
    expect(fired).toHaveLength(0); // not its transition
    app.foreground();
    expect(fired).toHaveLength(1);
    expect(fired[0].taskId).toBe('open');
    expect(fired[0].triggerType).toBe('appState');
  });

  it('fires a background task on a background transition', async () => {
    const h = makeHarness();
    const app = makeAppState();
    const engine = new WebSchedulerEngine({ ...h, appStateSource: app.source });
    const fired: string[] = [];
    engine.addListener('onTaskExecute', (p) => fired.push(p.taskId));

    await engine.registerTaskAsync({ id: 'leave', triggers: [{ type: 'appState', on: 'background' }] });
    app.foreground();
    app.background();
    expect(fired).toEqual(['leave']);
  });

  it('an appState-only task arms no timer (never fires on the clock alone)', async () => {
    const h = makeHarness();
    const app = makeAppState();
    const engine = new WebSchedulerEngine({ ...h, appStateSource: app.source });
    const fired: string[] = [];
    engine.addListener('onTaskExecute', (p) => fired.push(p.taskId));

    await engine.registerTaskAsync({ id: 'open', triggers: [{ type: 'appState', on: 'foreground' }] });
    h.advanceTo(10_000_000);
    expect(fired).toHaveLength(0);
  });

  it('honors appState AND recurrence on the same task', async () => {
    const h = makeHarness();
    const app = makeAppState();
    const engine = new WebSchedulerEngine({ ...h, appStateSource: app.source });
    const fired: TaskEventPayload[] = [];
    engine.addListener('onTaskExecute', (p) => fired.push(p));

    await engine.registerTaskAsync({
      id: 'mix',
      // Recurrence first so a timer-driven fire reports `recurrence`; the appState fire
      // reports `appState` via the explicit firedBy override regardless of order.
      triggers: [
        { type: 'recurrence', recurrence: { kind: 'interval', everyMs: 1000 } },
        { type: 'appState', on: 'foreground' },
      ],
    });
    app.foreground(); // appState fire
    h.advanceTo(1000); // recurrence fire
    expect(fired.map((f) => f.triggerType)).toEqual(['appState', 'recurrence']);
  });

  it('gates appState fires through single-flight leadership', async () => {
    const h = makeHarness();
    const app = makeAppState();
    const keys = new Map<string, { leader: boolean; listeners: Set<(l: boolean) => void> }>();
    const election: LeaderElection = {
      acquire(key, onChange) {
        let s = keys.get(key);
        if (!s) {
          s = { leader: false, listeners: new Set() };
          keys.set(key, s);
        }
        if (onChange) s.listeners.add(onChange);
        return { isLeader: () => keys.get(key)?.leader ?? false, release: () => {} };
      },
    };
    const setLeader = (key: string) => {
      const s = keys.get(key)!;
      s.leader = true;
      for (const l of [...s.listeners]) l(true);
    };

    const engine = new WebSchedulerEngine({ ...h, appStateSource: app.source, leaderElection: election });
    const fired: string[] = [];
    const skipped: TaskSkippedEventPayload[] = [];
    engine.addListener('onTaskExecute', (p) => fired.push(p.taskId));
    engine.addListener('onTaskSkipped', (p) => skipped.push(p));

    await engine.registerTaskAsync({
      id: 'open',
      triggers: [{ type: 'appState', on: 'foreground' }],
      policy: { singleFlight: true },
    });

    app.foreground(); // non-leader → deferred, not fired
    expect(fired).toHaveLength(0);
    expect(skipped).toEqual([{ taskId: 'open', reason: 'DEFERRED_BY_LEADER' }]);

    setLeader('open'); // becoming leader catches up the deferred foreground occurrence
    expect(fired).toEqual(['open']);
  });
});

/** Minimal DOM doubles so the default source can be exercised under the Node test env. */
function fakeDom() {
  const docL: Record<string, Array<() => void>> = {};
  const winL: Record<string, Array<() => void>> = {};
  const document = {
    hidden: false,
    addEventListener: (t: string, cb: () => void) => (docL[t] ??= []).push(cb),
    removeEventListener: (t: string, cb: () => void) => {
      docL[t] = (docL[t] ?? []).filter((x) => x !== cb);
    },
  };
  const window = {
    addEventListener: (t: string, cb: () => void) => (winL[t] ??= []).push(cb),
    removeEventListener: (t: string, cb: () => void) => {
      winL[t] = (winL[t] ?? []).filter((x) => x !== cb);
    },
  };
  const fireDoc = (t: string) => (docL[t] ?? []).forEach((cb) => cb());
  const fireWin = (t: string) => (winL[t] ?? []).forEach((cb) => cb());
  const counts = () => ({
    visibility: (docL['visibilitychange'] ?? []).length,
    focus: (winL['focus'] ?? []).length,
    blur: (winL['blur'] ?? []).length,
  });
  return { document, window, fireDoc, fireWin, counts };
}

describe('defaultAppStateSource', () => {
  const g = globalThis as Record<string, unknown>;
  afterEach(() => {
    delete g.document;
    delete g.window;
  });

  it('no-ops when there is no DOM', () => {
    // Node test env: no document on globalThis → the default source must be inert.
    const transitions: AppStateTransition[] = [];
    const unsub = defaultAppStateSource().subscribe((s) => transitions.push(s));
    expect(transitions).toEqual([]);
    expect(() => unsub()).not.toThrow();
  });

  it('maps visibilitychange + focus/blur to transitions, de-duplicating overlaps', () => {
    const dom = fakeDom();
    g.document = dom.document;
    g.window = dom.window;

    const transitions: AppStateTransition[] = [];
    const unsub = defaultAppStateSource().subscribe((s) => transitions.push(s));

    dom.document.hidden = true;
    dom.fireDoc('visibilitychange'); // → background
    dom.fireWin('blur'); // already background → de-duped (no second emit)
    dom.document.hidden = false;
    dom.fireDoc('visibilitychange'); // → foreground
    dom.fireWin('focus'); // already foreground → de-duped

    expect(transitions).toEqual(['background', 'foreground']);

    unsub();
    expect(dom.counts()).toEqual({ visibility: 0, focus: 0, blur: 0 }); // listeners removed
  });
});

describe('noopAppStateSource', () => {
  it('never emits and unsubscribes cleanly', () => {
    const seen: AppStateTransition[] = [];
    const unsub = noopAppStateSource.subscribe((s) => seen.push(s));
    expect(seen).toEqual([]);
    expect(() => unsub()).not.toThrow();
  });
});
