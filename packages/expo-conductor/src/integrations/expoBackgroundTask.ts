/**
 * Optional first-party interop (Phase 2): drive conductor's engine from an
 * `expo-background-task` tick so **JS handlers survive a headless cold start**.
 *
 * expo-conductor's own JS handler registry is in-memory, so a JS handler only runs while
 * the app is alive. `expo-task-manager`'s `defineTask` uses a *persisted, global* registry
 * that the OS can invoke headlessly; this module registers a single conductor "tick" task
 * there and runs every currently-due conductor task through the engine when it fires.
 *
 * Requires the optional peer deps `expo-task-manager` and `expo-background-task`.
 *
 * Usage — import at **module scope** (e.g. your app entry), not inside a component:
 * ```ts
 * import Conductor, { TaskResult } from 'expo-conductor';
 * import { registerConductorBackgroundTask } from 'expo-conductor/task-manager';
 *
 * Conductor.defineTask('refresh', async () => TaskResult.SUCCESS); // module scope!
 * await registerConductorBackgroundTask({ minimumInterval: 15 });
 * ```
 *
 * Keep conductor's engine for prioritization/weight/policy/recurrence; this just lets the
 * `background` trigger + JS handlers run when the app is terminated. The hand-rolled native
 * BGTaskScheduler/WorkManager path remains the default when this integration isn't used.
 */
import * as BackgroundTask from 'expo-background-task';
import * as TaskManager from 'expo-task-manager';

import Conductor from '../index';

/** The task name registered with expo-task-manager / expo-background-task. */
export const CONDUCTOR_BACKGROUND_TASK = 'expo-conductor.tick';

// Defined at module scope (required for headless execution): when the OS wakes the app for
// a background tick, this runs every due conductor task through the engine.
TaskManager.defineTask(CONDUCTOR_BACKGROUND_TASK, async () => {
  try {
    await Conductor.runDueTasks();
    return BackgroundTask.BackgroundTaskResult.Success;
  } catch {
    return BackgroundTask.BackgroundTaskResult.Failed;
  }
});

export interface ConductorBackgroundTaskOptions {
  /** Minimum interval between background ticks, in minutes (Android floors at 15). */
  minimumInterval?: number;
}

/** Register the conductor background tick with expo-background-task. */
export async function registerConductorBackgroundTask(
  options: ConductorBackgroundTaskOptions = {},
): Promise<void> {
  await BackgroundTask.registerTaskAsync(CONDUCTOR_BACKGROUND_TASK, {
    minimumInterval: options.minimumInterval,
  });
}

/** Unregister the conductor background tick. */
export async function unregisterConductorBackgroundTask(): Promise<void> {
  await BackgroundTask.unregisterTaskAsync(CONDUCTOR_BACKGROUND_TASK);
}

/** Whether OS background execution is currently available (Available / Restricted). */
export function getBackgroundTaskStatusAsync(): Promise<BackgroundTask.BackgroundTaskStatus> {
  return BackgroundTask.getStatusAsync();
}
