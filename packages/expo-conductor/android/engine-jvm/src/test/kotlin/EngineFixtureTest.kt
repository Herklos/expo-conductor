import expo.modules.conductor.engine.Constraints
import expo.modules.conductor.engine.DeviceContext
import expo.modules.conductor.engine.ExecutionWindow
import expo.modules.conductor.engine.PolicyEngine
import expo.modules.conductor.engine.PolicyReason
import expo.modules.conductor.engine.PriorityEngine
import expo.modules.conductor.engine.Recurrence
import expo.modules.conductor.engine.RecurrenceEngine
import expo.modules.conductor.engine.ResourceWeight
import expo.modules.conductor.engine.WeightEngine
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.File

/**
 * Runs the shared cross-platform behavior fixtures from the repo-root `fixtures`
 * directory through the Kotlin engine. These are the same cases the TypeScript (Jest) and
 * Swift (XCTest) suites assert, guaranteeing identical behavior on every platform.
 */
class EngineFixtureTest {
  private val fixturesDir = File(System.getProperty("fixturesDir"))

  private fun load(file: String): JSONObject =
    JSONObject(File(fixturesDir, file).readText())

  private fun cases(file: String): JSONArray = load(file).getJSONArray("cases")

  private fun recurrenceFromJson(spec: JSONObject): Recurrence = when (spec.getString("kind")) {
    "interval" -> Recurrence.Interval(spec.getLong("everyMs"), spec.optLong("anchor", 0L))
    "daily" -> Recurrence.Daily(spec.getInt("hour"), spec.getInt("minute"))
    "weekly" -> Recurrence.Weekly(spec.getInt("weekday"), spec.getInt("hour"), spec.getInt("minute"))
    "cron" -> Recurrence.Cron(spec.getString("expression"))
    else -> error("Unknown recurrence kind")
  }

  private fun weightFromJson(o: JSONObject) = ResourceWeight(
    o.getDouble("cpu"),
    o.getDouble("network"),
    o.getDouble("battery"),
    o.getDouble("memory"),
  )

  private fun ids(array: JSONArray): List<String> =
    (0 until array.length()).map { array.getString(it) }

  @Test
  fun recurrence() {
    val cases = cases("recurrence.cases.json")
    for (i in 0 until cases.length()) {
      val c = cases.getJSONObject(i)
      val expected: Long? = if (c.isNull("expected")) null else c.getLong("expected")
      val actual = RecurrenceEngine.nextRun(recurrenceFromJson(c.getJSONObject("spec")), c.getLong("fromMs"))
      assertEquals(c.getString("name"), expected, actual)
    }
  }

  @Test
  fun priority() {
    val cases = cases("priority.cases.json")
    for (i in 0 until cases.length()) {
      val c = cases.getJSONObject(i)
      val tasks = c.getJSONArray("tasks").let { arr ->
        (0 until arr.length()).map {
          val t = arr.getJSONObject(it)
          PriorityEngine.Item(t.getString("id"), t.getInt("priority"), t.getLong("dueAt"))
        }
      }
      assertEquals(c.getString("name"), ids(c.getJSONArray("expected")), PriorityEngine.order(tasks))
    }
  }

  @Test
  fun weightAdmission() {
    val cases = cases("weight-admission.cases.json")
    for (i in 0 until cases.length()) {
      val c = cases.getJSONObject(i)
      val budget = weightFromJson(c.getJSONObject("budget"))
      val tasks = c.getJSONArray("tasks").let { arr ->
        (0 until arr.length()).map {
          val t = arr.getJSONObject(it)
          WeightEngine.Task(
            t.getString("id"),
            t.getInt("priority"),
            t.getLong("dueAt"),
            weightFromJson(t.getJSONObject("weight")),
          )
        }
      }
      val expected = c.getJSONObject("expected")
      val result = WeightEngine.admit(budget, tasks)
      assertEquals(c.getString("name") + " [admitted]", ids(expected.getJSONArray("admitted")), result.admitted)
      assertEquals(c.getString("name") + " [deferred]", ids(expected.getJSONArray("deferred")), result.deferred)
    }
  }

  @Test
  fun policy() {
    val cases = cases("policy.cases.json")
    for (i in 0 until cases.length()) {
      val c = cases.getJSONObject(i)
      val co = c.getJSONObject("constraints")
      val window = co.optJSONObject("window")?.let {
        ExecutionWindow(
          if (it.has("earliest")) it.getLong("earliest") else null,
          if (it.has("latest")) it.getLong("latest") else null,
        )
      }
      val constraints = Constraints(
        window = window,
        requiresCharging = if (co.has("requiresCharging")) co.getBoolean("requiresCharging") else null,
        minBatteryLevel = if (co.has("minBatteryLevel")) co.getDouble("minBatteryLevel") else null,
        network = if (co.has("network")) co.getString("network") else null,
        requiresIdle = if (co.has("requiresIdle")) co.getBoolean("requiresIdle") else null,
        expiresAt = if (co.has("expiresAt")) co.getLong("expiresAt") else null,
      )
      val cx = c.getJSONObject("context")
      val context = DeviceContext(
        cx.getLong("now"),
        cx.getDouble("batteryLevel"),
        cx.getBoolean("charging"),
        cx.getString("networkType"),
        cx.getBoolean("idle"),
      )
      val expected = c.getJSONObject("expected")
      val decision = PolicyEngine.evaluate(constraints, context)
      assertEquals(c.getString("name") + " [eligible]", expected.getBoolean("eligible"), decision.eligible)
      assertEquals(
        c.getString("name") + " [reason]",
        PolicyReason.valueOf(expected.getString("reason")),
        decision.reason,
      )
    }
  }
}
