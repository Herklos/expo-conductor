package expo.modules.conductor.triggers

import org.json.JSONArray
import org.json.JSONObject

/** Recursively convert a [JSONObject] to a plain Map for crossing the JS bridge. */
fun JSONObject.toMap(): Map<String, Any?> {
  val map = HashMap<String, Any?>()
  for (key in keys()) {
    map[key] = unwrap(get(key))
  }
  return map
}

/**
 * Convert a plain [Map] to a JSON string for passing to native/Rust FFI handlers.
 * Returns `"{}"` on any serialization error to keep callers simple.
 */
fun Map<String, Any?>.toJsonString(): String = try {
  val obj = JSONObject()
  for ((k, v) in this) {
    when (v) {
      null -> obj.put(k, JSONObject.NULL)
      is Map<*, *> -> {
        @Suppress("UNCHECKED_CAST")
        obj.put(k, JSONObject(v as Map<String, Any?>))
      }
      else -> obj.put(k, v)
    }
  }
  obj.toString()
} catch (_: Exception) { "{}" }

private fun JSONArray.toList(): List<Any?> = (0 until length()).map { unwrap(get(it)) }

private fun unwrap(value: Any?): Any? = when (value) {
  JSONObject.NULL -> null
  is JSONObject -> value.toMap()
  is JSONArray -> value.toList()
  else -> value
}
