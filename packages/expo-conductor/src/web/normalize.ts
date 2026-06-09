/**
 * Resolve a user-supplied {@link TaskDefinition} into a fully-defaulted
 * {@link RegisteredTask}, including its initial `nextRunAt`. Mirrors the
 * normalization the native engines perform when a task is registered.
 */
import {
  Priority,
  type Recurrence,
  type RegisteredTask,
  type TaskDefinition,
  type Trigger,
  type TriggerType,
} from '../ExpoConductor.types';
import { isValidCronExpression, nextRun } from './engine/recurrence';
import { resolveWeight } from './engine/weight';

/** Derive the recurrence to schedule from explicit recurrence or triggers. */
export function recurrenceFor(def: TaskDefinition): Recurrence | undefined {
  if (def.recurrence) return def.recurrence;
  const recurrenceTrigger = def.triggers.find((t) => t.type === 'recurrence');
  return recurrenceTrigger?.type === 'recurrence' ? recurrenceTrigger.recurrence : undefined;
}

/**
 * Reject a malformed cron expression at registration (fail fast) rather than letting the
 * engine silently return null and the task never fire. The engines themselves stay total
 * (return null) so cross-platform parity holds; this boundary check is the developer-facing
 * guard. Throws on a cron recurrence whose expression isn't exactly three valid fields.
 */
export function assertValidRecurrence(recurrence: Recurrence | undefined): void {
  if (recurrence?.kind === 'cron' && !isValidCronExpression(recurrence.expression)) {
    throw new Error(
      `Invalid cron expression "${recurrence.expression}" (expected "minute hour dayOfWeek", ` +
        `each field "*", "*/<n>" with 1<=n<=59, or a comma list of integers)`,
    );
  }
}

export interface NextRunResult {
  nextRunAt: number | null;
  /** The trigger type that produced the earliest run time, or null when nothing is scheduled. */
  firedBy: TriggerType | null;
}

/**
 * Compute the earliest concrete fire time implied by a task's triggers, and identify which
 * trigger type won. Iteration order is preserved: when two triggers resolve to the same
 * timestamp, the first one in `triggers[]` wins; the explicit `recurrence` field is checked
 * last (mirror of Kotlin/Swift behavior — do not change the order).
 */
export function computeNextRunAt(
  triggers: Trigger[],
  recurrence: Recurrence | undefined,
  now: number,
): NextRunResult {
  let best: number | null = null;
  let bestType: TriggerType | null = null;

  function consider(at: number, type: TriggerType): void {
    if (best === null || at < best) {
      best = at;
      bestType = type;
    }
  }

  for (const trigger of triggers) {
    switch (trigger.type) {
      case 'time':
        if (trigger.at != null) consider(trigger.at, 'time');
        else if (trigger.inSeconds != null) consider(now + trigger.inSeconds * 1000, 'time');
        break;
      case 'notification':
        if (trigger.at != null) consider(trigger.at, 'notification');
        else if (trigger.inSeconds != null) consider(now + trigger.inSeconds * 1000, 'notification');
        break;
      case 'alarm':
        consider(trigger.at, 'alarm');
        break;
      case 'recurrence': {
        const next = nextRun(trigger.recurrence, now);
        if (next != null) consider(next, 'recurrence');
        break;
      }
      default:
        break;
    }
  }

  if (recurrence) {
    const next = nextRun(recurrence, now);
    if (next != null) consider(next, 'recurrence');
  }

  return { nextRunAt: best, firedBy: bestType };
}

export function normalize(def: TaskDefinition, now: number = Date.now()): RegisteredTask {
  const recurrence = recurrenceFor(def);
  assertValidRecurrence(recurrence);
  const { nextRunAt, firedBy } = computeNextRunAt(def.triggers, recurrence, now);
  return {
    id: def.id,
    handler: def.handler ?? { name: def.id, type: 'js' },
    triggers: def.triggers,
    priority: typeof def.priority === 'number' ? def.priority : (def.priority ?? Priority.DEFAULT),
    weight: resolveWeight(def.weight ?? 'moderate'),
    recurrence,
    policy: def.policy ?? {},
    metadata: def.metadata,
    nextRunAt,
    nextFiredBy: firedBy,
    createdAt: now,
  };
}
