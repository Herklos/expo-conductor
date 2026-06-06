package expo.modules.conductor.engine

/**
 * Policy / constraint evaluation engine (Android). Mirrors `web/engine/policy.ts`.
 * Checks run in a fixed order; first failure wins. Validated by
 * `fixtures/policy.cases.json`.
 */
object PolicyEngine {
  fun evaluate(constraints: Constraints, ctx: DeviceContext): PolicyDecision {
    val now = ctx.now

    constraints.expiresAt?.let { if (now > it) return fail(PolicyReason.EXPIRED) }
    constraints.window?.earliest?.let { if (now < it) return fail(PolicyReason.BEFORE_WINDOW) }
    constraints.window?.latest?.let { if (now > it) return fail(PolicyReason.AFTER_WINDOW) }
    if (constraints.requiresCharging == true && !ctx.charging) {
      return fail(PolicyReason.REQUIRES_CHARGING)
    }
    constraints.minBatteryLevel?.let {
      if (ctx.batteryLevel < it) return fail(PolicyReason.BATTERY_TOO_LOW)
    }
    if (constraints.network == "any" && ctx.networkType == "none") {
      return fail(PolicyReason.NETWORK_UNAVAILABLE)
    }
    if (constraints.network == "unmetered" && ctx.networkType != "unmetered") {
      return fail(PolicyReason.NETWORK_NOT_UNMETERED)
    }
    if (constraints.requiresIdle == true && !ctx.idle) {
      return fail(PolicyReason.REQUIRES_IDLE)
    }
    return PolicyDecision(true, PolicyReason.ELIGIBLE)
  }

  private fun fail(reason: PolicyReason) = PolicyDecision(false, reason)
}
