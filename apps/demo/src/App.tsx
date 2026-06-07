import { StatusBar } from 'expo-status-bar';
import Conductor, {
  Priority,
  type RegisteredTask,
  type TaskDefinition,
} from 'expo-conductor';

import {
  backgroundTaskStatus,
  disableHeadlessBackground,
  enableHeadlessBackground,
} from './backgroundTask';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useColorScheme,
} from 'react-native';

/**
 * expo-conductor demo. Every section maps to a feature of the library so a developer
 * can validate behavior on a device, simulator or the web. The event log at the bottom
 * shows task lifecycle events in real time.
 */
export default function App() {
  const dark = useColorScheme() === 'dark';
  const theme = dark ? darkTheme : lightTheme;
  const [log, setLog] = useState<string[]>([]);
  const [tasks, setTasks] = useState<RegisteredTask[]>([]);
  const counter = useRef(0);

  const append = useCallback((line: string) => {
    const time = new Date().toLocaleTimeString();
    setLog((prev) => [`${time}  ${line}`, ...prev].slice(0, 100));
  }, []);

  const refresh = useCallback(async () => {
    setTasks(await Conductor.getTasks());
  }, []);

  // JS handlers ('sync'/'flaky'/'heavy') are registered at module scope in src/tasks.ts
  // (the correct headless-safe pattern). Here we only subscribe to lifecycle events to
  // drive the on-screen log.
  useEffect(() => {
    const subs = [
      Conductor.addListener('onTaskExecute', (p) =>
        append(`execute → ${p.taskId} (trigger=${p.triggerType}, attempt=${p.attempt})`),
      ),
      Conductor.addListener('onTaskComplete', (p) => append(`complete → ${p.taskId} (${p.result})`)),
      Conductor.addListener('onTaskSkipped', (p) => append(`skipped → ${p.taskId} (${p.reason})`)),
      Conductor.addListener('onTaskError', (p) => append(`error → ${p.taskId} (${p.error})`)),
    ];
    void refresh();
    return () => subs.forEach((s) => s.remove());
  }, [append, refresh]);

  const schedule = useCallback(
    async (def: TaskDefinition) => {
      const task = await Conductor.schedule(def);
      append(`scheduled "${task.id}" nextRunAt=${task.nextRunAt ?? 'none'}`);
      await refresh();
    },
    [append, refresh],
  );

  const uniqueId = (base: string) => `${base}-${counter.current++}`;

  const actions: Section[] = useMemo(
    () => [
      {
        title: '1 · Time & recurrence triggers',
        buttons: [
          {
            label: 'One-shot in 5s',
            onPress: () =>
              schedule({ id: uniqueId('once'), handler: { name: 'sync', type: 'js' }, triggers: [{ type: 'time', inSeconds: 5 }] }),
          },
          {
            label: 'Every 5s (interval)',
            onPress: () =>
              schedule({
                id: uniqueId('interval'),
                handler: { name: 'sync', type: 'js' },
                triggers: [{ type: 'recurrence', recurrence: { kind: 'interval', everyMs: 5000 } }],
              }),
          },
          {
            label: 'Daily 09:30 (cron)',
            onPress: () =>
              schedule({
                id: uniqueId('daily'),
                handler: { name: 'sync', type: 'js' },
                triggers: [{ type: 'recurrence', recurrence: { kind: 'cron', expression: '30 9 *' } }],
              }),
          },
        ],
      },
      {
        title: '2 · Notification / alarm / background / push',
        buttons: [
          {
            label: 'Notification in 5s',
            onPress: () =>
              schedule({
                id: uniqueId('notif'),
                handler: { name: 'sync', type: 'js' },
                triggers: [{ type: 'notification', inSeconds: 5, title: 'Conductor', body: 'Task fired!' }],
              }),
          },
          {
            label: 'Exact alarm in 10s',
            onPress: () =>
              schedule({
                id: uniqueId('alarm'),
                handler: { name: 'sync', type: 'js' },
                triggers: [{ type: 'alarm', at: Date.now() + 10_000, allowWhileIdle: true }],
              }),
          },
          {
            label: 'Background task',
            onPress: () =>
              schedule({
                id: uniqueId('bg'),
                handler: { name: 'sync', type: 'js' },
                triggers: [{ type: 'background', minimumIntervalMinutes: 15 }],
              }),
          },
          {
            label: 'Push (FCM/APNs)',
            onPress: () =>
              schedule({
                id: uniqueId('push'),
                handler: { name: 'sync', type: 'js' },
                triggers: [{ type: 'push', matchKey: 'refresh' }],
              }),
          },
        ],
      },
      {
        title: '3 · Priority & resource weight',
        buttons: [
          {
            label: 'Constrain budget (cpu 0.5)',
            onPress: async () => {
              await Conductor.setResourceBudget({ cpu: 0.5, network: 1, battery: 1, memory: 1 });
              append('budget set: cpu=0.5');
            },
          },
          {
            label: 'Heavy + high priority in 3s',
            onPress: () =>
              schedule({
                id: uniqueId('heavy'),
                handler: { name: 'heavy', type: 'js' },
                priority: Priority.HIGH,
                weight: 'heavy',
                triggers: [{ type: 'time', inSeconds: 3 }],
              }),
          },
          {
            label: 'Reset budget',
            onPress: async () => {
              await Conductor.setResourceBudget({ cpu: 1, network: 1, battery: 1, memory: 1 });
              append('budget reset');
            },
          },
        ],
      },
      {
        title: '4 · Policy / constraints & retry',
        buttons: [
          {
            label: 'Requires charging in 3s',
            onPress: () =>
              schedule({
                id: uniqueId('charge'),
                handler: { name: 'sync', type: 'js' },
                triggers: [{ type: 'time', inSeconds: 3 }],
                policy: { constraints: { requiresCharging: true } },
              }),
          },
          {
            label: 'Flaky w/ retry in 3s',
            onPress: () =>
              schedule({
                id: uniqueId('flaky'),
                handler: { name: 'flaky', type: 'js' },
                triggers: [{ type: 'time', inSeconds: 3 }],
                policy: { retry: { maxAttempts: 3, backoffMs: 1000 } },
              }),
          },
        ],
      },
      {
        title: '5 · Lifecycle',
        buttons: [
          { label: 'Request notif permission', onPress: async () => append(`permission granted: ${await Conductor.requestPermissions()}`) },
          { label: 'Check status', onPress: async () => append(`status: ${await Conductor.getStatus()}`) },
          { label: 'Pause all', onPress: async () => { await Conductor.pause(); append('paused'); } },
          { label: 'Resume all', onPress: async () => { await Conductor.resume(); append('resumed'); await refresh(); } },
          {
            label: 'Cancel all',
            onPress: async () => {
              const all = await Conductor.getTasks();
              await Promise.all(all.map((t) => Conductor.cancelTask(t.id)));
              append(`cancelled ${all.length} task(s)`);
              await refresh();
            },
          },
        ],
      },
      {
        title: '6 · Headless background (Phase 2 · optional deps)',
        buttons: [
          {
            label: 'Enable headless tick',
            onPress: async () => append(`headless: ${await enableHeadlessBackground(15)}`),
          },
          {
            label: 'BG status',
            onPress: async () => append(await backgroundTaskStatus()),
          },
          {
            label: 'Disable headless tick',
            onPress: async () => append(`headless: ${await disableHeadlessBackground()}`),
          },
        ],
      },
    ],
    [append, refresh, schedule],
  );

  return (
    <ScrollView style={[styles.root, { backgroundColor: theme.bg }]} contentContainerStyle={styles.content}>
      <StatusBar style={dark ? 'light' : 'dark'} />
      <Text style={[styles.h1, { color: theme.text }]}>expo-conductor</Text>
      <Text style={[styles.subtitle, { color: theme.muted }]}>Tap a button, then watch the event log.</Text>

      {actions.map((section) => (
        <View key={section.title} style={styles.section}>
          <Text style={[styles.h2, { color: theme.text }]}>{section.title}</Text>
          <View style={styles.buttonRow}>
            {section.buttons.map((b) => (
              <Pressable key={b.label} style={[styles.button, { backgroundColor: theme.accent }]} onPress={b.onPress}>
                <Text style={styles.buttonText}>{b.label}</Text>
              </Pressable>
            ))}
          </View>
        </View>
      ))}

      <View style={styles.section}>
        <Text style={[styles.h2, { color: theme.text }]}>Registered tasks ({tasks.length})</Text>
        {tasks.length === 0 && <Text style={{ color: theme.muted }}>None yet.</Text>}
        {tasks.map((t) => (
          <Text key={t.id} style={[styles.task, { color: theme.text }]}>
            • {t.id} — p{t.priority} — next {t.nextRunAt ? new Date(t.nextRunAt).toLocaleTimeString() : '—'}
          </Text>
        ))}
      </View>

      <View style={styles.section}>
        <Text style={[styles.h2, { color: theme.text }]}>Event log</Text>
        {log.map((line, i) => (
          <Text key={i} style={[styles.logLine, { color: theme.muted }]}>{line}</Text>
        ))}
      </View>
    </ScrollView>
  );
}

interface Section {
  title: string;
  buttons: { label: string; onPress: () => void }[];
}

const lightTheme = { bg: '#fff', text: '#111', muted: '#666', accent: '#2563eb' };
const darkTheme = { bg: '#0b0b0c', text: '#f5f5f5', muted: '#9aa0a6', accent: '#3b82f6' };

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { padding: 20, paddingTop: 64, gap: 8 },
  h1: { fontSize: 28, fontWeight: '700' },
  subtitle: { fontSize: 14, marginBottom: 12 },
  section: { marginTop: 18 },
  h2: { fontSize: 16, fontWeight: '600', marginBottom: 8 },
  buttonRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  button: { paddingVertical: 10, paddingHorizontal: 14, borderRadius: 10 },
  buttonText: { color: '#fff', fontWeight: '600', fontSize: 13 },
  task: { fontSize: 13, marginVertical: 2, fontFamily: 'monospace' },
  logLine: { fontSize: 12, marginVertical: 1, fontFamily: 'monospace' },
});
