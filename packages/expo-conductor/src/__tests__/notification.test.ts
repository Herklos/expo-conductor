/**
 * TS-side verification of `computeNextRunAt` for notification triggers (winning-trigger
 * selection, recurring re-fire math, futureOnly semantics). Uses the shared fixture so
 * any divergence from the documented semantics is caught early. Note: Kotlin/Swift tests
 * only cover the pure engine (recurrence/priority/weight/policy) via the JVM/SwiftPM
 * harnesses; computeNextRunAt sits above the engine in TaskMapper on those platforms and
 * is verified by device integration tests.
 */
import { type Recurrence, type Trigger } from '../ExpoConductor.types';
import { computeNextRunAt } from '../web/normalize';
import { loadFixture } from './fixtures';

interface NotificationCase {
  name: string;
  triggers: Trigger[];
  recurrence: Recurrence | null;
  now: number;
  futureOnly?: boolean;
  expected: { nextRunAt: number | null; firedBy: string | null };
}

interface NotificationFixture {
  description: string;
  cases: NotificationCase[];
}

// The `futureOnly` filtering is performed by `futureTriggers` before calling
// computeNextRunAt in WebSchedulerEngine. Simulate it here by pre-filtering triggers
// to match what `futureTriggers` does (keep future at-based + all recurrences + recurring notifications).
function applyFutureOnly(triggers: Trigger[], now: number): Trigger[] {
  return triggers.filter((t) => {
    if (t.type === 'time' && t.at != null) return t.at > now;
    if (t.type === 'alarm') return t.at > now;
    if (t.type === 'notification') {
      if (t.recurring && t.inSeconds != null) return true;
      if (t.at != null) return t.at > now;
      return false;
    }
    return t.type === 'recurrence';
  });
}

describe('computeNextRunAt (notification.cases.json)', () => {
  const fixture = loadFixture<NotificationFixture>('notification.cases.json');

  for (const c of fixture.cases) {
    it(c.name, () => {
      const triggers = c.futureOnly ? applyFutureOnly(c.triggers, c.now) : c.triggers;
      const result = computeNextRunAt(triggers, c.recurrence ?? undefined, c.now);
      expect(result.nextRunAt).toBe(c.expected.nextRunAt);
      expect(result.firedBy).toBe(c.expected.firedBy);
    });
  }
});
