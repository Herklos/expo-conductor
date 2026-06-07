package expo.modules.conductor.engine

/**
 * Recurrence engine (Android). Bit-for-bit mirror of `web/engine/recurrence.ts`
 * and `Engine/Recurrence.swift`. All math is integer math on UTC epoch ms using
 * floor division/modulo so results match the other platforms exactly. Validated
 * by `fixtures/recurrence.cases.json`.
 */
object RecurrenceEngine {
  const val MS_PER_MINUTE = 60_000L
  const val MS_PER_HOUR = 3_600_000L
  const val MS_PER_DAY = 86_400_000L

  private const val CRON_MAX_ITERATIONS = 366 * 24 * 60

  /** UTC day-of-week, 0 = Sunday (matches JS getUTCDay). */
  private fun dayOfWeek(epochMs: Long): Int {
    val epochDay = Math.floorDiv(epochMs, MS_PER_DAY)
    return Math.floorMod(epochDay + 4, 7L).toInt()
  }

  private fun matchCronField(field: String, value: Int): Boolean {
    if (field == "*") return true
    if (field.startsWith("*/")) {
      val step = field.substring(2).toIntOrNull() ?: return false
      return step > 0 && value % step == 0
    }
    // Parse each comma part raw (no trimming): a part can't contain a separator after the
    // field split, and trimming would strip non-ASCII whitespace (NBSP) that Swift/JS keep,
    // re-introducing a cross-engine divergence.
    return field.split(",").mapNotNull { it.toIntOrNull() }.contains(value)
  }

  private fun nextCron(expression: String, fromMs: Long): Long? {
    // Split on ASCII whitespace only (space/tab/newline/CR), NOT Java's broader \\s, so the
    // three engines split identically. A malformed expression (not exactly three fields)
    // yields null — identical across TS/Kotlin/Swift, so it is expressible as a `null`
    // fixture. Registration-time rejection is the normalize boundary's job (see normalize.ts).
    val fields = expression.split(Regex("[ \t\n\r]+")).filter { it.isNotEmpty() }
    if (fields.size != 3) return null
    val (minuteField, hourField, dowField) = fields
    var candidate = (Math.floorDiv(fromMs, MS_PER_MINUTE) + 1) * MS_PER_MINUTE
    for (i in 0 until CRON_MAX_ITERATIONS) {
      val minute = (Math.floorDiv(candidate, MS_PER_MINUTE) % 60).toInt()
      val hour = (Math.floorDiv(candidate, MS_PER_HOUR) % 24).toInt()
      val dow = dayOfWeek(candidate)
      if (matchCronField(minuteField, minute) &&
        matchCronField(hourField, hour) &&
        matchCronField(dowField, dow)
      ) {
        return candidate
      }
      candidate += MS_PER_MINUTE
    }
    return null
  }

  /** Next run strictly greater than [fromMs], or null if it will never fire. */
  fun nextRun(spec: Recurrence, fromMs: Long): Long? = when (spec) {
    is Recurrence.Interval -> {
      if (spec.everyMs <= 0L) {
        null
      } else if (fromMs < spec.anchor) {
        spec.anchor
      } else {
        val steps = Math.floorDiv(fromMs - spec.anchor, spec.everyMs) + 1
        spec.anchor + steps * spec.everyMs
      }
    }
    is Recurrence.Daily -> {
      val offset = spec.hour * MS_PER_HOUR + spec.minute * MS_PER_MINUTE
      val dayStart = Math.floorDiv(fromMs, MS_PER_DAY) * MS_PER_DAY
      var candidate = dayStart + offset
      while (candidate <= fromMs) candidate += MS_PER_DAY
      candidate
    }
    is Recurrence.Weekly -> {
      val offset = spec.hour * MS_PER_HOUR + spec.minute * MS_PER_MINUTE
      val dayStart = Math.floorDiv(fromMs, MS_PER_DAY) * MS_PER_DAY
      val dow = dayOfWeek(fromMs)
      val daysUntil = Math.floorMod((spec.weekday - dow).toLong(), 7L)
      var candidate = dayStart + daysUntil * MS_PER_DAY + offset
      while (candidate <= fromMs) candidate += 7 * MS_PER_DAY
      candidate
    }
    is Recurrence.Cron -> nextCron(spec.expression, fromMs)
  }
}
