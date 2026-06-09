/**
 * Tests for the web execution log (ExecutionLog) and the history fold (foldHistory).
 *
 * Covers:
 * - Ring-buffer capacity enforcement
 * - localStorage persistence + reload survival
 * - foldHistory: execute→complete pairing
 * - foldHistory: execute→error pairing
 * - foldHistory: skipped events
 * - foldHistory: orphaned complete (missed execute)
 * - foldHistory: unmatched execute → 'running'
 * - foldHistory: sort order (oldest first)
 * - foldHistory: rapid repeat — FIFO queue per taskId
 */
import { ExecutionLog, EXECUTION_LOG_CAPACITY } from '../web/engine/executionLog';
import { foldHistory } from '../history/history';
import type { TaskExecutionEvent } from '../ExpoConductor.types';
import { TaskResult } from '../ExpoConductor.types';

// ---------------------------------------------------------------------------
// ExecutionLog
// ---------------------------------------------------------------------------

describe('ExecutionLog (in-memory, no localStorage)', () => {
  it('starts empty', () => {
    const log = new ExecutionLog(10, '__test_log_empty__');
    expect(log.all()).toHaveLength(0);
  });

  it('appends events and returns them oldest-first', () => {
    const log = new ExecutionLog(10, '__test_log_order__');
    const a: TaskExecutionEvent = { kind: 'execute', taskId: 'a', triggeredAt: 1000 };
    const b: TaskExecutionEvent = { kind: 'complete', taskId: 'a', triggeredAt: 2000, result: TaskResult.SUCCESS };
    log.append(a);
    log.append(b);
    expect(log.all()).toEqual([a, b]);
  });

  it('enforces capacity by dropping oldest events', () => {
    const log = new ExecutionLog(3, '__test_log_cap__');
    for (let i = 0; i < 5; i++) {
      log.append({ kind: 'execute', taskId: `t${i}`, triggeredAt: i });
    }
    const events = log.all();
    expect(events).toHaveLength(3);
    // Should retain the 3 most recent (t2, t3, t4)
    expect(events.map((e) => e.taskId)).toEqual(['t2', 't3', 't4']);
  });

  it('clear() empties the log', () => {
    const log = new ExecutionLog(10, '__test_log_clear__');
    log.append({ kind: 'execute', taskId: 'x', triggeredAt: 1 });
    log.clear();
    expect(log.all()).toHaveLength(0);
  });

  it('default capacity is EXECUTION_LOG_CAPACITY', () => {
    const log = new ExecutionLog();
    for (let i = 0; i < EXECUTION_LOG_CAPACITY + 5; i++) {
      log.append({ kind: 'execute', taskId: 't', triggeredAt: i });
    }
    expect(log.all()).toHaveLength(EXECUTION_LOG_CAPACITY);
  });
});

describe('ExecutionLog localStorage persistence', () => {
  const KEY = '__conductor_test_persist__';

  beforeEach(() => {
    // Node environment: localStorage is not defined — tests that rely on it are skipped.
    if (typeof localStorage === 'undefined') return;
    localStorage.removeItem(KEY);
  });

  it('survives a simulated "reload" (new instance with same key)', () => {
    if (typeof localStorage === 'undefined') {
      // Not in a browser — skip silently.
      return;
    }
    const log1 = new ExecutionLog(10, KEY);
    const ev: TaskExecutionEvent = { kind: 'execute', taskId: 'persist', triggeredAt: 42 };
    log1.append(ev);

    const log2 = new ExecutionLog(10, KEY);
    expect(log2.all()).toEqual([ev]);
  });
});

// ---------------------------------------------------------------------------
// foldHistory
// ---------------------------------------------------------------------------

describe('foldHistory', () => {
  it('pairs execute + complete into a completed record', () => {
    const events: TaskExecutionEvent[] = [
      { kind: 'execute', taskId: 'a', triggeredAt: 1000, triggerType: 'time', attempt: 1 },
      { kind: 'complete', taskId: 'a', triggeredAt: 1500, triggerType: 'time', attempt: 1, result: TaskResult.SUCCESS },
    ];
    const records = foldHistory(events);
    expect(records).toHaveLength(1);
    expect(records[0].status).toBe('completed');
    expect(records[0].firedAt).toBe(1000);
    expect(records[0].completedAt).toBe(1500);
    expect(records[0].result).toBe(TaskResult.SUCCESS);
  });

  it('pairs execute + complete with FAILED result → status failed', () => {
    const events: TaskExecutionEvent[] = [
      { kind: 'execute', taskId: 'a', triggeredAt: 1000, triggerType: 'time', attempt: 1 },
      { kind: 'complete', taskId: 'a', triggeredAt: 1200, triggerType: 'time', attempt: 1, result: TaskResult.FAILED },
    ];
    const records = foldHistory(events);
    expect(records[0].status).toBe('failed');
  });

  it('pairs execute + error → status error', () => {
    const events: TaskExecutionEvent[] = [
      { kind: 'execute', taskId: 'a', triggeredAt: 1000, triggerType: 'time', attempt: 1 },
      { kind: 'error', taskId: 'a', triggeredAt: 1100, triggerType: 'time', attempt: 1, error: 'boom' },
    ];
    const records = foldHistory(events);
    expect(records[0].status).toBe('error');
    expect(records[0].error).toBe('boom');
  });

  it('produces a skipped record from a skipped event', () => {
    const events: TaskExecutionEvent[] = [
      { kind: 'skipped', taskId: 'a', triggeredAt: 999, reason: 'EXPIRED' },
    ];
    const records = foldHistory(events);
    expect(records[0].status).toBe('skipped');
    expect(records[0].skippedReason).toBe('EXPIRED');
  });

  it('produces orphaned complete record when no execute was seen', () => {
    const events: TaskExecutionEvent[] = [
      { kind: 'complete', taskId: 'a', triggeredAt: 2000, triggerType: 'time', attempt: 1, result: TaskResult.SUCCESS },
    ];
    const records = foldHistory(events);
    expect(records).toHaveLength(1);
    expect(records[0].status).toBe('completed');
    expect(records[0].firedAt).toBe(2000);
  });

  it('produces a running record for an unmatched execute', () => {
    const events: TaskExecutionEvent[] = [
      { kind: 'execute', taskId: 'a', triggeredAt: 1000, triggerType: 'time', attempt: 1 },
    ];
    const records = foldHistory(events);
    expect(records[0].status).toBe('running');
  });

  it('returns records sorted oldest-first by firedAt', () => {
    const events: TaskExecutionEvent[] = [
      { kind: 'execute', taskId: 'b', triggeredAt: 3000, triggerType: 'time', attempt: 1 },
      { kind: 'complete', taskId: 'b', triggeredAt: 3100, result: TaskResult.SUCCESS },
      { kind: 'execute', taskId: 'a', triggeredAt: 1000, triggerType: 'time', attempt: 1 },
      { kind: 'complete', taskId: 'a', triggeredAt: 1100, result: TaskResult.SUCCESS },
    ];
    const records = foldHistory(events);
    expect(records[0].firedAt).toBeLessThan(records[1].firedAt);
  });

  it('FIFO pairing: rapid repeats pair in order', () => {
    const events: TaskExecutionEvent[] = [
      { kind: 'execute', taskId: 'x', triggeredAt: 1000 },
      { kind: 'execute', taskId: 'x', triggeredAt: 2000 },
      { kind: 'complete', taskId: 'x', triggeredAt: 1500, result: TaskResult.SUCCESS },
      { kind: 'complete', taskId: 'x', triggeredAt: 2500, result: TaskResult.NEW_DATA },
    ];
    const records = foldHistory(events);
    expect(records).toHaveLength(2);
    // First execute (1000) pairs with first complete (1500)
    const first = records.find((r) => r.firedAt === 1000);
    const second = records.find((r) => r.firedAt === 2000);
    expect(first?.completedAt).toBe(1500);
    expect(second?.completedAt).toBe(2500);
  });

  it('handles mixed taskIds without cross-pairing', () => {
    const events: TaskExecutionEvent[] = [
      { kind: 'execute', taskId: 'a', triggeredAt: 1000 },
      { kind: 'execute', taskId: 'b', triggeredAt: 1100 },
      { kind: 'complete', taskId: 'b', triggeredAt: 1200, result: TaskResult.SUCCESS },
      { kind: 'complete', taskId: 'a', triggeredAt: 1300, result: TaskResult.SUCCESS },
    ];
    const records = foldHistory(events);
    const a = records.find((r) => r.taskId === 'a');
    const b = records.find((r) => r.taskId === 'b');
    expect(a?.completedAt).toBe(1300);
    expect(b?.completedAt).toBe(1200);
  });
});
