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
}

export interface AdmissionResult {
  admitted: string[];
  deferred: string[];
}

const DIMENSIONS: (keyof ResourceWeight)[] = ['cpu', 'network', 'battery', 'memory'];

/**
 * Greedily admit tasks (highest priority first) while every weight dimension
 * stays within `budget`. A task that does not fit is deferred, but later, smaller
 * tasks are still considered (skip-over greedy).
 */
export function admit(budget: ResourceBudget, tasks: WeightedTask[]): AdmissionResult {
  const ordered = [...tasks].sort(compare);
  const used: ResourceWeight = { cpu: 0, network: 0, battery: 0, memory: 0 };
  const admitted: string[] = [];
  const deferred: string[] = [];

  for (const task of ordered) {
    const fits = DIMENSIONS.every((d) => used[d] + task.weight[d] <= budget[d]);
    if (fits) {
      for (const d of DIMENSIONS) used[d] += task.weight[d];
      admitted.push(task.id);
    } else {
      deferred.push(task.id);
    }
  }

  return { admitted, deferred };
}
