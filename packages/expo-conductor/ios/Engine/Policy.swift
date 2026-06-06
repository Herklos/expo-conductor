import Foundation

/// Policy / constraint evaluation engine (iOS). Mirrors `web/engine/policy.ts`.
/// Checks run in a fixed order; first failure wins. Validated by
/// `fixtures/policy.cases.json`.
public enum PolicyEngine {
  public static func evaluate(_ constraints: Constraints, _ ctx: DeviceContext) -> PolicyDecision {
    let now = ctx.now

    if let expiresAt = constraints.expiresAt, now > expiresAt {
      return fail(.expired)
    }
    if let earliest = constraints.window?.earliest, now < earliest {
      return fail(.beforeWindow)
    }
    if let latest = constraints.window?.latest, now > latest {
      return fail(.afterWindow)
    }
    if constraints.requiresCharging == true, !ctx.charging {
      return fail(.requiresCharging)
    }
    if let minBattery = constraints.minBatteryLevel, ctx.batteryLevel < minBattery {
      return fail(.batteryTooLow)
    }
    if constraints.network == "any", ctx.networkType == "none" {
      return fail(.networkUnavailable)
    }
    if constraints.network == "unmetered", ctx.networkType != "unmetered" {
      return fail(.networkNotUnmetered)
    }
    if constraints.requiresIdle == true, !ctx.idle {
      return fail(.requiresIdle)
    }
    return PolicyDecision(eligible: true, reason: .eligible)
  }

  private static func fail(_ reason: PolicyReason) -> PolicyDecision {
    PolicyDecision(eligible: false, reason: reason)
  }
}
