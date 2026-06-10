# expo-conductor — Comprehensive Guide

> **Version coverage:** this guide covers the v0.4.0 API.

---

## Table of contents

1. [Overview](#overview)
2. [Installation & config plugin](#installation--config-plugin)
3. [Task model](#task-model)
4. [Triggers](#triggers)
   - [time](#time-trigger)
   - [recurrence](#recurrence-trigger)
   - [notification](#notification-trigger)
   - [alarm](#alarm-trigger)
   - [background](#background-trigger)
   - [push](#push-trigger)
   - [appState](#appstate-trigger)
   - [userInitiatedBackground (iOS 26+)](#userinitatedbackground-trigger-ios-26)
5. [Trigger-aware execution (`firedBy`)](#trigger-aware-execution-firedby)
6. [Multi-trigger tasks](#multi-trigger-tasks)
7. [Recurrence](#recurrence)
8. [Priority & resource weight](#priority--resource-weight)
9. [Execution policy & constraints](#execution-policy--constraints)
10. [Handlers — JS, native, Rust](#handlers)
11. [ConductorClient API](#conductorclient-api)
12. [Execution history & reconciliation](#execution-history--reconciliation)
13. [Config plugin options](#config-plugin-options)
14. [Per-platform behavior](#per-platform-behavior)
15. [Optional integrations](#optional-integrations)

---

## Overview

`expo-conductor` is a declarative background-work scheduler for Expo. Instead of managing
timers and callbacks directly, you describe a task's *entire policy* — when it may fire,
how expensive it is, how important it is, what conditions it needs, and whether it should
recur — and the library maps that onto the right OS primitive on each platform.

**Three-engine architecture.** The orchestration logic (recurrence math, priority ordering,
weight-based admission control, policy evaluation) runs natively in **Kotlin** (Android),
**Swift** (iOS), and **TypeScript** (Web). On mobile the TypeScript layer is a thin proxy;
decisions are made in the platform language. All three engines are verified bit-for-bit
against the same shared fixture set in [`/fixtures`](../../../fixtures).

**Handler types.** A task's work runs in a JS callback (while the app is alive) or in a
platform-native handler (Kotlin/Swift, runs headless including after termination), or a
Rust handler (over C ABI FFI). You can mix: schedule with `handler.type: 'native'` and the
engine routes to the native layer; absent the native handler it falls through to JS.

---

## Installation & config plugin

```sh
npx expo install @drakkar.software/expo-conductor
```

Add to `app.json` — the plugin wires Android permissions, FCM service, iOS background modes,
BGTask identifiers, and exact-alarm flags:

```json
{
  "expo": {
    "plugins": [
      ["@drakkar.software/expo-conductor", {
        "enableExactAlarms":       true,
        "enableFcm":               false,
        "enableForegroundService": false,
        "enableRust":              false
      }]
    ]
  }
}
```

All options are optional. See [Config plugin options](#config-plugin-options) for the full list.

---

## Task model

```ts
interface TaskDefinition {
  id:         string;                          // unique, stable across app restarts
  handler?:   TaskHandlerRef;                  // defaults to JS handler named `id`
  triggers:   Trigger[];                       // at least one
  priority?:  number | Priority;               // default Priority.DEFAULT (0)
  weight?:    TaskWeight;                      // 'light' | 'moderate' | 'heavy' | ResourceWeight
  recurrence?: Recurrence;                     // legacy convenience field — prefer a RecurrenceTrigger
  policy?:    ExecutionPolicy;
  metadata?:  Record<string, unknown>;         // app-specific data, opaque to the engine
}
```

A task fires when **any** of its `triggers` fire. The engine then checks `policy.constraints`
(skipping and rescheduling if not met), applies admission control (priority + resource budget),
dispatches to the handler, and re-arms for the next occurrence.

---

## Triggers

### `time` trigger

Fire once at a wall-clock time or after a delay.

```ts
{ type: 'time', at: Date.now() + 60_000 }         // absolute UTC epoch ms
{ type: 'time', inSeconds: 60 }                    // relative delay
```

| Platform | Mechanism |
| --- | --- |
| Android | WorkManager `OneTimeWorkRequest` |
| iOS | `UNTimeIntervalNotificationTrigger` (user-visible banner) |
| Web | `setTimeout` (chains for delays > 24.8 days) |

> iOS surfaces a notification banner for `time` triggers — that is the only way to wake the
> app at a wall-clock time on iOS. The banner uses the task `id` as title unless you also
> add a `notification` trigger with a custom `title`/`body`.

---

### `recurrence` trigger

Fire repeatedly according to a [Recurrence](#recurrence) schedule.

```ts
{ type: 'recurrence', recurrence: { kind: 'interval', everyMs: 15 * 60_000 } }
{ type: 'recurrence', recurrence: { kind: 'daily', hour: 9, minute: 30 } }
{ type: 'recurrence', recurrence: { kind: 'cron', expression: '*/15 * *' } }
```

| Platform | Mechanism |
| --- | --- |
| Android | Periodic `WorkManager` |
| iOS | `BGTaskScheduler` (silent, no banner) |
| Web | `setInterval` |

iOS recurrence is silent and opportunistic — no notification banner, no Simulator support.
Intervals are advisory on iOS.

---

### `notification` trigger

Schedule a user-visible local notification; the task fires when it is delivered.

```ts
{
  type:            'notification',
  title:           'Feed refresh',
  body:            'New items available',
  inSeconds:       300,
  runInBackground: true,     // also fire in background on delivery (not just foreground)
  recurring:       true,     // re-arm inSeconds after each delivery (v0.4.0+)
}
```

`recurring: true` (v0.4.0+): after each delivery the engine re-computes `now + inSeconds * 1000`
and schedules a fresh notification, so clock drift does not accumulate. Only meaningful with
`inSeconds`; a fixed `at` timestamp cannot recur.

| Platform | Mechanism |
| --- | --- |
| Android | `NotificationManagerCompat` (auto-creates a channel) |
| iOS | `UNUserNotificationCenter` |
| Web | Timer only (no visible notification) |

---

### `alarm` trigger

Fire at an exact wall-clock time. Android wakes the device out of Doze.

```ts
{
  type:           'alarm',
  at:             Date.now() + 10_000,
  allowWhileIdle: true,    // setExactAndAllowWhileIdle (default)
  windowMs:       60_000,  // Android only: setWindow [at, at+windowMs] (v0.4.0+)
}
```

`windowMs` (v0.4.0+, Android only): use `AlarmManager.setWindow` instead of `setExact`.
The OS may fire anywhere within the window, enabling battery-efficient batching. Ignored
when exact alarms are unavailable (falls back to inexact).

| Platform | Mechanism |
| --- | --- |
| Android | `AlarmManager.setExactAndAllowWhileIdle` (or `setWindow` with `windowMs`) |
| iOS | ⚠️ Falls back to a `UNTimeIntervalNotificationTrigger` |
| Web | `setTimeout` |

> Exact alarms on Android 12+ require the `SCHEDULE_EXACT_ALARM` permission
> (`enableExactAlarms: true` in the plugin). On Android 14+ the user may revoke it and the
> engine falls back to an inexact alarm. `USE_EXACT_ALARM` is Play-restricted — see config
> plugin options.

---

### `background` trigger

Run as a deferrable OS background task when system conditions allow.

```ts
{
  type:                     'background',
  minimumIntervalMinutes:   15,
  bgProcessing:             true,   // iOS only: BGProcessingTask (~30 min)
  requiresNetwork:          true,   // BGProcessingTask only
  requiresCharging:         false,  // BGProcessingTask only
}
```

`bgProcessing: true` (iOS only): use `BGProcessingTaskRequest` (~30 min CPU + network window)
instead of `BGAppRefreshTask` (~30 s). Combined with a `push` trigger, a silent APNs push
(v0.4.0+) can chain directly into a BGProcessingTask slot — see [Push trigger](#push-trigger).

| Platform | Mechanism |
| --- | --- |
| Android | Periodic `WorkManager` (15 min floor) |
| iOS | `BGAppRefreshTask` (or `BGProcessingTask` with `bgProcessing: true`) |
| Web | Periodic Background Sync (availability varies) |

---

### `push` trigger

Fire when a server sends a remote data message matching the `matchKey`.

```ts
{ type: 'push', matchKey: 'refresh-feed' }
```

**Security:** the engine only matches tasks that declare a `push` trigger with a non-empty
`matchKey` equal to `data.conductorTask` in the message. A forged push cannot fire arbitrary
tasks. Treat push `data` as untrusted.

**FCM format (Android):**
```json
{ "message": { "token": "<device-token>",
               "data": { "conductorTask": "refresh-feed" },
               "android": { "priority": "high" } } }
```
Send via FCM HTTP v1 directly (service-account credential). **Do not** use the Expo Push
Service — it re-wraps `data` and `conductorTask` won't be at the top level.

**APNs format (iOS):**
```json
{ "aps": { "content-available": 1 }, "conductorTask": "refresh-feed" }
```
Use `apns-push-type: background` and `apns-priority: 5`. Background push is throttled
(~2–3/hr) and not guaranteed.

**Foreground-service promotion (Android, v0.4.0+):** set `policy.foreground: true` and
`enableForegroundService: true` in the config plugin. The task's `ConductorWorker` WorkManager job
promotes itself to a foreground service via `setForeground(...)` (dataSync), so it is exempt from
Doze and the background-CPU cap while it runs. WorkManager supplies the service — no app-declared
`<service>` is needed.

**Silent APNs → BGProcessingTask chain (iOS, v0.4.0+):** combine a `push` trigger with a
`background` trigger that has `bgProcessing: true`. A silent APNs push matching the `matchKey`
will submit a `BGProcessingTaskRequest(earliestBeginDate: now)` to give the handler the full
~30 min slot.

| Platform | Mechanism |
| --- | --- |
| Android | `FirebaseMessagingService` (requires `enableFcm: true`) |
| iOS | `ConductorAppDelegate` APNs delegate |
| Web | Not available |

---

### `appState` trigger

Fire on an app lifecycle transition.

```ts
{ type: 'appState', on: 'foreground' }   // app becomes active/visible
{ type: 'appState', on: 'background' }   // app is hidden/backgrounded
```

On **Web**, `appState` fires from `visibilitychange` (supplemented by window focus/blur).
Overlapping focus/visibility events are de-duplicated to a single transition.

Native: single app instance, fires synchronously on lifecycle events. No OS involvement.

---

### `userInitiatedBackground` trigger (iOS 26+)

Submit a `BGContinuedProcessingTask` — a long-running background task that continues after
the user backgrounds the app and is not subject to the ~30-minute `BGProcessingTask` cap.

```ts
{ type: 'userInitiatedBackground' }
```

**Must originate from a direct user interaction** (button press, etc.). The OS will deny the
request if there is no recent user action. Call `BackgroundScheduler.submitContinued()` from
your native-side user-action handler, or expose it via a JS-bridged module function.

Silently ignored on iOS < 26 and on Android/Web.

---

## Trigger-aware execution (`firedBy`)

Since v0.4.0, every task execution carries a `firedBy: FiredBy` value
(`TriggerType | 'manual'`) that reports what caused it:

- A `TriggerType` string (e.g. `'alarm'`, `'recurrence'`, `'push'`) when the scheduler fired it.
- `'manual'` when triggered explicitly via `runNow()` or `runDueTasks()`.

`firedBy` appears on:
- `onTaskExecute`, `onTaskComplete`, `onTaskError` event payloads.
- `TaskExecutionEvent` (raw history event).
- `TaskExecutionRecord` (folded history record).

```ts
Conductor.addListener('onTaskComplete', ({ taskId, firedBy, result }) => {
  console.log(`${taskId} fired by ${firedBy} → ${result}`);
});
```

**Best-effort on native multi-trigger tasks.** A WorkManager worker only knows "a worker ran"
and reports the trigger that won the previous `computeNextRunAt`. For precise attribution,
prefer single-trigger tasks.

---

## Multi-trigger tasks

A single task may declare multiple triggers. The engine arms all of them and fires on whichever
arrives first, then reschedules to the next soonest trigger.

```ts
await Conductor.schedule({
  id: 'sync',
  triggers: [
    { type: 'recurrence', recurrence: { kind: 'interval', everyMs: 900_000 } },
    { type: 'push',       matchKey: 'sync-now' },
    { type: 'appState',   on: 'foreground' },
  ],
});
```

The `firedBy` field tells you which trigger won each time.

---

## Recurrence

Four shapes, validated at `schedule()` time on every platform:

```ts
{ kind: 'interval', everyMs: 900000, anchor?: 0 }
{ kind: 'daily',    hour: 9, minute: 30 }
{ kind: 'weekly',   weekday: 1 /* 0=Sun */, hour: 9, minute: 0 }
{ kind: 'cron',     expression: '*/15 * *' /* minute hour dayOfWeek */ }
```

Cron is exactly **3 whitespace-separated fields** (`minute hour dayOfWeek`). Each field is
`*`, `*/<n>` (1 ≤ n ≤ 59), or a comma-separated list of integers. An invalid expression
throws at `schedule()` time — it never silently fires at wrong times. All three engines parse
cron identically: ASCII-whitespace separators, strict ASCII-integer tokens.

---

## Priority & resource weight

The engine **orders tasks by priority** (higher first, then earliest-due, then id) and
**admits** them greedily against a `ResourceBudget`:

```ts
enum Priority { MIN = -100, LOW = -10, DEFAULT = 0, HIGH = 10, MAX = 100 }

// Per-dimension cost of running one task (0..1 each):
interface ResourceWeight { cpu: number; network: number; battery: number; memory: number; }

// Presets expand to fixed ResourceWeight values:
type WeightPreset = 'light' | 'moderate' | 'heavy';
```

```ts
Conductor.setResourceBudget({ cpu: 1, network: 1, battery: 1, memory: 1 }); // default

await Conductor.schedule({
  id: 'heavy-sync',
  priority: Priority.LOW,
  weight: { cpu: 0.8, network: 0.6, battery: 0.4, memory: 0.3 },
  triggers: [{ type: 'background' }],
});
```

When a task cannot be admitted (would exceed a budget dimension) it emits `onTaskSkipped`
with reason `DEFERRED_BY_BUDGET` and is retried shortly. It does not lose its occurrence.
Admission also accounts for currently-running tasks and each task's `policy.maxConcurrent`.

---

## Execution policy & constraints

```ts
interface ExecutionPolicy {
  constraints?: {
    window?:           { earliest?: number; latest?: number };  // UTC epoch ms
    requiresCharging?: boolean;
    minBatteryLevel?:  number;    // 0..1
    network?:          'any' | 'unmetered' | 'none';
    requiresIdle?:     boolean;
    expiresAt?:        number;    // UTC epoch ms — drop the task after this time
  };
  retry?: {
    maxAttempts:   number;
    backoffMs:     number;        // doubled each attempt
    maxBackoffMs?: number;
  };
  maxConcurrent?:  number;        // max in-flight tasks at admission time
  foreground?:     boolean;       // Android: foreground service (survives Doze)
  singleFlight?:   boolean | string; // Web: cross-instance leader election
}
```

When a constraint isn't met at fire time, the task is **skipped** (not dropped) and
rescheduled to its next occurrence.

> **`retry` is per-platform.** Web engine + JS handlers while alive: fully honored.
> Native + JS handler: in-process only while alive. Native handler: OS retry
> (WorkManager exponential backoff, not the configured values; iOS BGTask: no auto-retry).
> Design handlers to be idempotent.

---

## Handlers

### JS handler

```ts
// Must be at MODULE (global) scope — not inside a component or effect.
Conductor.defineTask('my-task', async (ctx: TaskExecutionContext) => {
  // ctx.taskId, ctx.triggerType, ctx.data, ctx.firedAt, ctx.attempt
  return TaskResult.NEW_DATA;
});
```

Runs while the app is alive. Not available after termination.

### Native handler

```kotlin
// Android — Application.onCreate or equivalent
ExpoConductorModule.registerHandler("my-task") { taskId, data -> "success" }
```

```swift
// iOS — AppDelegate or early module init
import ExpoConductor
ExpoConductorModule.registerHandler(name: "my-task") { taskId, data in "success" }
```

Runs headless (including after termination). Return one of:
`"success"` | `"failed"` | `"newData"` | `"noData"`.

Set `handler: { name: 'my-task', type: 'native' }` on the task definition.

### Rust handler

```rust
// src/lib.rs
use conductor_ffi::{conductor_register, Handler};
use std::sync::Arc;

#[no_mangle]
pub extern "C" fn conductor_app_init() {
    conductor_register("my-task", Arc::new(|_task_id, _data| "success"));
}
```

Enable with `{ "enableRust": true, "rustLibName": "my_app_rust" }` in the config plugin.
Behaves like a native handler on the TS side. See the package README for full build steps.

---

## ConductorClient API

```ts
// Handler registration (call at module scope)
Conductor.defineTask(name, handler)           // register JS handler
Conductor.undefineTask(name)                  // remove JS handler
Conductor.isTaskDefined(name)                 // boolean
Conductor.getDefinedTaskNames()               // string[]

// Scheduling
await Conductor.schedule(def, handler?)       // register task + optional JS handler
await Conductor.defineTaskDefinition(def)     // register definition (handler separate)
await Conductor.cancelTask(id)                // remove a task
await Conductor.getTasks()                    // RegisteredTask[] — all stored tasks
await Conductor.runNow(id)                    // fire immediately (bypasses policy/budget)
await Conductor.runDueTasks()                 // run all currently-due tasks; returns count fired

// Runtime control
await Conductor.setResourceBudget(budget)     // { cpu, network, battery, memory } each 0..1
await Conductor.pause()                       // suspend all dispatch
await Conductor.resume()                      // re-arm all tasks
await Conductor.getStatus()                   // 'available' | 'restricted' | 'unsupported'
await Conductor.requestPermissions()          // notification permission → boolean

// History
await Conductor.getHistory()                  // TaskExecutionEvent[] (raw ring buffer)
await Conductor.clearHistory()                // clear the ring buffer

// Events
Conductor.addListener('onTaskExecute',  cb)   // { taskId, triggerType, firedBy, firedAt, attempt, data }
Conductor.addListener('onTaskComplete', cb)   // adds: result
Conductor.addListener('onTaskSkipped',  cb)   // { taskId, reason }
Conductor.addListener('onTaskError',    cb)   // adds: error

const sub = Conductor.addListener('onTaskExecute', cb)
sub.remove()                                  // detach a single listener (there is no removeAllListeners)
```

### `RegisteredTask` (from `getTasks()`)

```ts
{
  id:          string;
  handler:     TaskHandlerRef;
  triggers:    Trigger[];
  priority:    number;
  weight:      ResourceWeight;
  recurrence?: Recurrence;
  policy:      ExecutionPolicy;
  metadata?:   Record<string, unknown>;
  nextRunAt:   number | null;    // UTC epoch ms of next scheduled fire, or null
  nextFiredBy: TriggerType | null; // which trigger will cause the next fire
  createdAt:   number;
}
```

---

## Execution history & reconciliation

The engine writes an append-only ring buffer (200 events) of every task lifecycle event to
durable storage (Android: `SharedPreferences`; iOS: `UserDefaults`; Web: `localStorage`).
Background/headless runs are captured because the write happens from the main-thread emit helper.

```ts
import { foldHistory, reconcile } from '@drakkar.software/expo-conductor';

// Fold raw events into paired records
const records = foldHistory(await Conductor.getHistory());
// records: TaskExecutionRecord[] — { taskId, triggerType, firedBy, firedAt,
//          completedAt, result, error, status, attempt, … }

// Compare expected vs actual firings
const { matched, missed, unexpected, aborted } = reconcile(
  await Conductor.getTasks(),
  records,
  { now: Date.now(), windowMs: 24 * 60 * 60_000 },
);
```

Reconciliation is **exact** for `time`, `recurrence`, `alarm` triggers (deterministic math).
For `background`, `push`, `appState` it is **advisory** — OS timing is non-deterministic.

---

## Config plugin options

```jsonc
["@drakkar.software/expo-conductor", {
  // Permissions & features
  "enableExactAlarms":        true,   // SCHEDULE_EXACT_ALARM permission (Android 12+)
  "useExactAlarmClock":       false,  // USE_EXACT_ALARM — Play-restricted, opt in only if eligible
  "enableFcm":                false,  // Firebase FCM service + gradle dependency
  "enablePush":               false,  // iOS remote-notification background mode (APNs, no Firebase)
  "enableForegroundService":  false,  // FOREGROUND_SERVICE(_DATA_SYNC) permissions for policy.foreground
  "enableRust":               false,  // CONDUCTOR_RUST xcconfig + rustLibName in build

  // iOS background task identifiers (added to BGTaskSchedulerPermittedIdentifiers)
  // Defaults: refresh, processing, continued (v0.4.0+) are always included
  "backgroundTaskIdentifiers": [],    // extra custom identifiers

  // Rust
  "rustLibName": ""                   // must match your crate's [lib] name
}]
```

| Option | Platform | Default | Notes |
| --- | --- | --- | --- |
| `enableExactAlarms` | Android | `true` | Adds `SCHEDULE_EXACT_ALARM` (falls back to inexact if not granted) |
| `useExactAlarmClock` | Android | `false` | Adds `USE_EXACT_ALARM`; Play-restricted |
| `enableFcm` | Android | `false` | Firebase messaging; add `google-services.json` |
| `enablePush` | iOS | `false` | `remote-notification` background mode for APNs-only push (implied by `enableFcm`) |
| `enableForegroundService` | Android | `false` | `FOREGROUND_SERVICE` permissions for `policy.foreground` |
| `enableRust` | iOS + Android | `false` | C ABI Rust handler bridge |
| `rustLibName` | iOS + Android | `""` | Your crate's `[lib] name` |
| `backgroundTaskIdentifiers` | iOS | `[]` | Extra BGTask ids to declare |

---

## Per-platform behavior

### Android

- Recurrence → Periodic `WorkManager`. Background tasks don't run in strict Doze without
  FCM + foreground service.
- Exact alarms → `AlarmManager`. Require `SCHEDULE_EXACT_ALARM` (user-revocable on Android 14+).
- `windowMs` on `alarm` → `AlarmManager.setWindow` for battery-efficient batching.
- `policy.foreground: true` → `ConductorWorker` promotes its WorkManager job to a foreground
  service via `setForeground(ForegroundInfo)` (dataSync type), exempt from Doze while it runs.
- Notifications → `NotificationManagerCompat` with an auto-created channel.
- `push` trigger → `FirebaseMessagingService.onMessageReceived`. Requires `enableFcm: true`.
- History → `SharedPreferences` JSON ring buffer.

### iOS

- Recurrence → `BGTaskScheduler` (silent, opportunistic). Minimum intervals are advisory.
  Background tasks **do not run on the Simulator**.
- `time`/`alarm` → `UNTimeIntervalNotificationTrigger` (always shows a banner — this is the
  only way to wake the app at a wall-clock time on iOS).
- `notification` → `UNUserNotificationCenter`. `recurring: true` re-arms after each delivery.
- `background` → `BGAppRefreshTask` (or `BGProcessingTask` with `bgProcessing: true`).
- Silent APNs push + `bgProcessing: true` → submits a `BGProcessingTaskRequest` immediately.
- `userInitiatedBackground` (iOS 26+) → `BGContinuedProcessingTask` from user-action context.
- `policy.foreground` is ignored on iOS.
- `AlarmTrigger.windowMs` is ignored on iOS.
- History → `UserDefaults` JSON ring buffer.

### Web

- Recurrence → `setInterval`. Long delays chain `setTimeout` to avoid the 2^31 ms overflow.
- Background → Periodic Background Sync (browser-dependent availability).
- `push`, `alarm` (`allowWhileIdle`), `userInitiatedBackground` → not available.
- `singleFlight` → `navigator.locks` (leader election across tabs). No-op on native.
- History → `localStorage` JSON ring buffer.

---

## Optional integrations

### Headless JS via `expo-task-manager` / `expo-background-task`

By default JS handlers only run while the app is alive. To run JS handlers after termination:

```sh
npx expo install expo-task-manager expo-background-task
```

```ts
// app entry — MODULE scope
import Conductor, { TaskResult } from '@drakkar.software/expo-conductor';
import { registerConductorBackgroundTask } from '@drakkar.software/expo-conductor/task-manager';

Conductor.defineTask('refresh', async () => TaskResult.NEW_DATA);
await registerConductorBackgroundTask({ minimumInterval: 15 }); // minutes
```

When the OS fires the background tick, conductor runs all currently-due tasks through its
engine (`Conductor.runDueTasks()`), so priority/weight/policy still apply.

### Notifications via `expo-notifications`

```sh
npx expo install expo-notifications
```

```ts
import { setupConductorNotifications } from '@drakkar.software/expo-conductor/notifications';
await setupConductorNotifications(); // foreground handler + Android channel + response routing
```

Handles foreground presentation, Android channels, permission prompts, and cold-start
notification response routing.
