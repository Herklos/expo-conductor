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

### 7. System Broadcast Triggers

**What:** Android allows manifest-registered `BroadcastReceiver`s for a curated set of system events that survive Oreo's implicit-broadcast ban. Most useful for expo-conductor:

| Trigger | Broadcast action |
|---|---|
| Charging started | `ACTION_POWER_CONNECTED` |
| Charging stopped | `ACTION_POWER_DISCONNECTED` |
| Bluetooth device connected | `ACTION_ACL_CONNECTED` |
| Bluetooth device disconnected | `ACTION_ACL_DISCONNECTED` |
| USB accessory attached | `ACTION_USB_ACCESSORY_ATTACHED` |
| Clock/timezone changed | `ACTION_TIME_SET`, `ACTION_TIMEZONE_CHANGED` |
| Locale changed | `ACTION_LOCALE_CHANGED` |

**API surface:**
```ts
// New trigger types
{ type: 'charging' }                         // fires on power connect
{ type: 'discharging' }                      // fires on power disconnect
{ type: 'bluetoothDevice', name?: string }   // BT ACL connect
{ type: 'usbDevice' }                        // USB attach
```

**Native work:**

`ConductorSystemReceiver.kt` (new)
- Single `BroadcastReceiver` with a dispatch table from `intent.action` → trigger type
- `onReceive()`: call `goAsync()`, look up matching registered tasks, enqueue WorkManager jobs

`AndroidManifest.xml` (via config plugin)
- `<receiver>` with `<intent-filter>` for each enabled action

**Effort:** ~2–3 h  
**Priority:** P2

---

### 8. Geofence Trigger

**What:** `GeofencingClient.addGeofences()` fires a `PendingIntent` when the device enters or exits a virtual geographic boundary. Runs in the Google Play Services process — no app process needed.

**API surface:**
```ts
{ type: 'geofence', latitude: number, longitude: number, radiusMeters: number,
  on: 'enter' | 'exit' | 'dwell', dwellMs?: number }
```

**Native work:**

`ConductorGeofenceReceiver.kt` (new)
- `BroadcastReceiver` receiving `GeofencingEvent`; extracts geofence ID → task ID, enqueues WorkManager job

`TaskMapper.kt`
- On `schedule()`, call `GeofencingClient.addGeofences()` and persist the geofence ID → task ID mapping
- Re-register on `BOOT_COMPLETED` (geofences are lost on reboot)

**Constraints:** max 100 geofences per app; min ~150m radius; `ACCESS_FINE_LOCATION` + `ACCESS_BACKGROUND_LOCATION` required; does NOT wake force-stopped apps.

**Effort:** ~3–4 h  
**Priority:** P2

---

### 9. Activity Recognition Transitions

**What:** Google Play Services `ActivityRecognitionClient` Transition API fires a `PendingIntent` when the device enters or exits a detected activity state: `IN_VEHICLE`, `ON_BICYCLE`, `RUNNING`, `STILL`, `WALKING`.

**API surface:**
```ts
{ type: 'activityTransition',
  activity: 'still' | 'walking' | 'running' | 'cycling' | 'vehicle',
  on: 'enter' | 'exit' }
```

**Native work:**

`ConductorActivityReceiver.kt` (new)
- `BroadcastReceiver` decoding `ActivityTransitionResult` from the `PendingIntent`
- Maps activity + transition type → task dispatch

`TaskMapper.kt`
- On `schedule()`, call `ActivityRecognitionClient.requestActivityTransitionUpdates()`

**Constraints:** Requires `ACTIVITY_RECOGNITION` permission (Android 10+); depends on Google Play Services; latency seconds–minutes.

**Effort:** ~2–3 h  
**Priority:** P2

---

### 10. BLE Device-Presence Trigger

**What:** `BluetoothLeScanner.startScan(filters, settings, PendingIntent)` wakes the app via `PendingIntent` when a BLE advertisement matching device filters is detected — without keeping the app process alive.

**API surface:**
```ts
{ type: 'bleDevice', serviceUuid?: string, deviceName?: string }
```

**Native work:**

`ConductorBleReceiver.kt` (new)
- `BroadcastReceiver` receiving `BluetoothLeScanner.EXTRA_LIST_SCAN_RESULT`
- Matches scan result → task dispatch

`TaskMapper.kt`
- `BluetoothLeScanner.startScan(filters, settings, pendingIntent)` on schedule; `stopScan` on cancel

**Constraints:** `BLUETOOTH_SCAN` runtime permission (Android 12+); no-op when Bluetooth is off.

**Effort:** ~2–3 h  
**Priority:** P3

---

### 11. ContentUri Job Trigger

**What:** `JobInfo.Builder.addTriggerContentUri()` runs a job whenever a `ContentProvider` URI changes (e.g. `MediaStore.Images.Media.EXTERNAL_CONTENT_URI`, `ContactsContract.Contacts.CONTENT_URI`, or any custom provider).

**API surface:**
```ts
{ type: 'contentUri', uri: string, notifyForDescendants?: boolean }
```

**Native work:**

`TaskMapper.kt`
- Build `JobInfo` with `addTriggerContentUri(...)` instead of the time-based path
- Retrieve `JobParameters.getTriggeredContentUris()` in `ConductorWorker.doWork()`

**Constraints:** Android 7.0+; system batches delivery with a configurable delay.

**Effort:** ~1–2 h  
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

### 12. Significant Location Change Trigger

**What:** `CLLocationManager.startMonitoringSignificantLocationChanges()` delivers a location event (~every 500m of movement or tower change) and wakes a suspended (not force-quit) app in the background.

**API surface:**
```ts
{ type: 'significantLocation' }
```

**Native work:**

`ConductorLocationDelegate.swift` (new)
- `CLLocationManagerDelegate` that calls `Conductor.dispatch(trigger: .significantLocation)` on `locationManager(_:didUpdateLocations:)` when triggered from background

`ConductorAppDelegate.swift`
- Start/stop significant-change monitoring based on registered tasks

`plugin/src/index.ts`
- Add `location` UIBackgroundMode; inject `NSLocationAlwaysAndWhenInUseUsageDescription` if significant-location tasks are registered

**Constraints:** Requires "Always On" location permission; cannot wake force-quit app; low power (cell tower, no GPS).

**Effort:** ~2–3 h  
**Priority:** P2

---

### 13. Region Monitoring (Geofence) Trigger

**What:** `CLLocationManager.startMonitoring(for: CLCircularRegion)` delivers `didEnterRegion`/`didExitRegion` events, waking the suspended app in the background.

**API surface:**
```ts
{ type: 'geofence', latitude: number, longitude: number, radiusMeters: number,
  on: 'enter' | 'exit' }
```

**Native work:**

`ConductorLocationDelegate.swift`
- `locationManager(_:didEnterRegion:)` / `locationManager(_:didExitRegion:)` → dispatch task by region identifier (= task ID)

`ConductorAppDelegate.swift`
- `CLLocationManager.startMonitoring(for: region)` on task schedule; `stopMonitoring` on cancel

**Constraints:** Max 20 regions per app; ~100m minimum radius; "Always On" location permission; cannot wake force-quit app.  
**Shares location delegate with:** #12 above.

**Effort:** ~1–2 h (on top of #12)  
**Priority:** P2

---

### 14. Location Visit Monitoring

**What:** `CLLocationManager.startMonitoringVisits()` delivers a `CLVisit` when the OS detects the user has arrived at or departed from a location where they dwelled.

**API surface:**
```ts
{ type: 'locationVisit', on: 'arrival' | 'departure' | 'both' }
```

**Native work:**

`ConductorLocationDelegate.swift`
- `locationManager(_:didVisit:)` → dispatch; distinguish arrival/departure via `CLVisit.departureDate == .distantFuture`

**Constraints:** "Always On" location permission; lower precision than geofence; no maximum count.  
**Shares location delegate with:** #12, #13.

**Effort:** ~1 h (on top of #12)  
**Priority:** P3

---

### 15. Core Bluetooth State Restoration (BLE Wakeup)

**What:** `CBCentralManager` with `CBCentralManagerOptionRestoreIdentifierKey` preserves BLE scan/connection state across system-kills and re-launches the app when a matching BLE advertisement is found, a GATT connection event occurs, or a subscribed characteristic notifies.

**API surface:**
```ts
{ type: 'bleDevice', serviceUuid?: string, deviceName?: string }
```
*(same shape as Android #10 — cross-platform symmetry)*

**Native work:**

`ConductorBleManager.swift` (new)
- Initialises `CBCentralManager` with restore key at module load
- `centralManager(_:willRestoreState:)` re-activates scans
- `centralManagerDidUpdateState` / `centralManager(_:didDiscover:)` → dispatch matching task

`plugin/src/index.ts`
- Add `bluetooth-central` UIBackgroundMode when BLE tasks are registered

**Constraints:** `NSBluetoothAlwaysUsageDescription`; cannot wake force-quit (user-killed) app; BLE state restoration opt-in required at init time.

**Effort:** ~3–4 h  
**Priority:** P3

---

### 16. URLSession Background Transfer Completion

**What:** A `URLSessionConfiguration.background(withIdentifier:)` download/upload session is managed entirely by iOS. When the transfer completes (even if app is killed), iOS calls `handleEventsForBackgroundURLSession` to re-launch the app.

**API surface:**
```ts
{ type: 'backgroundTransfer', sessionIdentifier: string }
```

**Native work:**

`ConductorAppDelegate.swift`
- Implement `application(_:handleEventsForBackgroundURLSession:completionHandler:)`: look up task by session identifier, dispatch, call completion handler after

`TaskMapper.swift`
- Store `sessionIdentifier → taskId` in persistent storage alongside task registration

**Constraints:** No explicit scheduling — fires on transfer completion. Upload tasks require file URLs, not in-memory data. `isDiscretionary = true` can delay hours.

**Effort:** ~2–3 h  
**Priority:** P3

---

### 17. HealthKit Background Delivery

**What:** `HKObserverQuery` with `HKHealthStore.enableBackgroundDelivery(for:frequency:)` sends a silent notification when HealthKit data of a subscribed type changes, waking the suspended app.

**API surface:**
```ts
{ type: 'healthKitData', dataType: string,
  frequency: 'immediate' | 'hourly' | 'daily' | 'weekly' }
```

**Native work:**

`ConductorHealthKitObserver.swift` (new)
- Register `HKObserverQuery` per task; observer callback enqueues a `BGProcessingTask` for the actual handler work (background delivery gives only ~30s)

`plugin/src/index.ts`
- Add `com.apple.developer.healthkit` + `com.apple.developer.healthkit.background-delivery` entitlements; add `processing` UIBackgroundMode

**Constraints:** Requires HealthKit entitlement + `background-delivery` sub-entitlement; cannot wake force-quit app; heavy data work must be deferred to BGProcessingTask (#4).

**Effort:** ~3–4 h  
**Priority:** P3

---

### 18. BGContinuedProcessingTask (iOS 26+)

**What:** New `BGTaskScheduler` task type from WWDC 2025. Allows a task that was initiated by a user action (button tap) to continue running in the background after the user backgrounds the app. Progress is shown in system UI; user can cancel.

**API surface:**
```ts
{ type: 'userInitiatedBackground' }  // must be called from a user-action handler
```

**Native work:**

`ConductorAppDelegate.swift`
- Register `BGContinuedProcessingTask` identifier in `didFinishLaunching`

New `ConductorBGContinuedHandler.swift`
- Called from a foreground user-action path; suspends into background via `BGContinuedProcessingTaskRequest`

**Constraints:** Must originate from explicit user action — cannot be autonomously scheduled. iOS/iPadOS 26+ only (2025 devices).

**Effort:** ~2–3 h  
**Priority:** P2 (future — target iOS 26)

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

| # | Feature                             | Platform      | Impact                                    | Effort   | Priority |
|---|-------------------------------------|---------------|-------------------------------------------|----------|----------|
| 1 | Foreground Service Worker           | Android       | Long-running, Doze-safe tasks             | 3–4 h    | P1       |
| 4 | BGProcessingTask trigger            | iOS           | 30-min background window                  | 4–5 h    | P1       |
| 5 | APNs → BGProcessingTask chain       | iOS           | Near-real-time background                 | 2 h      | P2       |
| 6 | Recurring notification trigger      | All platforms | Repeating notification-driven cadence     | 3–4 h    | P2       |
| 2 | FCM Doze bypass (foreground svc)    | Android       | Doze-proof FCM tasks                      | 1 h      | P2       |
| 7 | System broadcast triggers           | Android       | Charging/BT/USB/locale event tasks        | 2–3 h    | P2       |
| 8 | Geofence trigger                    | Android       | Location-boundary task firing             | 3–4 h    | P2       |
| 9 | Activity Recognition transitions    | Android       | Motion-state task firing                  | 2–3 h    | P2       |
|12 | Significant Location Change         | iOS           | ~500m-movement background wakeup          | 2–3 h    | P2       |
|13 | Region Monitoring (geofence)        | iOS           | Location-boundary task firing             | 1–2 h    | P2       |
|18 | BGContinuedProcessingTask (iOS 26+) | iOS           | User-initiated long-running background    | 2–3 h    | P2       |
| 3 | Windowed exact alarm                | Android       | Battery-friendly timing                   | 30 min   | P3       |
|10 | BLE device-presence scan            | Android       | BLE advertisement wakeup                  | 2–3 h    | P3       |
|11 | ContentUri job trigger              | Android       | ContentProvider change wakeup             | 1–2 h    | P3       |
|14 | Location Visit Monitoring           | iOS           | Arrival/departure wakeup                  | 1 h      | P3       |
|15 | Core Bluetooth state restoration    | iOS           | BLE advertisement/connection wakeup       | 3–4 h    | P3       |
|16 | URLSession background transfer      | iOS           | Transfer-completion wakeup                | 2–3 h    | P3       |
|17 | HealthKit background delivery       | iOS           | Health-data-change wakeup                 | 3–4 h    | P3       |

Implement #1 and #4 first — they unlock long-running task support which is the
main gap between the current implementation and full production use.

**Android 15 note:** If/when #1 (Foreground Service Worker) is implemented, add
`onTimeout()` handling — `dataSync` FGS type is capped at 6 hours per 24h on
Android 15; exceeding it without calling `stopSelf()` in `onTimeout()` causes an ANR.
