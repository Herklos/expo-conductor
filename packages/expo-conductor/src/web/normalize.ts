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

/** Compute the earliest concrete fire time implied by a task's triggers. */
export function computeNextRunAt(
  triggers: Trigger[],
  recurrence: Recurrence | undefined,
  now: number,
): number | null {
  const candidates: number[] = [];

  for (const trigger of triggers) {
    switch (trigger.type) {
      case 'time':
      case 'notification':
        if (trigger.at != null) candidates.push(trigger.at);
        else if (trigger.inSeconds != null) candidates.push(now + trigger.inSeconds * 1000);
        break;
      case 'alarm':
        candidates.push(trigger.at);
        break;
      case 'recurrence': {
        const next = nextRun(trigger.recurrence, now);
        if (next != null) candidates.push(next);
        break;
      }
      default:
        break;
    }
  }

  if (recurrence) {
    const next = nextRun(recurrence, now);
    if (next != null) candidates.push(next);
  }

  if (candidates.length === 0) return null;
  return Math.min(...candidates);
}

export function normalize(def: TaskDefinition, now: number = Date.now()): RegisteredTask {
  const recurrence = recurrenceFor(def);
  assertValidRecurrence(recurrence);
  return {
    id: def.id,
    handler: def.handler ?? { name: def.id, type: 'js' },
    triggers: def.triggers,
    priority: typeof def.priority === 'number' ? def.priority : (def.priority ?? Priority.DEFAULT),
    weight: resolveWeight(def.weight ?? 'moderate'),
    recurrence,
    policy: def.policy ?? {},
    metadata: def.metadata,
    nextRunAt: computeNextRunAt(def.triggers, recurrence, now),
    createdAt: now,
  };
}
