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
      a.priority != b.priority -> b.priority - a.priority
      a.dueAt != b.dueAt -> a.dueAt.compareTo(b.dueAt)
      else -> a.id.compareTo(b.id)
    }
  }

  /** Skip-over greedy admission ordered by the priority comparator. */
  fun admit(budget: ResourceWeight, tasks: List<Task>): Admission {
    val ordered = tasks.sortedWith(taskComparator)
    var cpu = 0.0
    var network = 0.0
    var battery = 0.0
    var memory = 0.0
    val admitted = mutableListOf<String>()
    val deferred = mutableListOf<String>()

    for (task in ordered) {
      val w = task.weight
      val fits = cpu + w.cpu <= budget.cpu &&
        network + w.network <= budget.network &&
        battery + w.battery <= budget.battery &&
        memory + w.memory <= budget.memory
      if (fits) {
        cpu += w.cpu
        network += w.network
        battery += w.battery
        memory += w.memory
        admitted.add(task.id)
      } else {
        deferred.add(task.id)
      }
    }
    return Admission(admitted, deferred)
  }
}
