import Foundation
import UserNotifications
#if canImport(BackgroundTasks)
import BackgroundTasks
#endif
// BGContinuedProcessingTask requires iOS 26 / macOS 26.
#if canImport(BackgroundTasks)
// NOTE: BGContinuedProcessingTaskRequest is only available on iOS 26+.
// All use sites are guarded by #available(iOS 26, *).
#endif

/// Schedules local notifications that fire conductor tasks. Used for `time`,
/// `notification` and (as the iOS fallback) `alarm` triggers.
enum NotificationScheduler {
  static func schedule(id: String, fireAtMs: Int, title: String?, body: String?) {
    let center = UNUserNotificationCenter.current()
    let content = UNMutableNotificationContent()
    content.title = title ?? "Task"
    if let body = body { content.body = body }
    // `conductorLocal` distinguishes our app-scheduled LOCAL notifications from another library's
    // when the delegate claims a delivery. It is NOT a security boundary — a remote sender CAN
    // forge it (APNs delivers arbitrary custom userInfo keys) — so the delegate's real
    // local-vs-remote gate is the OS-set trigger class (`UNPushNotificationTrigger`), not this key.
    content.userInfo = ["conductorTask": id, "conductorLocal": true]

    let interval = max(1.0, Double(fireAtMs) / 1000.0 - Date().timeIntervalSince1970)
    let trigger = UNTimeIntervalNotificationTrigger(timeInterval: interval, repeats: false)
    let request = UNNotificationRequest(identifier: id, content: content, trigger: trigger)
    center.add(request)
  }

  static func cancel(id: String) {
    UNUserNotificationCenter.current().removePendingNotificationRequests(withIdentifiers: [id])
  }
}

/// Schedules OS background app-refresh tasks via BGTaskScheduler. The identifier must be
/// listed in Info.plist `BGTaskSchedulerPermittedIdentifiers` (the config plugin does
/// this) and `registerLaunchHandlers(_:)` must run during app launch (done by
/// `ConductorAppDelegate`).
enum BackgroundScheduler {
  static let refreshIdentifier     = "software.drakkar.expoconductor.refresh"
  static let processingIdentifier  = "software.drakkar.expoconductor.processing"
  static let continuedIdentifier   = "software.drakkar.expoconductor.continued"
  private static var registered = false

  /// Register both BGTask launch handlers. Must be called before the app finishes
  /// launching (BGTaskScheduler requirement). Each handler runs `onLaunch`, completes the
  /// task, and re-submits the next request (BGTasks are one-shot).
  static func registerLaunchHandlers(_ onLaunch: @escaping () -> Void) {
    #if canImport(BackgroundTasks)
    guard !registered else { return }
    registered = true

    // BGAppRefreshTask — short background window (~30 s).
    BGTaskScheduler.shared.register(forTaskWithIdentifier: refreshIdentifier, using: nil) { task in
      // Re-arm before doing work so the cadence continues even if work is cut short.
      scheduleRefresh(earliestMs: nil)
      task.expirationHandler = { task.setTaskCompleted(success: false) }
      onLaunch()
      task.setTaskCompleted(success: true)
    }

    // BGProcessingTask — long background window (~30 min CPU + network).
    BGTaskScheduler.shared.register(forTaskWithIdentifier: processingIdentifier, using: nil) { task in
      scheduleProcessing(earliestMs: nil, requiresNetwork: false, requiresCharging: false)
      task.expirationHandler = { task.setTaskCompleted(success: false) }
      onLaunch()
      task.setTaskCompleted(success: true)
    }

    // BGContinuedProcessingTask — iOS 26+. Initiated by user action; continues after backgrounding.
    if #available(iOS 26, *) {
      BGTaskScheduler.shared.register(forTaskWithIdentifier: continuedIdentifier, using: nil) { task in
        task.expirationHandler = { task.setTaskCompleted(success: false) }
        onLaunch()
        task.setTaskCompleted(success: true)
      }
    }
    #endif
  }

  static func scheduleRefresh(earliestMs: Int?) {
    #if canImport(BackgroundTasks)
    let request = BGAppRefreshTaskRequest(identifier: refreshIdentifier)
    if let earliestMs = earliestMs {
      request.earliestBeginDate = Date(timeIntervalSince1970: Double(earliestMs) / 1000.0)
    }
    do {
      try BGTaskScheduler.shared.submit(request)
    } catch {
      // Surface instead of swallowing: usually a missing Info.plist identifier or
      // Background App Refresh being disabled.
      NSLog("[expo-conductor] BGTaskScheduler.submit failed: \(error.localizedDescription)")
    }
    #endif
  }

  /// Submit a BGProcessingTaskRequest for tasks that declare `bgProcessing: true`.
  /// BGProcessingTask allows ~30 min of CPU + network — suitable for heavy sync work.
  static func scheduleProcessing(earliestMs: Int?, requiresNetwork: Bool, requiresCharging: Bool) {
    #if canImport(BackgroundTasks)
    let request = BGProcessingTaskRequest(identifier: processingIdentifier)
    if let earliestMs = earliestMs {
      request.earliestBeginDate = Date(timeIntervalSince1970: Double(earliestMs) / 1000.0)
    }
    request.requiresNetworkConnectivity = requiresNetwork
    request.requiresExternalPower = requiresCharging
    do {
      try BGTaskScheduler.shared.submit(request)
    } catch {
      NSLog("[expo-conductor] BGTaskScheduler.submit(processing) failed: \(error.localizedDescription)")
    }
    #endif
  }

  /// Submit a BGContinuedProcessingTaskRequest (iOS 26+). Must be called from a user-action
  /// context (button press, etc.) — the OS denies requests without user context.
  static func submitContinued() {
    #if canImport(BackgroundTasks)
    if #available(iOS 26, *) {
      let request = BGContinuedProcessingTaskRequest(identifier: continuedIdentifier)
      do {
        try BGTaskScheduler.shared.submit(request)
      } catch {
        NSLog("[expo-conductor] BGTaskScheduler.submit(continued) failed: \(error.localizedDescription)")
      }
    }
    #endif
  }

  /// Cancel any pending background requests (used by pauseAsync so a background wake
  /// can't run work while paused). resumeAsync re-submits via the normal schedule path.
  static func cancel() {
    #if canImport(BackgroundTasks)
    BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: refreshIdentifier)
    BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: processingIdentifier)
    #endif
  }
}
