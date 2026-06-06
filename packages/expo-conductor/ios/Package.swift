// swift-tools-version:5.9
// Standalone SwiftPM package that compiles the *pure* Swift conductor engine and runs
// the shared cross-platform fixtures through it via XCTest — no Xcode/CocoaPods needed.
// Run with `swift test` from this directory (or `pnpm test:swift`). The CocoaPods
// podspec (used by Expo) is independent and includes the full module + triggers.
import PackageDescription

let package = Package(
  name: "ExpoConductor",
  platforms: [.macOS(.v12), .iOS(.v15)],
  products: [
    .library(name: "ExpoConductor", targets: ["ExpoConductor"]),
  ],
  targets: [
    .target(name: "ExpoConductor", path: "Engine"),
    .testTarget(name: "ExpoConductorTests", dependencies: ["ExpoConductor"], path: "Tests"),
  ]
)
