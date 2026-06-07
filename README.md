# expo-conductor

> Define tasks in an Expo app with rich execution policies and many triggers —
> priority, resource weight, recurrence and constraints — backed by a **native-first**
> engine on Android (Kotlin) and iOS (Swift), with a Web implementation.

`expo-conductor` is an Expo native module that gives you one declarative way to say
*“run this work, with this priority and resource cost, under these conditions, on these
triggers.”* It maps your task definitions onto the right OS scheduler — WorkManager,
AlarmManager, BGTaskScheduler, local notifications, FCM/APNs push — and decides *when*
and *whether* each task runs using a shared, heavily-tested decision engine.

```ts
import Conductor, { Priority, TaskResult } from 'expo-conductor';

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

## Why "native-first"?

The orchestration **engine** — recurrence math, priority ordering, weight-based
admission control and policy evaluation — is implemented natively three times:
**Kotlin**, **Swift** and **TypeScript** (for web). The TS layer on a native platform is a
thin proxy; the decisions are made in the platform language, close to the OS scheduler.

To guarantee these three implementations behave **identically**, they are all verified
against a single language-neutral set of fixtures in [`/fixtures`](./fixtures). Every
platform’s test suite (Jest, JUnit, XCTest) loads the *same* cases:

| Concern | Fixture | TS (Jest) | Kotlin (JUnit) | Swift (XCTest) |
| --- | --- | --- | --- | --- |
| recurrence / schedule | `recurrence.cases.json` | ✅ | ✅ | ✅ |
| priority vs other tasks | `priority.cases.json` | ✅ | ✅ | ✅ |
| task weight / budget | `weight-admission.cases.json` | ✅ | ✅ | ✅ |
| execution policy | `policy.cases.json` | ✅ | ✅ | ✅ |

Time math is integer math on UTC epoch milliseconds (no timezone database involved), and
resource weights use IEEE-754 `double` compared with a strict `<=` — both are bit-for-bit
identical across JVM, Swift and JS, so the three engines agree exactly. (Engines must
compare weights exactly; an epsilon-tolerant `<= budget + 1e-9` would diverge.)

## Monorepo layout

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

## Install

This module is developed in a pnpm monorepo. To use it in your own app:

```sh
npx expo install expo-conductor
```

Then add the config plugin to `app.json`:

```json
{
  "expo": {
    "plugins": [
      ["expo-conductor", { "enableExactAlarms": true, "enableFcm": false }]
    ]
  }
}
```

## Core concepts

### Triggers

A task fires when **any** of its triggers fire. Supported trigger types:

| Trigger | Android | iOS | Web | Notes |
| --- | --- | --- | --- | --- |
| `time` (at / inSeconds) | WorkManager | UNNotification | `setTimeout` | one-shot |
| `recurrence` (interval/daily/weekly/cron) | Periodic WorkManager | BGTaskScheduler + notif | `setInterval` | repeating |
| `notification` | NotificationManagerCompat (auto channel) | UNUserNotificationCenter | timer only (no UI) | user-visible on iOS/Android |
| `alarm` (exact) | AlarmManager (`setExactAndAllowWhileIdle`) | ⚠︎ notification fallback | `setTimeout` | exact wall-clock |
| `background` (deferrable) | WorkManager | BGAppRefreshTask | Periodic Background Sync | OS-optimized |
| `push` (FCM/APNs data message) | FirebaseMessagingService* | APNs remote-notification | — | server-driven |
| `appState` | lifecycle | lifecycle | visibility | fg/bg transitions |

\* FCM requires `enableFcm: true` in the config plugin and a Firebase setup.

### Recurrence

```ts
{ kind: 'interval', everyMs: 900000, anchor?: 0 }
{ kind: 'daily',    hour: 9, minute: 30 }
{ kind: 'weekly',   weekday: 1 /* 0=Sun */, hour: 9, minute: 0 }
{ kind: 'cron',     expression: '30 9 *' /* minute hour dayOfWeek */ }
```

### Priority & resource weight

The engine **orders by priority** (higher first, then earliest-due, then id) and
**admits** tasks greedily against a `ResourceBudget`, deferring (skip-over) any that would
exceed a dimension — this is how a heavy, low-priority task yields to lighter or more
important ones. Admission also accounts for the budget **and count already consumed by
tasks currently running**, and honors each task's `policy.maxConcurrent`, so a task is
deferred when the device is already busy. When a fired task can't be admitted it emits
`onTaskSkipped` with reason `DEFERRED_BY_BUDGET` and is retried shortly (it does not lose
its turn). The admission algorithm is verified across all platforms by the shared fixtures.

Cross-task budgeting is fully realized in the Web engine and within a live native process;
after a headless cold-start the native "running" set starts empty (each OS-triggered task
is admitted against whatever else is running in that process).

```ts
Conductor.setResourceBudget({ cpu: 1, network: 1, battery: 1, memory: 1 });

await Conductor.schedule({
  id: 'thumbnail-gen',
  priority: Priority.LOW,
  weight: { cpu: 0.8, network: 0.1, battery: 0.3, memory: 0.5 },
  triggers: [{ type: 'background' }],
});
```

`weight` accepts a preset (`'light' | 'moderate' | 'heavy'`) or explicit dimensions
(each `0..1`).

### Execution policy & constraints

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
}
```

If a constraint isn’t met when a task fires, it is **skipped** (with a reason emitted on
`onTaskSkipped`) and rescheduled for its next occurrence.

### Task handlers — JS *or* native

A task’s work can run as a **JS handler** or an **app-provided native handler**:

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

## API

```ts
import Conductor from 'expo-conductor';

Conductor.defineTask(name, handler)          // register a JS handler (call at module scope!)
Conductor.undefineTask(name)                 // remove a JS handler
Conductor.isTaskDefined(name)                // is a JS handler registered? -> boolean
Conductor.getDefinedTaskNames()              // names of registered JS handlers -> string[]
await Conductor.schedule(def, handler?)      // register handler + task definition
await Conductor.defineTaskDefinition(def)    // register a definition (handler registered separately)
await Conductor.cancelTask(id)
await Conductor.getTasks()
await Conductor.runNow(id)                    // fire immediately, bypassing policy/budget
await Conductor.setResourceBudget(budget)
await Conductor.pause() / Conductor.resume()
await Conductor.getStatus()                   // 'available' | 'restricted' | 'unsupported'
await Conductor.requestPermissions()          // request notification permission -> boolean granted

Conductor.addListener('onTaskExecute',  (p) => {})
Conductor.addListener('onTaskComplete', (p) => {})  // includes result
Conductor.addListener('onTaskSkipped',  (p) => {})  // includes reason
Conductor.addListener('onTaskError',    (p) => {})
```

## Testing

| Suite | Command | Runs where |
| --- | --- | --- |
| TS engine + orchestration + API (Jest) | `pnpm --filter expo-conductor test` | anywhere with Node |
| Kotlin engine (JUnit, shared fixtures) | `pnpm test:kotlin` | JDK 17+ (CI uses 21) |
| Swift engine (XCTest, shared fixtures) | `pnpm test:swift` | macOS / Swift toolchain |

The Kotlin and Swift engine tests use standalone JVM-Gradle and SwiftPM harnesses, so
they run **without** an Android emulator or Xcode project — they compile only the pure
engine and run the shared fixtures through it. CI ([`.github/workflows/ci.yml`](./.github/workflows/ci.yml))
runs all three.

### Manual testing with the demo app

```sh
pnpm install
pnpm --filter expo-conductor build
pnpm --filter demo prebuild           # generate native projects
pnpm --filter demo android            # or: ios / web
```

The demo has one section per feature with an in-app event log. To exercise OS-level
background behavior on a device:

- **Android background task:** `adb shell cmd jobscheduler run -f <your.package.name> <jobId>`
  or force WorkManager via `adb shell am broadcast`. Inspect with
  `adb shell dumpsys jobscheduler`.
- **Android exact alarm:** schedule “Exact alarm in 10s”, lock the device, observe it fire.
  Inspect with `adb shell dumpsys alarm`.
- **iOS background refresh:** run from Xcode, pause in the debugger and call
  `e -l objc -- (void)[[BGTaskScheduler sharedScheduler] _simulateLaunchForTaskWithIdentifier:@"com.expoconductor.refresh"]`.
- **Notifications:** schedule “Notification in 5s”, background the app, observe delivery.
- **Push (FCM):** enable FCM in the plugin, send a **raw FCM v1 data-only** message (see
  the Push message format section below — not via the Expo Push Service, which re-wraps data).

See [`fixtures/README.md`](./fixtures/README.md) for the shared behavior contract.

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
- **Android exact alarms** require the `SCHEDULE_EXACT_ALARM`/`USE_EXACT_ALARM` permissions
  (added by the plugin when `enableExactAlarms` is set); on Android 14+ the user may need
  to grant them, and the module falls back to an inexact allow-while-idle alarm if the
  permission isn’t granted.
- **`Conductor.getStatus()`** reports whether background execution is permitted
  (`available` / `restricted` / `unsupported`) — e.g. `restricted` when iOS Background App
  Refresh is off or the Android app is background-restricted.
- **Web** runs time/recurrence/notification triggers while the page (or a service worker)
  is alive; true background execution depends on Periodic Background Sync availability.

### Relationship to `expo-background-task` / `expo-task-manager`

expo-conductor implements its own scheduling so it can layer priority, resource-weight
admission, multi-trigger and recurrence semantics on top. For apps that only need a single
periodic background refresh, Expo’s [`expo-background-task`](https://docs.expo.dev/versions/latest/sdk/background-task/)
+ [`expo-task-manager`](https://docs.expo.dev/versions/latest/sdk/task-manager/) may be
simpler. A future direction is to delegate the `background` trigger and headless JS
dispatch to those modules (which already own the BGTask launch-handler and cold-start task
registry) while keeping conductor’s engine for prioritization — see `CLAUDE.md`.

## License

MIT
