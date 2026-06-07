package expo.modules.conductor.engine

/**
 * Weight / resource-budget admission engine (Android). Mirrors
 * `web/engine/weight.ts`. Validated by `fixtures/weight-admission.cases.json`.
 */
object WeightEngine {
  data class Task(
    val id: String,
    val priority: Int,
    val dueAt: Long,
    val weight: ResourceWeight,
    val maxConcurrent: Int? = null,
  )

  data class Admission(val admitted: List<String>, val deferred: List<String>)

  private val PRESETS = mapOf(
    "light" to ResourceWeight(0.1, 0.1, 0.1, 0.1),
    "moderate" to ResourceWeight(0.4, 0.4, 0.4, 0.4),
    "heavy" to ResourceWeight(0.8, 0.8, 0.8, 0.8),
  )

  fun resolvePreset(name: String): ResourceWeight =
    PRESETS[name] ?: error("Unknown weight preset: $name")

  private val taskComparator: Comparator<Task> = Comparator { a, b ->
    when {
      // compareTo, not subtraction: b.priority - a.priority overflows Int for far-apart
      // priorities and would flip the order (and break TimSort's contract).
      a.priority != b.priority -> b.priority.compareTo(a.priority)
      a.dueAt != b.dueAt -> a.dueAt.compareTo(b.dueAt)
      else -> a.id.compareTo(b.id) // UTF-16 code-unit order (matches JS/Swift)
    }
  }

  /**
   * Skip-over greedy admission ordered by the priority comparator, honoring per-task
   * `maxConcurrent` and the budget/count already consumed by in-flight tasks
   * ([used]/[running]).
   */
  fun admit(
    budget: ResourceWeight,
    tasks: List<Task>,
    running: Int = 0,
    used: ResourceWeight? = null,
  ): Admission {
    val ordered = tasks.sortedWith(taskComparator)
    var cpu = used?.cpu ?: 0.0
    var network = used?.network ?: 0.0
    var battery = used?.battery ?: 0.0
    var memory = used?.memory ?: 0.0
    var count = running
    val admitted = mutableListOf<String>()
    val deferred = mutableListOf<String>()

    for (task in ordered) {
      val w = task.weight
      val fitsBudget = cpu + w.cpu <= budget.cpu &&
        network + w.network <= budget.network &&
        battery + w.battery <= budget.battery &&
        memory + w.memory <= budget.memory
      val fitsConcurrency = task.maxConcurrent == null || count + 1 <= task.maxConcurrent
      if (fitsBudget && fitsConcurrency) {
        cpu += w.cpu
        network += w.network
        battery += w.battery
        memory += w.memory
        count += 1
        admitted.add(task.id)
      } else {
        deferred.add(task.id)
      }
    }
    return Admission(admitted, deferred)
  }
}
