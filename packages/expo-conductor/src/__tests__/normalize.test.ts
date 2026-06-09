import { Priority } from '../ExpoConductor.types';
import { computeNextRunAt, normalize } from '../web/normalize';

describe('normalize', () => {
  it('applies defaults for handler, priority and weight', () => {
    const task = normalize({ id: 'sync', triggers: [{ type: 'time', inSeconds: 10 }] }, 1000);
    expect(task.handler).toEqual({ name: 'sync', type: 'js' });
    expect(task.priority).toBe(Priority.DEFAULT);
    expect(task.weight).toEqual({ cpu: 0.4, network: 0.4, battery: 0.4, memory: 0.4 });
    expect(task.nextRunAt).toBe(1000 + 10_000);
    expect(task.createdAt).toBe(1000);
  });

  it('honors a named priority and weight preset', () => {
    const task = normalize(
      { id: 't', priority: Priority.HIGH, weight: 'light', triggers: [{ type: 'time', at: 5000 }] },
      0,
    );
    expect(task.priority).toBe(Priority.HIGH);
    expect(task.weight).toEqual({ cpu: 0.1, network: 0.1, battery: 0.1, memory: 0.1 });
    expect(task.nextRunAt).toBe(5000);
  });

  it('lifts a recurrence trigger into the task recurrence', () => {
    const task = normalize(
      { id: 'r', triggers: [{ type: 'recurrence', recurrence: { kind: 'interval', everyMs: 1000 } }] },
      0,
    );
    expect(task.recurrence).toEqual({ kind: 'interval', everyMs: 1000 });
    expect(task.nextRunAt).toBe(1000);
  });

  it('rejects a malformed cron expression at registration (fail fast, not a silent never-fire)', () => {
    // The engine is total (returns null) for parity; the normalize boundary is where a typo
    // must surface, so registering a bad cron throws instead of registering a dead task.
    const bad = (expression: string) =>
      normalize({ id: 'c', triggers: [{ type: 'recurrence', recurrence: { kind: 'cron', expression } }] }, 0);
    expect(() => bad('* *')).toThrow(/Invalid cron/); // too few fields
    expect(() => bad('30 9 * extra')).toThrow(/Invalid cron/); // too many fields
    expect(() => bad('30abc 9 *')).toThrow(/Invalid cron/); // non-numeric token
    // A valid cron still normalizes fine.
    expect(() => bad('*/15 * *')).not.toThrow();
  });
});

describe('computeNextRunAt', () => {
  it('returns the earliest of multiple triggers with the winning type', () => {
    const result = computeNextRunAt(
      [
        { type: 'time', at: 9000 },
        { type: 'alarm', at: 3000 },
        { type: 'time', inSeconds: 5 },
      ],
      undefined,
      0,
    );
    expect(result.nextRunAt).toBe(3000);
    expect(result.firedBy).toBe('alarm');
  });

  it('returns null when no trigger implies a concrete time', () => {
    const result = computeNextRunAt([{ type: 'push' }, { type: 'background' }], undefined, 0);
    expect(result.nextRunAt).toBeNull();
    expect(result.firedBy).toBeNull();
  });

  it('picks the first trigger in array order when two resolve to the same time (tie-breaking)', () => {
    const result = computeNextRunAt(
      [
        { type: 'alarm', at: 5000 },
        { type: 'time', at: 5000 },
      ],
      undefined,
      0,
    );
    expect(result.nextRunAt).toBe(5000);
    expect(result.firedBy).toBe('alarm'); // first in array wins
  });

  it('recurrence explicit field is evaluated last (after triggers[])', () => {
    const result = computeNextRunAt(
      [{ type: 'alarm', at: 5000 }],
      { kind: 'interval', everyMs: 3000 }, // recurrence would produce 3000, alarm produces 5000
      0,
    );
    // recurrence (3000) < alarm (5000), so recurrence wins
    expect(result.nextRunAt).toBe(3000);
    expect(result.firedBy).toBe('recurrence');
  });

  it('recurring notification with inSeconds always re-derives regardless of futureOnly intent', () => {
    // futureOnly filtering is done BEFORE computeNextRunAt (in futureTriggers), not inside.
    // A recurring notification is kept in the trigger array by futureTriggers, so
    // computeNextRunAt sees it and re-derives now + inSeconds*1000.
    const now = 100_000;
    const result = computeNextRunAt(
      [{ type: 'notification', inSeconds: 10, recurring: true }],
      undefined,
      now,
    );
    expect(result.nextRunAt).toBe(now + 10_000);
    expect(result.firedBy).toBe('notification');
  });
});
