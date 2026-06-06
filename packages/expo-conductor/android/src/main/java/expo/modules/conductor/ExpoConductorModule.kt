package expo.modules.conductor

import android.app.AlarmManager
import android.content.Context
import android.os.Build
import androidx.work.BackoffPolicy
import androidx.work.Constraints as WorkConstraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import expo.modules.conductor.engine.PolicyEngine
import expo.modules.conductor.engine.RecurrenceEngine
import expo.modules.conductor.engine.WeightEngine
import expo.modules.conductor.storage.TaskStore
import expo.modules.conductor.triggers.ConductorAlarmReceiver
import expo.modules.conductor.triggers.ConductorWorker
import expo.modules.conductor.triggers.TaskMapper
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * Android Expo module for expo-conductor. Implements the same JS-facing contract as
 * the Web engine ({@code ConductorBackend}) using OS schedulers (WorkManager for
 * deferrable background work, AlarmManager for exact alarms) while delegating all
 * decision logic to the shared, fixture-verified engine objects.
 */
class ExpoConductorModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw IllegalStateException("No React context")

  private val store: TaskStore by lazy { TaskStore(context) }

  override fun definition() = ModuleDefinition {
    Name("ExpoConductorModule")

    Events("onTaskExecute", "onTaskComplete", "onTaskError", "onTaskSkipped")

    OnCreate {
      INSTANCE = this@ExpoConductorModule
    }
    OnDestroy {
      if (INSTANCE === this@ExpoConductorModule) INSTANCE = null
    }

    AsyncFunction("registerTaskAsync") { definition: Map<String, Any?> ->
      val task = TaskMapper.normalize(definition, System.currentTimeMillis())
      store.upsert(task)
      schedule(task)
      TaskMapper.toMap(task)
    }

    AsyncFunction("cancelTaskAsync") { id: String ->
      unschedule(id)
      store.remove(id)
    }

    AsyncFunction("getTasksAsync") {
      store.all().map { TaskMapper.toMap(it) }
    }

    AsyncFunction("runTaskAsync") { id: String ->
      store.get(id)?.let { dispatch(it, manual = true) }
    }

    AsyncFunction("setResourceBudgetAsync") { budget: Map<String, Any?> ->
      resourceBudget = TaskMapper.weight(budget)
    }

    AsyncFunction("pauseAsync") {
      paused = true
      store.all().forEach { unschedule(it.optString("id")) }
    }

    AsyncFunction("resumeAsync") {
      paused = false
      store.all().forEach { schedule(it) }
    }

    AsyncFunction("reportResultAsync") { id: String, result: String ->
      // Result feeds retry/backoff; WorkManager handles its own retry via Result.retry().
      emitComplete(id, result)
    }
  }

  // --- scheduling ----------------------------------------------------------

  private fun schedule(task: JSONObject) {
    if (paused) return
    val id = task.optString("id")
    val nextRunAt = if (task.isNull("nextRunAt")) null else task.optLong("nextRunAt")
    val recurrence = TaskMapper.recurrence(task)

    when {
      TaskMapper.hasAlarmTrigger(task) && nextRunAt != null ->
        ConductorAlarmReceiver.schedule(context, id, nextRunAt, TaskMapper.allowWhileIdle(task))

      recurrence != null -> {
        val intervalMs = TaskMapper.minimumIntervalMs(task)
        val request = PeriodicWorkRequestBuilder<ConductorWorker>(intervalMs, TimeUnit.MILLISECONDS)
          .setConstraints(workConstraints(task))
          .setInputData(ConductorWorker.inputData(id))
          .build()
        WorkManager.getInstance(context)
          .enqueueUniquePeriodicWork(id, ExistingPeriodicWorkPolicy.UPDATE, request)
      }

      nextRunAt != null -> {
        val delay = (nextRunAt - System.currentTimeMillis()).coerceAtLeast(0)
        val request = OneTimeWorkRequestBuilder<ConductorWorker>()
          .setInitialDelay(delay, TimeUnit.MILLISECONDS)
          .setConstraints(workConstraints(task))
          .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
          .setInputData(ConductorWorker.inputData(id))
          .build()
        WorkManager.getInstance(context).enqueueUniqueWork(id, androidx.work.ExistingWorkPolicy.REPLACE, request)
      }
    }
  }

  private fun unschedule(id: String) {
    WorkManager.getInstance(context).cancelUniqueWork(id)
    ConductorAlarmReceiver.cancel(context, id)
  }

  private fun workConstraints(task: JSONObject): WorkConstraints {
    val c = task.optJSONObject("policy")?.optJSONObject("constraints")
    val builder = WorkConstraints.Builder()
    when (c?.optString("network")) {
      "any" -> builder.setRequiredNetworkType(NetworkType.CONNECTED)
      "unmetered" -> builder.setRequiredNetworkType(NetworkType.UNMETERED)
      else -> builder.setRequiredNetworkType(NetworkType.NOT_REQUIRED)
    }
    if (c?.optBoolean("requiresCharging") == true) builder.setRequiresCharging(true)
    if (c?.has("minBatteryLevel") == true) builder.setRequiresBatteryNotLow(true)
    if (c?.optBoolean("requiresIdle") == true && Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
      builder.setRequiresDeviceIdle(true)
    }
    return builder.build()
  }

  // --- dispatch ------------------------------------------------------------

  /** Called by triggers (Worker, AlarmReceiver, FCM) when a task should run. */
  fun dispatch(task: JSONObject, manual: Boolean, data: Map<String, Any?> = emptyMap()) {
    val id = task.optString("id")

    if (!manual) {
      val decision = PolicyEngine.evaluate(TaskMapper.constraints(task), deviceContext())
      if (!decision.eligible) {
        emitSkipped(id, decision.reason.name)
        return
      }
      val admission = WeightEngine.admit(resourceBudget, listOf(TaskMapper.weightedTask(task)))
      if (!admission.admitted.contains(id)) {
        emitSkipped(id, "DEFERRED_BY_BUDGET")
        return
      }
    }

    val handlerType = task.optJSONObject("handler")?.optString("type") ?: "js"
    val handlerName = task.optJSONObject("handler")?.optString("name") ?: id

    sendEvent("onTaskExecute", mapOf(
      "taskId" to id,
      "triggerType" to TaskMapper.primaryTriggerType(task),
      "firedAt" to System.currentTimeMillis(),
      "attempt" to 1,
      "data" to data,
    ))

    // Native handlers run immediately on the native side without crossing into JS.
    if (handlerType == "native") {
      val handler = nativeHandlers[handlerName]
      val result = handler?.run(id, data) ?: "noData"
      emitComplete(id, result)
    }

    advanceRecurrence(task)
  }

  private fun advanceRecurrence(task: JSONObject) {
    val recurrence = TaskMapper.recurrence(task) ?: return
    val next = RecurrenceEngine.nextRun(recurrence, System.currentTimeMillis()) ?: return
    task.put("nextRunAt", next)
    store.upsert(task)
  }

  private fun deviceContext() = DeviceInfo.read(context, System.currentTimeMillis())

  private fun emitComplete(id: String, result: String) {
    sendEvent("onTaskComplete", mapOf("taskId" to id, "result" to result, "firedAt" to System.currentTimeMillis(), "attempt" to 1, "triggerType" to "background"))
  }

  private fun emitSkipped(id: String, reason: String) {
    sendEvent("onTaskSkipped", mapOf("taskId" to id, "reason" to reason))
  }

  companion object {
    @Volatile
    var INSTANCE: ExpoConductorModule? = null
      private set

    private val nativeHandlers = HashMap<String, ConductorTaskHandler>()

    @Volatile
    private var paused = false

    @Volatile
    var resourceBudget = expo.modules.conductor.engine.ResourceWeight(1.0, 1.0, 1.0, 1.0)

    /** Register a native handler so a task's work can run without JS. */
    @JvmStatic
    fun registerHandler(name: String, handler: ConductorTaskHandler) {
      nativeHandlers[name] = handler
    }

    @JvmStatic
    fun unregisterHandler(name: String) {
      nativeHandlers.remove(name)
    }

    internal fun handlerFor(name: String): ConductorTaskHandler? = nativeHandlers[name]
  }
}
