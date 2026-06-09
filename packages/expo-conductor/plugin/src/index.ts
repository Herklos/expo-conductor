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
  /**
   * Enable the Rust FFI handler type (`handler.type: 'rust'`).
   *
   * **Android:** sets the `expo.conductor.enableRust=true` gradle property. The consuming
   * app (or a local config plugin) must also run `cargo-ndk` and place the produced
   * `.so` files under `android/app/src/main/jniLibs/<ABI>/libconductor_ffi.so`.
   *
   * **iOS:** sets the `CONDUCTOR_RUST=1` environment variable consumed by the podspec,
   * enabling the `#if CONDUCTOR_RUST` branches in `ConductorRustBridge.swift`. The
   * consuming app must also build and link the `ConductorFFI.xcframework`.
   *
   * Default `false` — zero impact on apps not using Rust handlers.
   */
  enableRust?: boolean;
  /** Request the user-revocable `SCHEDULE_EXACT_ALARM` permission (API 31+) for exact alarms.
   *  Default `true`. The module gracefully falls back to an inexact allow-while-idle alarm
   *  when the permission isn't granted, so this is safe for a general-purpose app. */
  enableExactAlarms?: boolean;
  /** Also request `USE_EXACT_ALARM` (API 33+), the **non-revocable** variant. Default `false`:
   *  Google Play restricts it to alarm-clock / calendar / reminder-class apps, so a general
   *  scheduler should NOT ship it (`SCHEDULE_EXACT_ALARM` alone is sufficient). Enable only if
   *  your app's core purpose qualifies, or Play may reject the build. */
  useExactAlarmClock?: boolean;
  /** Enable the iOS remote-notification background mode for the `push` trigger (APNs).
   *  `enableFcm` implies this; set it on its own for an APNs-only (no Firebase) setup. */
  enablePush?: boolean;
  /**
   * The Rust native library name to load on Android (without `lib` prefix / `.so`).
   * Default `"conductor_ffi"` — matches a Rust crate whose `[lib] name = "conductor_ffi"`.
   *
   * Override when your crate uses a different artifact name. For example, the demo crate
   * sets `"conductor_demo_ffi"` to avoid a Cargo rlib naming conflict with the upstream
   * `conductor_ffi` dependency:
   *
   *   `{ "enableRust": true, "rustLibName": "conductor_demo_ffi" }`
   *
   * **Android only.** Emitted as `expo.conductor.rustLibName` → `BuildConfig.CONDUCTOR_RUST_LIB_NAME`
   * → `System.loadLibrary(...)`. iOS links the Rust static lib at build time, so the
   * artifact name does not matter on that platform.
   */
  rustLibName?: string;
  /** Extra iOS BGTaskScheduler identifiers to permit. The module's own
   *  `software.drakkar.expoconductor.refresh` identifier is always included. */
  backgroundTaskIdentifiers?: string[];
}

const ANDROID_PERMISSIONS = [
  'android.permission.RECEIVE_BOOT_COMPLETED',
  'android.permission.WAKE_LOCK',
  'android.permission.POST_NOTIFICATIONS',
];

// The user-revocable exact-alarm permission a general scheduler should use (API 31+).
const SCHEDULE_EXACT_ALARM = 'android.permission.SCHEDULE_EXACT_ALARM';
// The non-revocable variant (API 33+) — Play-restricted to alarm-clock/calendar apps, opt-in.
const USE_EXACT_ALARM = 'android.permission.USE_EXACT_ALARM';

const DEFAULT_BG_IDENTIFIERS = ['software.drakkar.expoconductor.refresh'];

const withConductorAndroid: ConfigPlugin<ConductorPluginOptions> = (config, options) => {
  // Permissions. SCHEDULE_EXACT_ALARM ships by default (revocable, safe); USE_EXACT_ALARM is
  // Play-restricted, so it ships ONLY when the app explicitly opts in via useExactAlarmClock.
  const exactAlarmPermissions = [
    ...(options.enableExactAlarms !== false ? [SCHEDULE_EXACT_ALARM] : []),
    ...(options.useExactAlarmClock ? [USE_EXACT_ALARM] : []),
  ];
  config = AndroidConfig.Permissions.withPermissions(config, [
    ...ANDROID_PERMISSIONS,
    ...exactAlarmPermissions,
  ]);

  // Pass the FCM, Rust and rustLibName settings to the module's build.gradle via gradle properties.
  config = withGradleProperties(config, (cfg) => {
    const keysToRemove = new Set([
      'expo.conductor.enableFcm',
      'expo.conductor.enableRust',
      'expo.conductor.rustLibName',
    ]);
    cfg.modResults = cfg.modResults.filter(
      (item) => !(item.type === 'property' && keysToRemove.has(item.key)),
    );
    cfg.modResults.push({
      type: 'property',
      key: 'expo.conductor.enableFcm',
      value: String(Boolean(options.enableFcm)),
    });
    cfg.modResults.push({
      type: 'property',
      key: 'expo.conductor.enableRust',
      value: String(Boolean(options.enableRust)),
    });
    // Only emit rustLibName when explicitly set; build.gradle defaults to "conductor_ffi".
    if (options.rustLibName) {
      cfg.modResults.push({
        type: 'property',
        key: 'expo.conductor.rustLibName',
        value: options.rustLibName,
      });
    }
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
    if (options.enableFcm || options.enablePush) modes.add('remote-notification');
    cfg.modResults.UIBackgroundModes = Array.from(modes);

    // Always include the module's own identifier (the native code registers/submits it),
    // plus any extras the app declares — otherwise BGTaskScheduler throws at runtime.
    const identifiers = new Set<string>([
      ...((cfg.modResults.BGTaskSchedulerPermittedIdentifiers as string[]) ?? []),
      ...DEFAULT_BG_IDENTIFIERS,
      ...(options.backgroundTaskIdentifiers ?? []),
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
