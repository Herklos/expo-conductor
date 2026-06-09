package expo.modules.conductor

/**
 * JNI bridge to the Rust handler crate (`conductor_ffi`). Loaded only when the app
 * is built with `expo.conductor.enableRust=true` (the config plugin sets this gradle
 * property and invokes cargo-ndk to produce the jniLibs). When Rust is disabled,
 * this class compiles but [dispatch] always returns `"noData"` (the library is never
 * loaded).
 *
 * The Rust crate exposes a C ABI:
 *   `conductor_app_init()`
 *   `conductor_dispatch(name: *const c_char, taskId: *const c_char, data_json: *const c_char) -> *mut c_char`
 *   `conductor_free_string(ptr: *mut c_char)`
 *
 * Call [dispatch] from the module's dispatch branch for `handlerType == "rust"`. The
 * returned result string matches the [TaskResult] vocabulary: "success" | "failed" |
 * "newData" | "noData".
 *
 * **Verification tier C** — requires NDK + cargo-ndk + a device/emulator. Not
 * exercisable in a host-only session.
 */
object RustTaskBridge {
  private var loaded = false

  init {
    try {
      // The library name is set at compile time by the config plugin via the
      // expo.conductor.rustLibName gradle property (default "conductor_ffi").
      // Using BuildConfig avoids a hardcoded name — app developers whose Rust crate
      // is named differently (e.g. the demo uses "conductor_demo_ffi") just set the
      // property and this bridge loads the right .so without source changes.
      System.loadLibrary(BuildConfig.CONDUCTOR_RUST_LIB_NAME)
      // Let the Rust crate register its handlers before the first dispatch arrives.
      // conductor_app_init() is exported from the loaded library; it populates the
      // registry that conductor_dispatch reads — both symbols are in the same .so,
      // so there is exactly one shared registry instance.
      nativeAppInit()
      loaded = true
    } catch (_: UnsatisfiedLinkError) {
      // Rust library not compiled in (enableRust=false or missing jniLibs). All
      // dispatch calls will return "noData" gracefully.
    }
  }

  /**
   * Invoke the Rust handler registered under [name] with the given [taskId] and
   * serialized JSON [data]. Returns a TaskResult string. If the library is not
   * loaded (enableRust=false) or the handler is not registered, returns `"noData"`.
   */
  fun dispatch(name: String, taskId: String, data: String): String {
    if (!loaded) return "noData"
    return try {
      nativeDispatch(name, taskId, data) ?: "noData"
    } catch (e: Throwable) {
      "failed"
    }
  }

  /** Calls `conductor_app_init()` in the Rust crate to register all app-provided handlers. */
  private external fun nativeAppInit()

  /** Calls `conductor_dispatch(name, taskId, data_json)` in the Rust crate. */
  private external fun nativeDispatch(name: String, taskId: String, dataJson: String): String?
}
