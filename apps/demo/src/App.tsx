/**
 * expo-conductor demo app shell.
 *
 * Zero-dep tab navigation (no expo-router / react-navigation) so the load-bearing
 * `index.ts` entry ordering (tasks.ts registered before any component) is preserved.
 *
 * Screens:
 *  ⚗️  Lab        — 5-archetype × 3-language task matrix with per-cell config
 *  📜  History    — folded execution records (works for headless runs)
 *  🔍  Reconcile  — expected vs actual, flags missed / aborted executions
 *  ⚙️  System     — permissions, budget, lifecycle controls, live log
 */
import { StatusBar } from 'expo-status-bar';
import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ConductorProvider } from './state/ConductorProvider';
import { TabBar, type Tab } from './navigation/TabBar';
import { LabScreen } from './screens/LabScreen';
import { LogsScreen } from './screens/LogsScreen';
import { ReconciliationScreen } from './screens/ReconciliationScreen';
import { LifecycleScreen } from './screens/LifecycleScreen';
import { useTheme } from './theme';

function Shell() {
  const theme = useTheme();
  const [activeTab, setActiveTab] = useState<Tab>('lab');

  return (
    <View style={[styles.root, { backgroundColor: theme.bg }]}>
      <StatusBar style={theme.text === '#111827' ? 'dark' : 'light'} />

      {/* Screen area — each screen mounts permanently (no unmount on tab switch)
          so state is preserved across tabs without needing a context for all of it.
          The hidden screens use display:none equivalent via height:0+overflow:hidden. */}
      <View style={styles.screen}>
        <View style={activeTab === 'lab' ? styles.visible : styles.hidden}>
          <LabScreen />
        </View>
        <View style={activeTab === 'logs' ? styles.visible : styles.hidden}>
          <LogsScreen />
        </View>
        <View style={activeTab === 'reconcile' ? styles.visible : styles.hidden}>
          <ReconciliationScreen />
        </View>
        <View style={activeTab === 'lifecycle' ? styles.visible : styles.hidden}>
          <LifecycleScreen />
        </View>
      </View>

      <TabBar active={activeTab} onSelect={setActiveTab} theme={theme} />
    </View>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <ConductorProvider>
        <Shell />
      </ConductorProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  screen: { flex: 1 },
  visible: { flex: 1 },
  hidden: { height: 0, overflow: 'hidden' },
});
