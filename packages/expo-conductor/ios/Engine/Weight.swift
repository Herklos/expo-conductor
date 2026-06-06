import Foundation

/// Weight / resource-budget admission engine (iOS). Mirrors `web/engine/weight.ts`.
/// Validated by `fixtures/weight-admission.cases.json`.
public enum WeightEngine {
  public struct Task: Equatable {
    public let id: String
    public let priority: Int
    public let dueAt: Int
    public let weight: ResourceWeight
    public init(id: String, priority: Int, dueAt: Int, weight: ResourceWeight) {
      self.id = id
      self.priority = priority
      self.dueAt = dueAt
      self.weight = weight
    }
  }

  public struct Admission: Equatable {
    public let admitted: [String]
    public let deferred: [String]
  }

  static let presets: [String: ResourceWeight] = [
    "light": ResourceWeight(cpu: 0.1, network: 0.1, battery: 0.1, memory: 0.1),
    "moderate": ResourceWeight(cpu: 0.4, network: 0.4, battery: 0.4, memory: 0.4),
    "heavy": ResourceWeight(cpu: 0.8, network: 0.8, battery: 0.8, memory: 0.8),
  ]

  private static func isBefore(_ a: Task, _ b: Task) -> Bool {
    if a.priority != b.priority { return a.priority > b.priority }
    if a.dueAt != b.dueAt { return a.dueAt < b.dueAt }
    return a.id < b.id
  }

  /// Skip-over greedy admission ordered by the priority comparator.
  public static func admit(_ budget: ResourceWeight, _ tasks: [Task]) -> Admission {
    let ordered = tasks.sorted(by: isBefore)
    var cpu = 0.0, network = 0.0, battery = 0.0, memory = 0.0
    var admitted: [String] = []
    var deferred: [String] = []
    for task in ordered {
      let w = task.weight
      let fits = cpu + w.cpu <= budget.cpu
        && network + w.network <= budget.network
        && battery + w.battery <= budget.battery
        && memory + w.memory <= budget.memory
      if fits {
        cpu += w.cpu; network += w.network; battery += w.battery; memory += w.memory
        admitted.append(task.id)
      } else {
        deferred.append(task.id)
      }
    }
    return Admission(admitted: admitted, deferred: deferred)
  }
}
