/**
 * Cross-instance leader election for the Web engine.
 *
 * Backs `policy.singleFlight`: when several app instances of the same origin (two
 * browser tabs, or a tab plus an Electron shell) each schedule the same task, only the
 * elected LEADER should fire it — otherwise a recurring task double-runs and a webhook
 * double-posts. The Web Locks API gives exactly this: an exclusive lock per key, held for
 * as long as the holder lives, auto-released by the browser when the holding context goes
 * away (tab close / navigation) so leadership hands off with no heartbeat.
 *
 * This is the platform-neutral core that `WebSchedulerEngine` composes; it has no `expo`
 * import and is exercised directly by Jest. Platforms without `navigator.locks` (React
 * Native, Node, older runtimes) run a single instance, so there is nothing to serialize —
 * {@link alwaysLeader} makes every instance the holder.
 */

/** A held (ref-counted) leadership claim for one key. */
export interface LeaderHandle {
  /** Whether THIS instance currently holds leadership for the key. */
  readonly isLeader: () => boolean;
  /** Drop this claim. Releases the underlying lock once the last claim for the key goes. */
  release(): void;
}

export interface LeaderElection {
  /**
   * Claim leadership for `key`. Ref-counted: multiple claims on one key in the same
   * instance share a single underlying lock. `onChange` fires only on an asynchronous
   * transition into leadership (a lock handed over after this instance waited) — never
   * for the synchronous initial grant, so a caller can distinguish "took over" from
   * "was leader all along".
   */
  acquire(key: string, onChange?: (leader: boolean) => void): LeaderHandle;
}

/** The slice of `navigator.locks` this module uses. */
interface LockManager {
  request(
    name: string,
    options: { signal?: AbortSignal; mode?: 'exclusive' | 'shared' },
    callback: () => Promise<void>,
  ): Promise<unknown>;
}

/** `navigator.locks`, or null on platforms that don't expose it. */
function webLocks(): LockManager | null {
  const nav = (globalThis as { navigator?: { locks?: LockManager } }).navigator;
  const locks = nav?.locks;
  return locks && typeof locks.request === 'function' ? locks : null;
}

interface Entry {
  leader: boolean;
  refs: number;
  listeners: Set<(leader: boolean) => void>;
  /** Resolves the held-lock promise → releases the lock. Absent when always-leader. */
  release?: () => void;
}

/**
 * Leader election backed by the Web Locks API. Ref-counts one lock per key across all
 * claims in this instance and fans leadership changes out to every claim's listener.
 */
export class WebLockLeaderElection implements LeaderElection {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly locks: LockManager) {}

  acquire(key: string, onChange?: (leader: boolean) => void): LeaderHandle {
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { leader: false, refs: 0, listeners: new Set() };
      this.entries.set(key, entry);
      const e = entry;
      const held = new Promise<void>((resolve) => {
        e.release = resolve;
      });
      void this.locks
        .request(`expo-conductor.leader.${key}`, { mode: 'exclusive' }, async () => {
          // Runs only once the exclusive lock is held — this instance is now leader, and
          // stays so until `held` resolves (the last claim for this key is released).
          e.leader = true;
          this.notify(e);
          await held;
        })
        .catch(() => {
          // Request rejected/aborted — remain a passive (non-leader) observer.
        });
    }
    entry.refs += 1;
    if (onChange) entry.listeners.add(onChange);
    const e = entry;
    return {
      isLeader: () => e.leader,
      release: () => {
        if (onChange) e.listeners.delete(onChange);
        e.refs -= 1;
        if (e.refs <= 0) {
          e.release?.(); // free the Web Lock so a waiting instance can take over
          this.entries.delete(key);
        }
      },
    };
  }

  private notify(e: Entry): void {
    for (const listener of e.listeners) listener(e.leader);
  }
}

/** Always-leader election for single-instance platforms (native / Node). No locking,
 *  no transitions — every claim is the holder from the start. */
export const alwaysLeader: LeaderElection = {
  acquire() {
    return { isLeader: () => true, release: () => {} };
  },
};

/** Pick the right election for the current platform: Web Locks when available, otherwise
 *  always-leader (a single app instance has nothing to serialize). */
export function defaultLeaderElection(): LeaderElection {
  const locks = webLocks();
  return locks ? new WebLockLeaderElection(locks) : alwaysLeader;
}
