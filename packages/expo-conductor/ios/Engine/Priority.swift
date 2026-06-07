import Foundation

/// Priority engine (iOS). Mirrors `web/engine/priority.ts`. Validated by
/// `fixtures/priority.cases.json`.
public enum PriorityEngine {
  public struct Item: Equatable {
    public let id: String
    public let priority: Int
    public let dueAt: Int
    public init(id: String, priority: Int, dueAt: Int) {
      self.id = id
      self.priority = priority
      self.dueAt = dueAt
    }
  }

  /// priority desc, then dueAt asc, then id asc (id compared by UTF-16 code unit to match
  /// JS/Kotlin — see `idOrderedBefore`).
  public static func isBefore(_ a: Item, _ b: Item) -> Bool {
    if a.priority != b.priority { return a.priority > b.priority }
    if a.dueAt != b.dueAt { return a.dueAt < b.dueAt }
    return idOrderedBefore(a.id, b.id)
  }

  public static func order(_ items: [Item]) -> [String] {
    items.sorted(by: isBefore).map { $0.id }
  }
}
