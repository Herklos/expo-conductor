package expo.modules.conductor.triggers

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.app.PendingIntent
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat

/**
 * Posts a user-visible notification for `notification`-trigger tasks. Android 8+ requires
 * a notification channel or the post is silently dropped, so we lazily create a default
 * conductor channel. Tapping the notification re-launches the app with the task id in
 * extras so the host can route it back through the engine.
 */
object NotificationDisplay {
  const val CHANNEL_ID = "expo_conductor_default"
  private const val CHANNEL_NAME = "Tasks"

  // Stable, collision-free notification id per task id. taskId.hashCode() can collide for
  // distinct ids, which would cross-overwrite notifications and (via the content PendingIntent
  // requestCode) route a tap to the wrong task; a monotonic registry never aliases two ids.
  private val notificationIds = java.util.concurrent.ConcurrentHashMap<String, Int>()
  private val nextNotificationId = java.util.concurrent.atomic.AtomicInteger(1)

  private fun notificationIdFor(taskId: String): Int =
    notificationIds.computeIfAbsent(taskId) { nextNotificationId.getAndIncrement() }

  private fun ensureChannel(context: Context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (manager.getNotificationChannel(CHANNEL_ID) == null) {
      manager.createNotificationChannel(
        NotificationChannel(CHANNEL_ID, CHANNEL_NAME, NotificationManager.IMPORTANCE_DEFAULT),
      )
    }
  }

  private fun contentIntent(context: Context, taskId: String): PendingIntent? {
    val launch = context.packageManager.getLaunchIntentForPackage(context.packageName)
      ?.apply {
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        // A per-id data Uri makes the PendingIntent unique per task even when requestCodes
        // collide (Intent.filterEquals ignores extras but compares data) — so a tap always
        // routes to the right task. Mirrors ConductorAlarmReceiver.
        setData(android.net.Uri.parse("conductor://task/$taskId"))
        putExtra("conductorTask", taskId)
      } ?: return null
    return PendingIntent.getActivity(
      context,
      notificationIdFor(taskId),
      launch,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
  }

  fun show(context: Context, taskId: String, title: String?, body: String?) {
    ensureChannel(context)
    val builder = NotificationCompat.Builder(context, CHANNEL_ID)
      .setContentTitle(title ?: "Task")
      .setSmallIcon(context.applicationInfo.icon)
      .setAutoCancel(true)
      .setContentIntent(contentIntent(context, taskId))
    if (body != null) builder.setContentText(body)
    // POST_NOTIFICATIONS (API 33+) must be granted; notify() no-ops if it isn't.
    NotificationManagerCompat.from(context).notify(notificationIdFor(taskId), builder.build())
  }
}
