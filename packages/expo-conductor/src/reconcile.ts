/**
 * Reconciliation: compare expected task occurrences with actual execution records to
 * surface missed, aborted, and unexpected executions.
 *
 * **Scope of exactness:**
 * - `time` / `recurrence` / `alarm` — deterministic schedule; reconciliation is exact
 *   within the configured tolerance.
 * - `background` / `push` / `appState` — OS decides timing; `missed` results are
 *   advisory only (marked `advisory: true` on the {@link ExpectedOccurrence}).
 *
 * This is pure display/JS-side logic — no Kotlin/Swift port and no /fixtures case
 * (like web-only singleFlight/appState per CLAUDE.md).
 */
import type { RegisteredTask, TaskExecutionRecord, TriggerType } from './ExpoConductor.types';
import { nextRun } from './web/engine/recurrence';

/** Default tolerance for matching an expected occurrence to a record. 16 minutes
 *  accounts for WorkManager's deferred scheduling and BGTaskScheduler's flexibility. */
export const DEFAULT_TOLERANCE_MS = 16 * 60 * 1_000;

/** Default look-back window for finding expected occurrences (24 h). */
export const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1_000;

/** An occurrence that the scheduler was expected to fire. */
export interface ExpectedOccurrence {
  taskId: string;
  expectedAt: number;
  triggerType: TriggerType;
  /**
   * When `true`, reconciliation for this occurrence is advisory — the OS decides
   * the exact timing (`background` / `push` / `appState` triggers), so a "missed"
   * result may be a false positive.
   */
  advisory: boolean;
}

export interface MatchedOccurrence {
  occurrence: ExpectedOccurrence;
  record: TaskExecutionRecord;
}

export interface ReconcileResult {
  /** Expected occurrences matched to a real execution within tolerance. */
  matched: MatchedOccurrence[];
  /** Expected occurrences with no matching record within the tolerance window. */
  missed: ExpectedOccurrence[];
  /** Records that do not match any expected occurrence (e.g. manual triggers, push fires, extra bg wakes). */
  unexpected: TaskExecutionRecord[];
  /** Matched occurrences where the task ran but `result` was FAILED or the record has an error. */
  aborted: MatchedOccurrence[];
}

export interface ReconcileOptions {
  /** Tolerance in ms for matching an expected occurrence to a record. Default: 16 min. */
  toleranceMs?: number;
  /** Current time (UTC epoch ms). */
  now: number;
  /** How far back to search for expected occurrences. Default: 24 h. */
  windowMs?: number;
}

/**
 * Compute all expected fire times for `task` over `[windowStart, now]`.
 *
 * Returns an empty array for triggers with no deterministic schedule
 * (`background`, `push`, `appState`).
 */
export function expectedOccurrences(
  task: RegisteredTask,
  windowStart: number,
  now: number,
): ExpectedOccurrence[] {
  const results: ExpectedOccurrence[] = [];
  const seenTimes = new Set<number>();

  const push = (expectedAt: number, triggerType: TriggerType, advisory: boolean) => {
    if (expectedAt >= windowStart && expectedAt <= now && !seenTimes.has(expectedAt)) {
      seenTimes.add(expectedAt);
      results.push({ taskId: task.id, expectedAt, triggerType, advisory });
    }
  };

  // Recurrence: replay the engine forward from windowStart (or task creation if later).
  const recurrence = task.recurrence;
  if (recurrence) {
    let cursor = Math.max(task.createdAt, windowStart) - 1;
    for (let guard = 0; guard < 10_000; guard++) {
      const next = nextRun(recurrence, cursor);
      if (next == null || next > now) break;
      push(next, 'recurrence', false);
      cursor = next;
    }
  }

  for (const trigger of task.triggers) {
    switch (trigger.type) {
      case 'time':
      case 'notification': {
        const at =
          trigger.at != null
            ? trigger.at
            : trigger.inSeconds != null
              ? task.createdAt + trigger.inSeconds * 1_000
              : null;
        if (at != null) push(at, trigger.type, false);
        break;
      }
      case 'alarm':
        push(trigger.at, 'alarm', false);
        break;
      case 'recurrence':
        // Only handle if task.recurrence wasn't already set (normalize() extracts it).
        if (!recurrence) {
          let cursor = Math.max(task.createdAt, windowStart) - 1;
          for (let guard = 0; guard < 10_000; guard++) {
            const next = nextRun(trigger.recurrence, cursor);
            if (next == null || next > now) break;
            push(next, 'recurrence', false);
            cursor = next;
          }
        }
        break;
      case 'background':
      case 'push':
      case 'appState':
        // No deterministic schedule — advisory only, not included in expected occurrences.
        break;
    }
  }

  return results.sort((a, b) => a.expectedAt - b.expectedAt);
}

/**
 * Reconcile expected task firings against actual execution records.
 *
 * Uses greedy one-to-one matching: each expected occurrence is paired with the
 * nearest unmatched record for the same task within `toleranceMs`. Unmatched
 * expected occurrences → `missed`; unmatched records → `unexpected`.
 */
export function reconcile(
  tasks: RegisteredTask[],
  records: TaskExecutionRecord[],
  options: ReconcileOptions,
): ReconcileResult {
  const { toleranceMs = DEFAULT_TOLERANCE_MS, now, windowMs = DEFAULT_WINDOW_MS } = options;
  const windowStart = now - windowMs;

  // Compute and sort all expected occurrences.
  const allExpected: ExpectedOccurrence[] = [];
  for (const task of tasks) {
    allExpected.push(...expectedOccurrences(task, windowStart, now));
  }
  allExpected.sort((a, b) => a.expectedAt - b.expectedAt);

  // Restrict records to the window (exclude still-running).
  const windowRecords = records.filter(
    (r) => r.firedAt >= windowStart && r.firedAt <= now && r.status !== 'running',
  );

  // Build a mutable FIFO pool per taskId.
  const poolByTask = new Map<string, TaskExecutionRecord[]>();
  for (const r of windowRecords) {
    const pool = poolByTask.get(r.taskId) ?? [];
    pool.push(r);
    poolByTask.set(r.taskId, pool);
  }
  // Sort each pool oldest-first for greedy matching.
  for (const pool of poolByTask.values()) {
    pool.sort((a, b) => a.firedAt - b.firedAt);
  }

  const matched: MatchedOccurrence[] = [];
  const missed: ExpectedOccurrence[] = [];

  for (const occ of allExpected) {
    const pool = poolByTask.get(occ.taskId);
    if (!pool || pool.length === 0) {
      if (!occ.advisory) missed.push(occ);
      continue;
    }

    // Find the closest candidate within tolerance.
    let bestIdx = -1;
    let bestDist = Infinity;
    for (let i = 0; i < pool.length; i++) {
      const dist = Math.abs(pool[i].firedAt - occ.expectedAt);
      if (dist <= toleranceMs && dist < bestDist) {
        bestDist = dist;
        bestIdx = i;
      }
    }

    if (bestIdx >= 0) {
      const [record] = pool.splice(bestIdx, 1);
      matched.push({ occurrence: occ, record });
    } else if (!occ.advisory) {
      missed.push(occ);
    }
  }

  // Remaining unmatched records.
  const unexpected: TaskExecutionRecord[] = [];
  for (const pool of poolByTask.values()) unexpected.push(...pool);

  // Aborted = matched runs that failed or errored.
  const aborted = matched.filter(
    (m) => m.record.status === 'failed' || m.record.status === 'error',
  );

  return { matched, missed, unexpected, aborted };
}
