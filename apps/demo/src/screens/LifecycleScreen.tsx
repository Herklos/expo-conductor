/**
 * Lifecycle Screen — permissions, conductor status, budget control, headless toggle,
 * and the real-time event log (migrated from the original App.tsx).
 */
import React, { useCallback, useState } from 'react';
import {
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import Conductor from 'expo-conductor';
import {
  backgroundTaskStatus,
  disableHeadlessBackground,
  enableHeadlessBackground,
} from '../backgroundTask';
import { useTheme } from '../theme';
import { useConductor } from '../state/ConductorProvider';
import { Card } from '../components/Card';

export function LifecycleScreen() {
  const theme = useTheme();
  const { tasks, liveLog, refresh } = useConductor();
  const [status, setStatus] = useState('');

  const run = useCallback(async (label: string, fn: () => Promise<string>) => {
    setStatus('…');
    try {
      const result = await fn();
      setStatus(`${label}: ${result}`);
    } catch (e) {
      setStatus(`${label} error: ${String(e)}`);
    }
  }, []);

  const SECTIONS: {
    title: string;
    buttons: { label: string; onPress: () => void }[];
  }[] = [
    {
      title: 'Permissions & Status',
      buttons: [
        {
          label: 'Request notification permission',
          onPress: () =>
            run('permission', async () =>
              String(await Conductor.requestPermissions()),
            ),
        },
        {
          label: 'Check conductor status',
          onPress: () => run('status', async () => await Conductor.getStatus()),
        },
      ],
    },
    {
      title: 'Conductor Control',
      buttons: [
        {
          label: 'Pause all',
          onPress: () =>
            run('pause', async () => {
              await Conductor.pause();
              return 'paused';
            }),
        },
        {
          label: 'Resume all',
          onPress: () =>
            run('resume', async () => {
              await Conductor.resume();
              await refresh();
              return 'resumed';
            }),
        },
        {
          label: 'Cancel all tasks',
          onPress: () =>
            run('cancel', async () => {
              const all = await Conductor.getTasks();
              await Promise.all(all.map((t) => Conductor.cancelTask(t.id)));
              await refresh();
              return `cancelled ${all.length} task(s)`;
            }),
        },
      ],
    },
    {
      title: 'Resource Budget',
      buttons: [
        {
          label: 'Constrain CPU (0.5)',
          onPress: () =>
            run('budget', async () => {
              await Conductor.setResourceBudget({ cpu: 0.5, network: 1, battery: 1, memory: 1 });
              return 'cpu=0.5';
            }),
        },
        {
          label: 'Constrain network (0.5)',
          onPress: () =>
            run('budget', async () => {
              await Conductor.setResourceBudget({ cpu: 1, network: 0.5, battery: 1, memory: 1 });
              return 'network=0.5';
            }),
        },
        {
          label: 'Reset budget (all 1.0)',
          onPress: () =>
            run('budget', async () => {
              await Conductor.setResourceBudget({ cpu: 1, network: 1, battery: 1, memory: 1 });
              return 'reset';
            }),
        },
      ],
    },
    {
      title: 'Headless Background (Phase 2 — optional deps)',
      buttons: [
        {
          label: 'Enable headless tick (15 min)',
          onPress: () =>
            run('headless', async () => String(await enableHeadlessBackground(15))),
        },
        {
          label: 'Background task status',
          onPress: () => run('bg', async () => backgroundTaskStatus()),
        },
        {
          label: 'Disable headless tick',
          onPress: () =>
            run('headless', async () => String(await disableHeadlessBackground())),
        },
      ],
    },
  ];

  return (
    <View style={[styles.root, { backgroundColor: theme.bg }]}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={[styles.title, { color: theme.text }]}>System & Lifecycle</Text>

        {status !== '' && (
          <View style={[styles.statusBanner, { backgroundColor: theme.accentMuted }]}>
            <Text style={[styles.statusText, { color: theme.accent }]}>{status}</Text>
          </View>
        )}

        {/* Registered tasks summary */}
        <Card theme={theme} style={styles.tasksCard}>
          <Text style={[styles.sectionTitle, { color: theme.text }]}>
            Registered tasks ({tasks.length})
          </Text>
          {tasks.length === 0 ? (
            <Text style={[styles.empty, { color: theme.muted }]}>None yet.</Text>
          ) : (
            tasks.map((t) => (
              <Text key={t.id} style={[styles.taskLine, { color: theme.muted }]}>
                • {t.id} — p{t.priority} — next{' '}
                {t.nextRunAt ? new Date(t.nextRunAt).toLocaleTimeString() : '—'}
              </Text>
            ))
          )}
        </Card>

        {/* Action sections */}
        {SECTIONS.map((section) => (
          <Card key={section.title} theme={theme}>
            <Text style={[styles.sectionTitle, { color: theme.text }]}>{section.title}</Text>
            <View style={styles.buttonRow}>
              {section.buttons.map((b) => (
                <Pressable
                  key={b.label}
                  style={[styles.btn, { backgroundColor: theme.accent }]}
                  onPress={b.onPress}
                >
                  <Text style={styles.btnText}>{b.label}</Text>
                </Pressable>
              ))}
            </View>
          </Card>
        ))}

        <View style={{ height: 16 }} />
      </ScrollView>

      {/* Live log — docked at bottom */}
      <View
        style={[
          styles.logContainer,
          { backgroundColor: theme.card, borderTopColor: theme.border },
        ]}
      >
        <Text style={[styles.logTitle, { color: theme.text }]}>
          Live event log ({liveLog.length})
        </Text>
        <FlatList
          data={liveLog}
          keyExtractor={(_, i) => String(i)}
          renderItem={({ item }) => (
            <Text style={[styles.logLine, { color: theme.muted }]}>{item}</Text>
          )}
          style={styles.logList}
          nestedScrollEnabled
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { padding: 16, paddingTop: 56, gap: 4 },
  title: { fontSize: 20, fontWeight: '700', marginBottom: 12 },
  statusBanner: {
    padding: 10,
    borderRadius: 8,
    marginBottom: 10,
  },
  statusText: { fontSize: 13 },
  tasksCard: { marginBottom: 10 },
  sectionTitle: { fontSize: 14, fontWeight: '600', marginBottom: 8 },
  empty: { fontSize: 13 },
  taskLine: { fontSize: 12, fontFamily: 'monospace', marginVertical: 1 },
  buttonRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  btn: { paddingVertical: 9, paddingHorizontal: 14, borderRadius: 10 },
  btnText: { color: '#fff', fontWeight: '600', fontSize: 12 },
  logContainer: {
    height: 160,
    borderTopWidth: StyleSheet.hairlineWidth,
    padding: 8,
  },
  logTitle: { fontSize: 11, fontWeight: '600', marginBottom: 4 },
  logList: { flex: 1 },
  logLine: { fontSize: 11, fontFamily: 'monospace', marginVertical: 1 },
});
