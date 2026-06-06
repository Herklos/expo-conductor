/**
 * Priority engine (Web / reference implementation).
 *
 * Mirrors `Priority.kt` and `Priority.swift`. Validated by
 * `fixtures/priority.cases.json`.
 */

export interface Prioritizable {
  id: string;
  priority: number;
  dueAt: number;
}

/**
 * Total ordering used everywhere a task competes for execution:
 * priority descending, then `dueAt` ascending, then `id` ascending.
 */
export function compare(a: Prioritizable, b: Prioritizable): number {
  if (a.priority !== b.priority) return b.priority - a.priority;
  if (a.dueAt !== b.dueAt) return a.dueAt - b.dueAt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Return task ids in execution order. Does not mutate the input. */
export function order<T extends Prioritizable>(tasks: T[]): string[] {
  return [...tasks].sort(compare).map((t) => t.id);
}

/** Stable sorted copy of the tasks themselves. */
export function sorted<T extends Prioritizable>(tasks: T[]): T[] {
  return [...tasks].sort(compare);
}
