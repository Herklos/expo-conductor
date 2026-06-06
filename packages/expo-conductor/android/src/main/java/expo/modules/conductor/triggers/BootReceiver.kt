package expo.modules.conductor.triggers

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import expo.modules.conductor.storage.TaskStore

/**
 * Reschedules persisted exact alarms after a device reboot, since AlarmManager
 * alarms do not survive a restart. WorkManager work is persisted by the OS, so only
 * alarm triggers need re-arming here.
 */
class BootReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action != Intent.ACTION_BOOT_COMPLETED) return
    val store = TaskStore(context)
    for (task in store.all()) {
      val id = task.optString("id")
      if (!TaskMapper.hasAlarmTrigger(task)) continue
      if (task.isNull("nextRunAt")) continue
      ConductorAlarmReceiver.schedule(
        context,
        id,
        task.optLong("nextRunAt"),
        TaskMapper.allowWhileIdle(task),
      )
    }
  }
}
