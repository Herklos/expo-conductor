import Foundation

/// Durable task storage backed by UserDefaults (JSON), mirroring the Android
/// `TaskStore` (SharedPreferences) and Web `TaskRegistry` (localStorage).
final class TaskStore {
  private let defaults = UserDefaults.standard
  private let key = "expo.modules.conductor.tasks"

  func all() -> [[String: Any]] {
    guard let data = defaults.data(forKey: key),
          let array = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]]
    else { return [] }
    return array
  }

  func get(_ id: String) -> [String: Any]? {
    all().first { ($0["id"] as? String) == id }
  }

  func upsert(_ task: [String: Any]) {
    var list = all().filter { ($0["id"] as? String) != (task["id"] as? String) }
    list.append(task)
    persist(list)
  }

  @discardableResult
  func remove(_ id: String) -> Bool {
    let list = all()
    let filtered = list.filter { ($0["id"] as? String) != id }
    guard filtered.count != list.count else { return false }
    persist(filtered)
    return true
  }

  func clear() { defaults.removeObject(forKey: key) }

  private func persist(_ list: [[String: Any]]) {
    guard let data = try? JSONSerialization.data(withJSONObject: list) else { return }
    defaults.set(data, forKey: key)
  }
}
