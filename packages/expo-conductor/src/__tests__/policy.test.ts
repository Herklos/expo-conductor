import type { Constraints, DeviceContext, PolicyDecision } from '../ExpoConductor.types';
import { evaluate } from '../web/engine/policy';
import { loadFixture } from './fixtures';

interface PolicyCase {
  name: string;
  constraints: Constraints;
  context: DeviceContext;
  expected: PolicyDecision;
}

const { cases } = loadFixture<{ cases: PolicyCase[] }>('policy.cases.json');

describe('policy.evaluate (shared fixtures)', () => {
  it.each(cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    expect(evaluate(c.constraints, c.context)).toEqual(c.expected);
  });
});
