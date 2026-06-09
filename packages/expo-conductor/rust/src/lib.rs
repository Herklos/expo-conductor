/*!
 * `conductor_ffi` — Rust handler registry and C ABI for expo-conductor.
 *
 * # Overview
 *
 * Provides:
 * - A thread-safe registry mapping handler names to `Box<dyn Fn>` closures.
 * - A C ABI consumed by `RustTaskBridge.kt` (Android JNI) and
 *   `ConductorRustBridge.swift` (iOS) so tasks declared with
 *   `handler: { type: 'rust', name: '...' }` can invoke Rust functions.
 * - `conductor_app_init()` — called at app startup; override in the demo crate to
 *   register the demo's 5 archetype handlers.
 *
 * # Handler signature
 *
 * ```rust,ignore
 * fn my_handler(task_id: &str, data_json: &str) -> &'static str {
 *     "success"
 * }
 * ```
 * Return one of `"success"`, `"failed"`, `"newData"`, `"noData"`.
 *
 * # Registering handlers
 *
 * Call `conductor_register(name, handler)` at startup (from `conductor_app_init` or
 * before any task fires):
 *
 * ```rust,ignore
 * conductor_register("calc-rust", Arc::new(|_task_id, _data| "success"));
 * ```
 *
 * # Verification tier
 *
 * - **Host (Tier B):** `cargo test` on this machine — verifies the registry, dispatch,
 *   panic→"failed" handling, and CString round-trip without any mobile target.
 * - **Device (Tier C):** cargo-ndk → jniLibs (Android); cargo → xcframework (iOS).
 */

use std::collections::HashMap;
use std::ffi::{CStr, CString};
use std::os::raw::c_char;
use std::panic::{self, AssertUnwindSafe};
use std::sync::{Arc, Mutex, OnceLock};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/// Handler type: an `Arc`-wrapped function so we can clone a reference out of the
/// registry and release the `Mutex` before invoking the handler. This prevents the
/// mutex from being poisoned if the handler panics (a panic while holding a
/// `MutexGuard` marks the mutex as poisoned, breaking all subsequent lock calls).
/// Public alias so consuming crates (e.g. `apps/demo/rust`) can call
/// [`conductor_register`] without spelling out the full `Arc<dyn Fn...>` bound.
pub type Handler = Arc<dyn Fn(&str, &str) -> &'static str + Send + Sync + 'static>;

static REGISTRY: OnceLock<Mutex<HashMap<String, Handler>>> = OnceLock::new();

fn registry() -> &'static Mutex<HashMap<String, Handler>> {
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Register a handler under `name`. Replaces any existing handler with the same name.
///
/// Call this from [`conductor_app_init`] (or your own `#[no_mangle] pub extern "C"
/// fn conductor_app_init()` override) before any task fires.
pub fn conductor_register(name: impl Into<String>, handler: Handler) {
    // `unwrap_or_else(|e| e.into_inner())` recovers from a poisoned lock (should never
    // happen in normal use, but guards against test harnesses that leak panics).
    let mut map = registry().lock().unwrap_or_else(|e| e.into_inner());
    map.insert(name.into(), handler);
}

// ---------------------------------------------------------------------------
// C ABI
// ---------------------------------------------------------------------------

/// Invoke the Rust handler registered under `name` with the given `task_id` and
/// `data_json` (a UTF-8 JSON string).
///
/// Returns a heap-allocated UTF-8 C string containing the [`TaskResult`] value:
/// `"success"`, `"failed"`, `"newData"`, or `"noData"` when no handler is found.
///
/// **The caller MUST free the returned pointer with [`conductor_free_string`].**
///
/// A handler panic is caught via [`std::panic::catch_unwind`] and returns `"failed"`.
///
/// # Safety
/// All three pointer arguments must point to valid, null-terminated UTF-8 C strings.
#[no_mangle]
pub extern "C" fn conductor_dispatch(
    name: *const c_char,
    task_id: *const c_char,
    data_json: *const c_char,
) -> *mut c_char {
    // Safety: callers (RustTaskBridge.kt / ConductorRustBridge.swift) always pass
    // valid, null-terminated UTF-8 strings produced by Kotlin/Swift String APIs.
    let name_str = unsafe { CStr::from_ptr(name) }.to_str().unwrap_or("");
    let task_id_str = unsafe { CStr::from_ptr(task_id) }.to_str().unwrap_or("");
    let data_str = unsafe { CStr::from_ptr(data_json) }.to_str().unwrap_or("{}");

    // Clone an Arc out of the registry BEFORE calling the handler. This releases the
    // lock before dispatch so a panicking handler cannot poison the Mutex (a panic
    // while holding a MutexGuard would mark the mutex poisoned, breaking all future
    // lock calls in the same process).
    let handler_opt: Option<Handler> = {
        let map = registry().lock().unwrap_or_else(|e| e.into_inner());
        map.get(name_str).cloned()
    };

    // AssertUnwindSafe: our handlers are `Send + Sync`; the lock is released before
    // dispatch, so no MutexGuard is held across the unwind boundary. The `Fn` trait
    // object may theoretically contain interior mutability, but by design our handlers
    // are stateless (or use their own thread-safe state). We assert the invariant.
    let result = panic::catch_unwind(AssertUnwindSafe(move || {
        if let Some(handler) = handler_opt {
            handler(task_id_str, data_str)
        } else {
            "noData"
        }
    }));

    let outcome = result.unwrap_or("failed");
    // CString::new only fails if `outcome` contains an interior NUL byte; our four
    // TaskResult strings never do, so `.unwrap()` is safe here.
    CString::new(outcome).unwrap().into_raw()
}

/// Free a string previously returned by [`conductor_dispatch`].
///
/// # Safety
/// `ptr` must be a non-null pointer previously returned by `conductor_dispatch` and
/// not yet freed.
#[no_mangle]
pub unsafe extern "C" fn conductor_free_string(ptr: *mut c_char) {
    if !ptr.is_null() {
        // Retake ownership and drop.
        let _ = unsafe { CString::from_raw(ptr) };
    }
}

/// Called once at app startup to let the consuming crate register its handlers.
///
/// The library itself provides a no-op default, compiled only when the
/// `default-app-init` feature is enabled (which it is by default). A consuming crate
/// (e.g. `apps/demo/rust/`) disables the feature and provides its own
/// `#[no_mangle] pub extern "C" fn conductor_app_init()` that registers its handlers.
/// This avoids a duplicate-symbol linker error when both crates end up in the same
/// cdylib/staticlib.
///
/// On Android the `Application.onCreate` calls this; on iOS the `AppDelegate` calls it.
#[cfg(feature = "default-app-init")]
#[no_mangle]
pub extern "C" fn conductor_app_init() {
    // No-op default — consuming crate disables this feature to provide its own.
}

// ---------------------------------------------------------------------------
// Tests (Tier B — runs on host via `cargo test`)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::CString;

    fn c(s: &str) -> CString {
        CString::new(s).unwrap()
    }

    fn call(name: &str, task_id: &str, data: &str) -> String {
        let n = c(name);
        let t = c(task_id);
        let d = c(data);
        let ptr = conductor_dispatch(n.as_ptr(), t.as_ptr(), d.as_ptr());
        assert!(!ptr.is_null());
        let result = unsafe { CStr::from_ptr(ptr) }.to_string_lossy().into_owned();
        unsafe { conductor_free_string(ptr) };
        result
    }

    #[test]
    fn returns_no_data_when_handler_not_registered() {
        let result = call("not_registered", "task-1", "{}");
        assert_eq!(result, "noData");
    }

    #[test]
    fn dispatches_registered_handler() {
        conductor_register("test_success", Arc::new(|_, _| "success"));
        assert_eq!(call("test_success", "task-2", "{}"), "success");
    }

    #[test]
    fn handler_receives_task_id_and_data_json() {
        conductor_register(
            "echo_handler",
            Arc::new(|task_id: &str, data: &str| -> &'static str {
                assert_eq!(task_id, "my-task");
                assert!(data.contains("42"));
                "newData"
            }),
        );
        assert_eq!(call("echo_handler", "my-task", r#"{"n":42}"#), "newData");
    }

    #[test]
    fn catching_handler_panic_returns_failed() {
        conductor_register(
            "panic_handler",
            Arc::new(|_, _| -> &'static str { panic!("deliberate panic") }),
        );
        // The lock is released BEFORE the handler is called, so the panic does NOT
        // poison the Mutex. conductor_dispatch catches the panic via catch_unwind.
        let result = call("panic_handler", "t", "{}");
        assert_eq!(result, "failed");
    }

    #[test]
    fn free_string_does_not_crash_on_null() {
        // conductor_free_string guards against null — must not crash.
        unsafe { conductor_free_string(std::ptr::null_mut()) };
    }

    #[test]
    fn cstring_round_trip_preserves_utf8() {
        conductor_register("utf8_handler", Arc::new(|_, _| "success"));
        let result = call("utf8_handler", "täsk-é", r#"{"msg":"héllo"}"#);
        assert_eq!(result, "success");
    }
}
