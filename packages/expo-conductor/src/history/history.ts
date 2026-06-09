/**
 * Fold a flat stream of {@link TaskExecutionEvent}s into derived
 * {@link TaskExecutionRecord}s by pairing each `'execute'` event with its
 * corresponding `'complete'`, `'error'`, or `'skipped'` event.
 *
 * **Pairing limitations (documented, not polished away):**
 * - Native platforms always emit `attempt: 1` and `firedAt` = completion time,
 *   so execute→complete pairs are matched by taskId proximity (FIFO queue per task)
 *   rather than exact `firedAt`. Rapid repeated fires of one task id may mis-pair.
 * - Unmatched execute events (ring-buffer rotation, or tasks still in-flight) appear
 *   as `status: 'running'` records at the end.
 *
 * This is pure presentation logic — display/JS-side only (like web-only singleFlight
 * per CLAUDE.md). No Kotlin/Swift port; no /fixtures case.
 */
import type { TaskExecutionEvent, TaskExecutionRecord } from '../ExpoConductor.types';
import { TaskResult } from '../ExpoConductor.types';

/**
 * Fold a sequence of raw events into paired execution records, sorted oldest-first
 * by `firedAt`.
 */
export function foldHistory(events: TaskExecutionEvent[]): TaskExecutionRecord[] {
  const records: TaskExecutionRecord[] = [];
  // FIFO queue of unmatched 'execute' events, keyed by taskId.
  const pendingExecute = new Map<string, TaskExecutionEvent[]>();

  for (const event of events) {
    switch (event.kind) {
      case 'execute': {
        const queue = pendingExecute.get(event.taskId) ?? [];
        queue.push(event);
        pendingExecute.set(event.taskId, queue);
        break;
      }

      case 'complete':
      case 'error': {
        const queue = pendingExecute.get(event.taskId);
        if (queue && queue.length > 0) {
          const exec = queue.shift()!;
          records.push({
            taskId: exec.taskId,
            triggerType: exec.triggerType ?? event.triggerType ?? 'time',
            firedBy: exec.firedBy,
            firedAt: exec.triggeredAt,
            attempt: exec.attempt ?? 1,
            completedAt: event.triggeredAt,
            result: event.result,
            error: event.error,
            status:
              event.kind === 'error'
                ? 'error'
                : event.result === TaskResult.FAILED
                  ? 'failed'
                  : 'completed',
          });
        } else {
          // Orphaned complete/error (ring-buffer rotation, missed execute).
          records.push({
            taskId: event.taskId,
            triggerType: event.triggerType ?? 'time',
            firedBy: event.firedBy,
            firedAt: event.triggeredAt,
            attempt: event.attempt ?? 1,
            completedAt: event.triggeredAt,
            result: event.result,
            error: event.error,
            status:
              event.kind === 'error'
                ? 'error'
                : event.result === TaskResult.FAILED
                  ? 'failed'
                  : 'completed',
          });
        }
        break;
      }

      case 'skipped': {
        records.push({
          taskId: event.taskId,
          triggerType: event.triggerType ?? 'time',
          firedBy: event.firedBy,
          firedAt: event.triggeredAt,
          attempt: 1,
          skippedReason: event.reason,
          status: 'skipped',
        });
        break;
      }
    }
  }

  // Unmatched executes → still in-flight (or lost due to ring-buffer wrap).
  for (const [, queue] of pendingExecute) {
    for (const exec of queue) {
      records.push({
        taskId: exec.taskId,
        triggerType: exec.triggerType ?? 'time',
        firedBy: exec.firedBy,
        firedAt: exec.triggeredAt,
        attempt: exec.attempt ?? 1,
        status: 'running',
      });
    }
  }

  return records.sort((a, b) => a.firedAt - b.firedAt);
}
