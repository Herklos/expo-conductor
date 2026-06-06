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

private fun JSONArray.toList(): List<Any?> = (0 until length()).map { unwrap(get(it)) }

private fun unwrap(value: Any?): Any? = when (value) {
  JSONObject.NULL -> null
  is JSONObject -> value.toMap()
  is JSONArray -> value.toList()
  else -> value
}
