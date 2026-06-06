import { order, type Prioritizable } from '../web/engine/priority';
import { loadFixture } from './fixtures';

interface PriorityCase {
  name: string;
  tasks: Prioritizable[];
  expected: string[];
}

const { cases } = loadFixture<{ cases: PriorityCase[] }>('priority.cases.json');

describe('priority.order (shared fixtures)', () => {
  it.each(cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    expect(order(c.tasks)).toEqual(c.expected);
  });
});

describe('priority.order (invariants)', () => {
  it('does not mutate the input array', () => {
    const tasks: Prioritizable[] = [
      { id: 'a', priority: 1, dueAt: 0 },
      { id: 'b', priority: 2, dueAt: 0 },
    ];
    const snapshot = [...tasks];
    order(tasks);
    expect(tasks).toEqual(snapshot);
  });
});
