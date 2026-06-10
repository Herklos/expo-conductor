# Implementation plan — §3 Phase 2 & Phase 3

**Status:** design (2026-06-10). Source: a 5-reader research fan-out over the 0.4.0 native code +
the SDK 56 capability envelopes of `expo-background-task` / `expo-notifications`, synthesized by an
architect pass. This is the plan referenced by `TODO.md` §3.

## TL;DR

Both phases are **opt-in, backward-compatible, native-stays-in-charge** swaps — NOT wholesale
replacements:

- **Phase 2** routes *only* the deferrable periodic poll through `expo-background-task`'s single
  managed tick when an app opts in. Exact alarms, one-shot/expedited work, push, BGProcessing,
  BGContinued, foreground-service, and the notification wall-clock wake **stay native** — the
  package is too coarse (~15-min, OS-timed) to carry them.
- **Phase 3** lets `expo-notifications` own the notification *surface* (permissions, channels,
  foreground presentation, optionally scheduling) while the **native delegate remains the sole
  dispatcher** — because only it sees the OS-set trigger class that makes the push security gate
  (#12/#14) unforgeable.

Guiding rule (unchanged from CLAUDE.md): **the core module never imports the integrations.** Both
phases are gated behind config-plugin flags defaulting to `false`; flag off ⇒ byte-for-byte today.

---

## Step 0 — Shared scaffolding (land first, as no-ops)

> **Do NOT add a literal `compileOnly expo-background-task` / `expo-notifications` dependency.** The
> transferable part of the FCM-gate precedent is the **gradle-property / Info.plist flag + conditional
> arming** pattern, NOT the `compileOnly` Maven dep. These are autolinked Expo modules; weak-linking
> them into the core native module would violate "core never imports integrations." The native
> scheduler stays fully self-contained; the **opt-in JS integration + a flag** is the only override.

1. **Two config-plugin flags** in `plugin/src/index.ts` (`ConductorPluginOptions`), both default
   `false` — backward compat is the default:
   - `delegateBackgroundTask?: boolean`
   - `delegateNotifications?: boolean`

   Two flags, not one (**KD-1**): background-poll delegation and notification-surface delegation are
   independent — an app may want `expo-notifications` for permissions/channels while keeping the
   native BGTask/WorkManager poll (which preserves exact/processing cadence + per-task constraints).

2. **Plumb each flag to native**, mirroring the existing `enableFcm` plumbing
   (`plugin/src/index.ts:105-133`):
   - **Android:** emit `expo.conductor.delegateBackgroundTask` / `…delegateNotifications` gradle
     properties; read via `findProperty(...)` in `android/build.gradle` into `BuildConfig` booleans.
   - **iOS:** no gradle equivalent — write a custom Info.plist key (e.g. `ConductorDelegateBackgroundTask`)
     via `withInfoPlist`, read in Swift with `Bundle.main.object(forInfoDictionaryKey:)`.

3. **Conditional arming — gate the SUBMISSION, never the REGISTRATION** (load-bearing):
   - iOS: suppress only the `scheduleRefresh` BGAppRefreshTask **submission**; `registerLaunchHandlers`
     (all three identifiers) STILL runs — BGProcessing/BGContinued require pre-launch registration.
   - Android: gate only the `recurrence → PeriodicWorkRequest` branch (`ExpoConductorModule.kt:224-232`).
     Alarm, one-time/expedited, FGS, FCM, boot, push stay armed.
   - Notifications: do NOT gate `ConductorNotificationDelegate.install()` off (security — see Phase 3);
     `delegateNotifications` instead disables the integration's JS `runNow`-from-response routing.

4. **Peer-dep bookkeeping is already done** — `peerDependencies` + `peerDependenciesMeta.optional` +
   `devDependencies` exist for all three (`package.json:77-94`), and the `./task-manager` /
   `./notifications` exports exist. Reuse them. Add a `files` allowlist entry only if a phase adds a
   NEW native source directory (none planned — all changes are conditionals inside existing files).

5. **Idempotency backstop:** the engine's `nextRunAt` due-gate (`ExpoConductorModule.kt:290-294` /
   `.swift:293-296`) is the no-op-the-loser guard if a native wake and the tick ever both fire in one
   window. Handlers are already required idempotent. This makes the gating robust to OEM/timing quirks.

**Verify Step 0:** build + behavior byte-for-byte identical to today, all existing flows fire.

---

## Phase 2 — Headless deferrable poll via `expo-background-task`

**Goal:** when opted in, let `expo-background-task`'s single managed tick be the **sole** driver of
the deferrable periodic poll (so JS handlers survive a headless cold start), without double-firing
against conductor's own native poll. A NARROW swap of one branch per platform.

### What MOVES (the only candidate)
- **Android:** the recurrence-driven `PeriodicWorkRequestBuilder<ConductorWorker>` arming
  (`ExpoConductorModule.kt:224-232`, `enqueueUniquePeriodicWork`) — the *only* WorkManager-periodic
  source. `minimumIntervalMs` collapses into the single `expo-conductor.tick`'s `minimumInterval`.
- **iOS:** only the **submission** of the `BGAppRefreshTask` "refresh" identifier
  (`Schedulers.swift scheduleRefresh`) — NOT the launch-handler registration.
- Both already have the JS half built: `src/integrations/expoBackgroundTask.ts` registers
  `defineTask('expo-conductor.tick')` → `Conductor.runDueTasks()` → `backend.runDueTasksAsync()`.
  Phase 2's native work is to make the native poll **stand down** so the tick is the single driver.

### What STAYS native (always armed, regardless of the flag)
- **Android:** exact alarms (`ConductorAlarmReceiver`, `setExact*`/`setWindow`), one-time/delayed +
  expedited WorkManager (`:234-247`), FGS promotion (`ConductorWorker.setForeground`, `DATA_SYNC`),
  FCM (`ConductorMessagingService`), `BootReceiver` alarm re-arm, per-task `workConstraints()`.
- **iOS:** `BGProcessingTask` (~30-min window) + the silent-APNs→BGProcessing chain,
  `BGContinuedProcessingTask` (iOS 26+), the local-notification wall-clock wake, the
  `UNUserNotificationCenter` delegate + its OS-trigger-class security gate, the APNs `push` path.
- **CRITICAL:** iOS `registerLaunchHandlers` must STILL run at `didFinishLaunching` for ALL THREE
  identifiers. Only suppress the `scheduleRefresh` submission.

### Sequenced steps
1. Land Step 0 scaffolding (flag = no-op). Prove backward compat.
2. **Android gate:** wrap ONLY the `recurrence != null` periodic branch (`:224-232`) in
   `if (!BuildConfig.CONDUCTOR_DELEGATE_BG)`. On first delegating launch, cancel any stale
   `enqueueUniquePeriodicWork` from a prior non-delegating install (avoid an orphan worker
   double-firing alongside the tick).
3. **Pure-background drain (KD-2):** the tick calls `runDueTasksAsync`, which EXCLUDES `nil`-nextRunAt
   (pure `background`-only) tasks; only native `runDueBackgroundTasks` includes them. Add
   `runDueBackgroundTasksAsync` to `ConductorBackend` (+ `Conductor.ts`, both natives) and have the
   tick call it — otherwise pure-background tasks silently never fire once the native refresh stands
   down. (This also closes a pre-existing parity gap: a `background`-only task schedules nothing on
   all three engines today.)
4. **iOS gate:** read the Info.plist flag in `ConductorAppDelegate`/`Schedulers`; suppress ONLY the
   `scheduleRefresh` submission. `registerLaunchHandlers` still runs.
5. **Status passthrough (optional):** back `getStatusAsync` with `BackgroundTask.getStatusAsync()`
   (Available/Restricted) in the integration; native default when not delegating.
6. **Docs:** opting in trades exact/per-task cadence, per-task OS constraints, the BGProcessing
   window, and FGS for a single coarse (≥15-min, OS-discretion) poll.

### Verify
Flag OFF: identical to today. Flag ON: a recurring task fires exactly once per due window (nextRunAt
gate is the backstop) and the native periodic worker / BGAppRefresh submission is absent. Android
verifiable on emulator (WorkManager debug). **iOS only on a physical device** (Simulator no-ops
`expo-background-task`); use the BGTask LLDB `_simulateLaunchForTaskWithIdentifier` hook. Confirm
exact-alarm / notification / push tasks still fire while delegating.

---

## Phase 3 — Notification surface via `expo-notifications`

**Goal:** when opted in, delegate the notification *surface* (permission prompts, Android channels,
foreground presentation, optionally scheduling + rich content) to `expo-notifications`, while the
**native delegate remains the sole dispatcher** so the unforgeable security gate is preserved.
Permission/channel/foreground/cold-start routing is ALREADY in `expoNotifications.ts`; this phase
decides ownership and (optionally) adds scheduling.

### Resolved contradiction (security, **KD-4**)
Two research findings conflicted: one said gate `ConductorNotificationDelegate.install()` OFF; the
other said it MUST stay the dispatcher. **Resolution: the native delegate stays the sole dispatcher.**
Only the native delegate sees the OS-set trigger *class* (`UNPushNotificationTrigger` ⇒ remote ⇒
forwarded, never dispatched). A JS listener sees only `content.data` and CANNOT distinguish a forged
remote alert carrying `conductorTask` from an app-scheduled local one — routing by
`content.data.conductorTask` in JS is an **arbitrary-task-fire vulnerability**. So in delegated mode
the integration must NOT call `Conductor.runNow` from `addNotificationResponseReceivedListener` /
`getLastNotificationResponseAsync` (`expoNotifications.ts:42-46,73,76`).

### What the integration OWNS when `delegateNotifications` is on
- Permission prompts (incl. Android 13+ from an Activity), the single Android channel,
  `setNotificationHandler` foreground presentation. Net wins `expo-notifications` does better.
- **(Optional, KD-5) Scheduling:** post the wall-clock notification via
  `Notifications.scheduleNotificationAsync({ identifier: taskId, content: { title, body,
  data: { conductorTask, conductorLocal: true } }, trigger: { type: DATE, date: fireAtMs } })`,
  mirroring the native `UNTimeIntervalNotificationTrigger` request **byte-for-byte** (same id +
  userInfo) so the EXISTING native delegate dispatches it transparently. The engine still owns
  timing (re-arm one one-shot per fire), so the iOS ~64-pending cap is bounded by task count.

### What STAYS native (always)
- The engine math + `computeNextRunAt`/`advanceRecurrence` (expo-notifications repeats can't express
  daily/weekly/cron+tz).
- `NotificationPolicy.visibleNotificationTrigger` as the SOLE arbiter of which tasks get a banner
  (preserves the "no spurious Task banner" invariant).
- `ConductorNotificationDelegate` dispatch + OS-trigger-class gate + the `identifier#deliveryTimeMs`
  dedup. The APNs/FCM `push` matchKey path. The silent BGTask/AlarmManager/WorkManager wakes.

### Sequenced steps
1. Land the `delegateNotifications` flag (Step 0), default `false`.
2. **Decide scope (KD-5).** Presentation-only: gate OFF the integration's JS dispatch routing (so the
   native delegate isn't shadowed by a double `runNow`), keep its permission/channel/foreground setup,
   ship. Low-risk; most value already built.
3. **If adding JS scheduling:** add a native skip flag so `schedule()`/`advanceRecurrence` SKIP their
   own `NotificationScheduler.schedule` when the integration owns it (avoid double-schedule); have the
   integration create the identical UN request. Verify on-device that `expo-notifications` surfaces
   `conductorTask`/`conductorLocal` where native `handle()` reads them (top-level userInfo vs nested
   `content.data`) — the fragile data seam.
4. **Android channel single source of truth (KD-6):** reconcile `NotificationDisplay` channel, the FGS
   channel (`conductor_foreground`), and `CONDUCTOR_CHANNEL_ID` (`expo-conductor`). Standardize the
   user-visible task channel on the integration's `CONDUCTOR_CHANNEL_ID` when delegating; route
   `NotificationDisplay.show` through the integration's `presentNotificationAsync`. Keep the FGS
   channel separate (different purpose).
5. **Tests:** Jest for the integration scheduler (mock `expo-notifications`) asserting
   `identifier`/`content.data`/`trigger`. No `/fixtures` case (presentation glue, like
   `NotificationPolicy`, which has no Kotlin mirror).

### Verify
Flag OFF: identical. Flag ON: a single tap/delivery runs the task EXACTLY ONCE (native delegate only —
confirm the JS listener does not also `runNow`); a forged remote push carrying
`content.data.conductorTask` does NOT fire a task; cold-start tap runs once; channel/permission behave
as configured; iOS pending count ≈ task count.

---

## Key decisions

| # | Question | Recommendation |
|---|----------|----------------|
| **KD-1** | One delegation flag or two? | **Two** — background-poll and notification-surface delegation are independent. |
| **KD-2** | How do pure-background tasks fire once the native poll stands down? | Add `runDueBackgroundTasksAsync` and have the tick call it (also fixes a pre-existing parity gap). |
| **KD-3** | Android: all-or-nothing gate, or hybrid keeping native WorkManager for constrained tasks? | **All-or-nothing**, feature loss documented. Constrained/per-cadence apps keep the flag off. |
| **KD-4** | Who dispatches when `delegateNotifications` is on? | **Native delegate** (only it has the unforgeable OS-trigger-class gate). Overrides the "gate the delegate off" research step on security grounds. |
| **KD-5** | Phase 3: presentation-only, or also take over scheduling? | Start **presentation-only** (low-risk, mostly built). Add JS scheduling only if **rich content** (categories/actions/attachments) is an explicit product goal. |
| **KD-6** | Which Android channel is canonical when delegating? | The integration's `CONDUCTOR_CHANNEL_ID`; keep the FGS channel separate; document the id. |

## Risks

| Severity | Risk | Mitigation |
|----------|------|------------|
| **HIGH** | Pure-background tasks silently stop firing when the native poll is gated off (the tick's `runDueTasksAsync` excludes them). Passes tests, fails on device. | Resolve KD-2 before shipping; on-device test a background-only task under the flag. |
| **HIGH** | Security regression if Phase 3 moves dispatch to the JS listener — a forged remote push with `content.data.conductorTask` fires an arbitrary task. | Native delegate stays SOLE dispatcher (KD-4); disable integration `runNow`-from-response in delegated mode; on-device test a forged push. |
| **HIGH** | Gating the iOS launch-handler *registration* (not just submission) off breaks BGProcessing/BGContinued (must be registered pre-launch; throws if submitted unregistered). | Gate only the `scheduleRefresh` submission; always `registerLaunchHandlers` for all three. Mirror on Android (gate only the periodic branch). |
| **HIGH** | Double-fire: native arming not gated off while the tick is active → recurrence runs twice; both delegate + JS listener route a tap → task runs twice. | Flag suppresses the corresponding native arming/routing; `nextRunAt` gate is the backstop; cancel stale `enqueueUniquePeriodicWork` on first delegating launch. |
| **MED** | iOS delegate-slot race: conductor installs its UN delegate at `didFinishLaunching`; expo-notifications installs a global delegate later (last-writer-wins). | Conductor's delegate chains (`previousDelegate`). Verify on-device whether expo-notifications chains or clobbers; re-assert if needed. |
| **MED** | Data-key seam: native `handle()` reads top-level `userInfo.conductorTask`; expo-notifications nests under `content.data`. Mismatch → silent no-op. | If KD-5 = JS scheduling, verify on-device the keys surface at top-level userInfo; else keep native scheduling. |
| **MED** | Two BGTaskScheduler budgets compete (conductor refresh/processing + expo-background-task) → either fires less often. | When delegating, conductor's refresh stands down (only processing/continued remain native). Measure real-device wake frequency. |
| **MED** | Silent feature loss on opt-in: drops bgProcessing window, requiresNetwork/Charging, exact timing, per-task cadence/constraints, FGS — no error. | Document in the flag docs + CHANGELOG (opt-in/backward-compatible framing). |
| **LOW** | iOS Simulator + fixture harnesses can't catch Phase 2 regressions (BGTask no-ops on Simulator; timing is OS-discretionary). | Physical-device sign-off required; use the LLDB `_simulateLaunchForTaskWithIdentifier` hook. |
| **LOW** | iOS 64-pending cap if recurrence ever fans into many pending notifications. | Keep re-arming exactly ONE one-shot per task per fire; `NotificationPolicy` excludes recurrence-only tasks. |

## Recommended sequencing

Incremental, each step on-device-verifiable, **backward compat proven first**.

- **Step 0 — Scaffolding as no-ops.** Two flags default false, plumbed to native, reading them changes
  nothing. Verify byte-for-byte parity with today. (Backward-compat proof.)
- **Step 1 — Phase 2 Android** (most verifiable). Gate the recurrence→PeriodicWorkRequest branch;
  resolve KD-2. Verify on emulator with WorkManager debug: flag off → native worker present; flag on →
  no native worker, the tick drives recurrence, a recurring AND a background-only task each fire once
  per window; exact-alarm/notification tasks still fire.
- **Step 2 — Phase 2 iOS** (physical device only). Suppress only the `scheduleRefresh` submission;
  `registerLaunchHandlers` still registers all three. Verify via the LLDB hook; confirm
  BGProcessing/BGContinued/notification/push still work and no double-fire. Measure wake frequency.
- **Step 3 — Phase 3 presentation-only.** Keep native delegate as sole dispatcher; disable the
  integration's JS `runNow`-from-response; let the integration own permissions/channel/foreground.
  Verify: flag off → identical; flag on → single tap/delivery runs once, a forged remote push does NOT
  fire, cold-start tap runs once.
- **Step 4 — Phase 3 JS scheduling + rich content** (only if KD-5 = b). Integration creates a UN
  request byte-identical to native; native scheduling skips when delegating. Verify the data seam, no
  double-schedule, pending count ≈ task count, and that categories/actions render.

**The on-device contract at every step:** flag OFF ⇒ identical to today; flag ON ⇒ single fire (no
double-dispatch), `nextRunAt` gate as backstop, and all must-stay-native paths (exact alarm,
notification wall-clock wake, push, BGProcessing, BGContinued, FGS) still fire.

> **Non-blocking open item** (orthogonal to scope): whether a `background`-only task is *intended* to
> fire at all — it schedules nothing on all three engines today. KD-2's drain method is the natural
> place to close that pre-existing parity gap.
