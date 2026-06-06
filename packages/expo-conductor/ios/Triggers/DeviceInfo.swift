import Foundation
import Network
#if canImport(UIKit)
import UIKit
#endif

/// Reads live device conditions into the engine's `DeviceContext` for policy checks.
/// iOS has no user-facing "idle" concept, so `idle` is reported as `true` (tasks are
/// not gated on idle); metered vs unmetered is approximated from `isExpensive`.
enum DeviceInfo {
  private static let monitor: NWPathMonitor = {
    let m = NWPathMonitor()
    m.start(queue: DispatchQueue(label: "expo.conductor.network"))
    return m
  }()

  static func read(now: Int) -> DeviceContext {
    var level = 1.0
    var charging = true
    #if canImport(UIKit)
    UIDevice.current.isBatteryMonitoringEnabled = true
    let raw = UIDevice.current.batteryLevel
    if raw >= 0 { level = Double(raw) }
    let state = UIDevice.current.batteryState
    charging = (state == .charging || state == .full)
    #endif

    let path = monitor.currentPath
    let networkType: String
    if path.status != .satisfied {
      networkType = "none"
    } else if path.isExpensive || path.isConstrained {
      networkType = "metered"
    } else {
      networkType = "unmetered"
    }

    return DeviceContext(now: now, batteryLevel: level, charging: charging, networkType: networkType, idle: true)
  }
}
