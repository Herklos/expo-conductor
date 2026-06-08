<!-- Generated 2026-06-08 by a multi-agent adversarial SELF-REVIEW (Claude Code workflow conductor-0.1.2-selfreview) of the 0.2.0 native-glue fix diff — 5 dimensions (Kotlin/Swift compile, parity, security, regression), each finding double-verified. 18 subagents. The native code could not be compiled here (no Android SDK / CocoaPods), so this is the compile-substitute review. All 6 confirmed issues were FIXED before cutting 0.2.0 (notably the critical conductorLocal-forgeable security bypass -> now gated on the unforgeable OS trigger class). -->

# expo-conductor 0.2.0 — native-diff self-review

## 0.1.2 diff review — verdict: must-fix-issues

All 6 confirmed issues check out against the source I read; none is a false positive. They consolidate into **4 must-fix entries** (#3 and #5 are the same code locus; #6 rides along with the #3 Kotlin fix). The diff is **not safe to keep as-is** — it ships a critical security bypass plus three real cross-engine parity divergences.

### P0 — Security (critical)

**iOS forged-push fix is bypassable.** `NotificationDelegate.swift:63/81/99` and `Schedulers.swift:15-19`. The displayed-notification path is gated solely on the attacker-forgeable `userInfo["conductorLocal"] == true`. All three checks read the *same* value, so the handle()-level "defense in depth" is not independent and falls with the other two. APNs delivers every top-level custom key into `userInfo`, JSON `true` bridges through `as? Bool` to Swift `true`, and the marker is hardcoded in this shipped open-source file — so a remote alert push `{"aps":{"alert":{...}},"conductorTask":"victimId","conductorLocal":true}` reaches `TaskStore().get("victimId")` and dispatches it on present/tap. `grep` confirms zero trigger-class checks in `ios/`. #12/#14 is NOT closed. Fix: gate on the OS-set trigger class (`notification.request.trigger is UNPushNotificationTrigger`) at the willPresent/didReceive call sites — claim only when `!isRemote` — and keep `conductorLocal` as belt-and-suspenders. Correct the false comment at `Schedulers.swift:15-18`.

### P1 — Parity divergences (must-fix)

1. **runDueTasksAsync fired-count.** `ios/ExpoConductorModule.swift:99/180-185`. `runDueTasksAsync` delegates to `runDueBackgroundTasks()`, whose `isDue` is `due || isBackground`, so a pure-background task (`nextRunAt == nil`) fires and counts. The dispatch not-yet-due gate (line 309) does NOT cover this — `if let nextRunAt` fails for nil. Web (`WebSchedulerEngine.ts:161`) and Kotlin (`ExpoConductorModule.kt:84`) both exclude nil-nextRunAt. Narrow to exactly background+nil. Fix: split the callers — BGTask wake keeps `isDue` (correct, nothing lost), the AsyncFunction entry filters `nextRunAt != nil && nextRunAt <= now`.

2. **Paused-gate asymmetry.** `android/.../ExpoConductorModule.kt:214-221`. Swift dispatch skips when paused inside `!manual`; Kotlin has no such check. Since `pauseAsync` only unschedules local work, an FCM push (or in-tray alarm) while paused fires on Android but is skipped on iOS/Web. Fix: add `if (paused) { emitSkipped(id, "PAUSED"); return false }` at the top of Kotlin's `!manual` block.

3. **Recurrence-present reschedule ignores future one-shots** (merges #3 + #5 + #6). `ios/ExpoConductorModule.swift:353-355` and `android/.../ExpoConductorModule.kt:304-308` compute next from recurrence ONLY; Web takes `min(recurrence, future one-shots)`. A daily-11:00 + alarm-10:30 task fired at 10:00 loses the 10:30 occurrence on both natives. Fix: always call `computeNextRunAt(task, recurrence, now, futureOnly: true)` (verified to fold the recurrence param into `candidates.min()` with future-only one-shots — exactly Web's behavior). This also fixes the nil-nextRun edge (#6: Kotlin should write NULL, not early-return on a stale value). **Preserve the exact-alarm re-arm** (`ConductorAlarmReceiver.schedule`, Kotlin 310-312) — folding into `computeNextRunAt` must not drop it. Apply the same to both `dispatchHeadless` re-arms. The new Swift comment at 346-347 claiming it "Mirrors WebSchedulerEngine.reschedule/futureTriggers" is introduced by this diff and is provably false — correct it.

### Notes
- No compile errors found in the reviewed paths; the `computeNextRunAt` signatures (Swift `:129`, Kotlin `:126`, Web `:39`) all support `futureOnly`, so the suggested fixes are mechanically sound.
- #5 vs #3 verifier disagreement ("regression vs pre-existing") doesn't affect the fix — but the false comment is genuinely new in this diff, so it's flagged regardless.
