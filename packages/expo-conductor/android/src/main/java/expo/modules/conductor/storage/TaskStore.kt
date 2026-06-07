package expo.modules.conductor.storage

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/**
 * Durable storage for registered tasks, backed by SharedPreferences so that tasks
 * (and the data needed to reschedule alarms after a reboot) survive process death.
 * Mirrors the Web `TaskRegistry` (localStorage) and iOS `TaskStore` (UserDefaults).
 *
 * Every read-modify-write is serialized on a process-wide lock because the WorkManager
 * worker, alarm receiver, FCM service and the JS module all mutate the store from
 * different threads; SharedPreferences `apply()` is last-writer-wins on the whole blob,
 * so without this the compound read→modify→write would lose updates.
 */
class TaskStore(context: Context) {
  private val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  fun all(): List<JSONObject> = synchronized(LOCK) { readAll() }

  private fun readAll(): List<JSONObject> {
    val raw = prefs.getString(KEY, null) ?: return emptyList()
    val array = JSONArray(raw)
    return (0 until array.length()).map { array.getJSONObject(it) }
  }

  fun get(id: String): JSONObject? = synchronized(LOCK) {
    readAll().firstOrNull { it.optString("id") == id }
  }

  fun upsert(task: JSONObject) = synchronized(LOCK) {
    val list = readAll().filter { it.optString("id") != task.optString("id") }.toMutableList()
    list.add(task)
    persist(list)
  }

  fun remove(id: String): Boolean = synchronized(LOCK) {
    val list = readAll()
    val filtered = list.filter { it.optString("id") != id }
    if (filtered.size == list.size) return@synchronized false
    persist(filtered)
    true
  }

  fun clear() = synchronized(LOCK) { prefs.edit().remove(KEY).apply() }

  /** Whether the conductor is paused. Persisted so it survives process death / reboot. */
  fun isPaused(): Boolean = synchronized(LOCK) { prefs.getBoolean(KEY_PAUSED, false) }

  fun setPaused(value: Boolean) = synchronized(LOCK) { prefs.edit().putBoolean(KEY_PAUSED, value).apply() }

  private fun persist(list: List<JSONObject>) {
    val array = JSONArray()
    list.forEach { array.put(it) }
    prefs.edit().putString(KEY, array.toString()).apply()
  }

  companion object {
    private const val PREFS = "expo.modules.conductor.tasks"
    private const val KEY = "tasks"
    private const val KEY_PAUSED = "paused"
    private val LOCK = Any()
  }
}
