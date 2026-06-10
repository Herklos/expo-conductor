/**
 * Web-compatible bottom tabs. Native builds use `_layout.tsx` (NativeTabs); Metro resolves
 * THIS file on web, where the SwiftUI/Jetpack native tabs are unavailable.
 *
 * `headerShown: false` because each tab folder nests a `Stack` that renders the shared
 * header on every platform — letting the JS tab bar add its own header too would double it.
 */
import { Tabs } from 'expo-router';
import { Text } from 'react-native';
import { useTheme } from '../../src/theme';

const ICONS: Record<string, string> = {
  lab: '⚗️',
  logs: '📜',
  reconcile: '🔍',
  system: '⚙️',
};

const tabIcon = (route: string) => () => <Text style={{ fontSize: 18 }}>{ICONS[route]}</Text>;

export default function TabsLayoutWeb() {
  const theme = useTheme();
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: theme.tabActive,
        tabBarInactiveTintColor: theme.tabInactive,
        tabBarStyle: { backgroundColor: theme.tabBar, borderTopColor: theme.tabBarBorder },
      }}
    >
      <Tabs.Screen name="lab" options={{ title: 'Lab', tabBarIcon: tabIcon('lab') }} />
      <Tabs.Screen name="logs" options={{ title: 'Logs', tabBarIcon: tabIcon('logs') }} />
      <Tabs.Screen name="reconcile" options={{ title: 'Reconcile', tabBarIcon: tabIcon('reconcile') }} />
      <Tabs.Screen name="system" options={{ title: 'System', tabBarIcon: tabIcon('system') }} />
    </Tabs>
  );
}
