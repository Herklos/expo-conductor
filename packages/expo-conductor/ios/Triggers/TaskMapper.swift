import Foundation

/// Converts the JS task definition dictionary into the normalized stored shape and
/// extracts typed engine models. Mirrors `web/normalize.ts` and Android `TaskMapper`.
enum TaskMapper {
  private static let minute = 60_000

  private static let presets: [String: ResourceWeight] = WeightEngine.presets

  /// Safely coerce a bridge/JSON value to Int (values may arrive as Int, Double or
  /// NSNumber). Avoids `as! Int` crashes on malformed payloads.
  private static func int(_ value: Any?) -> Int? {
    if let i = value as? Int { return i }
    if let n = value as? NSNumber { return n.intValue }
    if let d = value as? Double { return Int(d) }
    return nil
  }

  static func normalize(_ def: [String: Any], now: Int) -> [String: Any] {
    var task = def
    let id = (def["id"] as? String) ?? ""

    if task["handler"] == nil {
      task["handler"] = ["name": id, "type": "js"]
    }
    if task["priority"] == nil { task["priority"] = 0 }
    task["weight"] = weightDict(def["weight"])
    if task["policy"] == nil { task["policy"] = [String: Any]() }

    let rec = parseRecurrence(task)
    let result = computeNextRunAt(task, rec, now)
    task["nextRunAt"] = result.nextRunAt.map { $0 as Any } ?? NSNull()
    task["nextFiredBy"] = result.firedBy.map { $0 as Any } ?? NSNull()
    task["createdAt"] = now
    return task
  }

  static func weight(_ value: Any?) -> ResourceWeight {
    if let name = value as? String { return presets[name] ?? presets["moderate"]! }
    if let o = value as? [String: Any] {
      return ResourceWeight(
        cpu: (o["cpu"] as? NSNumber)?.doubleValue ?? 0.4,
        network: (o["network"] as? NSNumber)?.doubleValue ?? 0.4,
        battery: (o["battery"] as? NSNumber)?.doubleValue ?? 0.4,
        memory: (o["memory"] as? NSNumber)?.doubleValue ?? 0.4
      )
    }
    return presets["moderate"]!
  }

  private static func weightDict(_ value: Any?) -> [String: Any] {
    let w = weight(value)
    return ["cpu": w.cpu, "network": w.network, "battery": w.battery, "memory": w.memory]
  }

  static func parseRecurrence(_ task: [String: Any]) -> Recurrence? {
    let r: [String: Any]
    if let explicit = task["recurrence"] as? [String: Any] {
      r = explicit
    } else if let t = triggerRecurrence(task) {
      r = t
    } else {
      return nil
    }
    switch r["kind"] as? String {
    case "interval":
      guard let everyMs = int(r["everyMs"]) else { return nil }
      return .interval(everyMs: everyMs, anchor: int(r["anchor"]) ?? 0)
    case "daily":
      guard let hour = int(r["hour"]), let minute = int(r["minute"]) else { return nil }
      return .daily(hour: hour, minute: minute)
    case "weekly":
      guard let weekday = int(r["weekday"]), let hour = int(r["hour"]), let minute = int(r["minute"]) else { return nil }
      return .weekly(weekday: weekday, hour: hour, minute: minute)
    case "cron":
      guard let expression = r["expression"] as? String else { return nil }
      return .cron(expression: expression)
    default: return nil
    }
  }

  private static func triggerRecurrence(_ task: [String: Any]) -> [String: Any]? {
    guard let triggers = task["triggers"] as? [[String: Any]] else { return nil }
    for t in triggers where (t["type"] as? String) == "recurrence" {
      return t["recurrence"] as? [String: Any]
    }
    return nil
  }

  static func constraints(_ task: [String: Any]) -> Constraints {
    guard let policy = task["policy"] as? [String: Any],
          let c = policy["constraints"] as? [String: Any]
    else { return Constraints() }
    var window: ExecutionWindow?
    if let w = c["window"] as? [String: Any] {
      window = ExecutionWindow(earliest: int(w["earliest"]), latest: int(w["latest"]))
    }
    return Constraints(
      window: window,
      requiresCharging: c["requiresCharging"] as? Bool,
      minBatteryLevel: (c["minBatteryLevel"] as? NSNumber)?.doubleValue,
      network: c["network"] as? String,
      requiresIdle: c["requiresIdle"] as? Bool,
      expiresAt: int(c["expiresAt"])
    )
  }

  static func weightedTask(_ task: [String: Any], now: Int) -> WeightEngine.Task {
    let maxConcurrent = (task["policy"] as? [String: Any]).flatMap { int($0["maxConcurrent"]) }
    return WeightEngine.Task(
      id: (task["id"] as? String) ?? "",
      priority: int(task["priority"]) ?? 0,
      dueAt: int(task["nextRunAt"]) ?? now,
      weight: weight(task["weight"]),
      maxConcurrent: maxConcurrent
    )
  }

  static func weightOf(_ task: [String: Any]) -> ResourceWeight {
    weight(task["weight"])
  }

  struct NextRunResult {
    let nextRunAt: Int?
    let firedBy: String?
  }

  /// Earliest concrete fire time from the task's triggers + recurrence, and the trigger type
  /// that produced it. With `futureOnly` one-shot triggers are kept only when still future;
  /// recurring notifications (recurring==true + inSeconds) are always re-evaluated.
  ///
  /// Tie-breaking: first candidate achieving the min in iteration order wins; the explicit
  /// `recurrence` field is evaluated last — mirrors the TS/Kotlin engines.
  static func computeNextRunAt(_ task: [String: Any], _ recurrence: Recurrence?, _ now: Int, futureOnly: Bool = false) -> NextRunResult {
    var best: Int? = nil
    var bestType: String? = nil
    func consider(_ at: Int, _ type: String) {
      if best == nil || at < best! { best = at; bestType = type }
    }
    if let triggers = task["triggers"] as? [[String: Any]] {
      for t in triggers {
        switch t["type"] as? String {
        case "time":
          if let at = int(t["at"]) { if !futureOnly || at > now { consider(at, "time") } }
          else if !futureOnly, let inSeconds = int(t["inSeconds"]) { consider(now + inSeconds * 1000, "time") }
        case "notification":
          let recurring = (t["recurring"] as? Bool) ?? false
          if recurring, let inSeconds = int(t["inSeconds"]) {
            // Recurring: always re-derive, never drops on futureOnly.
            consider(now + inSeconds * 1000, "notification")
          } else if let at = int(t["at"]) {
            if !futureOnly || at > now { consider(at, "notification") }
          } else if !futureOnly, let inSeconds = int(t["inSeconds"]) {
            consider(now + inSeconds * 1000, "notification")
          }
        case "alarm":
          if let at = int(t["at"]) { if !futureOnly || at > now { consider(at, "alarm") } }
        case "recurrence":
          if let r = t["recurrence"] as? [String: Any],
             let rec = parseRecurrence(["recurrence": r]),
             let next = RecurrenceEngine.nextRun(rec, now) {
            consider(next, "recurrence")
          }
        default:
          break
        }
      }
    }
    if let rec = recurrence, let next = RecurrenceEngine.nextRun(rec, now) {
      consider(next, "recurrence")
    }
    return NextRunResult(nextRunAt: best, firedBy: bestType)
  }

  static func primaryTriggerType(_ task: [String: Any]) -> String {
    (task["triggers"] as? [[String: Any]])?.first?["type"] as? String ?? "time"
  }
}
