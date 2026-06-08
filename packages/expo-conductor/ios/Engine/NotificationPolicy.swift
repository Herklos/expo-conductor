import Foundation

/// iOS-only presentation policy: decides whether a scheduled task should surface a
/// *user-visible* local notification when it next fires, and which trigger supplies its
/// title/body.
///
/// Why this exists: on iOS the only way to wake an app at a wall-clock time is to deliver a
/// local notification, and a local notification is ALWAYS user-visible — there is no silent,
/// app-waking local notification (silent background work is `BGTaskScheduler`'s job). So the
/// module posts a banner ONLY for triggers whose visibility is intended or unavoidable:
///
///   - `notification` — explicitly user-facing (carries `title` / `body`)
///   - `time` / `alarm` — a one-shot wall-clock fire; the local notification IS the wake
///
/// A task scheduled purely by `recurrence` (or `background` / `appState` / `push`) is
/// best-effort periodic/background work driven by `BGTaskScheduler` and the foreground engine;
/// it must NOT post a banner. Before this gate, every task with a `nextRunAt` posted a banner —
/// recurrence-only tasks included — which surfaced spurious notifications titled "Task".
///
/// This mirrors Android, where `NotificationDisplay.show` is reached only via a `notification`
/// trigger. It is iOS presentation glue, NOT part of the shared cross-platform engine math
/// (recurrence / priority / weight / policy), so it has no `/fixtures` case or Kotlin mirror —
/// it is unit-tested directly (see `NotificationPolicyTests`). It is kept pure (no
/// UserNotifications / UIKit import) so it compiles into the SwiftPM test target alongside the
/// engine.
enum NotificationPolicy {
  /// The trigger that should supply a user-visible local notification for this task, or `nil`
  /// when the task should instead be woken silently via `BGTaskScheduler`. Prefers an explicit
  /// `notification` trigger (it carries `title` / `body`); falls back to a `time` / `alarm`
  /// trigger (no title — the caller applies its own default).
  static func visibleNotificationTrigger(_ triggers: [[String: Any]]) -> [String: Any]? {
    if let notif = triggers.first(where: { ($0["type"] as? String) == "notification" }) {
      return notif
    }
    return triggers.first { trigger in
      let type = trigger["type"] as? String
      return type == "time" || type == "alarm"
    }
  }

  /// Whether the task's triggers warrant a user-visible local notification at all.
  static func shouldPostLocalNotification(_ triggers: [[String: Any]]) -> Bool {
    visibleNotificationTrigger(triggers) != nil
  }
}
