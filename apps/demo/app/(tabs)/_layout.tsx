/**
 * Native bottom tabs (iOS SwiftUI / Android Jetpack) via expo-router native tabs.
 *
 * NATIVE ONLY: Metro resolves `_layout.web.tsx` on the web platform, so this file — and
 * the `expo-router/unstable-native-tabs` native backing it imports — is never bundled for
 * web. The web build renders the JavaScript `Tabs` in `_layout.web.tsx` instead.
 *
 * Headers are NOT rendered here (native tabs have no JS header); each tab folder nests its
 * own `Stack` (`<tab>/_layout.tsx`) which supplies the screen header on every platform.
 */
import { NativeTabs } from 'expo-router/unstable-native-tabs';
import { useTheme } from '../../src/theme';

export default function TabsLayout() {
  const theme = useTheme();
  return (
    <NativeTabs tintColor={theme.tabActive}>
      <NativeTabs.Trigger name="lab">
        <NativeTabs.Trigger.Icon sf="flask.fill" md="science" />
        <NativeTabs.Trigger.Label>Lab</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="logs">
        <NativeTabs.Trigger.Icon sf="list.bullet.rectangle.fill" md="receipt_long" />
        <NativeTabs.Trigger.Label>Logs</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="reconcile">
        <NativeTabs.Trigger.Icon sf="checkmark.seal.fill" md="fact_check" />
        <NativeTabs.Trigger.Label>Reconcile</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="system">
        <NativeTabs.Trigger.Icon sf="gearshape.fill" md="settings" />
        <NativeTabs.Trigger.Label>System</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
