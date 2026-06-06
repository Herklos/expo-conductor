import { Priority } from '../ExpoConductor.types';
import { computeNextRunAt, normalize } from '../web/normalize';

describe('normalize', () => {
  it('applies defaults for handler, priority and weight', () => {
    const task = normalize({ id: 'sync', triggers: [{ type: 'time', inSeconds: 10 }] }, 1000);
    expect(task.handler).toEqual({ name: 'sync', type: 'js' });
    expect(task.priority).toBe(Priority.DEFAULT);
    expect(task.weight).toEqual({ cpu: 0.4, network: 0.4, battery: 0.4, memory: 0.4 });
    expect(task.nextRunAt).toBe(1000 + 10_000);
    expect(task.createdAt).toBe(1000);
  });

  it('honors a named priority and weight preset', () => {
    const task = normalize(
      { id: 't', priority: Priority.HIGH, weight: 'light', triggers: [{ type: 'time', at: 5000 }] },
      0,
    );
    expect(task.priority).toBe(Priority.HIGH);
    expect(task.weight).toEqual({ cpu: 0.1, network: 0.1, battery: 0.1, memory: 0.1 });
    expect(task.nextRunAt).toBe(5000);
  });

  it('lifts a recurrence trigger into the task recurrence', () => {
    const task = normalize(
      { id: 'r', triggers: [{ type: 'recurrence', recurrence: { kind: 'interval', everyMs: 1000 } }] },
      0,
    );
    expect(task.recurrence).toEqual({ kind: 'interval', everyMs: 1000 });
    expect(task.nextRunAt).toBe(1000);
  });
});

describe('computeNextRunAt', () => {
  it('returns the earliest of multiple triggers', () => {
    const next = computeNextRunAt(
      [
        { type: 'time', at: 9000 },
        { type: 'alarm', at: 3000 },
        { type: 'time', inSeconds: 5 },
      ],
      undefined,
      0,
    );
    expect(next).toBe(3000);
  });

  it('returns null when no trigger implies a concrete time', () => {
    expect(computeNextRunAt([{ type: 'push' }, { type: 'background' }], undefined, 0)).toBeNull();
  });
});
