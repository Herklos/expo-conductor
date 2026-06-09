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
import expo.modules.conductor.engine.ResourceWeight
import expo.modules.conductor.engine.WeightEngine
import expo.modules.conductor.storage.ExecutionLogStore
import expo.modules.conductor.storage.TaskStore
import expo.modules.conductor.triggers.ConductorAlarmReceiver
import expo.modules.conductor.triggers.ConductorWorker
import expo.modules.conductor.triggers.NotificationDisplay
import expo.modules.conductor.triggers.TaskMapper
import expo.modules.interfaces.permissions.Permissions
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
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
  private val execLog: ExecutionLogStore by lazy { ExecutionLogStore(context) }
  private val mainHandler = android.os.Handler(android.os.Looper.getMainLooper())

  /** Emit a JS event on the main thread and write to the execution log for history.
   *  Triggers run on WorkManager/alarm threads — always post to main for JS safety. */
  private fun emit(name: String, payload: Map<String, Any?>) {
    execLog.append(buildLogEvent(name, payload))
    mainHandler.post { sendEvent(name, payload) }
  }

  /**
   * Convert a lifecycle event name + payload into the serializable
   * [TaskExecutionEvent] shape that the TS `foldHistory()` understands.
   */
  private fun buildLogEvent(name: String, payload: Map<String, Any?>): Map<String, Any?> {
    val kind = when (name) {
      "onTaskExecute" -> "execute"
      "onTaskComplete" -> "complete"
      "onTaskError" -> "error"
      "onTaskSkipped" -> "skipped"
      else -> name
    }
    val event = mutableMapOf<String, Any?>(
      "kind" to kind,
      "taskId" to (payload["taskId"] as? String ?: ""),
      "triggeredAt" to System.currentTimeMillis(),
    )
    payload["triggerType"]?.let { event["triggerType"] = it }
    payload["attempt"]?.let { event["attempt"] = it }
    payload["result"]?.let { event["result"] = it }
    payload["error"]?.let { event["error"] = it }
    payload["reason"]?.let { event["reason"] = it }
    return event
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

    AsyncFunction("runDueTasksAsync") {
      // Respect pause: a background tick (expo-background-task) must fire nothing and report 0
      // while paused, matching WebSchedulerEngine.runDueTasksAsync (`if (this.paused) return 0`).
      if (paused) return@AsyncFunction 0
      val now = System.currentTimeMillis()
      val due = store.all()
        .filter { !it.isNull("nextRunAt") && it.optLong("nextRunAt") <= now }
        .sortedWith(compareByDescending<org.json.JSONObject> { it.optInt("priority", 0) }
          .thenBy { it.optLong("nextRunAt") }
          .thenBy { it.optString("id") })
      // Count tasks actually fired, not merely due (policy/budget can skip some).
      due.count { dispatch(it, manual = false) }
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

    AsyncFunction("requestPermissionsAsync") { promise: Promise ->
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
        promise.resolve(true)
        return@AsyncFunction
      }
      val perms = appContext.permissions
      if (perms == null) {
        // Permissions module unavailable — fall back to current grant state.
        promise.resolve(
          context.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) ==
            android.content.pm.PackageManager.PERMISSION_GRANTED
        )
        return@AsyncFunction
      }
      // Delegate to expo-modules-core so it handles the Activity request + result callback.
      // The utility resolves with a status map; we extract the boolean for our API contract.
      Permissions.askForPermissionsWithPermissionsManager(
        perms,
        object : Promise {
          override fun resolve(value: Any?) {
            @Suppress("UNCHECKED_CAST")
            val granted = when (val v = value) {
              is Boolean -> v
              // expo-modules-core resolves with Bundle{permName -> Bundle{granted, status, ...}}
              is android.os.Bundle ->
                v.getBundle(android.Manifest.permission.POST_NOTIFICATIONS)
                  ?.getBoolean("granted") == true
              is Map<*, *> ->
                v["granted"] == true ||
                  v.values.any { inner -> (inner as? Map<*, *>)?.get("granted") == true }
              else -> false
            }
            promise.resolve(granted)
          }
          override fun reject(code: String?, message: String?, cause: Throwable?) =
            promise.reject(code, message, cause)
          override fun reject(exception: CodedException) =
            promise.reject(exception)
        },
        android.Manifest.permission.POST_NOTIFICATIONS,
      )
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

    AsyncFunction("getHistoryAsync") {
      execLog.all()
    }

    AsyncFunction("clearHistoryAsync") {
      execLog.clear()
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

  /**
   * Called by triggers (Worker, AlarmReceiver, FCM) when a task should run. Returns whether
   * the task actually fired (emitted onTaskExecute) — false when it was not yet due or was
   * skipped by policy/budget — so [runDueTasksAsync] can report the number truly fired.
   */
  fun dispatch(task: JSONObject, manual: Boolean, data: Map<String, Any?> = emptyMap()): Boolean {
    val id = task.optString("id")

    if (!manual) {
      // Respect pause: a remote FCM push or an in-tray alarm reaches dispatch even while paused
      // (pauseAsync only unschedules local work), so skip here to match iOS/Web "nothing fires
      // while paused". Manual run-now (the `manual` branch) still fires.
      if (paused) {
        emitSkipped(id, "PAUSED")
        return false
      }
      // Periodic WorkManager ticks at most every 15 min, so a daily/weekly/cron (or any
      // interval > 15 min) recurrence must be gated on its computed nextRunAt — otherwise
      // it would fire on every tick. Not-yet-due ticks are a no-op (the worker succeeds).
      val nextRunAt = if (task.isNull("nextRunAt")) null else task.optLong("nextRunAt")
      if (nextRunAt != null && System.currentTimeMillis() < nextRunAt) {
        return false
      }
      val decision = PolicyEngine.evaluate(TaskMapper.constraints(task), deviceContext())
      if (!decision.eligible) {
        emitSkipped(id, decision.reason.name)
        return false
      }
      // Admit against the budget/count consumed by tasks already running in this process
      // (best-effort cross-task budgeting; a killed/relaunched process starts empty). The
      // check-then-reserve is serialized on `running` so two trigger threads (e.g. an alarm
      // receiver on the main thread and a WorkManager worker on a background thread) can't
      // both observe the same usage, both pass admission, and overshoot the budget.
      val admitted = synchronized(running) {
        val usage = runningUsage(id)
        val admission = WeightEngine.admit(
          resourceBudget, listOf(TaskMapper.weightedTask(task)), usage.first, usage.second,
        )
        if (admission.admitted.contains(id)) {
          running[id] = TaskMapper.weightOf(task)
          true
        } else {
          false
        }
      }
      if (!admitted) {
        emitSkipped(id, "DEFERRED_BY_BUDGET")
        return false
      }
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
      val result = try {
        handler?.run(id, data) ?: "noData"
      } catch (e: Throwable) {
        // A throwing native handler must NOT abort the whole runDueTasksAsync batch (which has
        // already counted this task as fired) — report it failed and continue. Swift's handler
        // type can't throw and the JS engine runs handlers async, so only Android needed this.
        emit("onTaskError", mapOf(
          "taskId" to id, "error" to (e.message ?: e.toString()),
          "firedAt" to System.currentTimeMillis(), "attempt" to 1, "triggerType" to "background",
        ))
        "failed"
      }
      running.remove(id) // completed synchronously
      emitComplete(id, result)
    }

    // Rust handlers run via FFI through RustTaskBridge (requires enableRust=true at build time).
    if (handlerType == "rust") {
      val dataJson = try { org.json.JSONObject(data as? Map<*, *> ?: emptyMap<String, Any?>()).toString() } catch (_: Exception) { "{}" }
      val result = try {
        RustTaskBridge.dispatch(handlerName, id, dataJson)
      } catch (e: Throwable) {
        emit("onTaskError", mapOf(
          "taskId" to id, "error" to (e.message ?: e.toString()),
          "firedAt" to System.currentTimeMillis(), "attempt" to 1, "triggerType" to "background",
        ))
        "failed"
      }
      running.remove(id)
      emitComplete(id, result)
    }

    // A manual run-now must not advance the task's real schedule (matches the TS engine).
    if (!manual) reschedule(task)
    return true
  }

  /**
   * Recompute nextRunAt = min(next recurrence, still-FUTURE one-shot triggers), persist (null when
   * none remain), and re-arm the exact alarm. Mirrors WebSchedulerEngine.reschedule/futureTriggers,
   * so a task with BOTH a recurrence and a sooner one-shot honors both, and a fired one-shot with
   * no future trigger clears (no longer re-dispatched by runDueTasksAsync on every tick).
   */
  private fun reschedule(task: JSONObject) {
    val recurrence = TaskMapper.recurrence(task)
    val next = TaskMapper.computeNextRunAt(task, recurrence, System.currentTimeMillis(), futureOnly = true)
    if (next == null) task.put("nextRunAt", JSONObject.NULL) else task.put("nextRunAt", next)
    store.upsert(task)
    // Exact alarms do not self-repeat (unlike periodic WorkManager) — re-arm the next one.
    if (next != null && TaskMapper.hasAlarmTrigger(task)) {
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
      val handlerType = handler?.optString("type") ?: "js"
      val isNative = handlerType == "native"
      val isRust = handlerType == "rust"

      // A notification trigger delivers its notification regardless of handler type.
      val notif = TaskMapper.notificationTrigger(task)
      if (notif != null) {
        val title = if (notif.has("title")) notif.getString("title") else null
        val body = if (notif.has("body")) notif.getString("body") else null
        NotificationDisplay.show(context, id, title, body)
      }
      if (isNative) nativeHandlers[handler!!.optString("name")]?.run(id, data)
      if (isRust) {
        val name = handler?.optString("name") ?: id
        val dataJson = try { org.json.JSONObject(data).toString() } catch (_: Exception) { "{}" }
        RustTaskBridge.dispatch(name, id, dataJson)
      }

      // Advance/re-arm only if the occurrence was meaningfully handled here. A pure JS
      // handler with no notification did nothing, so leave nextRunAt to replay on the
      // next foreground launch instead of silently losing the occurrence.
      if (!isNative && !isRust && notif == null) return
      // min(next recurrence, future one-shots), matching the live reschedule + Web; null -> nothing
      // future, so don't re-arm (a fired one-shot is done).
      val recurrence = TaskMapper.recurrence(task)
      val next = TaskMapper.computeNextRunAt(task, recurrence, System.currentTimeMillis(), futureOnly = true) ?: return
      task.put("nextRunAt", next)
      TaskStore(context).upsert(task)
      if (TaskMapper.hasAlarmTrigger(task)) {
        ConductorAlarmReceiver.schedule(context, id, next, TaskMapper.allowWhileIdle(task))
      }
    }
  }
}
