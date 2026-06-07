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
      self?.runDueBackgroundTasks() ?? 0
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
  }

  /// Emit a JS event on the main thread (triggers run on notification/BGTask threads).
  private func emit(_ name: String, _ payload: [String: Any]) {
    DispatchQueue.main.async { [weak self] in self?.sendEvent(name, payload) }
  }

  /// Run every task that is currently due (used by the BGTask launch handler). Returns the
  /// number of tasks fired.
  @discardableResult
  func runDueBackgroundTasks() -> Int {
    let now = nowMs()
    let due = store.all().filter { Self.isDue($0, now: now) }
    // Count tasks actually fired, not merely due (policy/budget can skip some).
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
    guard let id = task["id"] as? String,
          let handler = task["handler"] as? [String: Any],
          (handler["type"] as? String) == "native" else { return }
    if TaskStore().isPaused() { return }
    // Honor execution policy (esp. expiry/window/charging) even on the headless path.
    let now = Int(Date().timeIntervalSince1970 * 1000)
    guard PolicyEngine.evaluate(TaskMapper.constraints(task), DeviceInfo.read(now: now)).eligible else { return }
    let name = handler["name"] as? String ?? id
    _ = ConductorHandlerRegistry.shared.handler(for: name)?(id, data)
    if let recurrence = TaskMapper.parseRecurrence(task),
       let next = RecurrenceEngine.nextRun(recurrence, Int(Date().timeIntervalSince1970 * 1000)) {
      var updated = task
      updated["nextRunAt"] = next
      TaskStore().upsert(updated)
      NotificationScheduler.schedule(id: id, fireAtMs: next, title: nil, body: nil)
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

    if let nextRunAt = nextRunAt {
      // time / notification / alarm all map to a local notification on iOS.
      let notif = (task["triggers"] as? [[String: Any]])?.first { ($0["type"] as? String) == "notification" }
      NotificationScheduler.schedule(
        id: id,
        fireAtMs: nextRunAt,
        title: notif?["title"] as? String,
        body: notif?["body"] as? String
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

    advanceRecurrence(task)
    return true
  }

  private func advanceRecurrence(_ task: [String: Any]) {
    guard let recurrence = TaskMapper.parseRecurrence(task),
          let next = RecurrenceEngine.nextRun(recurrence, nowMs())
    else { return }
    var updated = task
    updated["nextRunAt"] = next
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
