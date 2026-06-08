import XCTest
@testable import ExpoConductor

/// Unit tests for the iOS notification-presentation gate (`NotificationPolicy`).
///
/// This is iOS-only presentation glue, not shared cross-platform engine math, so it has no
/// `/fixtures` case — it is asserted directly here (like the Web-only `singleFlight`/`appState`
/// logic is asserted directly under Jest). The regression it locks: a recurrence-only task must
/// NOT surface a user-visible local notification (which used to appear titled "Task"); only a
/// `notification` / `time` / `alarm` trigger may.
final class NotificationPolicyTests: XCTestCase {
  private func trigger(_ type: String, _ extra: [String: Any] = [:]) -> [String: Any] {
    var t: [String: Any] = ["type": type]
    for (k, v) in extra { t[k] = v }
    return t
  }

  // MARK: - the regression: recurrence-only / background-only tasks stay silent

  func testRecurrenceOnlyPostsNoNotification() {
    let triggers = [trigger("recurrence", ["recurrence": ["kind": "interval", "everyMs": 900_000]])]
    XCTAssertFalse(NotificationPolicy.shouldPostLocalNotification(triggers))
    XCTAssertNil(NotificationPolicy.visibleNotificationTrigger(triggers))
  }

  func testRecurrencePlusAppStateStaysSilent() {
    // OctoChat's automation-tick shape: recurrence + appState, no notification trigger.
    let triggers = [
      trigger("recurrence", ["recurrence": ["kind": "daily", "hour": 9, "minute": 0]]),
      trigger("appState", ["on": "foreground"]),
    ]
    XCTAssertFalse(NotificationPolicy.shouldPostLocalNotification(triggers))
  }

  func testBackgroundOnlyStaysSilent() {
    XCTAssertFalse(NotificationPolicy.shouldPostLocalNotification([trigger("background")]))
  }

  func testPushAndAppStateOnlyStaySilent() {
    XCTAssertFalse(NotificationPolicy.shouldPostLocalNotification([trigger("push", ["matchKey": "k"])]))
    XCTAssertFalse(NotificationPolicy.shouldPostLocalNotification([trigger("appState", ["on": "background"])]))
  }

  func testNoTriggersStaySilent() {
    XCTAssertFalse(NotificationPolicy.shouldPostLocalNotification([]))
  }

  // MARK: - triggers that ARE meant to be user-visible on iOS

  func testNotificationTriggerIsVisibleAndCarriesTitleBody() {
    let triggers = [trigger("notification", ["title": "Daily digest", "body": "3 new items"])]
    XCTAssertTrue(NotificationPolicy.shouldPostLocalNotification(triggers))
    let visible = NotificationPolicy.visibleNotificationTrigger(triggers)
    XCTAssertEqual(visible?["title"] as? String, "Daily digest")
    XCTAssertEqual(visible?["body"] as? String, "3 new items")
  }

  func testTimeTriggerIsVisible() {
    XCTAssertTrue(NotificationPolicy.shouldPostLocalNotification([trigger("time", ["at": 1_000])]))
  }

  func testAlarmTriggerIsVisible() {
    XCTAssertTrue(NotificationPolicy.shouldPostLocalNotification([trigger("alarm", ["at": 1_000])]))
  }

  // MARK: - mixed: a recurrence that ALSO declares a notification still posts (with its title)

  func testRecurrencePlusNotificationPrefersNotificationTrigger() {
    let triggers = [
      trigger("recurrence", ["recurrence": ["kind": "interval", "everyMs": 60_000]]),
      trigger("notification", ["title": "Reminder", "body": "tick"]),
    ]
    XCTAssertTrue(NotificationPolicy.shouldPostLocalNotification(triggers))
    let visible = NotificationPolicy.visibleNotificationTrigger(triggers)
    XCTAssertEqual(visible?["title"] as? String, "Reminder")
  }

  func testNotificationTriggerPreferredOverTimeForTitleBody() {
    // A `time` trigger carries no title; when both exist, the notification trigger wins so its
    // title/body are used (not the time trigger that would fall back to the "Task" default).
    let triggers = [
      trigger("time", ["at": 2_000]),
      trigger("notification", ["title": "Pick me", "body": "with text"]),
    ]
    let visible = NotificationPolicy.visibleNotificationTrigger(triggers)
    XCTAssertEqual(visible?["title"] as? String, "Pick me")
  }
}
