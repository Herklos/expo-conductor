/**
 * Tests for the reconciliation algorithm (src/reconcile.ts).
 *
 * Covers:
 * - On-time match within tolerance
 * - Missed (no record in tolerance window)
 * - Late-but-within-tolerance
 * - Unexpected (record with no expected occurrence)
 * - Aborted (matched but FAILED/error)
 * - Recurrence series
 * - Advisory note for background/push (no expected occurrences generated)
 */
import {
  DEFAULT_TOLERANCE_MS,
  expectedOccurrences,
  reconcile,
} from '../reconcile';
import type { RegisteredTask, TaskExecutionRecord } from '../ExpoConductor.types';
import { TaskResult } from '../ExpoConductor.types';
import { normalize } from '../web/normalize';

const BASE_TIME = 1_000_000_000_000; // arbitrary fixed "now" for tests

/** Build a minimal RegisteredTask from a partial TaskDefinition (using normalize). */
function task(def: Parameters<typeof normalize>[0], createdAt = BASE_TIME - 10_000): RegisteredTask {
  return normalize(def, createdAt);
}

/** Build a TaskExecutionRecord. */
function record(
  taskId: string,
  firedAt: number,
  status: TaskExecutionRecord['status'] = 'completed',
  result: TaskResult = TaskResult.SUCCESS,
): TaskExecutionRecord {
  return { taskId, triggerType: 'time', firedAt, attempt: 1, completedAt: firedAt + 100, result, status };
}

const NOW = BASE_TIME;

describe('expectedOccurrences', () => {
  it('returns a time trigger occurrence within the window', () => {
    const t = task({ id: 'a', triggers: [{ type: 'time', at: NOW - 5_000 }] });
    const occs = expectedOccurrences(t, NOW - DEFAULT_TOLERANCE_MS * 2, NOW);
    expect(occs).toHaveLength(1);
    expect(occs[0].taskId).toBe('a');
    expect(occs[0].expectedAt).toBe(NOW - 5_000);
    expect(occs[0].advisory).toBe(false);
  });

  it('excludes time trigger outside the window', () => {
    const t = task({ id: 'a', triggers: [{ type: 'time', at: NOW - DEFAULT_TOLERANCE_MS * 3 }] });
    const occs = expectedOccurrences(t, NOW - DEFAULT_TOLERANCE_MS * 2, NOW);
    expect(occs).toHaveLength(0);
  });

  it('returns recurrence occurrences over the window', () => {
    const start = NOW - 30_000;
    const t = task(
      { id: 'r', triggers: [{ type: 'recurrence', recurrence: { kind: 'interval', everyMs: 10_000, anchor: start } }] },
      start,
    );
    const occs = expectedOccurrences(t, start, NOW);
    // Should have fires at start+10000, start+20000, start+30000 (<=NOW)
    expect(occs.length).toBeGreaterThanOrEqual(2);
    for (const occ of occs) {
      expect(occ.taskId).toBe('r');
      expect(occ.advisory).toBe(false);
      expect(occ.triggerType).toBe('recurrence');
    }
  });

  it('returns no occurrences for background trigger (advisory)', () => {
    const t = task({
      id: 'bg',
      triggers: [{ type: 'background', minimumIntervalMinutes: 15 }],
    });
    const occs = expectedOccurrences(t, NOW - DEFAULT_TOLERANCE_MS * 100, NOW);
    expect(occs).toHaveLength(0);
  });

  it('returns no occurrences for push trigger (advisory)', () => {
    const t = task({ id: 'p', triggers: [{ type: 'push', matchKey: 'key' }] });
    const occs = expectedOccurrences(t, NOW - DEFAULT_TOLERANCE_MS * 100, NOW);
    expect(occs).toHaveLength(0);
  });
});

describe('reconcile', () => {
  const opts = { now: NOW, windowMs: 60 * 60 * 1_000 }; // 1h window

  it('matches an on-time record', () => {
    const fireAt = NOW - 5_000;
    const t = task({ id: 'a', triggers: [{ type: 'time', at: fireAt }] }, NOW - 10_000);
    const r = record('a', fireAt);
    const result = reconcile([t], [r], opts);
    expect(result.matched).toHaveLength(1);
    expect(result.missed).toHaveLength(0);
    expect(result.unexpected).toHaveLength(0);
    expect(result.aborted).toHaveLength(0);
  });

  it('matches a late-but-within-tolerance record', () => {
    // expected far enough back so that actual (expected + tolerance - 1s) is still < NOW
    const expected = NOW - DEFAULT_TOLERANCE_MS * 2;
    const actual = expected + DEFAULT_TOLERANCE_MS - 1_000; // within tolerance, but late
    const t = task({ id: 'a', triggers: [{ type: 'time', at: expected }] }, expected - 10_000);
    const r = record('a', actual);
    const result = reconcile([t], [r], opts);
    expect(result.matched).toHaveLength(1);
    expect(result.missed).toHaveLength(0);
  });

  it('marks as missed when record is outside tolerance', () => {
    // expected far enough back so that actual (expected + tolerance + 60s) is still < NOW
    const expected = NOW - DEFAULT_TOLERANCE_MS * 3;
    const actual = expected + DEFAULT_TOLERANCE_MS + 60_000; // well outside tolerance
    const t = task({ id: 'a', triggers: [{ type: 'time', at: expected }] }, expected - 10_000);
    const r = record('a', actual);
    const result = reconcile([t], [r], opts);
    expect(result.missed).toHaveLength(1);
    expect(result.unexpected).toHaveLength(1); // the record has no expected match
  });

  it('marks as missed when there are no records for the task', () => {
    const t = task({ id: 'a', triggers: [{ type: 'time', at: NOW - 5_000 }] }, NOW - 20_000);
    const result = reconcile([t], [], opts);
    expect(result.missed).toHaveLength(1);
    expect(result.matched).toHaveLength(0);
  });

  it('marks unexpected when record has no expected occurrence', () => {
    const r = record('unknown', NOW - 5_000);
    const result = reconcile([], [r], opts);
    expect(result.unexpected).toHaveLength(1);
    expect(result.matched).toHaveLength(0);
    expect(result.missed).toHaveLength(0);
  });

  it('marks aborted for a matched FAILED record', () => {
    const fireAt = NOW - 5_000;
    const t = task({ id: 'a', triggers: [{ type: 'time', at: fireAt }] }, NOW - 10_000);
    const r: TaskExecutionRecord = {
      taskId: 'a', triggerType: 'time', firedAt: fireAt, attempt: 1,
      completedAt: fireAt + 100, result: TaskResult.FAILED, status: 'failed',
    };
    const result = reconcile([t], [r], opts);
    expect(result.matched).toHaveLength(1);
    expect(result.aborted).toHaveLength(1);
    expect(result.aborted[0].record.status).toBe('failed');
  });

  it('marks aborted for a matched error record', () => {
    const fireAt = NOW - 5_000;
    const t = task({ id: 'a', triggers: [{ type: 'time', at: fireAt }] }, NOW - 10_000);
    const r: TaskExecutionRecord = {
      taskId: 'a', triggerType: 'time', firedAt: fireAt, attempt: 1,
      completedAt: fireAt + 100, error: 'boom', status: 'error',
    };
    const result = reconcile([t], [r], opts);
    expect(result.aborted).toHaveLength(1);
  });

  it('handles a recurrence series — one missed, one matched, one aborted', () => {
    const INTERVAL = 10_000;
    const anchor = NOW - 30_000;
    const t = task(
      { id: 'r', triggers: [{ type: 'recurrence', recurrence: { kind: 'interval', everyMs: INTERVAL, anchor } }] },
      anchor,
    );
    // Expected fires: anchor+10000, anchor+20000, anchor+30000 (=NOW)
    const exp1 = anchor + INTERVAL;   // matched (on-time)
    const exp2 = anchor + 2 * INTERVAL; // missed (no record)
    const exp3 = anchor + 3 * INTERVAL; // aborted (failed)

    const records: TaskExecutionRecord[] = [
      record('r', exp1),
      { taskId: 'r', triggerType: 'recurrence', firedAt: exp3, attempt: 1, completedAt: exp3 + 100, result: TaskResult.FAILED, status: 'failed' },
    ];
    const result = reconcile([t], records, opts);
    expect(result.matched.length).toBeGreaterThanOrEqual(2);
    expect(result.missed.length).toBeGreaterThanOrEqual(1);
    expect(result.aborted.length).toBeGreaterThanOrEqual(1);
    expect(result.unexpected).toHaveLength(0);
  });

  it('does not add to missed for background triggers (advisory)', () => {
    const t = task({
      id: 'bg',
      triggers: [{ type: 'background', minimumIntervalMinutes: 15 }],
    });
    const result = reconcile([t], [], opts);
    // No expected occurrences → no missed
    expect(result.missed).toHaveLength(0);
  });

  it('does not add to missed for push triggers (advisory)', () => {
    const t = task({ id: 'p', triggers: [{ type: 'push', matchKey: 'key' }] });
    const result = reconcile([t], [], opts);
    expect(result.missed).toHaveLength(0);
  });

  it('does not double-match a single record to two occurrences', () => {
    const fireAt = NOW - 5_000;
    const t = task({ id: 'a', triggers: [{ type: 'time', at: fireAt }] }, NOW - 10_000);
    const r = record('a', fireAt);
    // Two expected occurrences for same time → only one record → one missed
    const result = reconcile([t, t], [r], opts);
    // The second task (same id, same time) would normally just deduplicate expectedAt
    // In this test both tasks are identical so expectedOccurrences may deduplicate.
    // The important invariant: the single record is not matched twice.
    const totalMatched = result.matched.length;
    const totalMissed = result.missed.length;
    expect(totalMatched + totalMissed).toBeGreaterThan(0);
    // Record used at most once
    const usedRecordIds = result.matched.map((m) => m.record.firedAt);
    const unique = new Set(usedRecordIds);
    expect(unique.size).toBe(totalMatched);
  });

  it('excludes still-running records', () => {
    const fireAt = NOW - 1_000;
    const t = task({ id: 'a', triggers: [{ type: 'time', at: fireAt }] }, NOW - 10_000);
    const running: TaskExecutionRecord = {
      taskId: 'a', triggerType: 'time', firedAt: fireAt, attempt: 1, status: 'running',
    };
    const result = reconcile([t], [running], opts);
    // Running records are excluded from matching → the occurrence is missed
    expect(result.missed).toHaveLength(1);
    expect(result.matched).toHaveLength(0);
    expect(result.unexpected).toHaveLength(0);
  });
});
