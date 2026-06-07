import XCTest
@testable import ExpoConductor

/// Runs the shared cross-platform behavior fixtures from the repo-root `fixtures`
/// directory through the Swift engine. These are the same cases the TypeScript
/// (Jest) and Kotlin (JUnit) suites assert, guaranteeing identical behavior on every
/// platform. Run on macOS via `xcodebuild test` or `swift test`.
final class EngineFixtureTests: XCTestCase {
  private func fixturesURL() -> URL {
    var url = URL(fileURLWithPath: #filePath) // .../ios/Tests/EngineFixtureTests.swift
    for _ in 0..<5 { url.deleteLastPathComponent() } // -> repo root
    return url.appendingPathComponent("fixtures")
  }

  private func load(_ file: String) throws -> [String: Any] {
    let data = try Data(contentsOf: fixturesURL().appendingPathComponent(file))
    return try JSONSerialization.jsonObject(with: data) as! [String: Any]
  }

  private func cases(_ file: String) throws -> [[String: Any]] {
    try (load(file)["cases"] as! [[String: Any]])
  }

  private func recurrence(_ spec: [String: Any]) -> Recurrence {
    switch spec["kind"] as! String {
    case "interval":
      return .interval(everyMs: spec["everyMs"] as! Int, anchor: spec["anchor"] as? Int ?? 0)
    case "daily":
      return .daily(hour: spec["hour"] as! Int, minute: spec["minute"] as! Int)
    case "weekly":
      return .weekly(weekday: spec["weekday"] as! Int, hour: spec["hour"] as! Int, minute: spec["minute"] as! Int)
    default:
      return .cron(expression: spec["expression"] as! String)
    }
  }

  private func weight(_ o: [String: Any]) -> ResourceWeight {
    ResourceWeight(
      cpu: (o["cpu"] as! NSNumber).doubleValue,
      network: (o["network"] as! NSNumber).doubleValue,
      battery: (o["battery"] as! NSNumber).doubleValue,
      memory: (o["memory"] as! NSNumber).doubleValue
    )
  }

  func testRecurrence() throws {
    for c in try cases("recurrence.cases.json") {
      let expected = c["expected"] as? Int
      let actual = RecurrenceEngine.nextRun(recurrence(c["spec"] as! [String: Any]), c["fromMs"] as! Int)
      XCTAssertEqual(actual, expected, c["name"] as! String)
    }
  }

  func testPriority() throws {
    for c in try cases("priority.cases.json") {
      let items = (c["tasks"] as! [[String: Any]]).map {
        PriorityEngine.Item(id: $0["id"] as! String, priority: $0["priority"] as! Int, dueAt: $0["dueAt"] as! Int)
      }
      XCTAssertEqual(PriorityEngine.order(items), c["expected"] as! [String], c["name"] as! String)
    }
  }

  func testWeightAdmission() throws {
    for c in try cases("weight-admission.cases.json") {
      let budget = weight(c["budget"] as! [String: Any])
      let tasks = (c["tasks"] as! [[String: Any]]).map {
        WeightEngine.Task(
          id: $0["id"] as! String,
          priority: $0["priority"] as! Int,
          dueAt: $0["dueAt"] as! Int,
          weight: weight($0["weight"] as! [String: Any]),
          maxConcurrent: $0["maxConcurrent"] as? Int
        )
      }
      let running = c["running"] as? Int ?? 0
      let used = (c["used"] as? [String: Any]).map { weight($0) }
      let expected = c["expected"] as! [String: Any]
      let result = WeightEngine.admit(budget, tasks, running: running, used: used)
      XCTAssertEqual(result.admitted, expected["admitted"] as! [String], (c["name"] as! String) + " [admitted]")
      XCTAssertEqual(result.deferred, expected["deferred"] as! [String], (c["name"] as! String) + " [deferred]")
    }
  }

  func testPolicy() throws {
    for c in try cases("policy.cases.json") {
      let co = c["constraints"] as! [String: Any]
      var window: ExecutionWindow?
      if let w = co["window"] as? [String: Any] {
        window = ExecutionWindow(earliest: w["earliest"] as? Int, latest: w["latest"] as? Int)
      }
      let constraints = Constraints(
        window: window,
        requiresCharging: co["requiresCharging"] as? Bool,
        minBatteryLevel: (co["minBatteryLevel"] as? NSNumber)?.doubleValue,
        network: co["network"] as? String,
        requiresIdle: co["requiresIdle"] as? Bool,
        expiresAt: co["expiresAt"] as? Int
      )
      let cx = c["context"] as! [String: Any]
      let context = DeviceContext(
        now: cx["now"] as! Int,
        batteryLevel: (cx["batteryLevel"] as! NSNumber).doubleValue,
        charging: cx["charging"] as! Bool,
        networkType: cx["networkType"] as! String,
        idle: cx["idle"] as! Bool
      )
      let expected = c["expected"] as! [String: Any]
      let decision = PolicyEngine.evaluate(constraints, context)
      XCTAssertEqual(decision.eligible, expected["eligible"] as! Bool, (c["name"] as! String) + " [eligible]")
      XCTAssertEqual(decision.reason.rawValue, expected["reason"] as! String, (c["name"] as! String) + " [reason]")
    }
  }
}
