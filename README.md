<div align="center">
  <img src="./icon.png" alt="expo-conductor" width="120" height="120" />
</div>

# expo-conductor

> **Declarative background work** for Expo with priority, resource budgeting, recurrence, and constraints — backed by a **native-first engine** on iOS, Android, and Web.

Most schedulers hand you a timer and a callback. `expo-conductor` lets you *declare* the whole **policy** of a job — when it may run, how important it is, how expensive it is, and what conditions it needs — then intelligently dispatches it to the right OS primitive (WorkManager, AlarmManager, BGTaskScheduler, local notifications, FCM/APNs) and decides **whether and when** it actually executes, using one shared, heavily-tested engine across all three platforms.

### Why reach for it

- **Tasks are data, not callbacks.** Triggers, recurrence, priority, resource weight,
  retry/backoff, and constraints are all declared on a single task definition — the engine does
  the orchestration.
- **Native-first, identical everywhere.** The decision engine is implemented three times
  (Swift / Kotlin / TypeScript) and verified bit-for-bit against one shared fixture set, so the
  same task behaves the same on iOS, Android, and Web.
- **Cross-task admission control.** Tasks compete for a `ResourceBudget` (cpu / network / battery
  / memory) by priority, so a heavy, low-priority job yields to lighter or more important work
  instead of everything firing at once.
- **Many triggers, one model.** `time`, `recurrence` (interval / daily / weekly / cron),
  `notification`, exact `alarm`, deferrable `background`, `push` (FCM / APNs), and `appState`.
- **JS, native, *or* Rust handlers.** Run work in JS while the app is alive, or in a native or
  Rust handler that survives a headless cold start.
- **Single-flight across instances.** Elect one leader so two browser tabs (or a tab + an
  Electron shell) don't double-fire the same recurring job.
- **Batteries included.** An Expo config plugin wires permissions, the FCM service, BGTask
  identifiers, and exact-alarm flags; optional first-party bridges to `expo-task-manager` and
  `expo-notifications` extend it further.

```ts
import Conductor, { Priority, TaskResult } from '@drakkar.software/expo-conductor';

// 1. Define the work (JS handler — or implement it natively, see below).
Conductor.defineTask('refresh-feed', async (ctx) => {
  await fetchAndCache();
  return TaskResult.NEW_DATA;
});

// 2. Schedule it with policy, weight, priority and triggers.
await Conductor.schedule({
  id: 'refresh-feed',
  priority: Priority.HIGH,
  weight: 'moderate',                       // resource cost (cpu/network/battery/memory)
  triggers: [
    { type: 'recurrence', recurrence: { kind: 'interval', everyMs: 15 * 60_000 } },
    { type: 'push', matchKey: 'refresh' },  // also wake on a remote message
  ],
  policy: {
    constraints: { network: 'any', minBatteryLevel: 0.2 },
    retry: { maxAttempts: 3, backoffMs: 30_000 },
  },
});
```

That's the whole loop: **define** the handler once, **schedule** it with a policy, and let the
engine decide the rest. The sections below unpack each piece.

## How it works — one engine, three platforms

The orchestration **engine** — recurrence math, priority ordering, weight-based admission control,
and policy evaluation — is implemented natively in **Kotlin** (Android), **Swift** (iOS), and
**TypeScript** (web). On a native platform the TypeScript layer is a thin proxy; decisions are made
in the platform language, right next to the OS scheduler. The three implementations are kept
bit-for-bit identical — integer UTC-epoch-millisecond time math and strict `<=` weight comparisons,
locked down by one shared, language-neutral fixture set in [`/fixtures`](./fixtures).

What the engine can actually *do*, though, depends on the OS underneath it.

**Legend:** ✅ supported · ⚠️ partial / best-effort · ❌ not available · ➖ not applicable

| Capability | Android | iOS | Web |
| --- | :---: | :---: | :---: |
| One-shot & recurring schedules (interval / daily / weekly / cron) | ✅ | ✅ | ✅ |
| Run while the app is alive (JS handler) | ✅ | ✅ | ✅ |
| Run **after the app is terminated** (native / Rust handler) | ✅ | ✅ | ❌ |
| Deferrable background execution | ✅ | ✅ ¹ | ⚠️ ² |
| Long-running background task (~30 min, BGProcessingTask) | ➖ | ✅ ¹ | ➖ |
| User-initiated continued background task (iOS 26+) | ➖ | ✅ ⁵ | ➖ |
| Exact wall-clock alarms | ✅ | ⚠️ ³ | ⚠️ |
| Windowed exact alarm (battery-efficient batching) | ✅ | ➖ | ➖ |
| User-visible notifications (+ recurring re-arm) | ✅ | ✅ | ❌ |
| Server-driven push (`push` trigger) | ✅ ⁴ | ✅ | ❌ |
| Silent APNs → BGProcessingTask chain | ➖ | ✅ | ➖ |
| FCM push → foreground service (survives Doze) | ✅ ⁴ | ➖ | ➖ |
| `appState` (foreground / background) | ✅ | ✅ | ✅ |
| Priority + resource-budget admission control | ✅ | ✅ | ✅ |
| Policy constraints (charging / network / idle / battery / window / expiry) | ✅ | ✅ | ✅ |
| Execution history + `firedBy` attribution | ✅ | ✅ | ✅ |
| Single-flight across app instances | ➖ | ➖ | ✅ |

¹ Opportunistic timing; intervals are advisory and it does **not** run on the iOS Simulator.
² Depends on Periodic Background Sync availability.
³ iOS has no exact-alarm API — falls back to a scheduled local notification.
⁴ Requires `enableFcm: true` in the config plugin (and a Firebase setup).
⁵ Requires iOS 26+; silently ignored on earlier OS versions. Must originate from a direct user action.

The OS primitive behind each trigger is in the [Triggers](#triggers) table; see
**[Platform support & limitations](#platform-support--limitations)** for the full detail.

## Installation

```sh
npx expo install @drakkar.software/expo-conductor
```

Then add the config plugin to `app.json` — it sets up the Android permissions and FCM service, the
iOS background modes and BGTask identifiers, and the exact-alarm flags for you:

```json
{
  "expo": {
    "plugins": [
      ["@drakkar.software/expo-conductor", { "enableExactAlarms": true, "enableFcm": false }]
    ]
  }
}
```

Other plugin options: `enablePush` (iOS APNs background mode without Firebase),
`enableForegroundService` (Android `policy.foreground` foreground-service promotion),
`enableRust` / `rustLibName` (Rust handlers — see below), `useExactAlarmClock`, and
`backgroundTaskIdentifiers`.

`expo-conductor` ships native code, so it needs a [development build](https://docs.expo.dev/develop/development-builds/introduction/)
(or a bare/prebuilt project) — it won't run in Expo Go.

## Core concepts

A **task** is a serializable definition: an `id`, one or more **triggers**, an optional
**recurrence**, a **priority** and **resource weight**, and an execution **policy**. You attach a
**handler** (JS or native) that does the actual work. The rest of this section walks through each
field.

### Triggers

A task fires when **any** of its triggers fire. Supported trigger types:

| Trigger | Android | iOS | Web | Notes |
| --- | --- | --- | --- | --- |
| `time` (at / inSeconds) | WorkManager | UNNotification | `setTimeout` | one-shot |
| `recurrence` (interval/daily/weekly/cron) | Periodic WorkManager | BGTaskScheduler (silent) | `setInterval` | repeating |
| `notification` (+ `recurring`) | NotificationManagerCompat (auto channel) | UNUserNotificationCenter | timer only (no UI) | user-visible; `recurring:true` re-arms after each delivery |
| `alarm` (exact; + `windowMs`) | AlarmManager (`setExactAndAllowWhileIdle` or `setWindow`) | ⚠︎ notification fallback | `setTimeout` | `windowMs` enables battery-efficient batching on Android |
| `background` (+ `bgProcessing`) | WorkManager | BGAppRefreshTask / BGProcessingTask | Periodic Background Sync | `bgProcessing:true` uses ~30 min slot on iOS |
| `push` (FCM/APNs data message) | FirebaseMessagingService† | APNs remote-notification | — | server-driven; `policy.foreground:true` → FGS on Android† |
| `appState` | lifecycle | lifecycle | visibility | fg/bg transitions |
| `userInitiatedBackground` | ➖ | BGContinuedProcessingTask ‡ | ➖ | iOS 26+ only; must originate from user action |

† FCM requires `enableFcm: true` in the config plugin and a Firebase setup. `policy.foreground: true` starts a foreground service to survive Doze; requires `enableForegroundService: true`.  
‡ `BGContinuedProcessingTask` is iOS 26+; silently ignored on earlier OS versions.

On **web**, `appState` triggers fire from `visibilitychange` (supplemented by window
focus/blur): a task with `{ type: 'appState', on: 'foreground' }` fires when the tab
becomes visible, `on: 'background'` when it is hidden. Overlapping focus/visibility events
are de-duplicated to a single transition.

### Recurrence

Four recurrence shapes cover most schedules:

```ts
{ kind: 'interval', everyMs: 900000, anchor?: 0 }
{ kind: 'daily',    hour: 9, minute: 30 }
{ kind: 'weekly',   weekday: 1 /* 0=Sun */, hour: 9, minute: 0 }
{ kind: 'cron',     expression: '30 9 *' /* minute hour dayOfWeek */ }
```

A cron `expression` is exactly three whitespace-separated fields (`minute hour dayOfWeek`), each
`*`, `*/<n>` (with `1 ≤ n ≤ 59`), or a comma list of integers. An invalid expression is **rejected
at `schedule()` time on every platform** — a typo throws immediately instead of silently never
firing. All three engines parse cron identically: ASCII-whitespace separators and strict
ASCII-integer tokens.

### Priority & resource weight

This is the heart of the engine. It **orders tasks by priority** (higher first, then earliest-due,
then id) and **admits** them greedily against a `ResourceBudget`, skipping any that would blow a
dimension — that's how a heavy, low-priority task yields to lighter or more important ones.
Admission also accounts for the budget **and count already consumed by tasks currently running**,
and honors each task's `policy.maxConcurrent`, so a task is deferred when the device is already
busy. When a fired task can't be admitted it emits `onTaskSkipped` with reason
`DEFERRED_BY_BUDGET` and is retried shortly — it doesn't lose its turn. The admission algorithm is
verified across all platforms by the shared fixtures.

```ts
Conductor.setResourceBudget({ cpu: 1, network: 1, battery: 1, memory: 1 });

await Conductor.schedule({
  id: 'thumbnail-gen',
  priority: Priority.LOW,
  weight: { cpu: 0.8, network: 0.1, battery: 0.3, memory: 0.5 },
  triggers: [{ type: 'background' }],
});
```

`weight` accepts a preset (`'light' | 'moderate' | 'heavy'`) or explicit dimensions (each `0..1`).

> **Scope:** cross-task budgeting is fully realized in the Web engine and within a live native
> process. After a headless cold start the native "running" set starts empty — each OS-triggered
> task is admitted against whatever else is running in that same process.

### Execution policy & constraints

Constraints gate *whether* a task may run; retry governs *what happens on failure*:

```ts
policy: {
  constraints: {
    window: { earliest: t0, latest: t1 },   // only run within a window
    requiresCharging: true,
    minBatteryLevel: 0.2,                    // 0..1
    network: 'unmetered',                    // 'any' | 'unmetered' | 'none'
    requiresIdle: true,
    expiresAt: deadline,                     // drop the task after this time
  },
  retry: { maxAttempts: 3, backoffMs: 30000, maxBackoffMs: 600000 },
  maxConcurrent: 2,
  singleFlight: true,                          // cross-instance leader election (see below)
}
```

If a constraint isn't met when a task fires, it is **skipped** (with a reason emitted on
`onTaskSkipped`) and rescheduled for its next occurrence.

> **`retry` is intentionally per-platform.** It is fully honored by the Web engine and by JS
> handlers while the app is alive; native handlers fall back to OS retry (Android WorkManager's
> exponential backoff — not the configured values; iOS BGTask isn't auto-retried). Design handlers
> to be idempotent.

### Single-flight (cross-instance leader election)

When several app instances of the same origin run the same task — two browser tabs, or a tab plus
an Electron shell sharing one account — a recurring or `appState` task would fire in *each*,
double-posting a webhook or double-replying to a command. `policy.singleFlight` elects **one
leader**; only the holder fires, the others defer:

```ts
await Conductor.schedule({
  id: 'poll-feed',
  triggers: [{ type: 'recurrence', recurrence: { kind: 'interval', everyMs: 900000 } }],
  policy: { singleFlight: true },        // `true` keys on the task id…
  // policy: { singleFlight: 'feeds' },  // …a string shares one leader across tasks
});
```

- **Web** acquires `navigator.locks.request(key)` (exclusive). The browser frees the lock
  when the holding tab closes or navigates, so leadership hands off to a waiting instance
  with **no heartbeat**. A non-leader's occurrence emits `onTaskSkipped` with reason
  `DEFERRED_BY_LEADER`; when that instance later becomes leader it fires the deferred
  occurrence immediately (no full-interval wait).
- **Native** runs a single app instance, so this is a no-op (always the holder).
- `runNow(id)` always fires, regardless of leadership.

Intended for recurring / `appState` work. A one-shot `time`/`alarm` that fires while this
instance is a non-leader is skipped and **not** replayed on handoff.

### Task handlers — JS, native, or Rust

A task's work can run as a **JS handler**, an **app-provided native handler**, or a **Rust handler**.
JS is the easy path; a native or Rust handler is the reliable path for work that must run while the
app is terminated.

```ts
// JS handler — register at MODULE (global) scope, not inside a component/effect, so it
// survives a headless relaunch (same rule as expo-task-manager's defineTask). A JS handler
// runs while the app is alive (incl. foreground/background); it does NOT run after the app
// is terminated — use a native handler for that.
Conductor.defineTask('refresh-feed', async (ctx) => TaskResult.NEW_DATA);
```

```kotlin
// Android native handler — runs without spinning up JS (more reliable in background).
// Register early (e.g. in Application.onCreate). Return one of:
// "success" | "failed" | "newData" | "noData".
ExpoConductorModule.registerHandler("refresh-feed") { taskId, data ->
  // ...do the work synchronously...
  "success"
}
```

```swift
// iOS native handler — runs on the native side without crossing into JS.
// Register early (e.g. in your AppDelegate `application(_:didFinishLaunchingWithOptions:)`
// or any module init that runs at launch) so the handler exists when a trigger fires.
// The closure signature is `(_ taskId: String, _ data: [String: Any]) -> String`
// and must return one of: "success" | "failed" | "newData" | "noData".
import ExpoConductor

ExpoConductorModule.registerHandler(name: "refresh-feed") { taskId, data in
  // `data` carries the trigger payload (e.g. the remote push `data` dictionary).
  // Do the work, then report the outcome:
  return "newData"
}

// Remove it later if needed:
ExpoConductorModule.unregisterHandler(name: "refresh-feed")
```

Set `handler: { name, type: 'native' }` on the task definition to dispatch to a native
handler. The `name` must match the string you registered. If a JS handler is unavailable at
fire time (e.g. the process was killed) and a native handler with the same name exists, the
engine uses the native one. Native handlers should return quickly and respect background
execution limits — for long work, kick off your own bounded task and return promptly.

#### Rust handlers

For shared, portable logic a task can run a **Rust handler** (`handler: { name, type: 'rust' }`) —
a function registered with `conductor_register` in the `conductor_ffi` glue crate. Like a native
handler it runs on the native side (headless included) with no JS runtime involved:

```rust
// src/lib.rs — your app's Rust crate (depends on conductor_ffi)
use conductor_ffi::conductor_register;
use std::sync::Arc;

#[no_mangle]
pub extern "C" fn conductor_app_init() {
    conductor_register("refresh-feed", Arc::new(|_task_id, _data| "success"));
}
```

Enable it with `enableRust: true` (and `rustLibName` to match your crate's `[lib] name`) in the
config plugin. On Android the lib calls `conductor_app_init()` when the `.so` loads; on iOS call
`ConductorRustBridge.appInit()` from your AppDelegate. See the
[package README](packages/expo-conductor/README.md#rust-handlers) for the full crate + build setup,
and `apps/demo/rust/` for a working example.

## API

The default export is a ready-to-use singleton bound to the platform backend (native module on
iOS/Android, Web engine on web). Advanced consumers can construct their own `ConductorClient` with
a custom backend.

```ts
import Conductor from '@drakkar.software/expo-conductor';

// Handler registration
Conductor.defineTask(name, handler)          // register a JS handler (call at module scope!)
Conductor.undefineTask(name)                 // remove a JS handler
Conductor.isTaskDefined(name)                // boolean
Conductor.getDefinedTaskNames()              // string[]

// Scheduling
await Conductor.schedule(def, handler?)      // register handler + task definition
await Conductor.defineTaskDefinition(def)    // register a definition (handler registered separately)
await Conductor.cancelTask(id)
await Conductor.getTasks()                   // RegisteredTask[]
await Conductor.runNow(id)                   // fire immediately, bypassing policy/budget
await Conductor.runDueTasks()                // run all currently-due tasks through the engine; returns count fired

// Runtime control
await Conductor.setResourceBudget(budget)    // { cpu, network, battery, memory } each 0..1
await Conductor.pause()                      // suspend all dispatch
await Conductor.resume()                     // re-arm all tasks
await Conductor.getStatus()                  // 'available' | 'restricted' | 'unsupported'
await Conductor.requestPermissions()         // request notification permission -> boolean

// Execution history (persisted ring buffer, survives termination)
await Conductor.getHistory()                 // TaskExecutionEvent[]  (raw lifecycle events)
await Conductor.clearHistory()               // clear the ring buffer

// Events — payload includes `firedBy?: FiredBy` ('manual' | TriggerType) from v0.4.0
Conductor.addListener('onTaskExecute',  (p) => {})  // { taskId, triggerType, firedBy, firedAt, attempt, data }
Conductor.addListener('onTaskComplete', (p) => {})  // adds: result
Conductor.addListener('onTaskSkipped',  (p) => {})  // { taskId, reason }
Conductor.addListener('onTaskError',    (p) => {})  // adds: error
```

#### `foldHistory` and `reconcile`

```ts
import { foldHistory, reconcile } from '@drakkar.software/expo-conductor';

// Fold raw events into paired records { taskId, firedAt, firedBy, result, durationMs, … }
const records = foldHistory(await Conductor.getHistory());

// Compare expected vs actual — exact for time/recurrence/alarm, advisory for background/push/appState
const tasks = await Conductor.getTasks();
const { matched, missed, unexpected, aborted } = reconcile(tasks, records, {
  now: Date.now(),
  windowMs: 24 * 60 * 60_000,   // look-back window
});
```

Also exported: `expectedOccurrences` (a task's expected fire times), `DEFAULT_TOLERANCE_MS` and
`DEFAULT_WINDOW_MS` (the reconcile match-tolerance / look-back defaults), the `ReconcileResult`,
`ReconcileOptions`, `ExpectedOccurrence` and `MatchedOccurrence` types, and `backend` (the resolved
platform backend, for advanced consumers constructing a custom `ConductorClient`).

## Optional first-party integrations

The core is self-contained. These two opt-in bridges (each behind an optional peer dependency the
core never imports) cover the two places where a dedicated Expo library does the job better.

### Headless JS via `expo-task-manager` / `expo-background-task`

By default a **JS** handler only runs while the app is alive (its registry is in-memory).
To let JS handlers run after the app is **terminated**, opt into the first-party background
task — `expo-task-manager`'s `defineTask` uses a persisted, global registry the OS can
invoke headlessly, and conductor drives its engine from that tick:

```sh
npx expo install expo-task-manager expo-background-task
```

```ts
// app entry — MODULE scope (not inside a component)
import Conductor, { TaskResult } from '@drakkar.software/expo-conductor';
import { registerConductorBackgroundTask } from '@drakkar.software/expo-conductor/task-manager';

Conductor.defineTask('refresh', async () => TaskResult.SUCCESS);
await registerConductorBackgroundTask({ minimumInterval: 15 }); // minutes (Android floor: 15)
```

When this tick fires, conductor runs every currently-due task through its engine
(`Conductor.runDueTasks()`), so priority/weight/policy still apply. `expo-task-manager` /
`expo-background-task` are **optional peer dependencies** — the core works without them, and
the hand-rolled native BGTaskScheduler/WorkManager path remains the default. Both are
verified on a device build (iOS BGTask doesn't run on the Simulator); use
`expo-background-task`'s `triggerTaskWorkerForTestingAsync()` in development to fire the tick
on demand.

### Notifications via `expo-notifications`

`expo-notifications` owns the notification concerns conductor can't do well alone — real
permission prompts (incl. Android 13+ from an Activity), notification channels, foreground
presentation, and **cold-start response handling** (a tap that relaunches a terminated app):

```sh
npx expo install expo-notifications
```

```ts
import { setupConductorNotifications } from '@drakkar.software/expo-conductor/notifications';

await setupConductorNotifications(); // foreground handler + Android channel + response routing
```

A notification whose `content.data.conductorTask` is a task id then runs that task (via
`Conductor.runNow`) when delivered or tapped — including from a cold start, via
`getLastNotificationResponseAsync`. `requestConductorNotificationPermissions()` performs the
real prompt. `expo-notifications` is an **optional peer dependency**; conductor's own
notification display (Android channel + `NotificationManagerCompat`, iOS
`UNUserNotificationCenter`) remains the default when it isn't used.

> Phase 3 is a draft: this wires permissions/channel/foreground/response-routing through
> `expo-notifications`. Having it also *schedule* conductor's notifications (replacing the
> native scheduling) and the on-device validation are a follow-up.

## Permissions

Notification, `time`, and `alarm` triggers surface through the OS notification system, which
requires permission:

- Call `await Conductor.requestPermissions()` before scheduling (iOS prompts via
  `UNUserNotificationCenter`; web prompts via the Notification API).
- On **Android 13+**, `POST_NOTIFICATIONS` is a runtime permission. The module reports the
  current grant state from `requestPermissions()`, but prompting must happen from your
  Activity — request it there (or via `expo-notifications`).
- If you already use **`expo-notifications`**, let it own permission requests and channel
  setup; expo-conductor's notification delegate forwards notifications it doesn't own.

## Push message format

The `push` trigger only matches tasks that declare a `push` trigger with a matching
`matchKey` (a forged message cannot trigger arbitrary tasks). Senders must use:

- **Android (FCM):** a **raw FCM HTTP v1 data-only** message. `data` must be a flat
  string→string map, read in `onMessageReceived`:
  ```json
  { "message": { "token": "<device-token>",
                 "data": { "conductorTask": "<matchKey>" },
                 "android": { "priority": "high" } } }
  ```
  Send it directly to FCM v1 (with a service-account credential) — **not** via the Expo Push
  Service, which wraps custom data in its own envelope so `data.conductorTask` won't be at the
  top level. A `notification` payload is handled by the system tray and won't dispatch.
- **iOS (APNs):** a **silent/background** push (`apns-push-type: background`,
  `apns-priority: 5`) with `conductorTask` as a **top-level peer of `aps`**, and the app must
  have called `registerForRemoteNotifications()` (e.g. via `expo-notifications`):
  ```json
  { "aps": { "content-available": 1 }, "conductorTask": "<matchKey>" }
  ```
  Background push is throttled by iOS (~2–3/hr) and not guaranteed — don't use it for
  time-critical or high-frequency work. The `aps` envelope is stripped before handler `data`.
  Enable the iOS `remote-notification` background mode with `enablePush: true` in the config
  plugin (an APNs-only setup needs no Firebase; `enableFcm: true` implies it).
- A push task that must run while the app is **terminated** needs a **native** handler
  (`handler.type: 'native'`); a JS handler only runs while the app is alive. Treat all push
  `data` as untrusted input.

## Platform support & limitations

- **iOS has no exact-alarm API.** `alarm` triggers fall back to a scheduled local
  notification; exact wall-clock wakeups aren’t guaranteed by the OS.
- **iOS `time`/`alarm` are user-visible:** the only reliable way to wake at a wall-clock
  time on iOS is a local notification, so `time` and `alarm` triggers surface a notification
  banner there. On Android these run as silent WorkManager/alarm jobs. (Only the
  `notification` trigger is intended to be user-visible on both platforms — on Android it
  posts via a `NotificationManagerCompat` channel the module creates automatically.)
- **iOS recurrence is silent:** a `recurrence`-only task (and `background` / `appState` /
  `push`-only tasks) is **never** surfaced as a notification banner on iOS — it is woken
  opportunistically via `BGTaskScheduler` and advanced by the foreground engine while the app
  is alive. Only a `notification` / `time` / `alarm` trigger produces a banner. (Up to 0.2.0,
  every scheduled task posted a banner — recurrence-only tasks included — which appeared as a
  spurious "Task" notification. See the [changelog](packages/expo-conductor/CHANGELOG.md).) If
  you want a recurring *visible* notification, add a `notification` trigger with a `title`.
- **iOS background execution** is opportunistic (BGTaskScheduler decides timing); minimum
  intervals are advisory, and **background tasks do not run on the iOS Simulator** — test
  `background` triggers on a physical device. The BGTask launch handler and notification
  delegate are registered for you via an Expo AppDelegate subscriber.
- **iOS recurrence delivery:** a recurring `notification`/`time` task is re-armed when its
  notification is delivered to a live app or when a background refresh wakes the app. A
  recurrence the user never sees and that never coincides with a background wake may not
  advance on its own — for guaranteed cadence prefer a foregrounded app or a `background`
  trigger, or pair with `expo-notifications` repeating triggers.
- **Constraint enforcement:** `requiresCharging`/`requiresIdle`/`network` are mapped to
  WorkManager constraints on Android (the OS gates the wake), but on iOS (and for
  `minBatteryLevel`, which WorkManager approximates as "battery not low") they are enforced
  by re-checking at dispatch — an ineligible task is skipped and rescheduled rather than
  deferred-until-eligible by the OS.
- **iOS headless execution:** when the app is fully terminated, a **JS** handler cannot run
  (there is no live JS runtime). Use a **native** handler (`handler.type: 'native'`,
  registered with `ExpoConductorModule.registerHandler`) for work that must run while the
  app is killed; JS handlers run when the app is foregrounded/backgrounded but alive.
- **Android exact alarms** use `SCHEDULE_EXACT_ALARM` (added by the plugin when
  `enableExactAlarms` is set — the default); on Android 14+ the user may need to grant it, and
  the module falls back to an inexact allow-while-idle alarm if it isn’t granted. The
  non-revocable `USE_EXACT_ALARM` is **Google-Play-restricted** to alarm-clock/calendar/reminder
  apps and is **not** shipped by default — opt in with the plugin’s `useExactAlarmClock` flag
  only if your app qualifies, or Play may reject the build.
- **`Conductor.getStatus()`** reports whether background execution is permitted
  (`available` / `restricted` / `unsupported`) — e.g. `restricted` when iOS Background App
  Refresh is off or the Android app is background-restricted.
- **Web** runs time/recurrence/notification triggers while the page (or a service worker)
  is alive; true background execution depends on Periodic Background Sync availability.

## Testing

The engine is verified the same way on every platform — the *same* fixtures, three runners:

| Suite | Command | Runs where |
| --- | --- | --- |
| TS engine + orchestration + API (Jest) | `pnpm --filter expo-conductor test` | anywhere with Node |
| Kotlin engine (JUnit, shared fixtures) | `pnpm test:kotlin` | JDK 17+ (CI uses 21) |
| Swift engine (XCTest, shared fixtures) | `pnpm test:swift` | macOS / Swift toolchain |
| Rust glue crate (`conductor_ffi`) | `pnpm test:rust` | Rust toolchain (no NDK) |
| Demo Rust crate (archetype handlers) | `pnpm test:rust:demo` | Rust toolchain (no NDK) |

The Kotlin and Swift engine tests use standalone JVM-Gradle and SwiftPM harnesses, so
they run **without** an Android emulator or Xcode project — they compile only the pure
engine and run the shared fixtures through it. CI ([`.github/workflows/ci.yml`](./.github/workflows/ci.yml))
runs all three. See [`fixtures/README.md`](./fixtures/README.md) for the shared behavior contract.

### Manual testing with the demo app

`apps/demo/` is an Expo app with one section per feature and an in-app event log:

```sh
pnpm install
pnpm --filter expo-conductor build
pnpm --filter demo prebuild           # generate native projects
pnpm --filter demo android            # or: ios / web
```

To exercise OS-level background behavior on a device:

- **Android background task:** `adb shell cmd jobscheduler run -f <your.package.name> <jobId>`
  or force WorkManager via `adb shell am broadcast`. Inspect with
  `adb shell dumpsys jobscheduler`.
- **Android exact alarm:** schedule “Exact alarm in 10s”, lock the device, observe it fire.
  Inspect with `adb shell dumpsys alarm`.
- **iOS background refresh:** run from Xcode, pause in the debugger and call
  `e -l objc -- (void)[[BGTaskScheduler sharedScheduler] _simulateLaunchForTaskWithIdentifier:@"software.drakkar.expoconductor.refresh"]`.
- **Notifications:** schedule “Notification in 5s”, background the app, observe delivery.
- **Push (FCM):** enable FCM in the plugin, send a **raw FCM v1 data-only** message (see
  the Push message format section above — not via the Expo Push Service, which re-wraps data).

## Project layout

`expo-conductor` is developed in a pnpm monorepo:

```
expo-conductor/
├── fixtures/                     # shared cross-platform behavior cases (source of truth)
├── packages/expo-conductor/      # the Expo native module
│   ├── src/                      # TS proxy, types, public API, Web engine + Jest tests
│   ├── android/                  # Kotlin engine + module + triggers (+ JVM test harness)
│   ├── ios/                      # Swift engine + module + triggers (+ SwiftPM/XCTest)
│   └── plugin/                   # config plugin (permissions, manifest, BGTask ids, FCM)
└── apps/demo/                    # Expo app demonstrating every feature
```

## License

MIT
