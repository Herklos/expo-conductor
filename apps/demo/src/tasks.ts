/**
 * Task handler registration — intentionally at MODULE (global) scope, imported from
 * `index.ts` before the app mounts. This mirrors `expo-task-manager`'s requirement: when
 * the OS relaunches the app headlessly to run a background/alarm/push task, no React
 * components mount, so handlers must already be registered here (not inside a component).
 */
import Conductor, { TaskResult } from 'expo-conductor';

Conductor.defineTask('sync', () => TaskResult.NEW_DATA);

Conductor.defineTask('flaky', (ctx) =>
  ctx.attempt < 2 ? TaskResult.FAILED : TaskResult.SUCCESS,
);

Conductor.defineTask('heavy', () => TaskResult.SUCCESS);
