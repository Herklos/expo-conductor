# expo-conductor

Define tasks in an Expo app with rich execution policies and many triggers — priority,
resource weight, recurrence and constraints — backed by a native-first engine on Android
(Kotlin) and iOS (Swift), with a Web implementation.

See the [full documentation and architecture overview](../../README.md) at the repo root,
and the [shared behavior contract](../../fixtures/README.md).

## Quick start

```ts
import Conductor, { Priority, TaskResult } from 'expo-conductor';

// Register JS handlers at MODULE scope (not inside a component) so they survive a headless
// relaunch — same rule as expo-task-manager's defineTask.
Conductor.defineTask('refresh', async () => TaskResult.NEW_DATA);

await Conductor.schedule({
  id: 'refresh',
  priority: Priority.HIGH,
  weight: 'moderate',
  triggers: [{ type: 'recurrence', recurrence: { kind: 'interval', everyMs: 900000 } }],
  policy: { constraints: { network: 'any' }, retry: { maxAttempts: 3, backoffMs: 30000 } },
});
```

## Handlers, headless execution & push

- **JS handler:** runs while the app is alive (foreground/background). Register it at module
  scope. It does **not** run after the app is terminated.
- **Native handler** (`handler.type: 'native'`, registered via
  `ExpoConductorModule.registerHandler`): runs headless, including after termination.
- **Push trigger:** send a **raw FCM v1 data-only** message (Android) or a **silent APNs**
  push with `conductorTask` as a top-level peer of `aps` (iOS) — see the
  [push message format](../../README.md#push-message-format). Use a native handler for push
  tasks that must run while terminated. Treat push `data` as untrusted.
- **Notifications:** the `notification` trigger shows a notification on iOS and Android
  (Android channel auto-created). Call `Conductor.requestPermissions()` first.

See the [full documentation](../../README.md) for triggers, policy/weight/priority, the
config plugin options (`enableFcm`, `enablePush`, `enableExactAlarms`, `useExactAlarmClock`,
`backgroundTaskIdentifiers`), platform support matrix, and the device test guide.

## Scripts

- `pnpm --filter expo-conductor test` — Jest (engine + orchestration + API)
- `pnpm --filter expo-conductor typecheck`
- `pnpm --filter expo-conductor build`
- `pnpm test:kotlin` / `pnpm test:swift` — native engine tests against the shared fixtures
