package expo.modules.conductor.triggers

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import expo.modules.conductor.ExpoConductorModule
import expo.modules.conductor.storage.TaskStore

/**
 * Handles exact-alarm triggers via AlarmManager. Fires even in Doze when
 * `allowWhileIdle` is set. There is no iOS equivalent — on iOS an AlarmTrigger
 * falls back to a scheduled notification (see docs).
 */
class ConductorAlarmReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val id = intent.getStringExtra(EXTRA_ID) ?: return
    val task = TaskStore(context).get(id) ?: return
    val module = ExpoConductorModule.INSTANCE
    if (module != null) {
      module.dispatch(task, manual = false)
    } else {
      // No live module/JS: run native handlers and re-arm the next alarm anyway.
      ExpoConductorModule.dispatchHeadless(context, task, emptyMap())
    }
  }

  companion object {
    private const val EXTRA_ID = "taskId"

    private fun pendingIntent(context: Context, id: String): PendingIntent {
      // Use a per-id data Uri so distinct task ids never alias to the same PendingIntent
      // (String.hashCode collisions would otherwise cross-cancel/overwrite alarms — the
      // requestCode and extras are not part of PendingIntent identity, but `data` is).
      val intent = Intent(context, ConductorAlarmReceiver::class.java)
        .setData(android.net.Uri.parse("conductor://task/$id"))
        .putExtra(EXTRA_ID, id)
      return PendingIntent.getBroadcast(
        context,
        0,
        intent,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )
    }

    fun schedule(context: Context, id: String, triggerAtMs: Long, allowWhileIdle: Boolean) {
      val am = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
      val pi = pendingIntent(context, id)
      // On API 31+ exact-alarm permission is revocable; fall back to an inexact
      // allow-while-idle alarm rather than crashing with SecurityException.
      val canExact = Build.VERSION.SDK_INT < Build.VERSION_CODES.S || am.canScheduleExactAlarms()
      when {
        !canExact && Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ->
          am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAtMs, pi)
        allowWhileIdle && Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ->
          am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAtMs, pi)
        else ->
          am.setExact(AlarmManager.RTC_WAKEUP, triggerAtMs, pi)
      }
    }

    fun cancel(context: Context, id: String) {
      val am = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
      am.cancel(pendingIntent(context, id))
    }
  }
}
