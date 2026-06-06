# Shared behavior fixtures

These JSON files are the **single source of truth** for the behavior of the
`expo-conductor` orchestration engine. The engine is implemented natively three
times — **Kotlin** (Android), **Swift** (iOS) and **TypeScript** (Web) — and each
implementation ships a test suite that loads these exact files and asserts identical
results. This is how "the same behavior is tested on every platform" is guaranteed
for a native-first module.

All times are **UTC epoch milliseconds** and all math is integer math, so results
are bit-for-bit identical across languages with no timezone database involved.

| File | Engine concern | Function under test |
| --- | --- | --- |
| `recurrence.cases.json` | schedule / recurrence | `Recurrence.nextRun(spec, fromMs) -> Long?` |
| `priority.cases.json` | priority vs other tasks | `Priority.order(tasks) -> id[]` |
| `weight-admission.cases.json` | task weight / resource budget | `Weight.admit(budget, tasks) -> {admitted, deferred}` |
| `policy.cases.json` | execution policy / constraints | `Policy.evaluate(task, context) -> Decision` |

## Conventions

- **Weekday**: `0 = Sunday … 6 = Saturday` (matches JS `getUTCDay`). Epoch day 0
  (1970-01-01) is a **Thursday (4)**.
- **Recurrence kinds**: `interval`, `daily`, `weekly`, `cron` (subset: `minute hour
  dayOfWeek` with `*`, integers, comma lists and `*/step`).
- **Priority order**: priority descending, then `dueAt` ascending, then `id` ascending.
- **Admission**: candidates are ordered by the priority comparator, then admitted
  greedily while every weight dimension stays within budget (skip-over greedy — a task
  that does not fit is deferred and the next candidate is still considered).
