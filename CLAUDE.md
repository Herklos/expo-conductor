# CLAUDE.md

Guidance for working in this repository.

## What this is

`expo-conductor` — an Expo native module that lets an app define tasks with rich
**execution policies** (time windows, charging/battery/network/idle constraints, expiry,
retry/backoff), **resource weight** (cpu/network/battery/memory budgeting), **priority vs.
other tasks**, and **recurrence** (interval/daily/weekly/cron), fired by many **triggers**
(time, recurrence, scheduled notification, exact alarm, OS background task, FCM/APNs push,
app-state). A task's work runs as a **JS handler or an app-provided native handler**.

It is a **pnpm monorepo**:
- `packages/expo-conductor/` — the module
- `apps/demo/` — an Expo app exercising every feature
- `fixtures/` — shared cross-platform behavior cases (see "The big idea")

## The big idea: native-first + one shared fixture set

The orchestration **engine** is implemented **three times** — Kotlin (Android), Swift (iOS),
TypeScript (Web) — because the logic must live natively. To guarantee the three behave
**identically**, they are all tested against the SAME language-neutral fixtures in
`/fixtures/*.cases.json`. Every platform's test suite loads those exact files:

| Concern | Fixture | TS (Jest) | Kotlin (JUnit) | Swift (XCTest) |
| --- | --- | --- | --- | --- |
| recurrence | `recurrence.cases.json` | `src/__tests__/recurrence.test.ts` | `android/engine-jvm/.../EngineFixtureTest.kt` | `ios/Tests/EngineFixtureTests.swift` |
| priority | `priority.cases.json` | ✅ | ✅ | ✅ |
| weight admission | `weight-admission.cases.json` | ✅ | ✅ | ✅ |
| policy | `policy.cases.json` | ✅ | ✅ | ✅ |

**Rule of thumb:** if you change engine behavior, change it in **all three** engines AND
update the fixtures. The TS engine in `src/web/engine/` is the reference implementation;
Kotlin (`android/src/main/java/expo/modules/conductor/engine/`) and Swift (`ios/Engine/`)
mirror it line-for-line. Time math is integer math on UTC epoch ms; weights are IEEE-754
`double` compared with a **strict `<=`** (no epsilon — it would diverge across platforms).

## Layout of `packages/expo-conductor`

```
src/
  ExpoConductor.types.ts     # the serializable task model (single source of truth for types)
  ExpoConductorModule.ts     # native proxy: requireNativeModule('ExpoConductorModule')
  ExpoConductorModule.web.ts # web module wrapping WebSchedulerEngine
  WebSchedulerEngine.ts      # timer-driven web backend (ConductorBackend impl, no 'expo' import)
  ConductorBackend.ts        # interface every platform backend implements
  Conductor.ts               # ConductorClient: public API, JS handler registry + dispatch
  index.ts                   # default singleton `Conductor`
  web/engine/*.ts            # reference engine (recurrence/priority/weight/policy/registry)
  web/normalize.ts           # TaskDefinition -> RegisteredTask (+ nextRunAt)
  __tests__/*.test.ts        # Jest; fixtures.ts loads /fixtures
android/  src/main/java/expo/modules/conductor/{engine,triggers,storage}/  + engine-jvm/ (JVM test harness)
ios/      Engine/, Triggers/, *.swift, Package.swift (SwiftPM test target), ExpoConductor.podspec
plugin/   src/index.ts       # config plugin (permissions, manifest, BGTask ids, FCM gate)
```

## Commands

```sh
pnpm install
pnpm --filter expo-conductor test         # Jest (engine + orchestration + API)
pnpm --filter expo-conductor typecheck    # tsc for src + plugin
pnpm --filter expo-conductor build        # emits build/ and plugin/build/
pnpm test:kotlin                          # Kotlin engine vs shared fixtures (needs JDK 17+)
pnpm test:swift                           # Swift engine vs shared fixtures (macOS / Swift)
pnpm --filter demo typecheck
pnpm --filter demo prebuild && pnpm --filter demo android   # run demo on device
```

The Kotlin tests run via a **standalone JVM-Gradle harness** (`android/engine-jvm/`) that
compiles only the pure engine — no Android SDK/emulator needed. Swift tests run via a
**SwiftPM package** (`ios/Package.swift`) — no Xcode project needed. Full native *app*
builds need the Android SDK / Xcode (not required for engine verification).

## Conventions & gotchas

- **Jest matches `**/__tests__/**/*.test.ts` only.** Tests must not import `expo` (the
  module proxy/web module files do). Test the engines / `WebSchedulerEngine` / `ConductorClient`
  (with a mock backend) directly — that is why `WebSchedulerEngine` has no `expo` import.
- **Handlers are keyed by name, tasks by id.** Several tasks can share one handler, so
  `ConductorClient` maps `taskId -> handlerName` (populated in `schedule`/`defineTaskDefinition`)
  before dispatching `onTaskExecute`. Don't reintroduce a direct `handlers.get(taskId)`.
- **Events cross threads on both natives** — emit via the main-thread helper (`emit(...)`
  in `ExpoConductorModule.kt` / `.swift`), never call `sendEvent` directly from a
  Worker/Receiver/notification-delegate/BGTask handler.
- **iOS trigger wiring lives in `ConductorAppDelegate`** (an `ExpoAppDelegateSubscriber`
  registered in `expo-module.config.json`): it installs the `UNUserNotificationCenter`
  delegate and the `BGTaskScheduler` launch handler during `didFinishLaunching` (BGTask
  requires registration before launch completes). Automatic triggers reach `dispatch(...)`
  through that delegate / launch handler. Exact alarms on Android are re-armed in
  `advanceRecurrence` (they don't self-repeat like periodic WorkManager).
- **Permissions & push scoping**: notification/time/alarm triggers need notification
  permission — `Conductor.requestPermissions()` prompts on iOS/web; Android 13+ must be
  prompted from an Activity (or expo-notifications). The `push` trigger matches ONLY tasks
  that declared a `push` trigger with a matching non-empty `matchKey` (no id-fallback) so a
  forged remote message can't fire arbitrary tasks; treat push `data` as untrusted. On iOS the
  *displayed-notification* path (`NotificationDelegate`) dispatches a task by id ONLY for app-scheduled
  LOCAL notifications, gated on the **OS-set trigger class** (a `UNPushNotificationTrigger` is remote →
  forwarded, never dispatched) — which a sender CANNOT forge. The `conductorLocal` userInfo key is only
  a same-process hint to distinguish our local notifications from another lib's; it is NOT a security
  boundary (APNs delivers arbitrary custom keys), so never gate security on it alone.
- **`policy.retry` is per-platform** (by design — see the `RetryPolicy` doc comment): the Web engine
  and a JS handler running while the app is alive honor `maxAttempts`/`backoffMs`/`maxBackoffMs`;
  native handlers fall back to OS retry (Android WorkManager exponential backoff — NOT the configured
  values; iOS BGTask: none). Make handlers idempotent.
- **Web `setTimeout` cap**: delays over ~24.8 days (2^31 ms) overflow, so `scheduleTimer`
  chains timers in <=MAX_TIMER_DELAY hops; the web engine also re-arms persisted tasks in
  its constructor (persistence would otherwise be write-only).
- **Web-only orchestration (NOT fixture-validated)**: `policy.singleFlight` (leader
  election, `web/engine/leader.ts`) and the `appState` trigger firing (`web/engine/appState.ts`)
  live only in the Web engine. They are NOT part of the shared engine math (recurrence/
  priority/weight/policy) the three platforms mirror, so they have **no Kotlin/Swift port
  and no `/fixtures` case** — the "change all three engines" rule does not apply. Native is
  a single app instance (always the leader) and gets app-state from its own host lifecycle;
  it simply ignores the extra `singleFlight` policy key (`TaskMapper` reads policy by known
  keys). Both are injectable on `WebSchedulerEngine` (`leaderElection` / `appStateSource`)
  and unit-tested directly — no DOM/`navigator.locks` needed under Jest (Node defaults are
  a no-op source + always-leader). Call `engine.dispose()` for transient engines so the
  DOM listener + Web Locks don't leak.
- **Headless limits + the optional interop**: by default a JS handler can't run after the
  app is terminated (in-memory registry); native handlers (`type: 'native'`) run headless.
  Phase 2 adds an OPT-IN bridge — `src/integrations/expoBackgroundTask.ts` (shipped as the
  `expo-conductor/task-manager` entry) registers a `TaskManager.defineTask` tick via
  `expo-background-task` that calls `Conductor.runDueTasks()` (backend `runDueTasksAsync`),
  so JS handlers survive cold start. `expo-task-manager`/`expo-background-task` are OPTIONAL
  peer deps; the core never imports them (only that integration file does). Native swap of
  BGTaskScheduler/WorkManager for these is deferred — needs on-device verification.
- **Optional integrations live in `src/integrations/`** and ship as subpath exports
  (`expo-conductor/task-manager`, `expo-conductor/notifications`). Each statically imports its
  optional peer dep, so the core must NEVER import these files. `expoNotifications.ts`
  (Phase 3 draft) delegates permission prompts, Android channels, foreground presentation and
  cold-start response routing to `expo-notifications`. When you add an integration: add the
  optional peer dep + `peerDependenciesMeta.optional` + devDep + an `exports` entry.
- **Kotlin uses nested block comments**: a `/*` inside a KDoc (e.g. writing `a/*b`) opens a
  nested comment. Avoid `/` immediately followed by `*` in doc comments.
- **Publishing**: the `files` allowlist in `package.json` is explicit (plus `.npmignore`) so
  the JVM/Swift test harnesses and build artifacts are NOT shipped. If you add native source
  dirs, update `files`.
- **Versions**: Expo ~56, React 19, RN 0.85. Keep `@types/react` on 19.x.

## Git / branches

Development branch for sessions: `claude/zen-newton-0MGqO`. `master` exists at the same
commit. The local git remote only accepts pushes to the session branch; use the GitHub MCP
tools to operate on other branches (e.g. `master`). Do not push to other branches without
explicit permission.
