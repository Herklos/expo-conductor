// @ts-check
/**
 * conductor-rust.plugin.js — local Expo config plugin for the expo-conductor demo.
 *
 * Responsibilities at `expo prebuild`:
 *
 * 1. **Kotlin handlers** — copies `native-src/DemoHandlers.kt` into the generated
 *    `android/app/src/main/java/software/drakkar/expoconductor/demo/` directory and
 *    injects a `DemoHandlers.register()` call into `MainApplication.onCreate`.
 *
 * 2. **Swift handlers** — copies `native-src/DemoHandlers.swift` into the generated
 *    `ios/` directory and injects `DemoHandlers.register()` into the AppDelegate.
 *
 * 3. **Rust library** — documents the manual `cargo` / `cargo-ndk` build step required
 *    to place the compiled `.so` / `.a` where the Android/iOS build systems can find it.
 *    The actual `cargo` invocation is NOT run automatically here because it requires
 *    environment-specific toolchains (NDK path, iOS targets) that differ per machine.
 *    Run the commands documented below before `expo run:android` / `expo run:ios`.
 *
 * ## Build steps (run once per target after `expo prebuild`)
 *
 * ### Android (requires cargo-ndk + Android NDK):
 * ```sh
 * cargo ndk \
 *   -t armeabi-v7a -t arm64-v8a -t x86 -t x86_64 \
 *   -o android/app/src/main/jniLibs \
 *   --manifest-path apps/demo/rust/Cargo.toml \
 *   build --release
 * ```
 * Output: `android/app/src/main/jniLibs/<ABI>/libconductor_demo_ffi.so`
 * Loaded via `System.loadLibrary("conductor_demo_ffi")` (set by `rustLibName` in app.json).
 *
 * ### iOS (requires the ios target, Xcode):
 * ```sh
 * cargo build --manifest-path apps/demo/rust/Cargo.toml \
 *   --target aarch64-apple-ios --release
 * cargo build --manifest-path apps/demo/rust/Cargo.toml \
 *   --target aarch64-apple-ios-sim --release
 * # Combine into a fat lib and link from Xcode (see the Xcode linking note in README).
 * ```
 */

const {
  withDangerousMod,
  withMainApplication,
  withAppDelegate,
  createRunOncePlugin,
} = require('expo/config-plugins');
const path = require('path');
const fs = require('fs');

const PLUGIN_NAME = 'conductor-rust-demo';

// ---------------------------------------------------------------------------
// Android — copy DemoHandlers.kt + inject registration call
// ---------------------------------------------------------------------------

const withDemoHandlersAndroid = (config) => {
  // 1. Copy the Kotlin source file into the generated android project.
  config = withDangerousMod(config, [
    'android',
    async (cfg) => {
      const srcFile = path.join(__dirname, 'native-src', 'DemoHandlers.kt');
      const destDir = path.join(
        cfg.modRequest.projectRoot,
        'android', 'app', 'src', 'main', 'java',
        'software', 'drakkar', 'expoconductor', 'demo',
      );
      if (fs.existsSync(srcFile)) {
        fs.mkdirSync(destDir, { recursive: true });
        fs.copyFileSync(srcFile, path.join(destDir, 'DemoHandlers.kt'));
      }
      return cfg;
    },
  ]);

  // 2. Inject DemoHandlers.register() into MainApplication.onCreate.
  config = withMainApplication(config, (cfg) => {
    let contents = cfg.modResults.contents;

    // Add import if not already present.
    const importLine = 'import software.drakkar.expoconductor.demo.DemoHandlers';
    if (!contents.includes(importLine)) {
      // Insert after the last existing `import` line.
      contents = contents.replace(
        /^(import .+)(\n)(?!import )/m,
        `$1\n${importLine}\n`,
      );
    }

    // Inject registration call in onCreate after super.onCreate().
    const superCall = 'super.onCreate()';
    const registerCall = 'DemoHandlers.register()';
    if (!contents.includes(registerCall)) {
      contents = contents.replace(
        superCall,
        `${superCall}\n    ${registerCall}`,
      );
    }

    cfg.modResults.contents = contents;
    return cfg;
  });

  return config;
};

// ---------------------------------------------------------------------------
// iOS — copy DemoHandlers.swift + inject registration call
// ---------------------------------------------------------------------------

const withDemoHandlersIos = (config) => {
  // 1. Copy the Swift source file into the generated ios project.
  config = withDangerousMod(config, [
    'ios',
    async (cfg) => {
      const srcFile = path.join(__dirname, 'native-src', 'DemoHandlers.swift');
      const destDir = path.join(cfg.modRequest.projectRoot, 'ios');
      if (fs.existsSync(srcFile)) {
        fs.copyFileSync(srcFile, path.join(destDir, 'DemoHandlers.swift'));
      }
      return cfg;
    },
  ]);

  // 2. Inject DemoHandlers.register() into the AppDelegate.
  config = withAppDelegate(config, (cfg) => {
    let contents = cfg.modResults.contents;

    // Inject before the `return super.application(...)` call.
    const returnCall = 'return super.application(application, didFinishLaunchingWithOptions: launchOptions)';
    const registerCall = 'DemoHandlers.register()';
    if (!contents.includes(registerCall)) {
      contents = contents.replace(
        returnCall,
        `${registerCall}\n    ${returnCall}`,
      );
    }

    cfg.modResults.contents = contents;
    return cfg;
  });

  return config;
};

// ---------------------------------------------------------------------------
// Rust build documentation (no automatic execution — see file header)
// ---------------------------------------------------------------------------

const withRustBuildDoc = (config) => {
  // Log build instructions so the developer sees them after prebuild.
  config = withDangerousMod(config, [
    'android',
    async (cfg) => {
      const msg =
        '\n[conductor-rust] Rust library NOT built automatically.\n' +
        'Run the following before `expo run:android`:\n' +
        '  cargo ndk -t arm64-v8a -o android/app/src/main/jniLibs \\\n' +
        '    --manifest-path apps/demo/rust/Cargo.toml build --release\n';
      console.warn(msg);
      return cfg;
    },
  ]);
  return config;
};

// ---------------------------------------------------------------------------
// Compose
// ---------------------------------------------------------------------------

const withConductorRustDemo = (config) => {
  config = withDemoHandlersAndroid(config);
  config = withDemoHandlersIos(config);
  config = withRustBuildDoc(config);
  return config;
};

module.exports = createRunOncePlugin(withConductorRustDemo, PLUGIN_NAME, '1.0.0');
