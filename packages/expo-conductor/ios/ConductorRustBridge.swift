/**
 * Swift bridge to the Rust handler crate (`conductor_ffi`). Compiled only when the
 * app is built with `CONDUCTOR_RUST=1` (set by the config plugin via CocoaPods).
 *
 * The Rust crate exports a minimal C ABI (see `conductor_ffi.h`):
 *   `conductor_dispatch(name, task_id, data_json) -> UnsafeMutablePointer<CChar>?`
 *   `conductor_free_string(ptr)`
 *   `conductor_app_init()`
 *
 * Call `ConductorRustBridge.dispatch(name:taskId:dataJson:)` from the module's
 * dispatch branch when `handlerType == "rust"`.
 *
 * **Verification tier C** — requires cargo + xcframework + a device/simulator.
 * Not exercisable in a host-only session.
 */
#if CONDUCTOR_RUST

public enum ConductorRustBridge {
  /**
   * Invoke the Rust handler registered under `name`.
   * Returns a TaskResult string: "success" | "failed" | "newData" | "noData".
   * If the library is not loaded or the handler is missing, returns "noData".
   */
  public static func dispatch(name: String, taskId: String, dataJson: String) -> String {
    let result = conductor_dispatch(name, taskId, dataJson)
    guard let ptr = result else { return "noData" }
    let str = String(cString: ptr)
    conductor_free_string(ptr)
    return str
  }

  /// Call once at startup to let the Rust crate register its handlers.
  public static func appInit() {
    conductor_app_init()
  }
}

#else

/// Stub used when CONDUCTOR_RUST is not enabled — dispatch always returns "noData".
public enum ConductorRustBridge {
  public static func dispatch(name: String, taskId: String, dataJson: String) -> String {
    return "noData"
  }
  public static func appInit() {}
}

#endif
