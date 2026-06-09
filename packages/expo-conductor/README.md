# expo-conductor

Define tasks in an Expo app with rich execution policies and many triggers — priority,
resource weight, recurrence and constraints — backed by a native-first engine on Android
(Kotlin) and iOS (Swift), with a Web implementation.

See the [full documentation and architecture overview](../../README.md) at the repo root,
and the [shared behavior contract](../../fixtures/README.md).

## Quick start

```ts
import Conductor, { Priority, TaskResult } from '@drakkar.software/expo-conductor';

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
- **Rust handler** (`handler.type: 'rust'`): dispatched over C ABI FFI to a Rust function
  registered via `conductor_register(name, handler)` in a `conductor_app_init()` call.
  Runs wherever the native layer runs (headless included). Enable with
  `{ "enableRust": true }` in the config plugin options; see [Rust handlers](#rust-handlers).
- **Push trigger:** send a **raw FCM v1 data-only** message (Android) or a **silent APNs**
  push with `conductorTask` as a top-level peer of `aps` (iOS) — see the
  [push message format](../../README.md#push-message-format). Use a native handler for push
  tasks that must run while terminated. Treat push `data` as untrusted.
- **Notifications:** the `notification` trigger shows a notification on iOS and Android
  (Android channel auto-created). Call `Conductor.requestPermissions()` first.

## Rust handlers

```toml
# Cargo.toml — your app's crate (depends on the lib's rlib, not cdylib/staticlib)
[package]
name = "my_app_rust"              # unique package name — no naming conflict with the dep
[lib]
name = "my_app_rust"              # artifact name: set rustLibName to this value in app.json
crate-type = ["rlib", "cdylib", "staticlib"]

[dependencies]
# default-features = false disables the no-op conductor_app_init symbol so your own
# conductor_app_init (below) is the only one compiled into the final .so.
conductor_ffi = { path = "path/to/packages/expo-conductor/rust", default-features = false }
```

```rust
// src/lib.rs
use conductor_ffi::{conductor_register, Handler};
use std::sync::Arc;

#[no_mangle]
pub extern "C" fn conductor_app_init() {
    conductor_register("my-task", Arc::new(|_task_id, _data| "success"));
}
```

On Android the lib calls `conductor_app_init()` automatically when the `.so` is loaded
(`RustTaskBridge.init`). On iOS call `ConductorRustBridge.appInit()` from your
AppDelegate (or from a helper class registered via a config plugin). The demo shows a
complete example in `apps/demo/rust/` and `apps/demo/native-src/DemoHandlers.swift`.

Enable in `app.json` with the matching `rustLibName` (must match your crate's `[lib] name`):

```json
["expo-conductor", {
  "enableRust": true,
  "rustLibName": "my_app_rust"
}]
```

**Build steps:**

```sh
# Android (requires cargo-ndk + Android NDK):
cargo ndk -t arm64-v8a -t x86_64 -o android/app/src/main/jniLibs \
  --manifest-path path/to/your/rust/Cargo.toml build --release

# iOS (requires the ios targets + Xcode):
cargo build --manifest-path path/to/your/rust/Cargo.toml \
  --target aarch64-apple-ios --release
cargo build --manifest-path path/to/your/rust/Cargo.toml \
  --target aarch64-apple-ios-sim --release
```

## Execution history & reconciliation

```ts
import Conductor from '@drakkar.software/expo-conductor';
import { foldHistory } from '@drakkar.software/expo-conductor/history';
import { reconcile } from '@drakkar.software/expo-conductor/reconcile';

// Raw lifecycle events persisted by the native layer (survives headless runs).
const events = await Conductor.getHistory();

// Fold events into paired records: { taskId, firedAt, result, durationMs, ... }
const records = foldHistory(events);

// Compare expected occurrences against actual records.
const tasks = await Conductor.getScheduled();
const { matched, missed, unexpected, aborted } = reconcile(tasks, records, {
  toleranceMs: 16 * 60_000,   // 16 min default — covers OS jitter + WorkManager flex
  windowMs:    24 * 60 * 60_000,
});
```

`missed` = expected occurrences with no matching record (task never ran or ran outside
tolerance). `aborted` = matched records whose `result` is `'failed'` or `'error'`.
`unexpected` = records with no expected occurrence (e.g. a manually triggered one-shot).

Reconciliation is exact for `time`, `recurrence`, and `alarm` triggers. For `background`
and `push` triggers it is **advisory** — the OS decides timing, not the scheduler.

See the [full documentation](../../README.md) for triggers, policy/weight/priority, the
config plugin options (`enableFcm`, `enablePush`, `enableExactAlarms`, `useExactAlarmClock`,
`backgroundTaskIdentifiers`, `enableRust`), platform support matrix, and the device test guide.

## Scripts

- `pnpm --filter expo-conductor test` — Jest (engine + orchestration + API)
- `pnpm --filter expo-conductor typecheck`
- `pnpm --filter expo-conductor build`
- `pnpm test:kotlin` / `pnpm test:swift` — native engine tests against the shared fixtures
- `pnpm test:rust` — Rust glue crate unit tests (host, no NDK needed)
- `pnpm test:rust:demo` — demo Rust crate (5 archetype handlers)
