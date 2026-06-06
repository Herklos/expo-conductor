import type { Recurrence } from '../ExpoConductor.types';
import { MS_PER_DAY, nextRun } from '../web/engine/recurrence';
import { loadFixture } from './fixtures';

interface RecurrenceCase {
  name: string;
  spec: Recurrence;
  fromMs: number;
  expected: number | null;
}

const { cases } = loadFixture<{ cases: RecurrenceCase[] }>('recurrence.cases.json');

describe('recurrence.nextRun (shared fixtures)', () => {
  it.each(cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    expect(nextRun(c.spec, c.fromMs)).toBe(c.expected);
  });
});

describe('recurrence.nextRun (extra invariants)', () => {
  it('always returns a value strictly greater than the input for live specs', () => {
    const specs: Recurrence[] = [
      { kind: 'interval', everyMs: 1000 },
      { kind: 'daily', hour: 6, minute: 15 },
      { kind: 'weekly', weekday: 3, hour: 1, minute: 1 },
      { kind: 'cron', expression: '*/5 * *' },
    ];
    for (const spec of specs) {
      for (const from of [0, 12345, MS_PER_DAY * 100 + 777]) {
        const next = nextRun(spec, from);
        expect(next).not.toBeNull();
        expect(next as number).toBeGreaterThan(from);
      }
    }
  });

  it('returns null for a non-advancing interval', () => {
    expect(nextRun({ kind: 'interval', everyMs: 0 }, 100)).toBeNull();
  });

  it('throws on a malformed cron expression', () => {
    expect(() => nextRun({ kind: 'cron', expression: '* *' }, 0)).toThrow();
  });
});
