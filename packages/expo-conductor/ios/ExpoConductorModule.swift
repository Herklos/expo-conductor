import ExpoModulesCore
import Foundation
import UserNotifications
#if canImport(UIKit)
import UIKit
#endif

/// iOS Expo module for expo-conductor. Implements the same JS-facing contract as the
/// Web engine (`ConductorBackend`) using UNUserNotificationCenter for time/notification
/// triggers and BGTaskScheduler for background work, while delegating all decision
/// logic to the shared, fixture-verified engine types.
public class ExpoConductorModule: Module {
  static weak var shared: ExpoConductorModule?
  private let store = TaskStore()
  private let execLog = ExecutionLog()
  // `paused` and `budget` are written from AsyncFunction closures (the module queue) but read
  // from dispatch()/schedule() on notification/BGTask background threads, so guard them with a
  // lock like `running` (a torn read of the 4-Double `budget` struct or a stale `paused` could
  // otherwise admit/skip incorrectly on a concurrent background wake).
  private let stateLock = NSLock()
  private var _paused = false
  private var _budget = ResourceWeight(cpu: 1, network: 1, battery: 1, memory: 1)
  private var paused: Bool {
    get { stateLock.lock(); defer { stateLock.unlock() }; return _paused }
    set { stateLock.lock(); defer { stateLock.unlock() }; _paused = newValue }
  }
  private var budget: ResourceWeight {
    get { stateLock.lock(); defer { stateLock.unlock() }; return _budget }
    set { stateLock.lock(); defer { stateLock.unlock() }; _budget = newValue }
  }
  // Weight of tasks currently running in this process, for best-effort cross-task budgeting.
  // Guarded by `runningLock` since dispatch runs on notification/BGTask threads.
  private var running: [String: ResourceWeight] = [:]
  private let runningLock = NSLock()

  private func nowMs() -> Int { Int(Date().timeIntervalSince1970 * 1000) }

  private func clearRunning(_ id: String) {
    runningLock.lock(); defer { runningLock.unlock() }
    running[id] = nil
  }

  /// Atomically admit `id` against the budget and the resources already consumed by other
  /// in-flight tasks, reserving its weight when admitted — all under one lock so two trigger
  /// threads (e.g. a notification delivery and a BGTask wake) can't both observe the same
  /// usage, both pass admission, and overshoot the budget. Returns whether admitted.
  private func tryAdmit(_ id: String, _ task: [String: Any], now: Int) -> Bool {
    let currentBudget = budget // snapshot before taking runningLock (avoids nested locks)
    let weight = TaskMapper.weightOf(task)
    let weighted = TaskMapper.weightedTask(task, now: now)
    runningLock.lock(); defer { runningLock.unlock() }
    var cpu = 0.0, network = 0.0, battery = 0.0, memory = 0.0, count = 0
    for (rid, w) in running where rid != id {
      cpu += w.cpu; network += w.network; battery += w.battery; memory += w.memory; count += 1
    }
    let used = ResourceWeight(cpu: cpu, network: network, battery: battery, memory: memory)
    guard WeightEngine.admit(currentBudget, [weighted], running: count, used: used).admitted.contains(id)
    else { return false }
    running[id] = weight
    return true
  }

  public func definition() -> ModuleDefinition {
    Name("ExpoConductorModule")

    Events("onTaskExecute", "onTaskComplete", "onTaskError", "onTaskSkipped")

    OnCreate {
      ExpoConductorModule.shared = self
      self.paused = self.store.isPaused()
      // The notification delegate + BGTask launch handler are registered from
      // ConductorAppDelegate (an ExpoAppDelegateSubscriber) so they run during
      // application(_:didFinishLaunchingWithOptions:), which BGTaskScheduler requires.
    }

    AsyncFunction("registerTaskAsync") { [weak self] (definition: [String: Any]) -> [String: Any] in
      guard let self else { return definition }
      let task = TaskMapper.normalize(definition, now: self.nowMs())
      self.store.upsert(task)
      self.schedule(task)
      return task
    }

    AsyncFunction("cancelTaskAsync") { [weak self] (id: String) -> Bool in
      guard let self else { return false }
      self.unschedule(id)
      return self.store.remove(id)
    }

    AsyncFunction("getTasksAsync") { [weak self] () -> [[String: Any]] in
      self?.store.all() ?? []
    }

    AsyncFunction("runTaskAsync") { [weak self] (id: String) in
      guard let self, let task = self.store.get(id) else { return }
      self.dispatch(task, manual: true)
    }

    AsyncFunction("runDueTasksAsync") { [weak self] () -> Int in
      self?.runDueTasks() ?? 0
    }

    AsyncFunction("setResourceBudgetAsync") { [weak self] (budget: [String: Any]) in
      self?.budget = TaskMapper.weight(budget)
    }

    AsyncFunction("pauseAsync") { [weak self] in
      guard let self else { return }
      self.paused = true
      self.store.setPaused(true)
      for task in self.store.all() {
        if let id = task["id"] as? String { self.unschedule(id) }
      }
      // Also cancel the pending BGTask refresh so a background wake can't run work while paused
      // (Android cancels its WorkManager/alarm scheduling on pause). resumeAsync re-arms it via
      // schedule(); dispatch()'s paused gate is the backstop for an already-scheduled wake.
      BackgroundScheduler.cancel()
    }

    AsyncFunction("resumeAsync") { [weak self] in
      guard let self else { return }
      self.paused = false
      self.store.setPaused(false)
      for task in self.store.all() { self.schedule(task) }
    }

    AsyncFunction("getStatusAsync") { () -> String in
      ExpoConductorModule.backgroundStatus()
    }

    AsyncFunction("requestPermissionsAsync") { (promise: Promise) in
      UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { granted, _ in
        promise.resolve(granted)
      }
    }

    AsyncFunction("reportResultAsync") { [weak self] (id: String, result: String, error: String?) in
      guard let self else { return }
      self.clearRunning(id) // no longer occupies a concurrency/budget slot
      if let error {
        self.emit("onTaskError", [
          "taskId": id, "error": error, "firedAt": self.nowMs(), "attempt": 1, "triggerType": "background",
        ])
      }
      self.emit("onTaskComplete", [
        "taskId": id, "result": result, "firedAt": self.nowMs(), "attempt": 1, "triggerType": "background",
      ])
    }

    AsyncFunction("getHistoryAsync") { [weak self] () -> [[String: Any]] in
      self?.execLog.all() ?? []
    }

    AsyncFunction("clearHistoryAsync") { [weak self] in
      self?.execLog.clear()
    }
  }

  /// Emit a JS event on the main thread and write to the execution log for history.
  /// Triggers run on notification/BGTask threads — always dispatch to main for JS safety.
  private func emit(_ name: String, _ payload: [String: Any]) {
    execLog.append(ExecutionLog.buildEvent(name: name, payload: payload))
    DispatchQueue.main.async { [weak self] in self?.sendEvent(name, payload) }
  }

  /// Run due tasks on a real OS background wake (the BGTask launch handler). INCLUDES
  /// pure-background tasks (no `nextRunAt`) — they should run when the OS grants a slot.
  @discardableResult
  func runDueBackgroundTasks() -> Int {
    if paused { return 0 }
    let now = nowMs()
    return fireSorted(store.all().filter { Self.isDue($0, now: now) }, now: now)
  }

  /// The JS / `expo-background-task` integration entry (`runDueTasksAsync`). Uses the SAME due-set
  /// as Web/Kotlin — `nextRunAt != nil && nextRunAt <= now` — so the documented "number of tasks
  /// fired" matches across platforms. Pure-background tasks (nil `nextRunAt`) are excluded here;
  /// they fire on a real OS wake via `runDueBackgroundTasks`.
  private func runDueTasks() -> Int {
    if paused { return 0 }
    let now = nowMs()
    return fireSorted(store.all().filter { ($0["nextRunAt"] as? Int).map { $0 <= now } ?? false }, now: now)
  }

  /// Fire the given tasks highest-priority-first (priority desc, then nextRunAt asc, then id by
  /// UTF-16 code unit via the shared `idOrderedBefore` — NOT plain String `<`, which is
  /// Unicode-canonical and would re-introduce the non-ASCII id divergence the 0.1.1 tiebreaker fix
  /// removed) so the shared budget is allocated fairly. Returns the number actually fired (policy /
  /// budget can skip some).
  private func fireSorted(_ tasks: [[String: Any]], now: Int) -> Int {
    let due = tasks.sorted { a, b in
      let pa = (a["priority"] as? Int) ?? 0, pb = (b["priority"] as? Int) ?? 0
      if pa != pb { return pa > pb }
      let na = (a["nextRunAt"] as? Int) ?? 0, nb = (b["nextRunAt"] as? Int) ?? 0
      if na != nb { return na < nb }
      return idOrderedBefore((a["id"] as? String) ?? "", (b["id"] as? String) ?? "")
    }
    var fired = 0
    for task in due where dispatch(task, manual: false) { fired += 1 }
    return fired
  }

  private static func isDue(_ task: [String: Any], now: Int) -> Bool {
    let due = (task["nextRunAt"] as? Int).map { $0 <= now } ?? false
    let isBackground = (task["triggers"] as? [[String: Any]])?
      .contains { ($0["type"] as? String) == "background" } ?? false
    return due || isBackground
  }

  /// Headless variants used when the app is woken into the background and no module/JS
  /// instance exists yet. Only NATIVE handlers can run without JS; recurrence is advanced
  /// and notifications re-scheduled for those. JS-handler tasks are left untouched so they
  /// replay on the next foreground launch.
  static func runDueBackgroundTasksHeadless() {
    let store = TaskStore()
    if store.isPaused() { return }
    let now = Int(Date().timeIntervalSince1970 * 1000)
    for task in store.all() where isDue(task, now: now) {
      dispatchHeadless(task, data: [:])
    }
  }

  static func dispatchHeadless(_ task: [String: Any], data: [String: Any]) {
    guard let id = task["id"] as? String else { return }
    if TaskStore().isPaused() { return }
    // Honor execution policy (esp. expiry/window/charging) even on the headless path.
    let now = Int(Date().timeIntervalSince1970 * 1000)
    guard PolicyEngine.evaluate(TaskMapper.constraints(task), DeviceInfo.read(now: now)).eligible else { return }

    let handler = task["handler"] as? [String: Any]
    let handlerType = handler?["type"] as? String ?? "js"
    let isNative = handlerType == "native"
    let isRust = handlerType == "rust"
    let notif = (task["triggers"] as? [[String: Any]])?.first { ($0["type"] as? String) == "notification" }

    // Native and Rust handlers run headless; a JS handler cannot (no JS runtime).
    if isNative {
      let name = handler?["name"] as? String ?? id
      _ = ConductorHandlerRegistry.shared.handler(for: name)?(id, data)
    }
    if isRust {
      let name = handler?["name"] as? String ?? id
      let dataJson = (try? JSONSerialization.data(withJSONObject: data)).flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
      _ = ConductorRustBridge.dispatch(name: name, taskId: id, dataJson: dataJson)
    }

    // Re-arm the recurrence's NEXT occurrence when the occurrence was meaningfully handled here:
    // a native/rust handler ran, OR this is a notification task (the OS already delivered the
    // current notification from its scheduled request, so we must schedule the next one or the
    // chain dies). A pure JS handler with no notification did nothing headless, so leave
    // nextRunAt to replay on the next foreground launch.
    guard isNative || isRust || notif != nil else { return }
    // min(next recurrence, future one-shots), matching the live reschedule + Web; nil -> nothing
    // future, so don't re-arm (a fired one-shot is done).
    let recurrence = TaskMapper.parseRecurrence(task)
    guard let next = TaskMapper.computeNextRunAt(task, recurrence, now, futureOnly: true) else { return }
    var updated = task
    updated["nextRunAt"] = next
    TaskStore().upsert(updated)
    // Re-arm the NEXT occurrence the same way the live `schedule` path does: a user-visible banner
    // only for a notification/time/alarm trigger; otherwise (a native recurrence-only task) wake
    // silently via BGTaskScheduler rather than posting a spurious "Task" banner. See NotificationPolicy.
    let triggers = (task["triggers"] as? [[String: Any]]) ?? []
    if let visible = NotificationPolicy.visibleNotificationTrigger(triggers) {
      NotificationScheduler.schedule(id: id, fireAtMs: next, title: visible["title"] as? String, body: visible["body"] as? String)
    } else {
      BackgroundScheduler.scheduleRefresh(earliestMs: next)
    }
  }

  private static func backgroundStatus() -> String {
    #if canImport(UIKit)
    let read: () -> UIBackgroundRefreshStatus = { UIApplication.shared.backgroundRefreshStatus }
    let status = Thread.isMainThread ? read() : DispatchQueue.main.sync(execute: read)
    switch status {
    case .available: return "available"
    case .denied, .restricted: return "restricted"
    @unknown default: return "available"
    }
    #else
    return "available"
    #endif
  }

  // MARK: - scheduling

  private func schedule(_ task: [String: Any]) {
    guard !paused, let id = task["id"] as? String else { return }
    let nextRunAt = task["nextRunAt"] as? Int
    let recurrence = TaskMapper.parseRecurrence(task)

    // Post a user-visible local notification ONLY when a trigger warrants one (`notification` /
    // `time` / `alarm`). A recurrence-only (or background/appState/push) task is woken SILENTLY via
    // BGTaskScheduler below — it previously ALSO posted a banner titled "Task" here, which surfaced
    // spurious notifications. See NotificationPolicy; mirrors Android (posts only for `notification`).
    let triggers = (task["triggers"] as? [[String: Any]]) ?? []
    if let nextRunAt = nextRunAt, let notif = NotificationPolicy.visibleNotificationTrigger(triggers) {
      NotificationScheduler.schedule(
        id: id,
        fireAtMs: nextRunAt,
        title: notif["title"] as? String,
        body: notif["body"] as? String
      )
    }
    if recurrence != nil || hasBackgroundTrigger(task) {
      // Prefer an explicit next-run; otherwise honor the background trigger's advisory
      // minimum interval (the OS still decides actual timing).
      let earliest = nextRunAt ?? minimumIntervalEarliestMs(task)
      BackgroundScheduler.scheduleRefresh(earliestMs: earliest)
    }
  }

  /// `now + minimumIntervalMinutes` for a background trigger, if specified.
  private func minimumIntervalEarliestMs(_ task: [String: Any]) -> Int? {
    let bg = (task["triggers"] as? [[String: Any]])?.first { ($0["type"] as? String) == "background" }
    guard let minutes = bg?["minimumIntervalMinutes"] as? Int else { return nil }
    return nowMs() + minutes * 60_000
  }

  private func unschedule(_ id: String) {
    NotificationScheduler.cancel(id: id)
  }

  private func hasBackgroundTrigger(_ task: [String: Any]) -> Bool {
    (task["triggers"] as? [[String: Any]])?.contains { ($0["type"] as? String) == "background" } ?? false
  }

  // MARK: - dispatch

  /// Called by triggers (notification delivery, background refresh, remote push). Returns
  /// whether the task actually fired (emitted onTaskExecute) — false when skipped by policy or
  /// budget — so [runDueBackgroundTasks] can report the number truly fired.
  @discardableResult
  func dispatch(_ task: [String: Any], manual: Bool, data: [String: Any] = [:]) -> Bool {
    guard let id = task["id"] as? String else { return false }
    let now = nowMs()

    if !manual {
      // Respect pause on the live path too: pauseAsync cancels schedules, but a notification
      // already in the tray (tapped after pause) or a BGTask wake still reaches dispatch.
      if paused {
        emit("onTaskSkipped", ["taskId": id, "reason": "PAUSED"])
        return false
      }
      // Not-yet-due gate: isDue() admits any task with a `background` trigger regardless of
      // nextRunAt, so a background+recurrence task must be gated on its computed nextRunAt here
      // or it fires on every BGTask wake (ignoring its interval) and inflates the fired count.
      // A pure background task has nextRunAt == nil and still passes. Matches Web/Android.
      if let nextRunAt = task["nextRunAt"] as? Int, now < nextRunAt { return false }
      let decision = PolicyEngine.evaluate(TaskMapper.constraints(task), DeviceInfo.read(now: now))
      if !decision.eligible {
        emit("onTaskSkipped", ["taskId": id, "reason": decision.reason.rawValue])
        return false
      }
      // Admit against the budget/count consumed by other in-flight tasks in this process
      // (atomic check-then-reserve, see tryAdmit).
      if !tryAdmit(id, task, now: now) {
        emit("onTaskSkipped", ["taskId": id, "reason": "DEFERRED_BY_BUDGET"])
        return false
      }
    }

    let handler = task["handler"] as? [String: Any]
    let handlerType = handler?["type"] as? String ?? "js"
    let handlerName = handler?["name"] as? String ?? id

    emit("onTaskExecute", [
      "taskId": id,
      "triggerType": TaskMapper.primaryTriggerType(task),
      "firedAt": now,
      "attempt": 1,
      "data": data,
    ])

    if handlerType == "native" {
      let result = ConductorHandlerRegistry.shared.handler(for: handlerName)?(id, data) ?? "noData"
      clearRunning(id) // completed synchronously
      emit("onTaskComplete", ["taskId": id, "result": result, "firedAt": now, "attempt": 1, "triggerType": "background"])
    }

    // Rust handlers run via FFI through ConductorRustBridge (requires CONDUCTOR_RUST=1 at build).
    if handlerType == "rust" {
      let dataJson = (try? JSONSerialization.data(withJSONObject: data)).flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
      let result = ConductorRustBridge.dispatch(name: handlerName, taskId: id, dataJson: dataJson)
      clearRunning(id)
      emit("onTaskComplete", ["taskId": id, "result": result, "firedAt": now, "attempt": 1, "triggerType": "background"])
    }

    // A manual run-now must not advance the task's real schedule (matches Web/Android).
    if !manual { reschedule(task) }
    return true
  }

  /// Recompute nextRunAt over the recurrence, or (for a one-shot) over still-FUTURE triggers,
  /// then persist + re-arm. Mirrors WebSchedulerEngine.reschedule/futureTriggers and Android:
  /// a fired one-shot with no future trigger clears to nil so runDueBackgroundTasks (the BGTask
  /// / expo-background-task path) does not re-dispatch it on every wake.
  private func reschedule(_ task: [String: Any]) {
    let now = nowMs()
    let recurrence = TaskMapper.parseRecurrence(task)
    // Next fire = min(next recurrence, still-FUTURE one-shot triggers); clears to nil when none
    // remain. `computeNextRunAt(..., futureOnly: true)` folds the recurrence param plus future-only
    // one-shots into `candidates.min()`, exactly like WebSchedulerEngine.reschedule/futureTriggers —
    // so a task with BOTH a recurrence AND a sooner one-shot honors both, and a fired one-shot with
    // nothing future stops.
    let next = TaskMapper.computeNextRunAt(task, recurrence, now, futureOnly: true)
    var updated = task
    updated["nextRunAt"] = next ?? NSNull()
    store.upsert(updated)
    schedule(updated)
  }

  // MARK: - native handler registration

  /// Register a native handler so a task's work can run without JS.
  public static func registerHandler(name: String, handler: @escaping ConductorTaskHandler) {
    ConductorHandlerRegistry.shared.register(name, handler)
  }

  public static func unregisterHandler(name: String) {
    ConductorHandlerRegistry.shared.unregister(name)
  }
}
