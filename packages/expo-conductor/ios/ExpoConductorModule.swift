import ExpoModulesCore
import Foundation

/// iOS Expo module for expo-conductor. Implements the same JS-facing contract as the
/// Web engine (`ConductorBackend`) using UNUserNotificationCenter for time/notification
/// triggers and BGTaskScheduler for background work, while delegating all decision
/// logic to the shared, fixture-verified engine types.
public class ExpoConductorModule: Module {
  static weak var shared: ExpoConductorModule?
  private let store = TaskStore()
  private var paused = false
  private var budget = ResourceWeight(cpu: 1, network: 1, battery: 1, memory: 1)

  private func nowMs() -> Int { Int(Date().timeIntervalSince1970 * 1000) }

  public func definition() -> ModuleDefinition {
    Name("ExpoConductorModule")

    Events("onTaskExecute", "onTaskComplete", "onTaskError", "onTaskSkipped")

    OnCreate {
      ExpoConductorModule.shared = self
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

    AsyncFunction("setResourceBudgetAsync") { [weak self] (budget: [String: Any]) in
      self?.budget = TaskMapper.weight(budget)
    }

    AsyncFunction("pauseAsync") { [weak self] in
      guard let self else { return }
      self.paused = true
      for task in self.store.all() {
        if let id = task["id"] as? String { self.unschedule(id) }
      }
    }

    AsyncFunction("resumeAsync") { [weak self] in
      guard let self else { return }
      self.paused = false
      for task in self.store.all() { self.schedule(task) }
    }

    AsyncFunction("reportResultAsync") { [weak self] (id: String, result: String) in
      guard let self else { return }
      self.sendEvent("onTaskComplete", [
        "taskId": id, "result": result, "firedAt": self.nowMs(), "attempt": 1, "triggerType": "background",
      ])
    }
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
      BackgroundScheduler.scheduleRefresh(earliestMs: nextRunAt)
    }
  }

  private func unschedule(_ id: String) {
    NotificationScheduler.cancel(id: id)
  }

  private func hasBackgroundTrigger(_ task: [String: Any]) -> Bool {
    (task["triggers"] as? [[String: Any]])?.contains { ($0["type"] as? String) == "background" } ?? false
  }

  // MARK: - dispatch

  /// Called by triggers (notification delivery, background refresh, remote push).
  func dispatch(_ task: [String: Any], manual: Bool, data: [String: Any] = [:]) {
    guard let id = task["id"] as? String else { return }
    let now = nowMs()

    if !manual {
      let decision = PolicyEngine.evaluate(TaskMapper.constraints(task), DeviceInfo.read(now: now))
      if !decision.eligible {
        sendEvent("onTaskSkipped", ["taskId": id, "reason": decision.reason.rawValue])
        return
      }
      let admission = WeightEngine.admit(budget, [TaskMapper.weightedTask(task, now: now)])
      if !admission.admitted.contains(id) {
        sendEvent("onTaskSkipped", ["taskId": id, "reason": "DEFERRED_BY_BUDGET"])
        return
      }
    }

    let handler = task["handler"] as? [String: Any]
    let handlerType = handler?["type"] as? String ?? "js"
    let handlerName = handler?["name"] as? String ?? id

    sendEvent("onTaskExecute", [
      "taskId": id,
      "triggerType": TaskMapper.primaryTriggerType(task),
      "firedAt": now,
      "attempt": 1,
      "data": data,
    ])

    if handlerType == "native" {
      let result = ConductorHandlerRegistry.shared.handler(for: handlerName)?(id, data) ?? "noData"
      sendEvent("onTaskComplete", ["taskId": id, "result": result, "firedAt": now, "attempt": 1, "triggerType": "background"])
    }

    advanceRecurrence(task)
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
