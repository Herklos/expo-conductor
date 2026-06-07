import Foundation
import UserNotifications

/// Receives local-notification deliveries and dispatches the matching conductor task,
/// so `notification` / `time` / `alarm` triggers actually run their handler on iOS.
///
/// NOTE: this sets the shared `UNUserNotificationCenter` delegate. If the host app (or
/// another library such as expo-notifications) also needs that delegate, install this
/// before/after them deliberately, or forward deliveries to `handle(_:)`.
final class ConductorNotificationDelegate: NSObject, UNUserNotificationCenterDelegate {
  static let shared = ConductorNotificationDelegate()

  static func install() {
    UNUserNotificationCenter.current().delegate = shared
  }

  func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    willPresent notification: UNNotification,
    withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
  ) {
    handle(notification.request.content.userInfo)
    completionHandler([.banner, .list, .sound])
  }

  func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    didReceive response: UNNotificationResponse,
    withCompletionHandler completionHandler: @escaping () -> Void
  ) {
    handle(response.notification.request.content.userInfo)
    completionHandler()
  }

  /// Dispatch the conductor task named by the notification's `conductorTask` userInfo key.
  func handle(_ userInfo: [AnyHashable: Any]) {
    guard let id = userInfo["conductorTask"] as? String,
          let task = TaskStore().get(id) else { return }
    ExpoConductorModule.shared?.dispatch(task, manual: false)
  }
}
