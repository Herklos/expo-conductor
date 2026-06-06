package expo.modules.conductor.engine

/**
 * Pure, framework-free data model for the conductor engine. These types mirror the
 * TypeScript contract in `ExpoConductor.types.ts` and the Swift `Models.swift`, and
 * are exercised by the shared fixtures in `/fixtures`.
 */

sealed class Recurrence {
  data class Interval(val everyMs: Long, val anchor: Long = 0L) : Recurrence()
  data class Daily(val hour: Int, val minute: Int) : Recurrence()
  data class Weekly(val weekday: Int, val hour: Int, val minute: Int) : Recurrence()
  data class Cron(val expression: String) : Recurrence()
}

/** Per-dimension resource cost (each 0..1) and the budget shape are identical. */
data class ResourceWeight(
  val cpu: Double,
  val network: Double,
  val battery: Double,
  val memory: Double,
)

data class ExecutionWindow(val earliest: Long? = null, val latest: Long? = null)

data class Constraints(
  val window: ExecutionWindow? = null,
  val requiresCharging: Boolean? = null,
  val minBatteryLevel: Double? = null,
  val network: String? = null,
  val requiresIdle: Boolean? = null,
  val expiresAt: Long? = null,
)

data class DeviceContext(
  val now: Long,
  val batteryLevel: Double,
  val charging: Boolean,
  val networkType: String,
  val idle: Boolean,
)

enum class PolicyReason {
  ELIGIBLE,
  EXPIRED,
  BEFORE_WINDOW,
  AFTER_WINDOW,
  REQUIRES_CHARGING,
  BATTERY_TOO_LOW,
  NETWORK_UNAVAILABLE,
  NETWORK_NOT_UNMETERED,
  REQUIRES_IDLE,
}

data class PolicyDecision(val eligible: Boolean, val reason: PolicyReason)
