# Implementation plan — iOS Live Activity (the "foreground-service equivalent")

**Status:** design (2026-06-10). Companion to the Android `policy.foreground` foreground-service
promotion (TRIGGER_TODO §2, shipped v0.4.0) and the demo's `foregroundService` trigger mode. This
plan scopes an OPT-IN iOS surface that shows live task progress — it is **not** a 1:1 port.

## TL;DR — read the category mismatch first

The instinct is "Android foreground service ⇄ iOS Live Activity." **They are not equivalent**, and a
plan that treats them as equivalent will be subtly wrong:

| | Android `policy.foreground` | iOS Live Activity |
|---|---|---|
| Primary effect | **Buys execution time** — bypasses Doze + the 10-min background CPU cap | **UI surface only** — Lock Screen / Dynamic Island card |
| Extra background runtime granted | Yes (that's the whole point) | **None** |
| Notification | OS-*mandated* side effect of the service | The entire feature |
| Who starts it | The WorkManager worker, on its own | App **foreground** (iOS 16.1) or APNs push (17.2+) — a plain BGTask **cannot** start one |

So a Live Activity does **not** make a backgrounded iOS task run longer. It is a *display* for work
whose runtime is granted by something else. The honest framing for users: **on Android this trigger
mode buys runtime and shows a notification as a side effect; on iOS the equivalent shows live
progress for a long, user-started task but grants no extra runtime.**

## The honest mapping — pair it with the trigger iOS already has

iOS already ships the real analog to "long user-started work that survives backgrounding":
**`userInitiatedBackground` → `BGContinuedProcessingTask` (iOS 26)** — TRIGGER_TODO #18, shipped
v0.4.0. That is the trigger whose *runtime* a Live Activity should *visualize*. Do NOT invent a
parallel runtime path; connect the UI to that existing trigger.

- **iOS 16.1–25:** A Live Activity can be started while the app is foreground and updated from a
  foreground-initiated task; it persists on the Lock Screen after backgrounding but the task's own
  background runtime is still governed by normal BGTask limits. Best paired with short
  foreground-started work or push-driven updates.
- **iOS 26:** `BGContinuedProcessingTask` gives the long, user-started, survives-backgrounding
  runtime. A Live Activity started in the same user gesture becomes the progress UI for it — this is
  the closest thing to the Android FGS experience (long work + persistent system card).

**Decision KD-1:** scope this as a `policy.liveActivity?: boolean` (mirrors `policy.foreground`), NOT
a new `Trigger`. It changes *how a task surfaces*, not *when it fires* — same category as
`policy.foreground`, so it stays out of the shared engine (recurrence/priority/weight/policy) and
out of `/fixtures`. The native `TaskMapper` already ignores unknown policy keys, so Android/Web
no-op it for free, exactly as iOS no-ops `policy.foreground` today.

## The hard part is the build target, not the Swift

A Live Activity requires a **Widget Extension target** — a second bundle in the app, not just code in
the main target. This is the bulk of the effort:

1. **A Widget Extension** containing an ActivityKit `ActivityConfiguration` + a `Widget` whose
   `ActivityAttributes` define the static + dynamic (`ContentState`) fields rendered on the Lock
   Screen and in the Dynamic Island.
2. **`NSSupportsLiveActivities = true`** in the **main app** Info.plist.
3. (For background/remote updates) an **APNs push-token-per-activity** path: each `Activity` vends a
   `pushToken`; the app's server pushes `content-state` updates to it. Required if updates must
   happen while the app is suspended.

**KD-2 — Expo config plugins do not scaffold extension targets natively.** `withXcodeProject` can
nudge an existing target but does not cleanly create a new Widget Extension with its own
entitlements, Info.plist, and build phases. Realistic options:

- **`@bacons/apple-targets`** — community plugin purpose-built to declare extra Apple targets
  (widgets, App Clips) from Expo config. Lowest effort; adds a dependency the repo doesn't have yet.
- **A custom config plugin** under `plugin/src/` that writes the extension target via
  `withXcodeProject` + `withInfoPlist` + a templated Swift source dir. Most control, most code,
  most fragile against Xcode project-format churn.
- **Prebuild template / bare workflow** — ship the extension as a committed native template. Breaks
  the "managed, plugin-driven" model the rest of the package follows; not recommended.

This mirrors the package's existing rule (CLAUDE.md): **the core never imports an integration; opt-in
behind a config-plugin flag, default off ⇒ byte-for-byte today.**

## Steps

### Step 0 — Types + policy plumbing (land first, as a no-op everywhere)
- Add `liveActivity?: boolean` to the `ExecutionPolicy`/`policy` model in
  `ExpoConductor.types.ts`, doc-commented as **iOS 16.1+ only, requires the config-plugin flag**,
  ignored on Android/Web (parallels the `foreground` doc comment).
- No engine change, no fixture — it's a surface policy, not engine math (KD-1).

### Step 1 — Config-plugin flag
- Add `enableLiveActivities?: boolean` to `ConductorPluginOptions` (`plugin/src/index.ts`), default
  `false`. When set: write `NSSupportsLiveActivities = true` to the main Info.plist via
  `withInfoPlist`, and scaffold the Widget Extension target (KD-2 — pick `@bacons/apple-targets` for
  v1 to keep scope sane; document the dependency in `package.json` + README availability matrix).

### Step 2 — Native arming (iOS only)
- A `ConductorLiveActivity.swift` helper (gated on `if #available(iOS 16.1, *)` and the Info.plist
  flag) that:
  - **start:** when a task with `policy.liveActivity` begins via the foreground/`BGContinuedProcessingTask`
    dispatch path, call `Activity.request(attributes:content:)`. MUST be reachable from a foreground
    user action (16.1) — wire it into the `userInitiatedBackground` submit path, which already
    requires a live user gesture.
  - **update:** on task progress / `onTaskExecute` ticks, `activity.update(...)`.
  - **end:** on `onTaskComplete` / `onTaskError`, `activity.end(..., dismissalPolicy:)`.
- Reuse the main-thread `emit(...)` discipline: ActivityKit calls must not run from a BGTask thread
  without hopping to main (same constraint as event emission, see CLAUDE.md).
- **Do not gate runtime on the Live Activity.** If the OS denies the activity (user disabled them,
  budget exhausted), the task still runs — the UI is best-effort, exactly like the Android FGS
  notification is a side effect, not a precondition.

### Step 3 — Optional: push-updated activities (iOS 16.2+ / 17.2+ for start)
- For updates while suspended, capture `activity.pushToken` and surface it to the app so its server
  can push `content-state`. Defer to a Phase 2 of this plan — v1 can update only while the app has
  runtime (foreground or BGContinued window).

### Step 4 — Demo wiring (parallels the Android `foregroundService` mode)
- Add a `liveActivity` (or reuse `foregroundService` with platform-branched semantics) entry to the
  demo `TriggerMode` with `platforms: ['ios']`, backed by `userInitiatedBackground` + the new
  `policy.liveActivity` flag, plus a `RUN_NOW_ONLY_NOTE` caption stating it needs iOS 16.1+/26 and a
  development build with the extension target.

## Open questions / risks

- **OQ-1:** Demo UX — one shared `foregroundService` selector mode whose meaning branches by
  platform (Android FGS / iOS Live Activity), or two distinct modes gated by `platforms`? Two modes
  is more honest about the category mismatch; one mode reads as "the equivalent." Lean two.
- **OQ-2:** `@bacons/apple-targets` vs. a hand-rolled plugin — the dependency-vs-fragility trade. v1:
  `@bacons/apple-targets`; revisit if it can't pin to Expo ~56.
- **R-1:** Live Activities can't be unit-tested against `/fixtures` (no shared engine math, device-
  only behavior). Verification is on-device in the demo, like BGTask/notification triggers today.
- **R-2:** ActivityKit start has tight rules (foreground or push-to-start 17.2+, 8h active / 12h
  stale limits). A backgrounded recurrence task **cannot** start one — this is why it pairs with
  `userInitiatedBackground`, not with `background`/`recurrence`.

## Effort

- Types + policy plumbing + flag: ~1–2 h.
- Widget Extension scaffolding via `@bacons/apple-targets`: ~3–5 h (most of the risk).
- Native start/update/end + demo wiring: ~3–4 h.
- Push-updated activities (Step 3): separate phase, ~3–4 h.

Total v1 (no push updates): **~7–11 h**, gated behind `enableLiveActivities`, default off.
