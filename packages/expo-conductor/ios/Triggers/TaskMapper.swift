import Foundation

/// Converts the JS task definition dictionary into the normalized stored shape and
/// extracts typed engine models. Mirrors `web/normalize.ts` and Android `TaskMapper`.
enum TaskMapper {
  private static let minute = 60_000

  private static let presets: [String: ResourceWeight] = WeightEngine.presets

  static func normalize(_ def: [String: Any], now: Int) -> [String: Any] {
    var task = def
    let id = def["id"] as! String

    if task["handler"] == nil {
      task["handler"] = ["name": id, "type": "js"]
    }
    if task["priority"] == nil { task["priority"] = 0 }
    task["weight"] = weightDict(def["weight"])
    if task["policy"] == nil { task["policy"] = [String: Any]() }

    let rec = parseRecurrence(task)
    if let next = computeNextRunAt(task, rec, now) {
      task["nextRunAt"] = next
    } else {
      task["nextRunAt"] = NSNull()
    }
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
    case "interval": return .interval(everyMs: r["everyMs"] as! Int, anchor: r["anchor"] as? Int ?? 0)
    case "daily": return .daily(hour: r["hour"] as! Int, minute: r["minute"] as! Int)
    case "weekly": return .weekly(weekday: r["weekday"] as! Int, hour: r["hour"] as! Int, minute: r["minute"] as! Int)
    case "cron": return .cron(expression: r["expression"] as! String)
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
      window = ExecutionWindow(earliest: w["earliest"] as? Int, latest: w["latest"] as? Int)
    }
    return Constraints(
      window: window,
      requiresCharging: c["requiresCharging"] as? Bool,
      minBatteryLevel: (c["minBatteryLevel"] as? NSNumber)?.doubleValue,
      network: c["network"] as? String,
      requiresIdle: c["requiresIdle"] as? Bool,
      expiresAt: c["expiresAt"] as? Int
    )
  }

  static func weightedTask(_ task: [String: Any], now: Int) -> WeightEngine.Task {
    WeightEngine.Task(
      id: task["id"] as! String,
      priority: task["priority"] as? Int ?? 0,
      dueAt: task["nextRunAt"] as? Int ?? now,
      weight: weight(task["weight"])
    )
  }

  static func computeNextRunAt(_ task: [String: Any], _ recurrence: Recurrence?, _ now: Int) -> Int? {
    var candidates: [Int] = []
    if let triggers = task["triggers"] as? [[String: Any]] {
      for t in triggers {
        switch t["type"] as? String {
        case "time", "notification":
          if let at = t["at"] as? Int { candidates.append(at) }
          else if let inSeconds = t["inSeconds"] as? Int { candidates.append(now + inSeconds * 1000) }
        case "alarm":
          if let at = t["at"] as? Int { candidates.append(at) }
        case "recurrence":
          if let r = t["recurrence"] as? [String: Any],
             let rec = parseRecurrence(["recurrence": r]),
             let next = RecurrenceEngine.nextRun(rec, now) {
            candidates.append(next)
          }
        default:
          break
        }
      }
    }
    if let rec = recurrence, let next = RecurrenceEngine.nextRun(rec, now) {
      candidates.append(next)
    }
    return candidates.min()
  }

  static func primaryTriggerType(_ task: [String: Any]) -> String {
    (task["triggers"] as? [[String: Any]])?.first?["type"] as? String ?? "time"
  }
}
