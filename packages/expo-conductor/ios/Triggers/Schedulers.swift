import Foundation
import UserNotifications
#if canImport(BackgroundTasks)
import BackgroundTasks
#endif

/// Schedules local notifications that fire conductor tasks. Used for `time`,
/// `notification` and (as the iOS fallback) `alarm` triggers.
enum NotificationScheduler {
  static func schedule(id: String, fireAtMs: Int, title: String?, body: String?) {
    let center = UNUserNotificationCenter.current()
    let content = UNMutableNotificationContent()
    content.title = title ?? "Task"
    if let body = body { content.body = body }
    content.userInfo = ["conductorTask": id]

    let interval = max(1.0, Double(fireAtMs) / 1000.0 - Date().timeIntervalSince1970)
    let trigger = UNTimeIntervalNotificationTrigger(timeInterval: interval, repeats: false)
    let request = UNNotificationRequest(identifier: id, content: content, trigger: trigger)
    center.add(request)
  }

  static func cancel(id: String) {
    UNUserNotificationCenter.current().removePendingNotificationRequests(withIdentifiers: [id])
  }
}

/// Schedules OS background app-refresh tasks via BGTaskScheduler. The host app must
/// register the identifier in Info.plist (the config plugin does this) and call
/// `registerLaunchHandlers()` at launch.
enum BackgroundScheduler {
  static let refreshIdentifier = "com.expoconductor.refresh"

  static func scheduleRefresh(earliestMs: Int?) {
    #if canImport(BackgroundTasks)
    let request = BGAppRefreshTaskRequest(identifier: refreshIdentifier)
    if let earliestMs = earliestMs {
      request.earliestBeginDate = Date(timeIntervalSince1970: Double(earliestMs) / 1000.0)
    }
    try? BGTaskScheduler.shared.submit(request)
    #endif
  }
}
