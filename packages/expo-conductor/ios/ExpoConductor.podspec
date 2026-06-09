require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'ExpoConductor'
  s.version        = package['version']
  s.summary        = package['description']
  s.description    = package['description']
  s.license        = package['license']
  s.author         = 'expo-conductor'
  s.homepage       = package['homepage'] || 'https://github.com/herklos/expo-conductor'
  s.platforms      = { :ios => '15.1', :tvos => '15.1' }
  s.swift_version  = '5.9'
  s.source         = { git: 'https://github.com/herklos/expo-conductor' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  # Whether the Rust FFI handler crate is linked in (cargo → xcframework, built by the
  # config plugin at prebuild). Default off — CONDUCTOR_RUST is not defined, so the Rust
  # dispatch paths compile to no-ops and no xcframework link is required.
  enable_rust = ENV['CONDUCTOR_RUST'] == '1'

  xcconfig_flags = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule',
  }
  xcconfig_flags['OTHER_SWIFT_FLAGS'] = '$(inherited) -DCONDUCTOR_RUST' if enable_rust

  s.pod_target_xcconfig = xcconfig_flags

  if enable_rust
    # The config plugin places the xcframework alongside the app's ios/ dir after prebuild.
    s.vendored_frameworks = '../../apps/demo/ios/ConductorFFI.xcframework'
    # Expose the C header so Swift can call the C ABI directly via the bridging mechanism.
    s.public_header_files = 'conductor_ffi.h'
  end

  # Engine + module + triggers only. The SwiftPM manifest (Package.swift) and the
  # XCTest sources under Tests/ must NOT be compiled into the app target.
  s.source_files = '*.swift', '*.h', 'Engine/**/*.swift', 'Triggers/**/*.swift'
  s.exclude_files = 'Tests/**/*', 'Package.swift'
end
