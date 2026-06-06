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

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  # Engine + module + triggers only. The SwiftPM manifest (Package.swift) and the
  # XCTest sources under Tests/ must NOT be compiled into the app target.
  s.source_files = '*.swift', 'Engine/**/*.swift', 'Triggers/**/*.swift'
  s.exclude_files = 'Tests/**/*', 'Package.swift'
end
