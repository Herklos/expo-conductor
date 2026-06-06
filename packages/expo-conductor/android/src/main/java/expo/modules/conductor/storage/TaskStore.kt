package expo.modules.conductor.storage

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/**
 * Durable storage for registered tasks, backed by SharedPreferences so that tasks
 * (and the data needed to reschedule alarms after a reboot) survive process death.
 * Mirrors the Web `TaskRegistry` (localStorage) and iOS `Registry` (UserDefaults).
 */
class TaskStore(context: Context) {
  private val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  fun all(): List<JSONObject> {
    val raw = prefs.getString(KEY, null) ?: return emptyList()
    val array = JSONArray(raw)
    return (0 until array.length()).map { array.getJSONObject(it) }
  }

  fun get(id: String): JSONObject? = all().firstOrNull { it.optString("id") == id }

  fun upsert(task: JSONObject) {
    val list = all().filter { it.optString("id") != task.optString("id") }.toMutableList()
    list.add(task)
    persist(list)
  }

  fun remove(id: String): Boolean {
    val list = all()
    val filtered = list.filter { it.optString("id") != id }
    if (filtered.size == list.size) return false
    persist(filtered)
    return true
  }

  fun clear() = prefs.edit().remove(KEY).apply()

  private fun persist(list: List<JSONObject>) {
    val array = JSONArray()
    list.forEach { array.put(it) }
    prefs.edit().putString(KEY, array.toString()).apply()
  }

  companion object {
    private const val PREFS = "expo.modules.conductor.tasks"
    private const val KEY = "tasks"
  }
}
