import Foundation
import UserNotifications

/// Receives local-notification deliveries and dispatches the matching conductor task,
/// so `notification` / `time` / `alarm` triggers actually run their handler on iOS.
///
/// To avoid clobbering another library's notification handling (e.g. expo-notifications),
/// this captures any pre-existing `UNUserNotificationCenter` delegate and forwards
/// notifications it does not own — anything that is a REMOTE push (`UNPushNotificationTrigger`,
/// the unforgeable OS-set class) or a local notification lacking our `conductorLocal` marker.
final class ConductorNotificationDelegate: NSObject, UNUserNotificationCenterDelegate {
  static let shared = ConductorNotificationDelegate()
  // Held strongly: UNUserNotificationCenter.delegate is itself weak, so once we install
  // ourselves the center no longer retains the delegate we displaced — we must keep it
  // alive to forward foreign notifications to it.
  private var previousDelegate: UNUserNotificationCenterDelegate?

  // Dedup the two callbacks for a SINGLE delivery: when the app is foreground, willPresent
  // (delivery) runs the task, and if the user then taps the banner, didReceive fires for the
  // SAME notification — without this both would dispatch, double-running a non-idempotent
  // handler. Keyed on the request identifier PLUS the delivery time: willPresent and didReceive
  // of one delivery share the same notification.date (-> same key, deduped), while a genuinely
  // new occurrence (a re-armed one-shot notification) has a new delivery time (-> new key, NOT
  // suppressed). This is correct even for sub-30s recurrences, which the previous fixed 30s
  // wall-clock window silently stalled — it suppressed the real next occurrence, so the
  // re-arm (advanceRecurrence) never ran and the notification chain died after occurrence #2.
  private let dedupLock = NSLock()
  private var handledKeys: [String: Date] = [:]
  private let dedupRetention: TimeInterval = 60 // prune handled keys older than this (bounds memory)

  /// Run `handle(userInfo)` at most once per (notification identifier + delivery time).
  private func handleOnce(_ identifier: String, deliveredAt: Date, _ userInfo: [AnyHashable: Any]) {
    let key = "\(identifier)#\(Int(deliveredAt.timeIntervalSince1970 * 1000))"
    let now = Date()
    dedupLock.lock()
    handledKeys = handledKeys.filter { now.timeIntervalSince($0.value) < dedupRetention }
    if handledKeys[key] != nil {
      dedupLock.unlock()
      return
    }
    handledKeys[key] = now
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
    // Claim only OUR LOCAL notifications. AUTHORITATIVE gate: the OS-set trigger CLASS, which a
    // remote sender CANNOT forge — a remote push is a `UNPushNotificationTrigger`; a local one is a
    // `UNTimeIntervalNotificationTrigger` (or nil for an immediate local). `conductorLocal` merely
    // distinguishes our local notifications from another library's; it is attacker-forgeable (APNs
    // delivers arbitrary custom keys into userInfo) so it is NOT a security boundary on its own. A
    // forged remote alert carrying conductorTask/conductorLocal is therefore forwarded, not
    // dispatched. Remote pushes that legitimately drive tasks use the matchKey-gated path in
    // ConductorAppDelegate.
    let isRemote = notification.request.trigger is UNPushNotificationTrigger
    if !isRemote, (userInfo["conductorLocal"] as? Bool) == true {
      handleOnce(notification.request.identifier, deliveredAt: notification.date, userInfo)
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
    // Same authoritative trigger-class gate as willPresent: a remote push (forgeable userInfo) is
    // forwarded, never dispatched by bare id.
    let isRemote = response.notification.request.trigger is UNPushNotificationTrigger
    if !isRemote, (userInfo["conductorLocal"] as? Bool) == true {
      handleOnce(response.notification.request.identifier, deliveredAt: response.notification.date, userInfo)
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
    // The AUTHORITATIVE local-vs-remote gate is the OS trigger-class check at the
    // willPresent/didReceive call sites — a remote push never reaches here. handle() has no access
    // to the trigger, so the `conductorLocal` guard below is only belt-and-suspenders (the marker
    // is attacker-forgeable, so on its own it is NOT a security boundary).
    guard (userInfo["conductorLocal"] as? Bool) == true,
          let id = userInfo["conductorTask"] as? String,
          let task = TaskStore().get(id) else { return }
    let data = userInfo as? [String: Any] ?? [:]
    if let module = ExpoConductorModule.shared {
      module.dispatch(task, manual: false, data: data, firedBy: "notification")
    } else {
      ExpoConductorModule.dispatchHeadless(task, data: data, firedBy: "notification")
    }
  }
}
