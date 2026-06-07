package expo.modules.conductor.triggers

import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import expo.modules.conductor.ExpoConductorModule
import expo.modules.conductor.storage.TaskStore

/**
 * Optional FCM trigger. Compiled only when the config plugin is configured with
 * `enableFcm: true`. A data message whose `data.conductorTask` matches a task's
 * push `matchKey` (or id) dispatches that task with the message data as input.
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
      val key = data["conductorTask"] ?: return
      val store = TaskStore(context)
      val task = store.all().firstOrNull { task ->
        if (task.optString("id") == key) return@firstOrNull true
        val triggers = task.optJSONArray("triggers") ?: return@firstOrNull false
        (0 until triggers.length()).any {
          val t = triggers.getJSONObject(it)
          t.optString("type") == "push" && (t.optString("matchKey") == key)
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
