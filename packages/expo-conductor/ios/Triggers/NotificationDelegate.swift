import Foundation
import UserNotifications

/// Receives local-notification deliveries and dispatches the matching conductor task,
/// so `notification` / `time` / `alarm` triggers actually run their handler on iOS.
///
/// To avoid clobbering another library's notification handling (e.g. expo-notifications),
/// this captures any pre-existing `UNUserNotificationCenter` delegate and forwards
/// notifications it does not own (those without a `conductorTask` userInfo key).
final class ConductorNotificationDelegate: NSObject, UNUserNotificationCenterDelegate {
  static let shared = ConductorNotificationDelegate()
  // Held strongly: UNUserNotificationCenter.delegate is itself weak, so once we install
  // ourselves the center no longer retains the delegate we displaced — we must keep it
  // alive to forward foreign notifications to it.
  private var previousDelegate: UNUserNotificationCenterDelegate?

  // Dedup the two callbacks for a SINGLE delivery: when the app is foreground, willPresent
  // (delivery) runs the task, and if the user then taps the banner, didReceive fires for the
  // same notification — without this both would dispatch, double-running a non-idempotent
  // handler. Keyed on the request identifier with a window shorter than iOS's 60s minimum
  // repeat interval, so a genuine later re-delivery of a repeating notification is NOT
  // suppressed.
  private let dedupLock = NSLock()
  private var lastHandledAt: [String: Date] = [:]
  private let dedupWindow: TimeInterval = 30

  /// Run `handle(userInfo)` at most once per notification `identifier` within `dedupWindow`.
  private func handleOnce(_ identifier: String, _ userInfo: [AnyHashable: Any]) {
    let now = Date()
    dedupLock.lock()
    lastHandledAt = lastHandledAt.filter { now.timeIntervalSince($0.value) < dedupWindow }
    if let last = lastHandledAt[identifier], now.timeIntervalSince(last) < dedupWindow {
      dedupLock.unlock()
      return
    }
    lastHandledAt[identifier] = now
    dedupLock.unlock()
    handle(userInfo)
  }

  static func install() {
    let center = UNUserNotificationCenter.current()
    if center.delegate !== shared {
      shared.previousDelegate = center.delegate
      center.delegate = shared
    }
  }

  func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    willPresent notification: UNNotification,
    withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
  ) {
    let userInfo = notification.request.content.userInfo
    if userInfo["conductorTask"] != nil {
      handleOnce(notification.request.identifier, userInfo)
      completionHandler([.banner, .list, .sound])
      return
    }
    // Not ours — forward to the previous delegate, or default if it doesn't implement it.
    let forwarded: Void? = previousDelegate?.userNotificationCenter?(
      center, willPresent: notification, withCompletionHandler: completionHandler
    )
    if forwarded == nil { completionHandler([.banner, .list, .sound]) }
  }

  func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    didReceive response: UNNotificationResponse,
    withCompletionHandler completionHandler: @escaping () -> Void
  ) {
    let userInfo = response.notification.request.content.userInfo
    if userInfo["conductorTask"] != nil {
      handleOnce(response.notification.request.identifier, userInfo)
      completionHandler()
      return
    }
    let forwarded: Void? = previousDelegate?.userNotificationCenter?(
      center, didReceive: response, withCompletionHandler: completionHandler
    )
    if forwarded == nil { completionHandler() }
  }

  /// Dispatch the conductor task named by the notification's `conductorTask` userInfo key.
  /// Falls back to a headless native dispatch when no live module/JS instance exists.
  func handle(_ userInfo: [AnyHashable: Any]) {
    guard let id = userInfo["conductorTask"] as? String,
          let task = TaskStore().get(id) else { return }
    let data = userInfo as? [String: Any] ?? [:]
    if let module = ExpoConductorModule.shared {
      module.dispatch(task, manual: false, data: data)
    } else {
      ExpoConductorModule.dispatchHeadless(task, data: data)
    }
  }
}
