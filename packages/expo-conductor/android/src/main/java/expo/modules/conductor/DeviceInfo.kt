package expo.modules.conductor

import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.BatteryManager
import android.os.PowerManager
import expo.modules.conductor.engine.DeviceContext

/** Reads live device conditions into the engine's [DeviceContext] for policy checks. */
object DeviceInfo {
  fun read(context: Context, now: Long): DeviceContext {
    val battery = context.getSystemService(Context.BATTERY_SERVICE) as BatteryManager
    // BATTERY_PROPERTY_CAPACITY returns Integer.MIN_VALUE (or another out-of-range value) when
    // the device can't report capacity. Treat anything outside 0..100 as "unknown" and fail
    // OPEN at 1.0 — matching iOS's default — so a `minBatteryLevel` constraint doesn't defer
    // the task forever on a device that simply doesn't expose the property. (coerceIn would
    // clamp MIN_VALUE to 0.0 = fail-closed, the opposite of iOS.)
    val rawCapacity = battery.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)
    val level = if (rawCapacity in 0..100) rawCapacity / 100.0 else 1.0
    val charging = battery.isCharging

    val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
    val caps = cm.getNetworkCapabilities(cm.activeNetwork)
    val networkType = when {
      caps == null || !caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) -> "none"
      caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED) -> "unmetered"
      else -> "metered"
    }

    val power = context.getSystemService(Context.POWER_SERVICE) as PowerManager
    val idle = power.isDeviceIdleMode

    return DeviceContext(now, level, charging, networkType, idle)
  }

  @Suppress("DEPRECATION")
  fun batteryIntent(context: Context): Intent? =
    context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
}
