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
import expo.modules.conductor.engine.ResourceWeight
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
  private val mainHandler = android.os.Handler(android.os.Looper.getMainLooper())

  /** Emit a JS event on the main thread (triggers run on WorkManager/alarm threads). */
  private fun emit(name: String, payload: Map<String, Any?>) {
    mainHandler.post { sendEvent(name, payload) }
  }

  override fun definition() = ModuleDefinition {
    Name("ExpoConductorModule")

    Events("onTaskExecute", "onTaskComplete", "onTaskError", "onTaskSkipped")

    OnCreate {
      INSTANCE = this@ExpoConductorModule
      paused = store.isPaused()
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
      store.setPaused(true)
      store.all().forEach { unschedule(it.optString("id")) }
    }

    AsyncFunction("resumeAsync") {
      paused = false
      store.setPaused(false)
      store.all().forEach { schedule(it) }
    }

    AsyncFunction("getStatusAsync") {
      // WorkManager-backed background work is generally available; report "restricted"
      // when the OS has put the app under background restrictions (API 28+).
      val am = context.getSystemService(Context.ACTIVITY_SERVICE) as android.app.ActivityManager
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P && am.isBackgroundRestricted) {
        "restricted"
      } else {
        "available"
      }
    }

    AsyncFunction("requestPermissionsAsync") {
      // POST_NOTIFICATIONS (API 33+) is a runtime permission that must be requested from an
      // Activity; this module reports the current grant state. Apps should request it via
      // their Activity (or expo-notifications). Below API 33 notifications are allowed.
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
        true
      } else {
        context.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) ==
          android.content.pm.PackageManager.PERMISSION_GRANTED
      }
    }

    AsyncFunction("reportResultAsync") { id: String, result: String, error: String? ->
      // No longer occupies a concurrency/budget slot.
      running.remove(id)
      // Emits lifecycle events. NOTE: a JS-handler FAILED result is NOT retried by the OS
      // here — the Worker has already returned success by the time JS reports — so OS-level
      // retry/backoff applies to native handlers only; JS retry is handled in-process by
      // the JS engine while the app is alive.
      if (error != null) {
        emit("onTaskError", mapOf(
          "taskId" to id, "error" to error, "firedAt" to System.currentTimeMillis(),
          "attempt" to 1, "triggerType" to "background",
        ))
      }
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
      // Periodic WorkManager ticks at most every 15 min, so a daily/weekly/cron (or any
      // interval > 15 min) recurrence must be gated on its computed nextRunAt — otherwise
      // it would fire on every tick. Not-yet-due ticks are a no-op (the worker succeeds).
      val nextRunAt = if (task.isNull("nextRunAt")) null else task.optLong("nextRunAt")
      if (nextRunAt != null && System.currentTimeMillis() < nextRunAt) {
        return
      }
      val decision = PolicyEngine.evaluate(TaskMapper.constraints(task), deviceContext())
      if (!decision.eligible) {
        emitSkipped(id, decision.reason.name)
        return
      }
      // Admit against the budget/count consumed by tasks already running in this process
      // (best-effort cross-task budgeting; a killed/relaunched process starts empty).
      val usage = runningUsage(id)
      val admission = WeightEngine.admit(
        resourceBudget, listOf(TaskMapper.weightedTask(task)), usage.first, usage.second,
      )
      if (!admission.admitted.contains(id)) {
        emitSkipped(id, "DEFERRED_BY_BUDGET")
        return
      }
      running[id] = TaskMapper.weightOf(task)
    }

    val handlerType = task.optJSONObject("handler")?.optString("type") ?: "js"
    val handlerName = task.optJSONObject("handler")?.optString("name") ?: id

    // A `notification` trigger posts a user-visible notification when it fires.
    TaskMapper.notificationTrigger(task)?.let {
      val title = if (it.has("title")) it.getString("title") else null
      val body = if (it.has("body")) it.getString("body") else null
      NotificationDisplay.show(context, id, title, body)
    }

    emit("onTaskExecute", mapOf(
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
      running.remove(id) // completed synchronously
      emitComplete(id, result)
    }

    // A manual run-now must not advance the task's real schedule (matches the TS engine).
    if (!manual) advanceRecurrence(task)
  }

  private fun advanceRecurrence(task: JSONObject) {
    val recurrence = TaskMapper.recurrence(task) ?: return
    val next = RecurrenceEngine.nextRun(recurrence, System.currentTimeMillis()) ?: return
    task.put("nextRunAt", next)
    store.upsert(task)
    // Exact alarms do not self-repeat (unlike periodic WorkManager) — re-arm the next one.
    if (TaskMapper.hasAlarmTrigger(task)) {
      ConductorAlarmReceiver.schedule(context, task.optString("id"), next, TaskMapper.allowWhileIdle(task))
    }
  }

  private fun deviceContext() = DeviceInfo.read(context, System.currentTimeMillis())

  /** Budget + count consumed by other tasks running in this process (excluding [excludeId]). */
  private fun runningUsage(excludeId: String): Pair<Int, ResourceWeight> {
    var cpu = 0.0; var network = 0.0; var battery = 0.0; var memory = 0.0; var count = 0
    for ((id, w) in running) {
      if (id == excludeId) continue
      cpu += w.cpu; network += w.network; battery += w.battery; memory += w.memory; count++
    }
    return count to ResourceWeight(cpu, network, battery, memory)
  }

  private fun emitComplete(id: String, result: String) {
    emit("onTaskComplete", mapOf("taskId" to id, "result" to result, "firedAt" to System.currentTimeMillis(), "attempt" to 1, "triggerType" to "background"))
  }

  private fun emitSkipped(id: String, reason: String) {
    emit("onTaskSkipped", mapOf("taskId" to id, "reason" to reason))
  }

  companion object {
    @Volatile
    var INSTANCE: ExpoConductorModule? = null
      private set

    // Mutated by register/unregister (any thread) and read on Worker/alarm/FCM threads.
    private val nativeHandlers = java.util.concurrent.ConcurrentHashMap<String, ConductorTaskHandler>()

    // Weight of tasks currently running in this process, for best-effort cross-task budgeting.
    private val running = java.util.concurrent.ConcurrentHashMap<String, ResourceWeight>()

    @Volatile
    private var paused = false

    @Volatile
    var resourceBudget = ResourceWeight(1.0, 1.0, 1.0, 1.0)

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

    /**
     * Run a task when no live module/JS instance exists (process alive but module torn
     * down). Native handlers still run; recurrence/alarm are advanced/re-armed. JS-only
     * handlers cannot run here and are left for the next app launch.
     */
    @JvmStatic
    internal fun dispatchHeadless(context: Context, task: JSONObject, data: Map<String, Any?>) {
      if (TaskStore(context).isPaused()) return
      // Honor execution policy (esp. expiry/window/charging) even on the headless path.
      val ctx = DeviceInfo.read(context, System.currentTimeMillis())
      if (!PolicyEngine.evaluate(TaskMapper.constraints(task), ctx).eligible) return

      val id = task.optString("id")
      val handler = task.optJSONObject("handler")
      val isNative = handler?.optString("type") == "native"

      // A notification trigger delivers its notification regardless of handler type.
      val notif = TaskMapper.notificationTrigger(task)
      if (notif != null) {
        val title = if (notif.has("title")) notif.getString("title") else null
        val body = if (notif.has("body")) notif.getString("body") else null
        NotificationDisplay.show(context, id, title, body)
      }
      if (isNative) nativeHandlers[handler!!.optString("name")]?.run(id, data)

      // Advance/re-arm only if the occurrence was meaningfully handled here. A pure JS
      // handler with no notification did nothing, so leave nextRunAt to replay on the
      // next foreground launch instead of silently losing the occurrence.
      if (!isNative && notif == null) return
      val recurrence = TaskMapper.recurrence(task) ?: return
      val next = RecurrenceEngine.nextRun(recurrence, System.currentTimeMillis()) ?: return
      task.put("nextRunAt", next)
      TaskStore(context).upsert(task)
      if (TaskMapper.hasAlarmTrigger(task)) {
        ConductorAlarmReceiver.schedule(context, id, next, TaskMapper.allowWhileIdle(task))
      }
    }
  }
}
