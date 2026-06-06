// Standalone JVM project that compiles the *pure* Kotlin conductor engine and runs
// the shared cross-platform fixtures through it via JUnit. This lets the Android
// engine's behavior be verified on any machine with a JDK — no Android SDK/emulator
// required. Run with: `gradle test` from this directory (or `pnpm test:kotlin`).
plugins {
  kotlin("jvm") version "2.0.21"
}

repositories {
  mavenCentral()
}

dependencies {
  testImplementation("junit:junit:4.13.2")
  testImplementation("org.json:json:20240303")
}

sourceSets {
  main {
    kotlin.srcDir("../src/main/java/expo/modules/conductor/engine")
  }
}

kotlin {
  jvmToolchain(21)
}

tasks.test {
  useJUnit()
  // Point the tests at the repo-root shared fixtures directory.
  systemProperty("fixturesDir", file("../../../../fixtures").absolutePath)
  testLogging {
    events("passed", "failed", "skipped")
    showStandardStreams = true
  }
}
