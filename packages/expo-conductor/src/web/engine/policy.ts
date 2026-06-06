/**
 * Policy / constraint evaluation engine (Web / reference implementation).
 *
 * Mirrors `Policy.kt` and `Policy.swift`. Validated by `fixtures/policy.cases.json`.
 * Checks run in a fixed order; the first failing check wins.
 */
import type {
  Constraints,
  DeviceContext,
  PolicyDecision,
  PolicyReason,
} from '../../ExpoConductor.types';

function fail(reason: PolicyReason): PolicyDecision {
  return { eligible: false, reason };
}

const ELIGIBLE: PolicyDecision = { eligible: true, reason: 'ELIGIBLE' };

/**
 * Decide whether a task may run right now given device conditions. Check order:
 * EXPIRED → BEFORE_WINDOW → AFTER_WINDOW → REQUIRES_CHARGING → BATTERY_TOO_LOW →
 * NETWORK_UNAVAILABLE → NETWORK_NOT_UNMETERED → REQUIRES_IDLE.
 */
export function evaluate(constraints: Constraints, ctx: DeviceContext): PolicyDecision {
  const { now } = ctx;

  if (constraints.expiresAt != null && now > constraints.expiresAt) {
    return fail('EXPIRED');
  }
  if (constraints.window?.earliest != null && now < constraints.window.earliest) {
    return fail('BEFORE_WINDOW');
  }
  if (constraints.window?.latest != null && now > constraints.window.latest) {
    return fail('AFTER_WINDOW');
  }
  if (constraints.requiresCharging && !ctx.charging) {
    return fail('REQUIRES_CHARGING');
  }
  if (constraints.minBatteryLevel != null && ctx.batteryLevel < constraints.minBatteryLevel) {
    return fail('BATTERY_TOO_LOW');
  }
  if (constraints.network === 'any' && ctx.networkType === 'none') {
    return fail('NETWORK_UNAVAILABLE');
  }
  if (constraints.network === 'unmetered' && ctx.networkType !== 'unmetered') {
    return fail('NETWORK_NOT_UNMETERED');
  }
  if (constraints.requiresIdle && !ctx.idle) {
    return fail('REQUIRES_IDLE');
  }
  return ELIGIBLE;
}
