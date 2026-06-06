/**
 * Recurrence engine (Web / reference implementation).
 *
 * Mirrors `Recurrence.kt` and `Recurrence.swift`. All arithmetic is integer math
 * on UTC epoch milliseconds so results are identical across platforms. Validated
 * by `fixtures/recurrence.cases.json`.
 */
import type { Recurrence } from '../../ExpoConductor.types';

export const MS_PER_MINUTE = 60_000;
export const MS_PER_HOUR = 3_600_000;
export const MS_PER_DAY = 86_400_000;

/** UTC day-of-week with 0 = Sunday (matches JS `getUTCDay`). */
function dayOfWeek(epochMs: number): number {
  const epochDay = Math.floor(epochMs / MS_PER_DAY);
  return ((epochDay % 7) + 4 + 7) % 7;
}

function timeOfDayOffset(hour: number, minute: number): number {
  return hour * MS_PER_HOUR + minute * MS_PER_MINUTE;
}

function matchCronField(field: string, value: number): boolean {
  if (field === '*') return true;
  if (field.startsWith('*/')) {
    const step = parseInt(field.slice(2), 10);
    return step > 0 && value % step === 0;
  }
  return field
    .split(',')
    .map((part) => parseInt(part, 10))
    .includes(value);
}

/** Search bound for cron resolution: ~366 days of minutes. */
const CRON_MAX_ITERATIONS = 366 * 24 * 60;

function nextCron(expression: string, fromMs: number): number | null {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 3) {
    throw new Error(
      `Invalid cron expression "${expression}" (expected "minute hour dayOfWeek")`,
    );
  }
  const [minuteField, hourField, dowField] = fields;
  let candidate = (Math.floor(fromMs / MS_PER_MINUTE) + 1) * MS_PER_MINUTE;
  for (let i = 0; i < CRON_MAX_ITERATIONS; i++) {
    const minute = Math.floor(candidate / MS_PER_MINUTE) % 60;
    const hour = Math.floor(candidate / MS_PER_HOUR) % 24;
    const dow = dayOfWeek(candidate);
    if (
      matchCronField(minuteField, minute) &&
      matchCronField(hourField, hour) &&
      matchCronField(dowField, dow)
    ) {
      return candidate;
    }
    candidate += MS_PER_MINUTE;
  }
  return null;
}

/**
 * Compute the next run time strictly greater than `fromMs`, or `null` if the
 * recurrence will never fire again.
 */
export function nextRun(spec: Recurrence, fromMs: number): number | null {
  switch (spec.kind) {
    case 'interval': {
      const anchor = spec.anchor ?? 0;
      if (spec.everyMs <= 0) return null;
      if (fromMs < anchor) return anchor;
      const steps = Math.floor((fromMs - anchor) / spec.everyMs) + 1;
      return anchor + steps * spec.everyMs;
    }
    case 'daily': {
      const offset = timeOfDayOffset(spec.hour, spec.minute);
      const dayStart = Math.floor(fromMs / MS_PER_DAY) * MS_PER_DAY;
      let candidate = dayStart + offset;
      while (candidate <= fromMs) candidate += MS_PER_DAY;
      return candidate;
    }
    case 'weekly': {
      const offset = timeOfDayOffset(spec.hour, spec.minute);
      const dayStart = Math.floor(fromMs / MS_PER_DAY) * MS_PER_DAY;
      const dow = dayOfWeek(fromMs);
      const daysUntil = (((spec.weekday - dow) % 7) + 7) % 7;
      let candidate = dayStart + daysUntil * MS_PER_DAY + offset;
      while (candidate <= fromMs) candidate += 7 * MS_PER_DAY;
      return candidate;
    }
    case 'cron':
      return nextCron(spec.expression, fromMs);
    default:
      return null;
  }
}
