package expo.modules.conductor.triggers

import expo.modules.conductor.engine.Constraints
import expo.modules.conductor.engine.DeviceContext
import expo.modules.conductor.engine.ExecutionWindow
import expo.modules.conductor.engine.Recurrence
import expo.modules.conductor.engine.RecurrenceEngine
import expo.modules.conductor.engine.ResourceWeight
import expo.modules.conductor.engine.WeightEngine
import org.json.JSONArray
import org.json.JSONObject

/**
 * Converts between the JS task definition (a plain Map across the bridge) and the
 * internal JSONObject task representation, and extracts the typed engine models.
 * Mirrors `web/normalize.ts` so the persisted task shape is identical on every
 * platform.
 */
object TaskMapper {
  private const val MINUTE = 60_000L

  private val PRESETS = mapOf(
    "light" to ResourceWeight(0.1, 0.1, 0.1, 0.1),
    "moderate" to ResourceWeight(0.4, 0.4, 0.4, 0.4),
    "heavy" to ResourceWeight(0.8, 0.8, 0.8, 0.8),
  )

  fun normalize(def: Map<String, Any?>, now: Long): JSONObject {
    val json = JSONObject(def)
    val id = json.getString("id")

    val handler = json.optJSONObject("handler") ?: JSONObject().put("name", id).put("type", "js")
    json.put("handler", handler)

    if (!json.has("priority") || json.isNull("priority")) json.put("priority", 0)

    val weight = weight(def["weight"])
    json.put("weight", weightToJson(weight))

    if (!json.has("policy") || json.isNull("policy")) json.put("policy", JSONObject())

    val recurrence = recurrence(json)
    val (nextRun, nextFiredBy) = computeNextRunAt(json, recurrence, now)
    if (nextRun == null) json.put("nextRunAt", JSONObject.NULL) else json.put("nextRunAt", nextRun)
    if (nextFiredBy == null) json.put("nextFiredBy", JSONObject.NULL) else json.put("nextFiredBy", nextFiredBy)
    json.put("createdAt", now)
    return json
  }

  fun toMap(task: JSONObject): Map<String, Any?> = task.toMap()

  fun weight(value: Any?): ResourceWeight = when (value) {
    is String -> PRESETS[value] ?: PRESETS.getValue("moderate")
    is Map<*, *> -> {
      val o = JSONObject(value as Map<String, Any?>)
      ResourceWeight(o.optDouble("cpu", 0.4), o.optDouble("network", 0.4), o.optDouble("battery", 0.4), o.optDouble("memory", 0.4))
    }
    is JSONObject -> ResourceWeight(value.optDouble("cpu", 0.4), value.optDouble("network", 0.4), value.optDouble("battery", 0.4), value.optDouble("memory", 0.4))
    else -> PRESETS.getValue("moderate")
  }

  private fun weightToJson(w: ResourceWeight) =
    JSONObject().put("cpu", w.cpu).put("network", w.network).put("battery", w.battery).put("memory", w.memory)

  fun recurrence(task: JSONObject): Recurrence? {
    val r = task.optJSONObject("recurrence") ?: triggerRecurrence(task) ?: return null
    return when (r.getString("kind")) {
      "interval" -> Recurrence.Interval(r.getLong("everyMs"), r.optLong("anchor", 0L))
      "daily" -> Recurrence.Daily(r.getInt("hour"), r.getInt("minute"))
      "weekly" -> Recurrence.Weekly(r.getInt("weekday"), r.getInt("hour"), r.getInt("minute"))
      "cron" -> Recurrence.Cron(r.getString("expression"))
      else -> null
    }
  }

  private fun triggerRecurrence(task: JSONObject): JSONObject? {
    val triggers = task.optJSONArray("triggers") ?: return null
    for (i in 0 until triggers.length()) {
      val t = triggers.getJSONObject(i)
      if (t.optString("type") == "recurrence") return t.optJSONObject("recurrence")
    }
    return null
  }

  fun constraints(task: JSONObject): Constraints {
    val c = task.optJSONObject("policy")?.optJSONObject("constraints") ?: return Constraints()
    val window = c.optJSONObject("window")?.let {
      ExecutionWindow(
        if (it.has("earliest")) it.getLong("earliest") else null,
        if (it.has("latest")) it.getLong("latest") else null,
      )
    }
    return Constraints(
      window = window,
      requiresCharging = if (c.has("requiresCharging")) c.getBoolean("requiresCharging") else null,
      minBatteryLevel = if (c.has("minBatteryLevel")) c.getDouble("minBatteryLevel") else null,
      network = if (c.has("network")) c.getString("network") else null,
      requiresIdle = if (c.has("requiresIdle")) c.getBoolean("requiresIdle") else null,
      expiresAt = if (c.has("expiresAt")) c.getLong("expiresAt") else null,
    )
  }

  fun weightedTask(task: JSONObject): WeightEngine.Task {
    val w = task.getJSONObject("weight")
    val maxConcurrent = task.optJSONObject("policy")
      ?.let { if (it.has("maxConcurrent")) it.getInt("maxConcurrent") else null }
    return WeightEngine.Task(
      task.getString("id"),
      task.optInt("priority", 0),
      if (task.isNull("nextRunAt")) System.currentTimeMillis() else task.optLong("nextRunAt"),
      ResourceWeight(w.getDouble("cpu"), w.getDouble("network"), w.getDouble("battery"), w.getDouble("memory")),
      maxConcurrent,
    )
  }

  fun weightOf(task: JSONObject): ResourceWeight {
    val w = task.getJSONObject("weight")
    return ResourceWeight(w.getDouble("cpu"), w.getDouble("network"), w.getDouble("battery"), w.getDouble("memory"))
  }

  data class NextRunResult(val nextRunAt: Long?, val firedBy: String?)

  /**
   * Earliest concrete fire time from the task's triggers + recurrence, and the trigger type
   * that produced it. With [futureOnly] the one-shot triggers (time/alarm) and non-recurring
   * notification triggers are kept only when their absolute `at` is still in the future, and
   * relative `inSeconds` ones are dropped (they already fired). Recurring notifications with
   * `inSeconds` are always re-evaluated (mirrors WebSchedulerEngine.futureTriggers #6 fix).
   *
   * Tie-breaking: when two triggers produce the same timestamp the first one in trigger-array
   * order wins; the explicit `recurrence` field is evaluated last — mirrors the TS engine.
   */
  fun computeNextRunAt(
    task: JSONObject,
    recurrence: Recurrence?,
    now: Long,
    futureOnly: Boolean = false,
  ): NextRunResult {
    var best: Long? = null
    var bestType: String? = null
    fun consider(at: Long, type: String) {
      if (best == null || at < best!!) { best = at; bestType = type }
    }
    val triggers = task.optJSONArray("triggers") ?: JSONArray()
    for (i in 0 until triggers.length()) {
      val t = triggers.getJSONObject(i)
      when (t.optString("type")) {
        "time" ->
          if (t.has("at")) { val at = t.getLong("at"); if (!futureOnly || at > now) consider(at, "time") }
          else if (!futureOnly && t.has("inSeconds")) consider(now + t.getLong("inSeconds") * 1000, "time")
        "notification" -> {
          val recurring = t.optBoolean("recurring", false)
          if (recurring && t.has("inSeconds")) {
            // Recurring: re-derive interval regardless of futureOnly — never drops.
            consider(now + t.getLong("inSeconds") * 1000, "notification")
          } else if (t.has("at")) {
            val at = t.getLong("at"); if (!futureOnly || at > now) consider(at, "notification")
          } else if (!futureOnly && t.has("inSeconds")) {
            consider(now + t.getLong("inSeconds") * 1000, "notification")
          }
        }
        "alarm" -> if (t.has("at")) { val at = t.getLong("at"); if (!futureOnly || at > now) consider(at, "alarm") }
        "recurrence" -> recurrence(JSONObject().put("recurrence", t.optJSONObject("recurrence")))
          ?.let { RecurrenceEngine.nextRun(it, now)?.let { next -> consider(next, "recurrence") } }
      }
    }
    recurrence?.let { RecurrenceEngine.nextRun(it, now)?.let { next -> consider(next, "recurrence") } }
    return NextRunResult(best, bestType)
  }

  fun isForeground(task: JSONObject): Boolean =
    task.optJSONObject("policy")?.optBoolean("foreground", false) ?: false

  fun hasAlarmTrigger(task: JSONObject) = triggerTypes(task).contains("alarm")
  fun allowWhileIdle(task: JSONObject): Boolean {
    val triggers = task.optJSONArray("triggers") ?: return true
    for (i in 0 until triggers.length()) {
      val t = triggers.getJSONObject(i)
      if (t.optString("type") == "alarm") return t.optBoolean("allowWhileIdle", true)
    }
    return true
  }

  /** Window duration in ms for `AlarmManager.setWindow(…)`, or null when not set.
   *  Returns the first alarm trigger's `windowMs` field if positive. */
  fun windowMs(task: JSONObject): Long? {
    val triggers = task.optJSONArray("triggers") ?: return null
    for (i in 0 until triggers.length()) {
      val t = triggers.getJSONObject(i)
      if (t.optString("type") == "alarm" && t.has("windowMs")) {
        val w = t.getLong("windowMs")
        return if (w > 0) w else null
      }
    }
    return null
  }

  fun minimumIntervalMs(task: JSONObject): Long {
    val triggers = task.optJSONArray("triggers") ?: return 15 * MINUTE
    for (i in 0 until triggers.length()) {
      val t = triggers.getJSONObject(i)
      if (t.optString("type") == "background" && t.has("minimumIntervalMinutes")) {
        return (t.getLong("minimumIntervalMinutes") * MINUTE).coerceAtLeast(15 * MINUTE)
      }
    }
    return 15 * MINUTE
  }

  fun primaryTriggerType(task: JSONObject): String = triggerTypes(task).firstOrNull() ?: "time"

  /** The `notification` trigger object, if this task has one (carries title/body). */
  fun notificationTrigger(task: JSONObject): JSONObject? {
    val triggers = task.optJSONArray("triggers") ?: return null
    for (i in 0 until triggers.length()) {
      val t = triggers.getJSONObject(i)
      if (t.optString("type") == "notification") return t
    }
    return null
  }

  private fun triggerTypes(task: JSONObject): List<String> {
    val triggers = task.optJSONArray("triggers") ?: return emptyList()
    return (0 until triggers.length()).map { triggers.getJSONObject(it).optString("type") }
  }
}
