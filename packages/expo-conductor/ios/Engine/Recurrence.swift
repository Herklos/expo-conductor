import Foundation

/// Recurrence engine (iOS). Bit-for-bit mirror of the TypeScript and Kotlin engines.
/// Integer math on UTC epoch ms with floor division/modulo. Validated by
/// `fixtures/recurrence.cases.json` via `EngineFixtureTests`.
public enum RecurrenceEngine {
  static let msPerMinute = 60_000
  static let msPerHour = 3_600_000
  static let msPerDay = 86_400_000
  private static let cronMaxIterations = 366 * 24 * 60

  private static func floorDiv(_ a: Int, _ b: Int) -> Int {
    let q = a / b
    return (a % b != 0 && (a < 0) != (b < 0)) ? q - 1 : q
  }

  private static func floorMod(_ a: Int, _ b: Int) -> Int {
    let r = a % b
    return (r != 0 && (r < 0) != (b < 0)) ? r + b : r
  }

  /// UTC day-of-week, 0 = Sunday.
  private static func dayOfWeek(_ epochMs: Int) -> Int {
    let epochDay = floorDiv(epochMs, msPerDay)
    return floorMod(epochDay + 4, 7)
  }

  private static func matchCronField(_ field: String, _ value: Int) -> Bool {
    if field == "*" { return true }
    if field.hasPrefix("*/") {
      guard let step = Int(field.dropFirst(2)), step > 0 else { return false }
      return value % step == 0
    }
    // Parse each comma part raw (no trimming): after splitting fields on ASCII whitespace a
    // part can't contain a separator, and trimming would strip non-ASCII whitespace (NBSP)
    // that Kotlin/JS do not — re-introducing a cross-engine divergence.
    return field.split(separator: ",").compactMap { Int($0) }.contains(value)
  }

  private static func nextCron(_ expression: String, _ fromMs: Int) -> Int? {
    // Split on ASCII whitespace only (space/tab/newline/CR), NOT the broader Unicode set, so
    // the three engines split identically. A malformed expression (not exactly three fields)
    // yields no next run — identical across TS/Kotlin/Swift, so it is expressible as a `null`
    // fixture. Registration-time rejection is the normalize boundary's job (see normalize.ts).
    let fields = expression.split(whereSeparator: { $0 == " " || $0 == "\t" || $0 == "\n" || $0 == "\r" })
    guard fields.count == 3 else { return nil }
    let minuteField = String(fields[0])
    let hourField = String(fields[1])
    let dowField = String(fields[2])
    var candidate = (floorDiv(fromMs, msPerMinute) + 1) * msPerMinute
    for _ in 0..<cronMaxIterations {
      let minute = floorDiv(candidate, msPerMinute) % 60
      let hour = floorDiv(candidate, msPerHour) % 24
      let dow = dayOfWeek(candidate)
      if matchCronField(minuteField, minute)
        && matchCronField(hourField, hour)
        && matchCronField(dowField, dow) {
        return candidate
      }
      candidate += msPerMinute
    }
    return nil
  }

  /// Next run strictly greater than `fromMs`, or nil if it will never fire.
  public static func nextRun(_ spec: Recurrence, _ fromMs: Int) -> Int? {
    switch spec {
    case let .interval(everyMs, anchor):
      if everyMs <= 0 { return nil }
      if fromMs < anchor { return anchor }
      let steps = floorDiv(fromMs - anchor, everyMs) + 1
      return anchor + steps * everyMs
    case let .daily(hour, minute):
      let offset = hour * msPerHour + minute * msPerMinute
      let dayStart = floorDiv(fromMs, msPerDay) * msPerDay
      var candidate = dayStart + offset
      while candidate <= fromMs { candidate += msPerDay }
      return candidate
    case let .weekly(weekday, hour, minute):
      let offset = hour * msPerHour + minute * msPerMinute
      let dayStart = floorDiv(fromMs, msPerDay) * msPerDay
      let dow = dayOfWeek(fromMs)
      let daysUntil = floorMod(weekday - dow, 7)
      var candidate = dayStart + daysUntil * msPerDay + offset
      while candidate <= fromMs { candidate += 7 * msPerDay }
      return candidate
    case let .cron(expression):
      return nextCron(expression, fromMs)
    }
  }
}
