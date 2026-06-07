/**
 * Weight / resource-budget admission engine (Web / reference implementation).
 *
 * Mirrors `Weight.kt` and `Weight.swift`. Validated by
 * `fixtures/weight-admission.cases.json`.
 */
import type { ResourceBudget, ResourceWeight, WeightPreset } from '../../ExpoConductor.types';
import { compare, type Prioritizable } from './priority';

const PRESETS: Record<WeightPreset, ResourceWeight> = {
  light: { cpu: 0.1, network: 0.1, battery: 0.1, memory: 0.1 },
  moderate: { cpu: 0.4, network: 0.4, battery: 0.4, memory: 0.4 },
  heavy: { cpu: 0.8, network: 0.8, battery: 0.8, memory: 0.8 },
};

/** Resolve a preset or pass through an explicit {@link ResourceWeight}. */
export function resolveWeight(weight: ResourceWeight | WeightPreset): ResourceWeight {
  return typeof weight === 'string' ? PRESETS[weight] : weight;
}

export interface WeightedTask extends Prioritizable {
  weight: ResourceWeight;
  /** Max number of tasks allowed to run simultaneously when this task is admitted. */
  maxConcurrent?: number;
}

export interface AdmissionResult {
  admitted: string[];
  deferred: string[];
}

/** Resources already consumed by, and count of, tasks currently running. */
export interface AdmissionOptions {
  running?: number;
  used?: Partial<ResourceWeight>;
}

const DIMENSIONS: (keyof ResourceWeight)[] = ['cpu', 'network', 'battery', 'memory'];

/**
 * Greedily admit tasks (highest priority first) while every weight dimension stays within
 * `budget` AND the simultaneous-run count stays within each task's `maxConcurrent`. Budget
 * and count already consumed by in-flight tasks are supplied via `options` (used/running),
 * so a task yields when the device is already busy with heavier or more important work.
 * A task that does not fit is deferred, but later, smaller tasks are still considered
 * (skip-over greedy).
 */
export function admit(
  budget: ResourceBudget,
  tasks: WeightedTask[],
  options: AdmissionOptions = {},
): AdmissionResult {
  const ordered = [...tasks].sort(compare);
  const used: ResourceWeight = {
    cpu: options.used?.cpu ?? 0,
    network: options.used?.network ?? 0,
    battery: options.used?.battery ?? 0,
    memory: options.used?.memory ?? 0,
  };
  let count = options.running ?? 0;
  const admitted: string[] = [];
  const deferred: string[] = [];

  for (const task of ordered) {
    const fitsBudget = DIMENSIONS.every((d) => used[d] + task.weight[d] <= budget[d]);
    const fitsConcurrency = task.maxConcurrent == null || count + 1 <= task.maxConcurrent;
    if (fitsBudget && fitsConcurrency) {
      for (const d of DIMENSIONS) used[d] += task.weight[d];
      count += 1;
      admitted.push(task.id);
    } else {
      deferred.push(task.id);
    }
  }

  return { admitted, deferred };
}
