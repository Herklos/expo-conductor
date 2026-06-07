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
      ExpoConductorModule.shared?.runDueBackgroundTasks()
    }
    return true
  }
}
