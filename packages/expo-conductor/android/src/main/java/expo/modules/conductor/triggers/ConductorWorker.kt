package expo.modules.conductor.triggers

import android.content.Context
import androidx.work.Data
import androidx.work.Worker
import androidx.work.WorkerParameters
import expo.modules.conductor.ExpoConductorModule
import expo.modules.conductor.storage.TaskStore

/**
 * WorkManager worker that runs deferrable / recurring conductor tasks. It loads the
 * persisted task and asks the module to dispatch it (which enforces policy + budget
 * and runs a native handler directly, or emits an event for a JS handler).
 */
class ConductorWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
  override fun doWork(): Result {
    val id = inputData.getString(KEY_ID) ?: return Result.failure()
    val store = TaskStore(applicationContext)
    if (store.isPaused()) return Result.success() // conductor paused; skip without retrying
    val task = store.get(id) ?: return Result.success()
    val module = ExpoConductorModule.INSTANCE
      ?: // No JS runtime: only native handlers can run. Re-enqueue for JS later.
      return if (task.optJSONObject("handler")?.optString("type") == "native") {
        Result.success()
      } else {
        Result.retry()
      }
    module.dispatch(task, manual = false)
    return Result.success()
  }

  companion object {
    private const val KEY_ID = "taskId"
    fun inputData(id: String): Data = Data.Builder().putString(KEY_ID, id).build()
  }
}
