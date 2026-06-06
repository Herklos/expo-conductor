import Foundation

/// Contract for a *native* task handler on iOS. App developers register a closure
/// with `ExpoConductorModule.registerHandler(name:handler:)` so a task's work can
/// run on the native side without crossing into JS — the iOS half of the
/// "JS or native handler" dual dispatch.
///
/// Returns one of: "success", "failed", "newData", "noData".
public typealias ConductorTaskHandler = (_ taskId: String, _ data: [String: Any]) -> String

/// Registry for native handlers, shared across the module and triggers.
public final class ConductorHandlerRegistry {
  public static let shared = ConductorHandlerRegistry()
  private var handlers: [String: ConductorTaskHandler] = [:]
  private let queue = DispatchQueue(label: "expo.conductor.handlers")

  public func register(_ name: String, _ handler: @escaping ConductorTaskHandler) {
    queue.sync { handlers[name] = handler }
  }

  public func unregister(_ name: String) {
    queue.sync { handlers[name] = nil }
  }

  public func handler(for name: String) -> ConductorTaskHandler? {
    queue.sync { handlers[name] }
  }
}
