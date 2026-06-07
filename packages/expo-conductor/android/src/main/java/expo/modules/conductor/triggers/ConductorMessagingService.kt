package expo.modules.conductor.triggers

import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import expo.modules.conductor.ExpoConductorModule
import expo.modules.conductor.storage.TaskStore

/**
 * Optional FCM trigger. Compiled only when the config plugin is configured with
 * `enableFcm: true`. A data message whose `data.conductorTask` matches the `matchKey`
 * of a task's `push` trigger dispatches that task with the message data as input.
 *
 * Security: matching is restricted to tasks that explicitly declare a `push` trigger,
 * so a forged remote message cannot trigger arbitrary tasks by id. Treat the message
 * `data` passed to handlers as untrusted, attacker-controllable input.
 *
 * Apps that already use their own FirebaseMessagingService can instead forward
 * messages to {@link #handleRemoteData}.
 */
class ConductorMessagingService : FirebaseMessagingService() {
  override fun onMessageReceived(message: RemoteMessage) {
    handleRemoteData(this.applicationContext, message.data)
  }

  companion object {
    fun handleRemoteData(context: android.content.Context, data: Map<String, String>) {
      // Reject a missing OR empty key: a forged `conductorTask=""` must not match a push
      // trigger that declared no matchKey (optString returns "" for an absent matchKey, so
      // "" == "" would otherwise fire it). Require both sides non-empty.
      val key = data["conductorTask"]
      if (key.isNullOrEmpty()) return
      val store = TaskStore(context)
      val task = store.all().firstOrNull { task ->
        val triggers = task.optJSONArray("triggers") ?: return@firstOrNull false
        (0 until triggers.length()).any {
          val t = triggers.getJSONObject(it)
          val matchKey = t.optString("matchKey")
          t.optString("type") == "push" && matchKey.isNotEmpty() && matchKey == key
        }
      } ?: return
      val module = ExpoConductorModule.INSTANCE
      if (module != null) {
        module.dispatch(task, manual = false, data = data)
      } else {
        ExpoConductorModule.dispatchHeadless(context, task, data)
      }
    }
  }
}
