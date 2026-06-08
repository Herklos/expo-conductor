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

/**
 * Strict integer token parse: "30" -> 30; "30abc" / "" / "*" / "6x" -> null. Mirrors Kotlin
 * `String.toIntOrNull` and Swift `Int(_:)` so all three engines accept exactly the same cron
 * tokens (JS `parseInt` is lenient and would diverge — "30abc" -> 30 there but null here).
 */
function parseIntStrict(token: string): number | null {
  return /^[+-]?\d+$/.test(token) ? Number(token) : null;
}

/**
 * Split a cron expression into its three fields, or null when malformed (not exactly three
 * fields). Splits on ASCII whitespace only — space/tab/newline/CR — NOT the broader Unicode
 * `\s`, because `\s` covers NBSP/form-feed/vertical-tab differently across JS, Kotlin and
 * Swift; using a fixed ASCII class keeps the three engines splitting identically.
 */
export function parseCronFields(expression: string): [string, string, string] | null {
  const fields = expression.split(/[ \t\n\r]+/).filter((f) => f.length > 0);
  return fields.length === 3 ? (fields as [string, string, string]) : null;
}

function isValidCronField(field: string): boolean {
  if (field === '*') return true;
  if (field.startsWith('*/')) {
    const step = parseIntStrict(field.slice(2));
    // Cap the step at the largest meaningful field value (59). A larger step is nonsensical
    // (only value 0 could ever match) and, left unbounded, diverged across engines: it
    // overflows Kotlin's 32-bit Int (-> never fires) while Web/Swift kept firing at value 0.
    return step != null && step > 0 && step <= 59;
  }
  const parts = field.split(',');
  return parts.length > 0 && parts.every((p) => parseIntStrict(p) != null);
}

/**
 * Whether a cron expression is well-formed (exactly three fields, each `*`, `*​/<+int>`, or a
 * comma list of integers). The engine itself stays total (returns null on malformed input so
 * parity holds and a fixture can express it); this is used by the normalize boundary to
 * reject typos at registration instead of letting a task silently never fire.
 */
export function isValidCronExpression(expression: string): boolean {
  const fields = parseCronFields(expression);
  return fields != null && fields.every(isValidCronField);
}

function matchCronField(field: string, value: number): boolean {
  if (field === '*') return true;
  if (field.startsWith('*/')) {
    const step = parseIntStrict(field.slice(2));
    // step bounded to 1..59 (see isValidCronField): keeps all three engines identical and
    // avoids Kotlin's Int32 overflow on a huge step.
    return step != null && step > 0 && step <= 59 && value % step === 0;
  }
  return field.split(',').some((part) => parseIntStrict(part) === value);
}

/** Search bound for cron resolution: ~366 days of minutes. */
const CRON_MAX_ITERATIONS = 366 * 24 * 60;

function nextCron(expression: string, fromMs: number): number | null {
  const fields = parseCronFields(expression);
  // A malformed expression yields no next run — identical across all three engines, so it is
  // expressible as a `null` fixture. Registration-time rejection lives at the normalize
  // boundary (`isValidCronExpression`), which throws so a typo surfaces up front.
  if (fields == null) return null;
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
