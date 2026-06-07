import {
  AndroidConfig,
  ConfigPlugin,
  withAndroidManifest,
  withInfoPlist,
  createRunOncePlugin,
  withGradleProperties,
} from 'expo/config-plugins';

/**
 * Config plugin for expo-conductor. Wires up the OS permissions, manifest entries,
 * background-task identifiers and (optionally) Firebase Cloud Messaging needed by the
 * conductor triggers. Add to app.json:
 *
 *   ["expo-conductor", { "enableFcm": false, "enableExactAlarms": true,
 *                        "backgroundTaskIdentifiers": ["com.expoconductor.refresh"] }]
 */
export interface ConductorPluginOptions {
  /** Compile + register the Firebase Cloud Messaging trigger (requires google-services). */
  enableFcm?: boolean;
  /** Request exact-alarm permissions on Android (SCHEDULE_EXACT_ALARM / USE_EXACT_ALARM). */
  enableExactAlarms?: boolean;
  /** iOS BGTaskScheduler identifiers to permit (added to Info.plist). */
  backgroundTaskIdentifiers?: string[];
}

const ANDROID_PERMISSIONS = [
  'android.permission.RECEIVE_BOOT_COMPLETED',
  'android.permission.WAKE_LOCK',
  'android.permission.POST_NOTIFICATIONS',
];

const EXACT_ALARM_PERMISSIONS = [
  'android.permission.SCHEDULE_EXACT_ALARM',
  'android.permission.USE_EXACT_ALARM',
];

const DEFAULT_BG_IDENTIFIERS = ['com.expoconductor.refresh'];

const withConductorAndroid: ConfigPlugin<ConductorPluginOptions> = (config, options) => {
  // Permissions.
  config = AndroidConfig.Permissions.withPermissions(config, [
    ...ANDROID_PERMISSIONS,
    ...(options.enableExactAlarms !== false ? EXACT_ALARM_PERMISSIONS : []),
  ]);

  // Pass the FCM toggle to the module's build.gradle.
  config = withGradleProperties(config, (cfg) => {
    cfg.modResults = cfg.modResults.filter(
      (item) => !(item.type === 'property' && item.key === 'expo.conductor.enableFcm'),
    );
    cfg.modResults.push({
      type: 'property',
      key: 'expo.conductor.enableFcm',
      value: String(Boolean(options.enableFcm)),
    });
    return cfg;
  });

  // The ConductorAlarmReceiver / BootReceiver are declared in the library's own
  // AndroidManifest.xml (so they work without the plugin and aren't duplicated by the
  // manifest merger). Only the optional FCM service is added here, when enabled.
  if (options.enableFcm) {
    config = withAndroidManifest(config, (cfg) => {
      const app = AndroidConfig.Manifest.getMainApplicationOrThrow(cfg.modResults);
      app.service = app.service ?? [];
      const name = 'expo.modules.conductor.triggers.ConductorMessagingService';
      if (!app.service.some((s) => s.$['android:name'] === name)) {
        app.service.push({
          $: { 'android:name': name, 'android:exported': 'false' },
          'intent-filter': [
            { action: [{ $: { 'android:name': 'com.google.firebase.MESSAGING_EVENT' } }] },
          ],
        } as never);
      }
      return cfg;
    });
  }

  return config;
};

const withConductorIos: ConfigPlugin<ConductorPluginOptions> = (config, options) => {
  return withInfoPlist(config, (cfg) => {
    const modes = new Set<string>((cfg.modResults.UIBackgroundModes as string[]) ?? []);
    // Only 'fetch' is needed: the module submits BGAppRefreshTaskRequest. ('processing'
    // would only be required for BGProcessingTaskRequest, which is not used.)
    modes.add('fetch');
    if (options.enableFcm) modes.add('remote-notification');
    cfg.modResults.UIBackgroundModes = Array.from(modes);

    const identifiers = new Set<string>([
      ...((cfg.modResults.BGTaskSchedulerPermittedIdentifiers as string[]) ?? []),
      ...(options.backgroundTaskIdentifiers ?? DEFAULT_BG_IDENTIFIERS),
    ]);
    cfg.modResults.BGTaskSchedulerPermittedIdentifiers = Array.from(identifiers);

    return cfg;
  });
};

const withConductor: ConfigPlugin<ConductorPluginOptions | undefined> = (config, options = {}) => {
  config = withConductorAndroid(config, options);
  config = withConductorIos(config, options);
  return config;
};

const pkg = { name: 'expo-conductor', version: '0.1.0' };

export default createRunOncePlugin(withConductor, pkg.name, pkg.version);
