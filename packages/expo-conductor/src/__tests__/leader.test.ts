import {
  alwaysLeader,
  defaultLeaderElection,
  WebLockLeaderElection,
} from '../web/engine/leader';

/**
 * Faithful fake of `navigator.locks`: exclusive, FIFO. Each request's callback runs only
 * once all earlier requests for the same name have released (their callback promise
 * settled). `request` resolves when its callback resolves.
 */
class FakeLockManager {
  private chains = new Map<string, Promise<unknown>>();

  request(
    name: string,
    _options: { mode?: string; signal?: AbortSignal },
    callback: () => Promise<void>,
  ): Promise<unknown> {
    const prev = this.chains.get(name) ?? Promise.resolve();
    const run = prev.then(() => callback());
    // The next waiter chains off this one settling (i.e. this holder releasing).
    this.chains.set(name, run.then(undefined, () => undefined));
    return run;
  }
}

/** Let microtasks drain so lock callbacks (which run on `.then`) have executed. */
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe('WebLockLeaderElection', () => {
  it('grants leadership to the first claimant and notifies on the (async) transition', async () => {
    const election = new WebLockLeaderElection(new FakeLockManager() as never);
    const changes: boolean[] = [];
    const h = election.acquire('room-1', (l) => changes.push(l));

    expect(h.isLeader()).toBe(false); // not yet — the lock is granted on a later microtask
    await tick();
    expect(h.isLeader()).toBe(true);
    expect(changes).toEqual([true]); // exactly one transition into leadership
  });

  it('serializes two instances on one key — the second becomes leader only on release', async () => {
    const locks = new FakeLockManager();
    const a = new WebLockLeaderElection(locks as never);
    const b = new WebLockLeaderElection(locks as never);

    const ha = a.acquire('k');
    const hb = b.acquire('k');
    await tick();

    expect(ha.isLeader()).toBe(true);
    expect(hb.isLeader()).toBe(false); // queued behind A

    ha.release(); // A's tab "closes"
    await tick();
    expect(hb.isLeader()).toBe(true); // leadership handed to B with no heartbeat
  });

  it('ref-counts claims per key and only releases the lock when the last one goes', async () => {
    const locks = new FakeLockManager();
    const a = new WebLockLeaderElection(locks as never);
    const b = new WebLockLeaderElection(locks as never);

    const a1 = a.acquire('k');
    const a2 = a.acquire('k'); // same instance, same key → shares one lock
    const hb = b.acquire('k');
    await tick();
    expect(a1.isLeader()).toBe(true);
    expect(hb.isLeader()).toBe(false);

    a1.release(); // one of A's two claims gone — lock still held
    await tick();
    expect(hb.isLeader()).toBe(false);

    a2.release(); // last claim gone — lock freed, B takes over
    await tick();
    expect(hb.isLeader()).toBe(true);
  });

  it('does not fire onChange for the synchronous initial grant of a passive joiner', async () => {
    const locks = new FakeLockManager();
    const a = new WebLockLeaderElection(locks as never);
    a.acquire('k');
    await tick(); // A is leader

    // A second claim on the SAME instance after leadership is held: no new transition.
    const changes: boolean[] = [];
    const h2 = a.acquire('k', (l) => changes.push(l));
    await tick();
    expect(h2.isLeader()).toBe(true);
    expect(changes).toEqual([]); // already-leader → no onChange
  });
});

describe('alwaysLeader', () => {
  it('makes every claim the holder with no transitions', () => {
    const changes: boolean[] = [];
    const h = alwaysLeader.acquire('whatever', (l) => changes.push(l));
    expect(h.isLeader()).toBe(true);
    expect(changes).toEqual([]); // leader from the start — never an async transition
    expect(() => h.release()).not.toThrow();
  });
});

describe('defaultLeaderElection', () => {
  it('falls back to always-leader when navigator.locks is unavailable (Node)', () => {
    // The Node test runtime has no `navigator.locks`, so the default must be always-leader.
    const election = defaultLeaderElection();
    expect(election.acquire('k').isLeader()).toBe(true);
  });
});
