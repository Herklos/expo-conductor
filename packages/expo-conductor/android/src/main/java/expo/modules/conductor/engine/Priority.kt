package expo.modules.conductor.engine

/**
 * Priority engine (Android). Mirrors `web/engine/priority.ts`. Validated by
 * `fixtures/priority.cases.json`.
 */
object PriorityEngine {
  data class Item(val id: String, val priority: Int, val dueAt: Long)

  /** priority desc, then dueAt asc, then id asc. */
  val comparator: Comparator<Item> = Comparator { a, b ->
    when {
      a.priority != b.priority -> b.priority - a.priority
      a.dueAt != b.dueAt -> a.dueAt.compareTo(b.dueAt)
      else -> a.id.compareTo(b.id)
    }
  }

  fun order(items: List<Item>): List<String> = items.sortedWith(comparator).map { it.id }
}
