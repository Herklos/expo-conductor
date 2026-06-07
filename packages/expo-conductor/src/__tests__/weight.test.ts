import type { ResourceBudget, ResourceWeight } from '../ExpoConductor.types';
import { admit, resolveWeight, type WeightedTask } from '../web/engine/weight';
import { loadFixture } from './fixtures';

interface AdmissionCase {
  name: string;
  budget: ResourceBudget;
  tasks: WeightedTask[];
  running?: number;
  used?: Partial<ResourceWeight>;
  expected: { admitted: string[]; deferred: string[] };
}

const { cases } = loadFixture<{ cases: AdmissionCase[] }>('weight-admission.cases.json');

describe('weight.admit (shared fixtures)', () => {
  it.each(cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    expect(admit(c.budget, c.tasks, { running: c.running, used: c.used })).toEqual(c.expected);
  });
});

describe('weight.resolveWeight', () => {
  it('expands presets', () => {
    expect(resolveWeight('light')).toEqual({ cpu: 0.1, network: 0.1, battery: 0.1, memory: 0.1 });
    expect(resolveWeight('heavy')).toEqual({ cpu: 0.8, network: 0.8, battery: 0.8, memory: 0.8 });
  });

  it('passes through explicit weights', () => {
    const w = { cpu: 0.2, network: 0.3, battery: 0.4, memory: 0.5 };
    expect(resolveWeight(w)).toBe(w);
  });
});
