import type { RegisteredTask } from '../ExpoConductor.types';
import { TaskRegistry } from '../web/engine/registry';

function task(id: string): RegisteredTask {
  return {
    id,
    handler: { name: id, type: 'js' },
    triggers: [{ type: 'time', inSeconds: 1 }],
    priority: 0,
    weight: { cpu: 0.1, network: 0.1, battery: 0.1, memory: 0.1 },
    policy: {},
    nextRunAt: 1000,
    createdAt: 0,
  };
}

describe('TaskRegistry', () => {
  it('upserts, gets, lists and removes', () => {
    const r = new TaskRegistry();
    r.clear();
    r.upsert(task('a'));
    r.upsert(task('b'));
    expect(r.get('a')?.id).toBe('a');
    expect(r.all()).toHaveLength(2);
    expect(r.remove('a')).toBe(true);
    expect(r.remove('a')).toBe(false);
    expect(r.all()).toHaveLength(1);
  });

  it('upsert replaces existing task', () => {
    const r = new TaskRegistry();
    r.clear();
    r.upsert(task('a'));
    r.upsert({ ...task('a'), priority: 99 });
    expect(r.all()).toHaveLength(1);
    expect(r.get('a')?.priority).toBe(99);
  });
});
