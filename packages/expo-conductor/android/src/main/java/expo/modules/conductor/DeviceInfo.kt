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
    val level = battery.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY).coerceIn(0, 100) / 100.0
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
