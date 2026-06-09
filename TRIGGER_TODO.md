# Trigger & Execution Backend Roadmap

New trigger types and execution backends to implement. Each entry lists what needs
to change across native code, types, and the config plugin.

---

## Android

### 1. Foreground Service Worker

**What:** `ConductorWorker` promotes itself to a foreground service by calling
`setForegroundAsync(ForegroundInfo(...))` before running the task. While active,
an ongoing notification appears in the status bar. The task gets:
- No 10-minute background CPU limit
- Protection from low-memory killing
- Bypass of battery optimisation

**API surface:**
```ts
// New optional field in ExecutionPolicy
policy?: {
  foreground?: boolean;   // default false — runs as foreground service on Android
  // ...existing fields
}
```

**Native work:**

`ConductorWorker.kt`
- Check `inputData.getBoolean("foreground", false)` at the top of `doWork()`
- If true, call `setForeground(buildForegroundInfo(taskId, title, body))` before
  dispatching; create a `NotificationCompat.Builder` with `ONGOING` flag
- Channel ID: `"conductor_foreground"` (created on first use)

`AndroidManifest.xml` (via config plugin)
- `<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />`
- `<uses-permission android:name="android.permission.FOREGROUND_SERVICE_DATA_SYNC" />` (API 34+)
- Declare the worker service with `android:foregroundServiceType="dataSync"`

`plugin/src/index.ts`
- Inject permissions and service declaration when `enableForegroundService: true`
  is set in the plugin config

`TaskMapper.kt`
- Pass `policy.foreground` through to `ConductorWorker.inputData`

**Effort:** ~3–4 h  
**Priority:** P1

---

### 2. Doze-mode High-Priority FCM Bypass

**What:** FCM high-priority messages bypass Doze mode entirely. Extend
`ConductorFcmService` so that when the matched task has `policy.foreground: true`,
it starts a foreground service directly instead of enqueuing a WorkManager job.
This ensures the task fires immediately regardless of Doze state.

**Native work:**

`ConductorFcmService.kt`
- After matching the task, check `TaskMapper.isForeground(task)`
- If true, start a `ForegroundServiceTaskRunner` via `startForegroundService()`
  instead of `WorkManager.enqueueUniqueWork()`

New `ForegroundServiceTaskRunner.kt`
- `IntentService` subclass: calls `ExpoConductorModule.dispatchHeadless()` then
  stops itself

**Effort:** ~1 h (requires FCM already wired)  
**Depends on:** Foreground Service Worker (#1)  
**Priority:** P2

---

### 3. Windowed Exact Alarm

**What:** `setWindow(triggerAtMs, windowLengthMs, pendingIntent)` is less precise
than `setExact` but gentler on battery. Useful when "fire within the next 5 minutes
of this time" is acceptable.

**API surface:**
```ts
interface AlarmTrigger {
  type: 'alarm';
  at: number;
  allowWhileIdle?: boolean;
  windowMs?: number;   // NEW — if set, uses setWindow instead of setExact
}
```

**Native work:**

`ConductorAlarmReceiver.kt`
- In `schedule()`, if `windowMs > 0` use `alarmManager.setWindow(...)` instead of
  `setExact` / `setExactAndAllowWhileIdle`

**Effort:** ~30 min  
**Priority:** P3

---

## iOS

### 4. BGProcessingTask Trigger

**What:** `BGProcessingTask` is a separate BGTaskScheduler task type that allows
up to ~30 minutes of CPU + network time — far more than `BGAppRefreshTask`
(used by the current `background` trigger, capped at ~30 s). Right tool for heavy
one-off sync, ML inference, on-device indexing, large uploads.

**API surface:**
```ts
interface BackgroundTaskTrigger {
  type: 'background';
  minimumIntervalMinutes?: number;
  bgProcessing?: boolean;   // NEW — registers as BGProcessingTask; allows 30 min
  requiresNetwork?: boolean;
  requiresCharging?: boolean;
}
```

**Native work:**

`ConductorAppDelegate.swift`
- Register the BGProcessingTask identifier alongside the existing BGAppRefreshTask:
  ```swift
  BGTaskScheduler.shared.register(
    forTaskWithIdentifier: "\(bundleId).conductor.processing",
    using: nil
  ) { task in ConductorBGProcessingHandler.handle(task as! BGProcessingTask) }
  ```
- Must be called before `application(_:didFinishLaunchingWithOptions:)` returns

New `ConductorBGProcessingHandler.swift`
- Mirrors `ConductorBGAppRefreshHandler` but uses `BGProcessingTaskRequest`
- Sets `requiresNetworkConnectivity` / `requiresExternalPower` from task policy
- Calls `Conductor.runDueTasksAsync()` then schedules the next occurrence

`ios/Package.swift` + test target
- Add fixture test cases for the 30-min window behaviour

`plugin/src/index.ts`
- Append the processing task identifier to `BGTaskSchedulerPermittedIdentifiers`
  in `Info.plist` when any registered task has `bgProcessing: true`

**Effort:** ~4–5 h  
**Priority:** P1

---

### 5. Silent APNs Push → BGProcessingTask Chain

**What:** An APNs push with `content-available: 1` and no visible alert wakes the
app silently in the background. Extend `NotificationDelegate` to detect this and
immediately submit a `BGProcessingTaskRequest` with `earliestBeginDate = .now`, so
the task runs as soon as the OS allows — giving near-real-time background execution
without maintaining a persistent connection.

**API surface:** No new fields needed. If a task has `triggers: [{ type: 'push', matchKey: '...' }]` and `bgProcessing: true`, the push both matches the task AND
schedules the BGProcessingTask.

**Native work:**

`ConductorAppDelegate.swift` (NotificationDelegate path)
- In `userNotificationCenter(_:didReceive:)`, detect `content-available: 1` with
  no `alert`
- Match to a registered task via `matchKey`
- If the task has `bgProcessing: true`, call
  `BGTaskScheduler.shared.submit(BGProcessingTaskRequest(...))`

**Effort:** ~2 h  
**Depends on:** BGProcessingTask (#4)  
**Priority:** P2

---

## Cross-platform

### 6. Recurring Notification Trigger

**What:** Today a `notification` trigger is strictly one-shot — the `inSeconds`/`at`
offset is resolved to a fixed timestamp at registration, and `futureTriggers()` drops
it after delivery. To fire repeatedly via notification delivery, users must currently
pair a `notification` trigger with a `recurrence` trigger, which fires a timer rather
than a notification.

Goal: let a `notification` trigger self-reschedule by re-computing `now + inSeconds`
after each delivery and posting a new local notification to the OS.

**API surface:**
```ts
interface NotificationTrigger {
  type: 'notification';
  title: string;
  body?: string;
  inSeconds?: number;   // existing
  at?: number;          // existing
  runInBackground?: boolean;
  recurring?: boolean;  // NEW — re-schedules itself after each delivery
}
```

When `recurring: true` and `inSeconds` is set, the engine re-schedules a new
notification with the same `inSeconds` offset after each fire, effectively creating
a repeating notification-driven cadence.

**Web engine work:**

`normalize.ts` / `computeNextRunAt`
- When `trigger.recurring && trigger.inSeconds != null`, treat the trigger as
  recurrent: re-derive `nextRunAt = now + inSeconds * 1000` in `reschedule()`
  instead of dropping it via `futureTriggers()`

`WebSchedulerEngine.ts` — `futureTriggers()`
- Preserve recurring notification triggers regardless of their `at` value so
  `reschedule()` can recompute the next fire time

**Native work:**

Android — `ConductorNotificationReceiver.kt`
- After the notification fires and `dispatch()` completes, if the task's notification
  trigger has `recurring: true`, re-schedule a new `AlarmManager` exact alarm for
  `now + inSeconds * 1000` and post a new `NotificationCompat` notification for it

iOS — `ConductorAppDelegate.swift` (NotificationDelegate path)
- After `didReceive` dispatches the task, if `recurring: true`, call
  `UNUserNotificationCenter.add(UNNotificationRequest(...))` with a new
  `UNTimeIntervalNotificationTrigger(timeInterval: inSeconds, repeats: false)`
  (set `repeats: false` and re-arm manually so the recurrence interval is
  re-evaluated each time, consistent with the engine)

**Fixture work:**
- Add `recurring-notification.cases.json` (or extend `recurrence.cases.json`) to
  cover the re-arm timing and cross-platform identity

**Effort:** ~3–4 h (web: ~1 h; Android: ~1–1.5 h; iOS: ~1–1.5 h)  
**Priority:** P2

---

## Priority summary

| # | Feature                          | Platform      | Impact                          | Effort | Priority |
|---|----------------------------------|---------------|---------------------------------|--------|----------|
| 1 | Foreground Service Worker        | Android       | Long-running, Doze-safe tasks   | 3–4 h  | P1       |
| 4 | BGProcessingTask trigger         | iOS           | 30-min background window        | 4–5 h  | P1       |
| 5 | APNs → BGProcessingTask chain    | iOS           | Near-real-time background       | 2 h    | P2       |
| 6 | Recurring notification trigger   | All platforms | Repeating notification-driven cadence | 3–4 h | P2 |
| 2 | FCM Doze bypass (foreground svc) | Android       | Doze-proof FCM tasks            | 1 h    | P2       |
| 3 | Windowed exact alarm             | Android       | Battery-friendly timing         | 30 min | P3       |

Implement #1 and #4 first — they unlock long-running task support which is the
main gap between the current implementation and full production use.
