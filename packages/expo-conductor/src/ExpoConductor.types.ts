/**
 * Public type contract for `expo-conductor`.
 *
 * These types describe the JSON-serializable task model that crosses the bridge
 * to the native engines (Kotlin / Swift) and is mirrored by the Web engine. Keep
 * everything here serializable — no functions are sent to native (handlers are
 * referenced by name; see {@link TaskHandlerRef}).
 */

// ---------------------------------------------------------------------------
// Priority
// ---------------------------------------------------------------------------

/** Named priority levels. Higher numbers win when tasks compete for resources. */
export enum Priority {
  MIN = -100,
  LOW = -10,
  DEFAULT = 0,
  HIGH = 10,
  MAX = 100,
}

// ---------------------------------------------------------------------------
// Resource weight
// ---------------------------------------------------------------------------

/** Per-dimension resource cost of running a task, each in the range 0..1. */
export interface ResourceWeight {
  cpu: number;
  network: number;
  battery: number;
  memory: number;
}

/** Coarse weight presets that expand to {@link ResourceWeight} values. */
export type WeightPreset = 'light' | 'moderate' | 'heavy';

export type TaskWeight = ResourceWeight | WeightPreset;

/** A resource budget available for a single admission pass (per dimension, 0..1+). */
export type ResourceBudget = ResourceWeight;

// ---------------------------------------------------------------------------
// Recurrence
// ---------------------------------------------------------------------------

export type Recurrence =
  | { kind: 'interval'; everyMs: number; anchor?: number }
  | { kind: 'daily'; hour: number; minute: number }
  | { kind: 'weekly'; weekday: number; hour: number; minute: number }
  | { kind: 'cron'; expression: string };

// ---------------------------------------------------------------------------
// Triggers
// ---------------------------------------------------------------------------

export type NetworkRequirement = 'any' | 'unmetered' | 'none';

/** Fire once at a wall-clock time or after a delay. */
export interface TimeTrigger {
  type: 'time';
  /** Absolute UTC epoch ms. */
  at?: number;
  /** Relative delay in seconds (mutually exclusive with `at`). */
  inSeconds?: number;
}

/** Fire repeatedly following a {@link Recurrence}. */
export interface RecurrenceTrigger {
  type: 'recurrence';
  recurrence: Recurrence;
}

/** Fire when a scheduled local notification is delivered. */
export interface NotificationTrigger {
  type: 'notification';
  title?: string;
  body?: string;
  /** When to deliver the notification (absolute UTC epoch ms). */
  at?: number;
  /** Relative delay in seconds. */
  inSeconds?: number;
  /** If true, also fire the task in the background when delivered. */
  runInBackground?: boolean;
}

/** Fire when a remote data message arrives (FCM on Android, APNs on iOS). */
export interface PushTrigger {
  type: 'push';
  /** Match remote messages whose `data.conductorTask` equals this key. */
  matchKey?: string;
}

/** Fire at an exact alarm time (Android exact alarm; iOS falls back to a notification). */
export interface AlarmTrigger {
  type: 'alarm';
  at: number;
  /** Wake the device even in Doze (Android `setExactAndAllowWhileIdle`). */
  allowWhileIdle?: boolean;
}

/** Run as an OS deferrable background task (WorkManager / BGTaskScheduler). */
export interface BackgroundTaskTrigger {
  type: 'background';
  /**
   * Minimum interval in minutes between background executions. On Android this is
   * floored at 15 minutes (WorkManager limit); on iOS it is advisory — BGTaskScheduler
   * decides actual timing.
   */
  minimumIntervalMinutes?: number;
}

/** Fire on an app lifecycle transition. */
export interface AppStateTrigger {
  type: 'appState';
  on: 'foreground' | 'background';
}

export type Trigger =
  | TimeTrigger
  | RecurrenceTrigger
  | NotificationTrigger
  | PushTrigger
  | AlarmTrigger
  | BackgroundTaskTrigger
  | AppStateTrigger;

export type TriggerType = Trigger['type'];

// ---------------------------------------------------------------------------
// Execution policy & constraints
// ---------------------------------------------------------------------------

export interface ExecutionWindow {
  /** Earliest UTC epoch ms the task may run. */
  earliest?: number;
  /** Latest UTC epoch ms the task may run. */
  latest?: number;
}

export interface RetryPolicy {
  maxAttempts: number;
  /** Initial backoff in ms; doubled each attempt up to `maxBackoffMs`. */
  backoffMs: number;
  maxBackoffMs?: number;
}

export interface Constraints {
  window?: ExecutionWindow;
  requiresCharging?: boolean;
  /** Minimum battery level 0..1. */
  minBatteryLevel?: number;
  network?: NetworkRequirement;
  requiresIdle?: boolean;
  /** Drop the task entirely after this UTC epoch ms. */
  expiresAt?: number;
}

export interface ExecutionPolicy {
  constraints?: Constraints;
  retry?: RetryPolicy;
  /**
   * Max number of tasks allowed to run simultaneously when this task is admitted. The
   * engine counts in-flight tasks and defers this one (emitting `onTaskSkipped` with
   * `DEFERRED_BY_BUDGET`) if admitting it would exceed the limit. Enforced fully in the
   * Web engine and within a live native process; see the README for headless caveats.
   */
  maxConcurrent?: number;
  /**
   * Cross-instance single-flight (leader election). When set, only ONE app instance
   * sharing the resolved key fires this task; other instances defer their occurrence,
   * emitting `onTaskSkipped` with reason `DEFERRED_BY_LEADER`. The deferred instance
   * catches up automatically when it becomes the leader (e.g. the holder's tab closes).
   *
   * - `true` keys the lock on the task `id` (one leader per task).
   * - a `string` keys the lock on that value, so several tasks can share one leader.
   *
   * Web: acquires `navigator.locks.request(key)` — the browser releases the lock when the
   * holding tab closes/navigates, handing leadership to a waiting instance with no
   * heartbeat. Native engines run a single app instance, so this is a no-op (always the
   * holder). Intended for recurring / `appState` work; a one-shot `time`/`alarm` that
   * fires while this instance is a non-leader is skipped and not replayed on handoff.
   */
  singleFlight?: boolean | string;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/** Where a task's work runs: a JS callback or an app-provided native handler. */
export type HandlerType = 'js' | 'native';

export interface TaskHandlerRef {
  name: string;
  type: HandlerType;
}

/** Normalized outcome returned by both JS and native handlers. */
export enum TaskResult {
  SUCCESS = 'success',
  FAILED = 'failed',
  NEW_DATA = 'newData',
  NO_DATA = 'noData',
}

/** Parameters passed to a handler when a task fires. */
export interface TaskExecutionContext {
  taskId: string;
  /** The trigger that caused this execution. */
  triggerType: TriggerType;
  /** Free-form data (e.g. push payload, notification data). */
  data?: Record<string, unknown>;
  /** UTC epoch ms the execution started. */
  firedAt: number;
  attempt: number;
}

export type JsTaskHandler = (
  ctx: TaskExecutionContext,
) => Promise<TaskResult | void> | TaskResult | void;

// ---------------------------------------------------------------------------
// Task definition
// ---------------------------------------------------------------------------

export interface TaskDefinition {
  id: string;
  /** Handler reference; if omitted, defaults to a JS handler named `id`. */
  handler?: TaskHandlerRef;
  triggers: Trigger[];
  priority?: number | Priority;
  weight?: TaskWeight;
  recurrence?: Recurrence;
  policy?: ExecutionPolicy;
  metadata?: Record<string, unknown>;
}

/** A fully-resolved task as stored by the engine/registry. */
export interface RegisteredTask {
  id: string;
  handler: TaskHandlerRef;
  triggers: Trigger[];
  priority: number;
  weight: ResourceWeight;
  recurrence?: Recurrence;
  policy: ExecutionPolicy;
  metadata?: Record<string, unknown>;
  /** Next computed run time (UTC epoch ms) or null if not scheduled. */
  nextRunAt: number | null;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Policy evaluation
// ---------------------------------------------------------------------------

export type PolicyReason =
  | 'ELIGIBLE'
  | 'EXPIRED'
  | 'BEFORE_WINDOW'
  | 'AFTER_WINDOW'
  | 'REQUIRES_CHARGING'
  | 'BATTERY_TOO_LOW'
  | 'NETWORK_UNAVAILABLE'
  | 'NETWORK_NOT_UNMETERED'
  | 'REQUIRES_IDLE';

export interface PolicyDecision {
  eligible: boolean;
  reason: PolicyReason;
}

export type NetworkType = 'none' | 'metered' | 'unmetered';

export interface DeviceContext {
  now: number;
  batteryLevel: number;
  charging: boolean;
  networkType: NetworkType;
  idle: boolean;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export interface TaskEventPayload {
  taskId: string;
  triggerType: TriggerType;
  firedAt: number;
  attempt: number;
  data?: Record<string, unknown>;
}

export interface TaskResultEventPayload extends TaskEventPayload {
  result: TaskResult;
}

export interface TaskSkippedEventPayload {
  taskId: string;
  reason: PolicyReason | 'DEFERRED_BY_BUDGET' | 'DEFERRED_BY_LEADER';
}

export interface TaskErrorEventPayload extends TaskEventPayload {
  error: string;
}

export type ExpoConductorModuleEvents = {
  onTaskExecute: (payload: TaskEventPayload) => void;
  onTaskComplete: (payload: TaskResultEventPayload) => void;
  onTaskError: (payload: TaskErrorEventPayload) => void;
  onTaskSkipped: (payload: TaskSkippedEventPayload) => void;
};

// ---------------------------------------------------------------------------
// Background availability
// ---------------------------------------------------------------------------

/**
 * Whether background execution is permitted on the device.
 * - `available`   — background tasks may run.
 * - `restricted`  — disabled by the OS/user (e.g. iOS Background App Refresh off,
 *                   low-power mode, or Android background restrictions).
 * - `unsupported` — the platform cannot run background tasks (e.g. web without
 *                   Periodic Background Sync).
 */
export type ConductorStatus = 'available' | 'restricted' | 'unsupported';
