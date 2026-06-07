# Shared behavior fixtures

These JSON files are the **single source of truth** for the behavior of the
`expo-conductor` orchestration engine. The engine is implemented natively three
times — **Kotlin** (Android), **Swift** (iOS) and **TypeScript** (Web) — and each
implementation ships a test suite that loads these exact files and asserts identical
results. This is how "the same behavior is tested on every platform" is guaranteed
for a native-first module.

All times are **UTC epoch milliseconds** and time math is integer math, so results
are bit-for-bit identical across languages with no timezone database involved. Resource
weights are IEEE-754 `double`s and **must be compared with a strict `<=`** — an
epsilon-tolerant comparison would diverge across platforms (e.g. `0.1 + 0.1 + 0.1`
is `0.30000000000000004` everywhere, so it consistently exceeds a `0.3` budget).

| File | Engine concern | Function under test |
| --- | --- | --- |
| `recurrence.cases.json` | schedule / recurrence | `Recurrence.nextRun(spec, fromMs) -> Long?` |
| `priority.cases.json` | priority vs other tasks | `Priority.order(tasks) -> id[]` |
| `weight-admission.cases.json` | task weight / resource budget | `Weight.admit(budget, tasks) -> {admitted, deferred}` |
| `policy.cases.json` | execution policy / constraints | `Policy.evaluate(constraints, context) -> {eligible, reason}` |

## Conventions

- **Weekday**: `0 = Sunday … 6 = Saturday` (matches JS `getUTCDay`). Epoch day 0
  (1970-01-01) is a **Thursday (4)**.
- **Recurrence kinds**: `interval`, `daily`, `weekly`, `cron` (subset: `minute hour
  dayOfWeek` with `*`, integers, comma lists and `*/step`).
- **Priority order**: priority descending, then `dueAt` ascending, then `id` ascending.
- **Admission**: candidates are ordered by the priority comparator, then admitted
  greedily while every weight dimension stays within budget (skip-over greedy — a task
  that does not fit is deferred and the next candidate is still considered).
