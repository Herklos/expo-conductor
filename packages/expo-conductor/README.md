# expo-conductor

Define tasks in an Expo app with rich execution policies and many triggers — priority,
resource weight, recurrence and constraints — backed by a native-first engine on Android
(Kotlin) and iOS (Swift), with a Web implementation.

See the [full documentation and architecture overview](../../README.md) at the repo root,
and the [shared behavior contract](../../fixtures/README.md).

## Quick start

```ts
import Conductor, { Priority, TaskResult } from 'expo-conductor';

Conductor.defineTask('refresh', async () => TaskResult.NEW_DATA);

await Conductor.schedule({
  id: 'refresh',
  priority: Priority.HIGH,
  weight: 'moderate',
  triggers: [{ type: 'recurrence', recurrence: { kind: 'interval', everyMs: 900000 } }],
  policy: { constraints: { network: 'any' }, retry: { maxAttempts: 3, backoffMs: 30000 } },
});
```

## Scripts

- `pnpm --filter expo-conductor test` — Jest (engine + orchestration + API)
- `pnpm --filter expo-conductor typecheck`
- `pnpm --filter expo-conductor build`
- `pnpm test:kotlin` / `pnpm test:swift` — native engine tests against the shared fixtures
