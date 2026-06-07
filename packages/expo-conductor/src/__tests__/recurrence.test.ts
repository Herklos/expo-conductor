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

  it('returns null (never throws) for a malformed cron expression, so all three engines agree', () => {
    // The engine is total: malformed input yields null, never an exception (which would
    // diverge between Kotlin `require`/throw and Swift's silent nil). Registration-time
    // rejection is the normalize boundary's job (see normalize.test.ts). Only ASCII
    // space/tab/newline/CR separate fields, so NBSP / form-feed are NOT separators.
    const NBSP = String.fromCharCode(0xa0);
    const FF = String.fromCharCode(0x0c);
    expect(nextRun({ kind: 'cron', expression: '* *' }, 0)).toBeNull(); // wrong field count
    expect(nextRun({ kind: 'cron', expression: '30 9 * extra' }, 0)).toBeNull(); // too many fields
    expect(nextRun({ kind: 'cron', expression: '30abc 9 *' }, 0)).toBeNull(); // non-numeric token
    expect(nextRun({ kind: 'cron', expression: `0${NBSP}0${NBSP}5` }, 0)).toBeNull(); // NBSP not a separator
    expect(nextRun({ kind: 'cron', expression: `0 0${FF}5` }, 0)).toBeNull(); // form-feed not a separator
  });
});
