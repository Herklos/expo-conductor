import ExpoModulesCore
#if canImport(UIKit)
import UIKit
#endif

/// Registered via `expo-module.config.json` (apple.appDelegateSubscribers). Runs during
/// `application(_:didFinishLaunchingWithOptions:)` — the point at which BGTaskScheduler
/// requires its launch handlers to be registered, and the right place to install the
/// notification delegate.
public class ConductorAppDelegate: ExpoAppDelegateSubscriber {
  public func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    ConductorNotificationDelegate.install()
    BackgroundScheduler.registerLaunchHandlers {
      // When woken into the background, the JS module may not exist yet; fall back to a
      // headless path that still runs native handlers.
      if let module = ExpoConductorModule.shared {
        module.runDueBackgroundTasks()
      } else {
        ExpoConductorModule.runDueBackgroundTasksHeadless()
      }
    }
    return true
  }

  /// APNs data-message path for `push` triggers (the iOS counterpart of Android's FCM
  /// service). A remote notification carrying `conductorTask` dispatches the matching task.
  ///
  /// Security: only tasks that explicitly declare a `push` trigger with a matching
  /// `matchKey` are dispatched — a forged push cannot trigger arbitrary tasks by id. The
  /// remote `userInfo` passed to handlers is untrusted input.
  @objc
  public func application(
    _ application: UIApplication,
    didReceiveRemoteNotification userInfo: [AnyHashable: Any],
    fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void
  ) {
    guard let key = userInfo["conductorTask"] as? String else {
      completionHandler(.noData)
      return
    }
    let task = TaskStore().all().first { task in
      let triggers = task["triggers"] as? [[String: Any]] ?? []
      return triggers.contains {
        ($0["type"] as? String) == "push" && ($0["matchKey"] as? String) == key
      }
    }
    guard let task else {
      completionHandler(.noData)
      return
    }
    // Pass the custom payload to handlers, minus the APNs internal `aps` envelope.
    var data = userInfo as? [String: Any] ?? [:]
    data.removeValue(forKey: "aps")
    if let module = ExpoConductorModule.shared {
      module.dispatch(task, manual: false, data: data)
    } else {
      ExpoConductorModule.dispatchHeadless(task, data: data)
    }
    completionHandler(.newData)
  }
}
