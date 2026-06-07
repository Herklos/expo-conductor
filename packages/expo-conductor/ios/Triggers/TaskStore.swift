import Foundation

/// Durable task storage backed by UserDefaults (JSON), mirroring the Android
/// `TaskStore` (SharedPreferences) and Web `TaskRegistry` (localStorage).
///
/// All read-modify-write mutations are serialized on a single static queue because the
/// notification delegate, BGTask handler, push handler and JS module can mutate the store
/// from different threads; without this the compound read→modify→write would lose updates.
final class TaskStore {
  private let defaults = UserDefaults.standard
  private let key = "expo.modules.conductor.tasks"
  private let pausedKey = "expo.modules.conductor.paused"
  private static let queue = DispatchQueue(label: "expo.conductor.taskstore")

  func all() -> [[String: Any]] {
    Self.queue.sync { readAll() }
  }

  private func readAll() -> [[String: Any]] {
    guard let data = defaults.data(forKey: key),
          let array = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]]
    else { return [] }
    return array
  }

  func get(_ id: String) -> [String: Any]? {
    Self.queue.sync { readAll().first { ($0["id"] as? String) == id } }
  }

  func upsert(_ task: [String: Any]) {
    Self.queue.sync {
      var list = readAll().filter { ($0["id"] as? String) != (task["id"] as? String) }
      list.append(task)
      persist(list)
    }
  }

  @discardableResult
  func remove(_ id: String) -> Bool {
    Self.queue.sync {
      let list = readAll()
      let filtered = list.filter { ($0["id"] as? String) != id }
      guard filtered.count != list.count else { return false }
      persist(filtered)
      return true
    }
  }

  func clear() { Self.queue.sync { defaults.removeObject(forKey: key) } }

  /// Whether the conductor is paused. Persisted so the headless paths can honor it.
  func isPaused() -> Bool { Self.queue.sync { defaults.bool(forKey: pausedKey) } }

  func setPaused(_ value: Bool) { Self.queue.sync { defaults.set(value, forKey: pausedKey) } }

  private func persist(_ list: [[String: Any]]) {
    guard let data = try? JSONSerialization.data(withJSONObject: list) else { return }
    defaults.set(data, forKey: key)
  }
}
