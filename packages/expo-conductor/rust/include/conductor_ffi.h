/**
 * C ABI exported by the `conductor_ffi` Rust crate.
 *
 * Included by ConductorRustBridge.swift via the bridging header or as a module map
 * when CONDUCTOR_RUST is enabled. When CONDUCTOR_RUST is NOT defined (default), this
 * header is not compiled in and no symbols are required, preventing linker errors.
 *
 * Functions:
 *   conductor_dispatch — look up the handler registered under `name`, call it with
 *     `task_id` and `data_json` (a UTF-8 JSON string), and return the TaskResult as a
 *     heap-allocated UTF-8 C string. The caller MUST free it with conductor_free_string.
 *     Returns "noData\0" if no handler is registered for `name`.
 *     Returns "failed\0" if the handler panics (caught via catch_unwind).
 *
 *   conductor_free_string — free a string previously returned by conductor_dispatch.
 *
 *   conductor_app_init — called once at app startup (Application.onCreate / AppDelegate
 *     didFinishLaunchingWithOptions) to let the Rust crate register its handlers. The
 *     demo crate's implementation of this function registers the 5 archetype handlers.
 */
#pragma once
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Invoke the Rust handler named `name`.
 * Returns a heap-allocated C string (one of "success", "failed", "newData", "noData").
 * Caller must pass the returned pointer to conductor_free_string.
 */
char *conductor_dispatch(const char *name, const char *task_id, const char *data_json);

/** Free a string returned by conductor_dispatch. */
void conductor_free_string(char *ptr);

/**
 * Register all app-defined Rust handlers. Call once at startup before any task fires.
 * The demo crate defines this to register its 5 archetype handlers.
 * A no-op stub is exported by the library crate so the symbol always resolves.
 */
void conductor_app_init(void);

#ifdef __cplusplus
}
#endif
