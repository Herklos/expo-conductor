package expo.modules.conductor.triggers

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.work.CoroutineWorker
import androidx.work.Data
import androidx.work.ForegroundInfo
import androidx.work.WorkerParameters
import expo.modules.conductor.ExpoConductorModule
import expo.modules.conductor.storage.TaskStore

/**
 * WorkManager worker that runs deferrable / recurring conductor tasks. It loads the
 * persisted task and asks the module to dispatch it (which enforces policy + budget
 * and runs a native handler directly, or emits an event for a JS handler).
 *
 * When the task's `policy.foreground` is true the worker promotes itself to a foreground
 * service before dispatching, bypassing Doze and the 10-minute background CPU limit.
 */
class ConductorWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
  override suspend fun doWork(): Result {
    val id = inputData.getString(KEY_ID) ?: return Result.failure()
    val store = TaskStore(applicationContext)
    if (store.isPaused()) return Result.success() // conductor paused; skip without retrying
    val task = store.get(id) ?: return Result.success()

    if (TaskMapper.isForeground(task)) {
      setForeground(buildForegroundInfo(id))
    }

    // Use the winning trigger persisted by the previous reschedule; falls back to
    // "recurrence"/"background" based on which triggers the task declares.
    // Use the winning trigger persisted by the previous reschedule as a best-effort source.
    val firedBy = task.optString("nextFiredBy", null) ?: "background"

    val module = ExpoConductorModule.INSTANCE
    if (module == null) {
      // No JS runtime. Native + Rust handlers can run headless; JS handlers are deferred
      // (retry) so they execute once a JS runtime exists.
      val handlerType = task.optJSONObject("handler")?.optString("type")
      return if (handlerType == "native" || handlerType == "rust") {
        ExpoConductorModule.dispatchHeadless(applicationContext, task, emptyMap(), firedBy = firedBy)
        Result.success()
      } else {
        Result.retry()
      }
    }
    module.dispatch(task, manual = false, firedBy = firedBy)
    return Result.success()
  }

  private fun buildForegroundInfo(taskId: String): ForegroundInfo {
    ensureForegroundChannel()
    val notification = NotificationCompat.Builder(applicationContext, CHANNEL_ID)
      .setContentTitle("Running task…")
      .setContentText(taskId)
      .setSmallIcon(applicationContext.applicationInfo.icon)
      .setOngoing(true)
      .build()
    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      ForegroundInfo(NOTIFICATION_ID, notification, android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
    } else {
      ForegroundInfo(NOTIFICATION_ID, notification)
    }
  }

  private fun ensureForegroundChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = applicationContext.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (manager.getNotificationChannel(CHANNEL_ID) == null) {
      manager.createNotificationChannel(
        NotificationChannel(CHANNEL_ID, "Running Tasks", NotificationManager.IMPORTANCE_LOW),
      )
    }
  }

  companion object {
    private const val KEY_ID = "taskId"
    private const val CHANNEL_ID = "conductor_foreground"
    private const val NOTIFICATION_ID = 0x1ced0001.toInt()

    fun inputData(id: String): Data = Data.Builder().putString(KEY_ID, id).build()
  }
}
