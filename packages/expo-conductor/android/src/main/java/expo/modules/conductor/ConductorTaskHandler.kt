package expo.modules.conductor

/**
 * Contract for a *native* task handler. App developers implement this in their own
 * Kotlin code and register it with `ExpoConductorModule.registerHandler(name, handler)`
 * so a task's work can run entirely on the native side — no JS runtime needed. This
 * is the Android half of expo-conductor's "JS or native handler" dual dispatch.
 */
fun interface ConductorTaskHandler {
  /**
   * Execute the task. Implementations should be quick and respect background
   * execution limits. Return one of the result strings: "success", "failed",
   * "newData", "noData".
   */
  fun run(taskId: String, data: Map<String, Any?>): String
}
