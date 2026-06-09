package expo.modules.conductor.storage

import android.content.Context
import android.content.SharedPreferences
import org.json.JSONArray
import org.json.JSONObject

/**
 * Append-only ring-buffer store for `TaskExecutionEvent` objects, backed by
 * [SharedPreferences]. Mirrors the web [ExecutionLog] and iOS [ExecutionLog] so
 * `foldHistory()` (pure TS) works identically on all platforms.
 *
 * Events are written from the main-thread `emit(...)` helper in
 * [ExpoConductorModule], so every lifecycle event — including headless/background
 * runs — is captured even when no JS runtime exists.
 *
 * Capacity: 200 events (oldest dropped when exceeded).
 */
class ExecutionLogStore(context: Context) {
  private val prefs: SharedPreferences =
    context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

  /** Append a lifecycle event to the ring buffer. */
  fun append(event: Map<String, Any?>) {
    synchronized(this) {
      val arr = load()
      arr.put(toJson(event))
      // Trim to capacity
      val trimmed = JSONArray()
      val start = maxOf(0, arr.length() - CAPACITY)
      for (i in start until arr.length()) trimmed.put(arr.get(i))
      prefs.edit().putString(KEY_EVENTS, trimmed.toString()).apply()
    }
  }

  /** Return all persisted events in append order (oldest first). */
  fun all(): List<Map<String, Any?>> {
    val arr = load()
    val result = mutableListOf<Map<String, Any?>>()
    for (i in 0 until arr.length()) {
      result.add(fromJson(arr.getJSONObject(i)))
    }
    return result
  }

  /** Clear the ring buffer. */
  fun clear() {
    prefs.edit().remove(KEY_EVENTS).apply()
  }

  private fun load(): JSONArray {
    val raw = prefs.getString(KEY_EVENTS, null) ?: return JSONArray()
    return try { JSONArray(raw) } catch (_: Exception) { JSONArray() }
  }

  private fun toJson(map: Map<String, Any?>): JSONObject {
    val obj = JSONObject()
    for ((k, v) in map) {
      when (v) {
        null -> obj.put(k, JSONObject.NULL)
        else -> obj.put(k, v)
      }
    }
    return obj
  }

  private fun fromJson(obj: JSONObject): Map<String, Any?> {
    val map = mutableMapOf<String, Any?>()
    for (key in obj.keys()) {
      map[key] = if (obj.isNull(key)) null else obj.get(key)
    }
    return map
  }

  companion object {
    private const val PREFS_NAME = "expo_conductor_exec_log"
    private const val KEY_EVENTS = "events"
    private const val CAPACITY = 200
  }
}
