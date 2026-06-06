import Foundation

/// Pure, framework-free model for the conductor engine. Mirrors the TypeScript
/// contract and Kotlin `Models.kt`, exercised by the shared fixtures in `/fixtures`.

public enum Recurrence: Equatable {
  case interval(everyMs: Int, anchor: Int)
  case daily(hour: Int, minute: Int)
  case weekly(weekday: Int, hour: Int, minute: Int)
  case cron(expression: String)
}

public struct ResourceWeight: Equatable {
  public let cpu: Double
  public let network: Double
  public let battery: Double
  public let memory: Double
  public init(cpu: Double, network: Double, battery: Double, memory: Double) {
    self.cpu = cpu
    self.network = network
    self.battery = battery
    self.memory = memory
  }
}

public struct ExecutionWindow: Equatable {
  public let earliest: Int?
  public let latest: Int?
  public init(earliest: Int? = nil, latest: Int? = nil) {
    self.earliest = earliest
    self.latest = latest
  }
}

public struct Constraints: Equatable {
  public let window: ExecutionWindow?
  public let requiresCharging: Bool?
  public let minBatteryLevel: Double?
  public let network: String?
  public let requiresIdle: Bool?
  public let expiresAt: Int?
  public init(
    window: ExecutionWindow? = nil,
    requiresCharging: Bool? = nil,
    minBatteryLevel: Double? = nil,
    network: String? = nil,
    requiresIdle: Bool? = nil,
    expiresAt: Int? = nil
  ) {
    self.window = window
    self.requiresCharging = requiresCharging
    self.minBatteryLevel = minBatteryLevel
    self.network = network
    self.requiresIdle = requiresIdle
    self.expiresAt = expiresAt
  }
}

public struct DeviceContext: Equatable {
  public let now: Int
  public let batteryLevel: Double
  public let charging: Bool
  public let networkType: String
  public let idle: Bool
  public init(now: Int, batteryLevel: Double, charging: Bool, networkType: String, idle: Bool) {
    self.now = now
    self.batteryLevel = batteryLevel
    self.charging = charging
    self.networkType = networkType
    self.idle = idle
  }
}

public enum PolicyReason: String, Equatable {
  case eligible = "ELIGIBLE"
  case expired = "EXPIRED"
  case beforeWindow = "BEFORE_WINDOW"
  case afterWindow = "AFTER_WINDOW"
  case requiresCharging = "REQUIRES_CHARGING"
  case batteryTooLow = "BATTERY_TOO_LOW"
  case networkUnavailable = "NETWORK_UNAVAILABLE"
  case networkNotUnmetered = "NETWORK_NOT_UNMETERED"
  case requiresIdle = "REQUIRES_IDLE"
}

public struct PolicyDecision: Equatable {
  public let eligible: Bool
  public let reason: PolicyReason
  public init(eligible: Bool, reason: PolicyReason) {
    self.eligible = eligible
    self.reason = reason
  }
}
