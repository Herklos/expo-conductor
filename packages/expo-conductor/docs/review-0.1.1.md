<!-- Generated 2026-06-08 by a multi-agent static review (Claude Code workflow conductor-0.1.1-review):
     7 review dimensions -> each finding adversarially verified by 3 diverse-lens skeptics -> completeness critic -> synthesis.
     63 subagents, ~2.5M tokens. The native glue was NOT compiled (no Android SDK / no CocoaPods+Expo-app context here),
     so this is a STATIC review: it substitutes for, and does not replace, the TODO.md section 1 native builds.
     Machine-readable confirmed findings live in review-0.1.1-findings.json next to this file. -->

# expo-conductor 0.1.1 — Post-Fix Synthesis Report

## Executive verdict: `serious-issues`

The release has two layers in very different shape:

- **Shared engine (recurrence / priority / weight / policy math) — SOUND.** Verified green on all three platforms (TS Jest, Swift `swift test`, Kotlin JVM harness, per `TODO.md` lines 27–34). **None** of the 18 confirmed findings break the fixture-validated engine math.
- **Native glue (module / delegate / trigger code) — SERIOUS-ISSUES, and uncompiled** (`TODO.md` §1). It carries **2 critical** and **9 high** findings.

### What MUST be fixed before the §1 native builds "go green" — two levels

**To COMPILE:**
- **Android:** only **finding 9** (missing `NotificationDisplay` import) blocks the build.
- **iOS:** *no* compile-error finding in the set — it already builds.
- **Residual risk:** `TODO.md` says the glue has never been compiled, so this static review **cannot prove finding 9 is the only Android compile error**. The first real `gradle assemble` / `pod lib lint` may surface more.

**To be MEANINGFULLY green (fixes actually correct + at parity):** finding 9 + the security/behavioral set (12/14, 1, 4, 5, 7, 8, 10, 15, 16, 17).

### Key asymmetry for the build effort
**Android won't compile but is behaviorally closer** to the reference once it does (its main runtime divergence is finding 10). **iOS compiles cleanly but is the most divergent at runtime** — it carries the security hole plus most highs (4, 5, 7, 8, 15, 16, and the shared 14, 17, 18). So the iOS build will go green while still being the least correct.

### Fix clusters (so this reads as fewer changes than 18)
- **12 + 14 = one fix** (provenance marker / `UNPushNotificationTrigger` check).
- **11 ⊂ 1** (validate cron at `ConductorClient.schedule/defineTaskDefinition`). **Caveat:** this does **not** fix **3** (`*/3000000000` passes `isValidCronExpression`).
- **5 + 8 share the iOS `dispatch` paused gate.**

---

## CRITICAL

### dimension: android-glue
**#9 — Android module does not compile: `NotificationDisplay` unresolved**
`ExpoConductorModule.kt:253,359` (import block 13–20).
- **Wrong:** `NotificationDisplay.show(...)` is called but the class lives in `expo.modules.conductor.triggers` and is never imported; Kotlin doesn't bring a sub-package into the parent's scope.
- **Impact:** unresolved reference — the Android module fails to compile. Hard blocker for §1 Android build.
- **Fix:** add `import expo.modules.conductor.triggers.NotificationDisplay` alongside lines 18–20.

### dimension: push-security
**#12 — iOS notification delegate fires arbitrary tasks by id from a forged APNs push**
`ios/Triggers/NotificationDelegate.swift:54-95` (stamp point `Schedulers.swift:15`).
- **Wrong:** `willPresent`/`didReceive` gate only on `userInfo["conductorTask"] != nil`, then `handle()` does a bare `TaskStore().get(id)` dispatch — no `push`-trigger / `matchKey` check. The delegate can't tell a locally-scheduled notification from a remote APNs alert carrying the same key.
- **Impact:** a forged `{"aps":{"alert":"x"},"conductorTask":"<any-id>"}` fires arbitrary tasks on foreground delivery (no user action) or tap — exactly the threat the 0.1.1 push fix (CHANGELOG line 49) claims to defend.
- **Fix:** stamp `content.userInfo["conductorLocal"]=true` (`Schedulers.swift:15`) and require it in `handle()` before the id lookup, OR for `notification.request.trigger is UNPushNotificationTrigger` route through the `matchKey` check in `ConductorAppDelegate.didReceiveRemoteNotification:46-52`. **This same fix closes #14.**

---

## HIGH

### dimension: push-security
**#14 — Android/iOS asymmetry: Android has no remote id-fire path; iOS does**
`ios/Triggers/NotificationDelegate.swift:86-95`.
- **Wrong/Impact:** Android's only remote-reachable entry (`ConductorMessagingService:30-40`) is `matchKey`-gated; its id-based receivers are app-PendingIntent-only and unreachable by a remote message. iOS exposes the unsecured bare-id `handle` to remote APNs notifications. Same forged-message attack: impossible on Android, succeeds on iOS.
- **Fix:** apply #12's provenance/`UNPushNotificationTrigger` fix so the only remote-reachable iOS dispatch is the `matchKey`-gated push path (matches Android).

### dimension: cron-parity
**#1 — Malformed cron rejected only on Web; native silently accepts (or fires) it**
`src/Conductor.ts:62-77`; native `TaskMapper.kt:70` / `TaskMapper.swift:78-79`.
- **Wrong:** `schedule`/`defineTaskDefinition` pass the definition straight to `backend.registerTaskAsync`; `assertValidRecurrence`/`isValidCronExpression` runs only inside the Web normalize step. Native registers an invalid cron with zero validation.
- **Impact:** `"30 9 * *"` (4 fields) → Web **throws** at register, native silently never fires. `"3, * *"` (trailing comma) → Web **throws**, native silently registers **and fires** at minute 3.
- **Fix:** call `assertValidRecurrence` in `ConductorClient.schedule/defineTaskDefinition` before `backend.registerTaskAsync` (platform-agnostic; subsumes #11). Does **not** fix #3.

### dimension: rundue-count
**#4 — iOS background tasks over-fire every BGTask wake and inflate fired count**
`ios/ExpoConductorModule.swift:154-168,262-300`.
- **Wrong:** `isDue` treats any `background`-triggered task as due regardless of `nextRunAt`, and `dispatch`'s `!manual` block has no not-yet-due check. Kotlin gates at `:214-217`; Web filters `nextRunAt<=now`.
- **Impact:** a `background`+recurrence task fires on every wake (ignoring its interval) and is counted — diverging the documented "tasks fired" return.
- **Fix:** at top of the Swift `if !manual` block: `if let n = task["nextRunAt"] as? Int, now < n { return false }`.

**#5 — Native `runDueTasks()` ignores `paused`; Android/iOS fire and return nonzero while Web returns 0**
`ios/ExpoConductorModule.swift:154-161,262-278`; `android …/ExpoConductorModule.kt:77-86,207-244`.
- **Wrong/Impact:** Web short-circuits `if (this.paused) return 0` (`WebSchedulerEngine.ts:156`); neither native live entry point nor its dispatch checks `paused`, even though both headless paths do. A tick or BGTask wake while paused fires every due task and returns nonzero — wrong count + work runs while paused.
- **Fix:** add an early `paused` guard to Kotlin `runDueTasksAsync` and Swift `runDueBackgroundTasks` (shares the iOS dispatch gate with #8).

### dimension: ios-glue
**#7 — Foreground-notification dedup permanently stalls sub-30s recurrences**
`ios/Triggers/NotificationDelegate.swift:20-39`; `Schedulers.swift:18`.
- **Wrong:** notifications are one-shot (`repeats:false`) re-armed via `advanceRecurrence`, but the 30s dedup window's comment assumes a non-existent 60s repeat interval. For any interval < 30s, the genuine next occurrence lands inside the window and `handleOnce` returns **before** `handle()`/`advanceRecurrence()`, so occurrence #2 is suppressed and never re-arms #3.
- **Impact:** the chain dies permanently. The demo (`App.tsx:87`, 5s interval) hits this; no min-interval clamp exists in `normalize`.
- **Fix:** include the notification delivery timestamp in the dedup key, or clear `lastHandledAt[id]` in `advanceRecurrence` when re-arming; fix the misleading comment.

**#8 — Paused conductor still runs tasks on iOS via the live BGTask/notification path**
`ios/ExpoConductorModule.swift:106-113,154-161,262-278`.
- **Wrong:** `dispatch`'s `!manual` block checks policy+budget but never `paused`; `pauseAsync` only cancels local notifications, never the BGTask request. Android has no such leak (`ConductorWorker` checks `isPaused`).
- **Impact:** a background wake or tapped tray notification runs work after pause.
- **Fix:** at top of the Swift `if !manual` block add `if paused { emit("onTaskSkipped", …PAUSED…); return false }`; have `pauseAsync` cancel and `resumeAsync` re-submit the BGTask request. Shares the gate with #5.

### dimension: android-glue
**#10 — One-time tasks never cleared from `nextRunAt` on Android → repeated re-fires**
`android …/ExpoConductorModule.kt:77-86,277-286`.
- **Wrong:** `advanceRecurrence` early-returns for non-recurring tasks (`:278`) and never clears `nextRunAt`; a fired one-shot keeps its past `nextRunAt`, so `runDueTasksAsync` (`filter nextRunAt<=now`) re-dispatches it on every tick. Web recomputes over future-only triggers → null → fires once.
- **Impact:** Android fires a one-shot repeatedly. Main Android runtime divergence once it compiles.
- **Fix:** in dispatch's non-manual path, when recurrence is null recompute `nextRunAt` from still-future triggers and persist `JSONObject.NULL`.

### dimension: completeness
**#15 — iOS `dispatch` advances recurrence on a MANUAL run**
`ios/ExpoConductorModule.swift:262-310`.
- **Wrong/Impact:** `advanceRecurrence(task)` is called unconditionally (`:298`), so `runTaskAsync` (run-now) advances `nextRunAt` and skips the next natural occurrence. Web (`:354`) and Kotlin (`:273`) gate on `!manual`.
- **Fix:** change `:298` to `if !manual { advanceRecurrence(task) }`.

**#16 — iOS `runDueBackgroundTasks` fires in store order, not priority order**
`ios/ExpoConductorModule.swift:153-161`.
- **Wrong/Impact:** no sort before the sequential dispatch loop; since each dispatch reserves budget in `running`, store order decides admission under contention and a low-priority task can starve a high-priority one. Web (`:162-168`) and Kotlin (`:81-83`) sort priority-desc → nextRunAt-asc → id-asc.
- **Fix:** sort `due` identically before the loop.

**#17 — `policy.retry` is a three-way divergence**
`ios/ExpoConductorModule.swift:132-143` (and Kotlin `reportResultAsync` / `schedule:171`).
- **Wrong/Impact:** retry/backoff is implemented only in `WebSchedulerEngine.handleRetry:405-425`. Kotlin uses a hard-coded EXPONENTIAL/30s for native handlers and no retry for JS; Swift never retries. The same `policy.retry` behaves three different ways.
- **Fix:** drive retry centrally in `ConductorClient`, or port the backoff math into Kotlin/Swift; at minimum document `policy.retry` as Web/app-alive-only in the public type and CLAUDE.md.

---

## MEDIUM / LOW / INFO (should-fix; parity refinements)

| # | dim | file:lines | gist |
|---|---|---|---|
| 2 | cron-parity (med) | `Recurrence.kt:25,31` | Kotlin `toIntOrNull` accepts Unicode digits ('٣','３'); Swift/JS ASCII-only. Guard tokens with `^[+-]?[0-9]+$`. |
| 18 | completeness (med) | `ios/ExpoConductorModule.swift:183-200` | Swift `dispatchHeadless` drops JS+notification recurring tasks at cold start; Android re-arms them. Mirror Android logic. |
| 6 | rundue-count (med) | `android …/ExpoConductorModule.kt:85,264-270` | A throwing Kotlin native handler aborts the `runDueTasksAsync` batch (no count); Swift's type can't throw. Wrap `handler?.run` in try/catch. |
| 3 | cron-parity (low) | `Recurrence.kt:24-26` | `*/n` with `n` in (2^31, 2^63) overflows Int32 → never fires on Android; fires on Web/Swift. Parse step as Long or reject step > 59. **Not fixed by #1.** |
| 11 | android-glue (low) | `triggers/TaskMapper.kt:28-47` | Android normalize does no cron validation. Subsumed by #1, or add `isValidCronExpression` here. |
| 13 | push-security (info) | `ConductorMessagingService.kt:37-38` | Non-string `matchKey` coerced by Android `optString`, dropped by iOS `as? String`. **Not attacker-reachable** (developer-controlled). Optional parity polish. |

---

## Residual risk (examined gaps — cleared)
- `normalize.ts` priority/weight/policy defaulting consistent across engines (`Priority.DEFAULT=0` matches native 0).
- TaskStore persistence (localStorage / SharedPreferences+static LOCK / UserDefaults+serial queue): read-modify-write serialization sound and equivalent.
- Config plugin (`plugin/src/index.ts`): Android permissions, FCM gating, iOS `UIBackgroundModes`/`BGTaskSchedulerPermittedIdentifiers` (`com.expoconductor.refresh` matches `Schedulers.swift`), `USE_EXACT_ALARM` opt-in — no defect.
- `appState` + single-flight: web-only by design, no cross-engine obligation.
- Exact-alarm re-arm (`advanceRecurrence:283`): consistent for the recurring path.
- Expiry/window/policy evaluation (`Policy.*`): byte-identical across engines.

**Open residual risk:** the native glue has never been compiled (`TODO.md` §1), so static review cannot guarantee #9 is the only Android compile error — verify with a real `gradle assemble` / `pod lib lint`.
