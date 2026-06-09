import Foundation

/**
 * Append-only ring-buffer store for `TaskExecutionEvent` objects, backed by
 * `UserDefaults`. Mirrors the Android `ExecutionLogStore` and the web `ExecutionLog`
 * so `foldHistory()` (pure TS) works identically on all platforms.
 *
 * Events are written from the main-thread `emit(...)` helper in
 * `ExpoConductorModule`, so every lifecycle event — including headless/background
 * runs via `ConductorAppDelegate` — is captured even when no JS runtime exists.
 *
 * Capacity: 200 events (oldest dropped when exceeded).
 */
class ExecutionLog {
  private static let defaultsKey = "expo_conductor_exec_log"
  private static let capacity = 200
  private let lock = NSLock()

  private var defaults: UserDefaults { .standard }

  /// Append a lifecycle event to the ring buffer.
  func append(_ event: [String: Any]) {
    lock.lock(); defer { lock.unlock() }
    var events = load()
    events.append(event)
    if events.count > Self.capacity {
      events = Array(events.suffix(Self.capacity))
    }
    persist(events)
  }

  /// Return all persisted events in append order (oldest first).
  func all() -> [[String: Any]] {
    lock.lock(); defer { lock.unlock() }
    return load()
  }

  /// Clear the ring buffer.
  func clear() {
    lock.lock(); defer { lock.unlock() }
    defaults.removeObject(forKey: Self.defaultsKey)
  }

  // MARK: - private

  private func load() -> [[String: Any]] {
    guard
      let data = defaults.data(forKey: Self.defaultsKey),
      let decoded = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]]
    else { return [] }
    return decoded
  }

  private func persist(_ events: [[String: Any]]) {
    guard let data = try? JSONSerialization.data(withJSONObject: events) else { return }
    defaults.set(data, forKey: Self.defaultsKey)
  }

  /// Convert a lifecycle event name + payload to a serializable TaskExecutionEvent dict.
  static func buildEvent(name: String, payload: [String: Any]) -> [String: Any] {
    let kind: String
    switch name {
    case "onTaskExecute": kind = "execute"
    case "onTaskComplete": kind = "complete"
    case "onTaskError": kind = "error"
    case "onTaskSkipped": kind = "skipped"
    default: kind = name
    }
    var event: [String: Any] = [
      "kind": kind,
      "taskId": payload["taskId"] as? String ?? "",
      "triggeredAt": Int(Date().timeIntervalSince1970 * 1000),
    ]
    if let v = payload["triggerType"] { event["triggerType"] = v }
    if let v = payload["attempt"] { event["attempt"] = v }
    if let v = payload["result"] { event["result"] = v }
    if let v = payload["error"] { event["error"] = v }
    if let v = payload["reason"] { event["reason"] = v }
    return event
  }
}
