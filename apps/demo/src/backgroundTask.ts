/**
 * Optional Phase 2 wiring for the demo. If `expo-task-manager` + `expo-background-task` are
 * installed, this enables a conductor background tick so JS handlers can run headless.
 * Everything is guarded behind a dynamic import so the demo still runs when those optional
 * peer deps are absent (it simply reports "unavailable").
 *
 * NOTE: for true headless cold-start the conductor tick must be defined at module scope.
 * Importing `expo-conductor/task-manager` (which calls TaskManager.defineTask on load) from
 * your app entry does that; here we trigger it from a button to keep the demo explicit.
 */
type TaskManagerModule = typeof import('expo-conductor/task-manager');

async function loadIntegration(): Promise<TaskManagerModule | null> {
  try {
    return await import('expo-conductor/task-manager');
  } catch {
    return null; // optional deps not installed
  }
}

export async function enableHeadlessBackground(minimumIntervalMinutes = 15): Promise<string> {
  const mod = await loadIntegration();
  if (!mod) return 'unavailable (install expo-task-manager + expo-background-task)';
  try {
    await mod.registerConductorBackgroundTask({ minimumInterval: minimumIntervalMinutes });
    return `registered (every ~${minimumIntervalMinutes}m)`;
  } catch (e) {
    return `error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

export async function disableHeadlessBackground(): Promise<string> {
  const mod = await loadIntegration();
  if (!mod) return 'unavailable';
  try {
    await mod.unregisterConductorBackgroundTask();
    return 'unregistered';
  } catch (e) {
    return `error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

export async function backgroundTaskStatus(): Promise<string> {
  const mod = await loadIntegration();
  if (!mod) return 'unavailable (optional deps not installed)';
  try {
    return `status: ${String(await mod.getBackgroundTaskStatusAsync())}`;
  } catch (e) {
    return `error: ${e instanceof Error ? e.message : String(e)}`;
  }
}
