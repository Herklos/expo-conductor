/**
 * Optional first-party interop (Phase 3, draft): delegate the user-visible notification
 * concerns conductor can't do well on its own to `expo-notifications` — real permission
 * prompts (incl. Android 13+ from an Activity), Android notification channels, foreground
 * presentation control, and crucially **cold-start response handling**
 * (`getLastNotificationResponseAsync`) so a notification tap that relaunches a terminated
 * app still reaches the right conductor task.
 *
 * Requires the optional peer dep `expo-notifications`. Conductor keeps its engine
 * (priority/weight/policy/recurrence); this only owns the notification surface.
 *
 * Usage — call once at app startup (module scope or root effect):
 * ```ts
 * import { setupConductorNotifications } from 'expo-conductor/notifications';
 * await setupConductorNotifications();
 * ```
 * Then a notification whose `content.data.conductorTask` is a task id will run that task
 * (via `Conductor.runNow`) when delivered or tapped — including from a cold start.
 */
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import Conductor from '../index';

/** Android channel conductor notifications are posted on. */
export const CONDUCTOR_CHANNEL_ID = 'expo-conductor';

export interface ConductorNotificationsOptions {
  /** Foreground presentation (defaults: banner + list + sound, no badge). */
  foreground?: {
    banner?: boolean;
    list?: boolean;
    sound?: boolean;
    badge?: boolean;
  };
  /** Android channel display name. */
  channelName?: string;
}

let responseSub: Notifications.Subscription | undefined;

function runTaskFrom(response: Notifications.NotificationResponse | null): void {
  const data = response?.notification.request.content.data as Record<string, unknown> | undefined;
  const id = data?.conductorTask;
  if (typeof id === 'string') void Conductor.runNow(id);
}

/**
 * Wire expo-notifications to conductor: foreground presentation, an Android channel, and
 * response routing (live + cold start). Idempotent.
 */
export async function setupConductorNotifications(
  options: ConductorNotificationsOptions = {},
): Promise<void> {
  const fg = options.foreground ?? {};
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: fg.banner ?? true,
      shouldShowList: fg.list ?? true,
      shouldPlaySound: fg.sound ?? true,
      shouldSetBadge: fg.badge ?? false,
    }),
  });

  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync(CONDUCTOR_CHANNEL_ID, {
      name: options.channelName ?? 'Tasks',
      importance: Notifications.AndroidImportance.DEFAULT,
    });
  }

  responseSub?.remove();
  responseSub = Notifications.addNotificationResponseReceivedListener(runTaskFrom);

  // Cold start: if the app was launched by tapping a conductor notification, run its task.
  const last = await Notifications.getLastNotificationResponseAsync();
  if (last) runTaskFrom(last);
}

/** Stop routing notification responses to conductor. */
export function teardownConductorNotifications(): void {
  responseSub?.remove();
  responseSub = undefined;
}

/** Prompt for notification permission via expo-notifications. Returns whether granted. */
export async function requestConductorNotificationPermissions(): Promise<boolean> {
  const { granted } = await Notifications.requestPermissionsAsync();
  return granted;
}
