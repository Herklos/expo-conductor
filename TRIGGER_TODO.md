# Trigger & Execution Backend Roadmap

New trigger types and execution backends to implement. Each entry lists what needs
to change across native code, types, and the config plugin.

---

## ✅ Shipped in v0.4.0

These former roadmap items are now implemented and released — see the
[CHANGELOG](packages/expo-conductor/CHANGELOG.md):

- **#3 Windowed exact alarm** — `AlarmTrigger.windowMs` → `AlarmManager.setWindow`.
- **#5 Silent APNs → BGProcessingTask chain** — a silent push with `bgProcessing: true` submits a
  `BGProcessingTaskRequest`.
- **#6 Recurring notification trigger** — `NotificationTrigger.recurring` re-arms after each delivery.
- **#18 BGContinuedProcessingTask (iOS 26+)** — `type: 'userInitiatedBackground'`.
- **#2 (partial) foreground-service promotion** — `policy.foreground: true` promotes a `ConductorWorker`
  WorkManager job to a foreground service via `setForeground(...)` (needs `enableForegroundService`).
  The originally-scoped *FCM-message-path direct* foreground-service start was **not** built — the FCM
  receive path dispatches normally (see #2 below).

---

## Priority summary

| # | Feature                             | Platform      | Impact                                    | Effort   | Priority |
|---|-------------------------------------|---------------|-------------------------------------------|----------|----------|
| 2 | FCM push-path foreground start¹     | Android       | Doze-proof FCM tasks (remainder)          | 1 h      | P3       |
| 7 | System broadcast triggers           | Android       | Charging/BT/USB/locale event tasks        | 2–3 h    | P3       |
| 8 | Geofence trigger                    | Android       | Location-boundary task firing             | 3–4 h    | P3       |
| 9 | Activity Recognition transitions    | Android       | Motion-state task firing                  | 2–3 h    | P3       |
|10 | BLE device-presence scan            | Android       | BLE advertisement wakeup                  | 2–3 h    | P3       |
|11 | ContentUri job trigger              | Android       | ContentProvider change wakeup             | 1–2 h    | P3       |
|12 | Significant Location Change         | iOS           | ~500m-movement background wakeup          | 2–3 h    | P3       |
|13 | Region Monitoring (geofence)        | iOS           | Location-boundary task firing             | 1–2 h    | P3       |
|14 | Location Visit Monitoring           | iOS           | Arrival/departure wakeup                  | 1 h      | P3       |
|15 | Core Bluetooth state restoration    | iOS           | BLE advertisement/connection wakeup       | 3–4 h    | P3       |
|16 | URLSession background transfer      | iOS           | Transfer-completion wakeup                | 2–3 h    | P3       |
|17 | HealthKit background delivery       | iOS           | Health-data-change wakeup                 | 3–4 h    | P3       |

¹ Foreground-service *promotion* for `policy.foreground` tasks already shipped in v0.4.0 (via
WorkManager `setForeground`). Only the optional FCM-receive-path *direct* foreground-service start
remains — low value, since WorkManager-promoted tasks already bypass Doze.

---

## Android

### 2. Doze-mode High-Priority FCM Bypass

**Status (v0.4.0):** *Foreground-service promotion is shipped.* A task with `policy.foreground: true`
runs as a `ConductorWorker` WorkManager job that promotes itself to a foreground service via
`setForeground(ForegroundInfo)` (dataSync), exempt from Doze while it runs. Enable with
`enableForegroundService: true` (adds the `FOREGROUND_SERVICE` permissions; WorkManager supplies the
service, so no app-declared `<service>` is needed). The real FCM service class is
`ConductorMessagingService` — there is no `ConductorFcmService` / `ConductorForegroundService`.

**Remaining (optional, P3):** have the FCM *receive* path
(`ConductorMessagingService.handleRemoteData`) start a foreground service *directly* on receipt
instead of dispatching in-process, for push-woken tasks that don't run through `ConductorWorker`.
Low value — WorkManager-promoted tasks already bypass Doze — so deferred.

---

### 3. Windowed Exact Alarm

✅ **Shipped in v0.4.0.** `AlarmTrigger.windowMs` → `AlarmManager.setWindow` in
`ConductorAlarmReceiver.schedule()`. See the [CHANGELOG](packages/expo-conductor/CHANGELOG.md).

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
**Priority:** P3

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
**Priority:** P3

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
**Priority:** P3

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

### 5. Silent APNs Push → BGProcessingTask Chain

✅ **Shipped in v0.4.0.** A silent push (`content-available: 1`, no alert) matching a `push` trigger
with `bgProcessing: true` submits a `BGProcessingTaskRequest`. Implemented in
`ConductorAppDelegate.swift` on the `application(_:didReceiveRemoteNotification:)` path (not the
`didReceive` display path). See the [CHANGELOG](packages/expo-conductor/CHANGELOG.md).

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
**Priority:** P3

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
**Priority:** P3

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

✅ **Shipped in v0.4.0.** `ContinuedProcessingTrigger` (`type: 'userInitiatedBackground'`); the
`software.drakkar.expoconductor.continued` identifier is registered in `Schedulers.swift` and the
config plugin permits it. Must originate from a user action; iOS 26+ only. See the
[CHANGELOG](packages/expo-conductor/CHANGELOG.md).

---

## Cross-platform

### 6. Recurring Notification Trigger

✅ **Shipped in v0.4.0.** `NotificationTrigger.recurring?: boolean` — when `true` and `inSeconds` is
set, the engine re-derives `now + inSeconds * 1000` and re-arms after each delivery (re-arm logic in
`TaskMapper` on each platform; clock drift does not accumulate). See the
[CHANGELOG](packages/expo-conductor/CHANGELOG.md).

