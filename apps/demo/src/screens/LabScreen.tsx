/**
 * Lab Screen — 5-archetype × 3-language task matrix.
 *
 * Archetypes: calc | cpu | ram | net | all
 * Languages:  JS (always) | Native — Kotlin/Swift (native builds only) | Rust (native + enableRust)
 *
 * Each cell can be toggled active. When active the user can configure priority,
 * resource weight, and execution constraints inline. "Schedule active" schedules all
 * active cells as recurring tasks (30s interval for demo purposes). "Cancel lab"
 * cancels every task whose ID starts with "lab-".
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';
import Conductor, { Priority, type Recurrence, type Trigger, type WeightPreset } from 'expo-conductor';
import { useTheme } from '../theme';
import { useConductor, type ScheduleConfig } from '../state/ConductorProvider';
import { Card } from '../components/Card';

// ---------------------------------------------------------------------------
// Data model
// ---------------------------------------------------------------------------

interface Archetype {
  id: string;
  label: string;
  icon: string;
  defaultWeight: WeightPreset;
  /** Handler name suffix for JS (maps to tasks.ts Conductor.defineTask name). */
  jsHandler: string;
}

const ARCHETYPES: Archetype[] = [
  { id: 'calc', label: 'Simple Calc', icon: '🧮', defaultWeight: 'light', jsHandler: 'lab-calc' },
  { id: 'cpu',  label: 'High CPU',    icon: '⚡', defaultWeight: 'heavy', jsHandler: 'lab-cpu' },
  { id: 'ram',  label: 'High RAM',    icon: '💾', defaultWeight: 'heavy', jsHandler: 'lab-ram' },
  { id: 'net',  label: 'High Network',icon: '🌐', defaultWeight: 'moderate', jsHandler: 'lab-net' },
  { id: 'all',  label: 'All Heavy',   icon: '🔥', defaultWeight: 'heavy', jsHandler: 'lab-all' },
];

type LangId = 'js' | 'native' | 'rust';

interface LangDef {
  id: LangId;
  label: string;
  color: string;
  available: boolean;
}

// ---------------------------------------------------------------------------
// Per-cell settings
// ---------------------------------------------------------------------------

interface CellSettings {
  active: boolean;
  priority: number;
  weight: WeightPreset;
  requiresCharging: boolean;
  requiresNetwork: boolean;
  notifyOnRun: boolean;
  expanded: boolean;
}

const defaultCell = (weight: WeightPreset): CellSettings => ({
  active: false,
  priority: Priority.DEFAULT,
  weight,
  requiresCharging: false,
  requiresNetwork: false,
  notifyOnRun: false,
  expanded: false,
});

type CellKey = string; // `${archetypeId}-${langId}`

const PRIORITY_OPTIONS: { label: string; value: number }[] = [
  { label: 'Min', value: Priority.MIN },
  { label: 'Low', value: Priority.LOW },
  { label: 'Default', value: Priority.DEFAULT },
  { label: 'High', value: Priority.HIGH },
  { label: 'Max', value: Priority.MAX },
];

const WEIGHT_OPTIONS: WeightPreset[] = ['light', 'moderate', 'heavy'];

function buildRecurrence(cfg: ScheduleConfig): Recurrence {
  switch (cfg.kind) {
    case 'daily':   return { kind: 'daily', hour: cfg.hour, minute: cfg.minute };
    case 'weekly':  return { kind: 'weekly', weekday: cfg.weekday, hour: cfg.hour, minute: cfg.minute };
    case 'cron':    return { kind: 'cron', expression: cfg.cron };
    default:        return { kind: 'interval', everyMs: cfg.everyMs };
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function LabScreen() {
  const theme = useTheme();
  const { tasks, refresh, triggerMode, scheduleConfig } = useConductor();
  const [status, setStatus] = useState('');
  const [runningTasks, setRunningTasks] = useState<Record<string, boolean>>({});
  const [lastDurations, setLastDurations] = useState<Record<string, number>>({});
  const startTimesRef = useRef<Record<string, number>>({});

  const nativeLabel =
    Platform.OS === 'android' ? 'Kotlin' : Platform.OS === 'ios' ? 'Swift' : 'Native';
  const isNativeAvailable = Platform.OS !== 'web';
  const isRustAvailable = Platform.OS !== 'web'; // runtime proxy; actual availability depends on build

  const LANGS: LangDef[] = useMemo(() => [
    { id: 'js',     label: 'JS',       color: '#f59e0b', available: true },
    { id: 'native', label: nativeLabel, color: '#3b82f6', available: isNativeAvailable },
    { id: 'rust',   label: 'Rust',      color: '#b45309', available: isRustAvailable },
  ], [nativeLabel, isNativeAvailable, isRustAvailable]);

  // Initialise all cells from ARCHETYPES × LANGS.
  const [cells, setCells] = useState<Record<CellKey, CellSettings>>(() => {
    const init: Record<CellKey, CellSettings> = {};
    for (const a of ARCHETYPES) {
      for (const l of LANGS) {
        init[`${a.id}-${l.id}`] = defaultCell(a.defaultWeight);
      }
    }
    return init;
  });

  const updateCell = useCallback(
    (key: CellKey, patch: Partial<CellSettings>) => {
      setCells((prev) => ({ ...prev, [key]: { ...prev[key], ...patch } }));
    },
    [],
  );

  // ---------------------------------------------------------------------------
  // Task ID / handler resolution
  // ---------------------------------------------------------------------------

  const resolveTask = (archetype: Archetype, lang: LangDef) => {
    const langSuffix =
      lang.id === 'native'
        ? Platform.OS === 'android'
          ? 'kotlin'
          : 'swift'
        : lang.id; // js | rust

    const taskId = `lab-${archetype.id}-${langSuffix}`;

    let handlerName: string;
    let handlerType: 'js' | 'native' | 'rust';

    if (lang.id === 'js') {
      handlerName = archetype.jsHandler;
      handlerType = 'js';
    } else if (lang.id === 'native') {
      handlerName = `lab-${archetype.id}-${langSuffix}`;
      handlerType = 'native';
    } else {
      handlerName = `lab-${archetype.id}-rust`;
      handlerType = 'rust';
    }

    return { taskId, handlerName, handlerType } as const;
  };

  // ---------------------------------------------------------------------------
  // Schedule / cancel
  // ---------------------------------------------------------------------------

  const buildTriggers = useCallback((taskId: string, notifyOnRun: boolean): Trigger[] => {
    const recurrence = buildRecurrence(scheduleConfig);
    const notifTrigger: Trigger[] = notifyOnRun
      ? [{ type: 'notification', title: 'Lab Task', body: taskId, inSeconds: Math.max(10, Math.round((scheduleConfig.everyMs ?? 30_000) / 1000)), runInBackground: true }]
      : [];
    // Every mode is branched explicitly: a forgotten mode would otherwise silently fall
    // through to a recurrence task (TS can't catch that with an if/else), so the `never`
    // default keeps this exhaustive against the TriggerMode union.
    switch (triggerMode) {
      case 'interval':
        return [{ type: 'recurrence', recurrence }, ...notifTrigger];
      case 'alarm':
        return [
          { type: 'alarm', at: Date.now() + 5_000, allowWhileIdle: true },
          { type: 'recurrence', recurrence },
          ...notifTrigger,
        ];
      case 'notification':
        return [{ type: 'notification', title: 'Lab Task', body: taskId, inSeconds: 10, runInBackground: true }];
      case 'time':
        return [{ type: 'time', inSeconds: 10 }, ...notifTrigger];
      case 'background':
        return [{ type: 'background', minimumIntervalMinutes: 15 }, ...notifTrigger];
      case 'appState':
        return [{ type: 'appState', on: 'foreground' }, ...notifTrigger];
      case 'push':
        // matchKey = taskId so a real FCM/APNs `data.conductorTask` could route to it; on
        // web there is no push path, so the ▶ run button fires it by id (see hub caption).
        return [{ type: 'push', matchKey: taskId }, ...notifTrigger];
      case 'userInitiatedBackground':
        return [{ type: 'userInitiatedBackground' }, ...notifTrigger];
      default: {
        const _exhaustive: never = triggerMode;
        return _exhaustive;
      }
    }
  }, [triggerMode, scheduleConfig]);

  const scheduleActive = useCallback(async () => {
    setStatus('Scheduling…');
    let scheduled = 0;
    try {
      for (const archetype of ARCHETYPES) {
        for (const lang of LANGS) {
          if (!lang.available) continue;
          const key = `${archetype.id}-${lang.id}`;
          const cell = cells[key];
          if (!cell?.active) continue;

          const { taskId, handlerName, handlerType } = resolveTask(archetype, lang);

          // Cancel existing instance first (ignore errors — task may not exist).
          try { await Conductor.cancelTask(taskId); } catch { /* ok */ }

          await Conductor.schedule({
            id: taskId,
            handler: { name: handlerName, type: handlerType },
            triggers: buildTriggers(taskId, cell.notifyOnRun),
            priority: cell.priority,
            weight: cell.weight,
            policy: {
              constraints: {
                ...(cell.requiresCharging ? { requiresCharging: true } : {}),
                ...(cell.requiresNetwork ? { network: 'any' as const } : {}),
              },
            },
          });
          scheduled++;
        }
      }
      await refresh();
      setStatus(`✅ Scheduled ${scheduled} task${scheduled !== 1 ? 's' : ''} · ${triggerMode}`);
    } catch (e) {
      setStatus('⚠ ' + (e instanceof Error ? e.message : 'Schedule failed'));
    }
  }, [cells, LANGS, refresh, buildTriggers, triggerMode]);

  const cancelLab = useCallback(async () => {
    setStatus('Cancelling…');
    try {
      const all = await Conductor.getTasks();
      const lab = all.filter((t) => t.id.startsWith('lab-'));
      await Promise.all(lab.map((t) => Conductor.cancelTask(t.id)));
      await refresh();
      setStatus(`🗑 Cancelled ${lab.length} lab task${lab.length !== 1 ? 's' : ''}`);
    } catch (e) {
      setStatus('⚠ ' + (e instanceof Error ? e.message : 'Cancel failed'));
    }
  }, [refresh]);

  // ---------------------------------------------------------------------------
  // Run-now: fire a scheduled task immediately, track duration
  // ---------------------------------------------------------------------------

  useEffect(() => {
    const done = (p: { taskId: string }, trackDuration: boolean) => {
      if (!(p.taskId in startTimesRef.current)) return;
      const dur = trackDuration ? Date.now() - startTimesRef.current[p.taskId] : undefined;
      delete startTimesRef.current[p.taskId];
      setRunningTasks((prev) => ({ ...prev, [p.taskId]: false }));
      if (dur != null) setLastDurations((prev) => ({ ...prev, [p.taskId]: dur }));
    };
    const s1 = Conductor.addListener('onTaskComplete', (p) => done(p, true));
    const s2 = Conductor.addListener('onTaskError', (p) => done(p, true));
    const s3 = Conductor.addListener('onTaskSkipped', (p) => done(p, false));
    return () => { s1.remove(); s2.remove(); s3.remove(); };
  }, []);

  const handleRunNow = useCallback(async (taskId: string) => {
    if (taskId in startTimesRef.current) return;
    startTimesRef.current[taskId] = Date.now();
    setRunningTasks((prev) => ({ ...prev, [taskId]: true }));
    try {
      await Conductor.runNow(taskId);
    } catch (e) {
      delete startTimesRef.current[taskId];
      setRunningTasks((prev) => ({ ...prev, [taskId]: false }));
      setStatus('⚠ ' + (e instanceof Error ? e.message : 'Run failed'));
    }
  }, []);

  const activeLabIds = useMemo(
    () => new Set(tasks.filter((t) => t.id.startsWith('lab-')).map((t) => t.id)),
    [tasks],
  );

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.bg }}
      contentContainerStyle={styles.content}
    >
      <Text style={[styles.screenSub, { color: theme.muted }]}>
        Tap a cell to activate · tap again to expand settings · schedule to run
      </Text>

      {/* Action bar */}
      <View style={styles.actionRow}>
        <Pressable
          style={[styles.btn, { backgroundColor: theme.accent }]}
          onPress={scheduleActive}
        >
          <Text style={styles.btnText}>▶ Schedule active</Text>
        </Pressable>
        <Pressable
          style={[styles.btn, { backgroundColor: theme.danger }]}
          onPress={cancelLab}
        >
          <Text style={styles.btnText}>✕ Cancel lab</Text>
        </Pressable>
      </View>
      {status !== '' && (
        <Text style={[styles.status, { color: theme.muted }]}>{status}</Text>
      )}

      {/* Language column headers */}
      <View style={styles.headerRow}>
        <View style={styles.archetypeLabel} />
        {LANGS.map((l) => (
          <View key={l.id} style={styles.colHeader}>
            <Text
              style={[
                styles.colHeaderText,
                { color: l.available ? l.color : theme.disabled },
              ]}
            >
              {l.label}
            </Text>
          </View>
        ))}
      </View>

      {/* Archetype rows */}
      {ARCHETYPES.map((archetype) => (
        <Card key={archetype.id} theme={theme} style={styles.archetypeCard}>
          {/* Row header */}
          <View style={styles.archetypeRow}>
            <View style={styles.archetypeLabel}>
              <Text style={styles.archetypeIcon}>{archetype.icon}</Text>
              <Text style={[styles.archetypeText, { color: theme.text }]}>
                {archetype.label}
              </Text>
            </View>

            {LANGS.map((lang) => {
              const key = `${archetype.id}-${lang.id}`;
              const cell = cells[key];
              const { taskId } = resolveTask(archetype, lang);
              const isScheduled = activeLabIds.has(taskId);

              return (
                <CellToggle
                  key={lang.id}
                  langColor={lang.color}
                  available={lang.available}
                  active={cell?.active ?? false}
                  scheduled={isScheduled}
                  expanded={cell?.expanded ?? false}
                  onToggle={() => {
                    if (!(cell?.active ?? false)) {
                      // activate + expand
                      updateCell(key, { active: true, expanded: true });
                    } else {
                      // already active → toggle expanded only
                      updateCell(key, { expanded: !(cell?.expanded ?? false) });
                    }
                  }}
                  onDeactivate={() => updateCell(key, { active: false, expanded: false })}
                  theme={theme}
                />
              );
            })}
          </View>

          {/* Run-now row — visible when at least one lang cell is scheduled */}
          {LANGS.some((l) => activeLabIds.has(resolveTask(archetype, l).taskId)) && (
            <View style={styles.runRow}>
              <View style={styles.archetypeLabel} />
              {LANGS.map((lang) => {
                const { taskId } = resolveTask(archetype, lang);
                const isScheduled = activeLabIds.has(taskId);
                const isRunning = runningTasks[taskId] ?? false;
                const dur = lastDurations[taskId];
                return (
                  <View key={lang.id} style={styles.runCell}>
                    {isScheduled && (
                      isRunning ? (
                        <ActivityIndicator size="small" color={lang.color} />
                      ) : (
                        <Pressable
                          style={[styles.runBtn, { borderColor: lang.color }]}
                          onPress={() => handleRunNow(taskId)}
                        >
                          <Text style={[styles.runBtnText, { color: lang.color }]}>▶</Text>
                        </Pressable>
                      )
                    )}
                    {dur != null && !isRunning && (
                      <Text style={[styles.durationText, { color: theme.muted }]}>
                        {dur < 1000 ? `${dur}ms` : `${(dur / 1000).toFixed(1)}s`}
                      </Text>
                    )}
                  </View>
                );
              })}
            </View>
          )}

          {/* Per-cell settings (one expanded at a time) */}
          {LANGS.map((lang) => {
            const key = `${archetype.id}-${lang.id}`;
            const cell = cells[key];
            if (!cell?.active || !cell?.expanded || !lang.available) return null;
            return (
              <CellSettings
                key={lang.id}
                langLabel={lang.label}
                langColor={lang.color}
                cell={cell}
                onChange={(patch) => updateCell(key, patch)}
                onDeactivate={() => updateCell(key, { active: false, expanded: false })}
                theme={theme}
              />
            );
          })}
        </Card>
      ))}

      <View style={{ height: 32 }} />
    </ScrollView>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

interface CellToggleProps {
  langColor: string;
  available: boolean;
  active: boolean;
  scheduled: boolean;
  expanded: boolean;
  onToggle: () => void;
  onDeactivate: () => void;
  theme: ReturnType<typeof useTheme>;
}

function CellToggle({
  langColor,
  available,
  active,
  scheduled,
  expanded,
  onToggle,
  theme,
}: CellToggleProps) {
  if (!available) {
    return (
      <View style={[styles.cell, styles.cellDisabled, { borderColor: theme.border }]}>
        <Text style={{ color: theme.disabled, fontSize: 9, letterSpacing: 0.5 }}>N/A</Text>
      </View>
    );
  }

  return (
    <Pressable
      style={[
        styles.cell,
        {
          borderColor: active ? langColor : theme.border,
          backgroundColor: active ? `${langColor}15` : 'transparent',
        },
      ]}
      onPress={onToggle}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: active }}
    >
      <View
        style={[
          styles.cellDot,
          { backgroundColor: active ? langColor : theme.disabled },
        ]}
      />
      {active && (
        <Text style={[styles.cellArrow, { color: langColor }]}>
          {expanded ? '▴' : '▾'}
        </Text>
      )}
      {scheduled && (
        <View style={[styles.scheduledDot, { backgroundColor: theme.success }]} />
      )}
    </Pressable>
  );
}

interface CellSettingsProps {
  langLabel: string;
  langColor: string;
  cell: CellSettings;
  onChange: (patch: Partial<CellSettings>) => void;
  onDeactivate: () => void;
  theme: ReturnType<typeof useTheme>;
}

function CellSettings({ langLabel, langColor, cell, onChange, onDeactivate, theme }: CellSettingsProps) {
  return (
    <View style={[styles.settingsPanel, { borderColor: langColor }]}>
      <View style={styles.settingsTitleRow}>
        <Text style={[styles.settingsTitle, { color: langColor }]}>{langLabel.toUpperCase()}</Text>
        <Pressable onPress={onDeactivate} style={[styles.deactivateBtn, { borderColor: theme.border }]}>
          <Text style={[styles.deactivateBtnText, { color: theme.muted }]}>DEACTIVATE</Text>
        </Pressable>
      </View>

      {/* Priority */}
      <Text style={[styles.settingsLabel, { color: theme.muted }]}>Priority</Text>
      <View style={styles.chipRow}>
        {PRIORITY_OPTIONS.map((p) => (
          <Pressable
            key={p.value}
            style={[
              styles.chip,
              {
                backgroundColor:
                  cell.priority === p.value ? theme.accent : theme.border + '60',
                borderColor: cell.priority === p.value ? theme.accent : theme.border,
              },
            ]}
            onPress={() => onChange({ priority: p.value })}
          >
            <Text
              style={[
                styles.chipText,
                { color: cell.priority === p.value ? '#fff' : theme.text },
              ]}
            >
              {p.label}
            </Text>
          </Pressable>
        ))}
      </View>

      {/* Weight */}
      <Text style={[styles.settingsLabel, { color: theme.muted }]}>Weight</Text>
      <View style={styles.chipRow}>
        {WEIGHT_OPTIONS.map((w) => (
          <Pressable
            key={w}
            style={[
              styles.chip,
              {
                backgroundColor:
                  cell.weight === w ? theme.accent : theme.border + '60',
                borderColor: cell.weight === w ? theme.accent : theme.border,
              },
            ]}
            onPress={() => onChange({ weight: w })}
          >
            <Text
              style={[
                styles.chipText,
                { color: cell.weight === w ? '#fff' : theme.text },
              ]}
            >
              {w}
            </Text>
          </Pressable>
        ))}
      </View>

      {/* Constraints */}
      <View style={styles.switchRow}>
        <Text style={[styles.switchLabel, { color: theme.text }]}>Requires charging</Text>
        <Switch
          value={cell.requiresCharging}
          onValueChange={(v) => onChange({ requiresCharging: v })}
          trackColor={{ true: theme.accent, false: theme.border }}
        />
      </View>
      <View style={styles.switchRow}>
        <Text style={[styles.switchLabel, { color: theme.text }]}>Requires network</Text>
        <Switch
          value={cell.requiresNetwork}
          onValueChange={(v) => onChange({ requiresNetwork: v })}
          trackColor={{ true: theme.accent, false: theme.border }}
        />
      </View>
      <View style={styles.switchRow}>
        <Text style={[styles.switchLabel, { color: theme.text }]}>Notify on run</Text>
        <Switch
          value={cell.notifyOnRun}
          onValueChange={(v) => onChange({ notifyOnRun: v })}
          trackColor={{ true: theme.accent, false: theme.border }}
        />
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  content: { padding: 16 },
  screenSub: { fontSize: 11, marginBottom: 16, lineHeight: 17 },
  actionRow: { flexDirection: 'row', gap: 10, marginBottom: 8 },
  btn: { flex: 1, paddingVertical: 10, borderRadius: 6, alignItems: 'center' },
  btnText: { color: '#fff', fontWeight: '700', fontSize: 12, letterSpacing: 0.5 },
  status: { fontSize: 11, marginBottom: 10, textAlign: 'center' },

  headerRow: { flexDirection: 'row', marginBottom: 4, paddingHorizontal: 2 },
  archetypeLabel: { flex: 2, justifyContent: 'center' },
  colHeader: { flex: 1, alignItems: 'center' },
  colHeaderText: { fontSize: 10, fontWeight: '800', letterSpacing: 1 },

  archetypeCard: { padding: 10, marginBottom: 6 },
  archetypeRow: { flexDirection: 'row', alignItems: 'center', minHeight: 44 },
  archetypeIcon: { fontSize: 16, marginRight: 6 },
  archetypeText: { fontSize: 12, fontWeight: '600' },

  cell: {
    flex: 1,
    height: 40,
    marginHorizontal: 3,
    borderRadius: 5,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cellDisabled: { opacity: 0.35 },
  cellDot: { width: 8, height: 8, borderRadius: 4 },
  cellArrow: { fontSize: 9, position: 'absolute', bottom: 3 },
  scheduledDot: {
    position: 'absolute',
    top: 4,
    right: 4,
    width: 5,
    height: 5,
    borderRadius: 3,
  },

  settingsPanel: {
    marginTop: 10,
    borderLeftWidth: 3,
    paddingLeft: 10,
    paddingTop: 6,
    paddingBottom: 6,
  },
  settingsTitleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
  settingsTitle: { fontSize: 10, fontWeight: '800', letterSpacing: 1.5 },
  deactivateBtn: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 3, borderWidth: 1 },
  deactivateBtnText: { fontSize: 8, fontWeight: '700', letterSpacing: 0.8 },
  settingsLabel: { fontSize: 9, fontWeight: '700', letterSpacing: 1, marginTop: 5, marginBottom: 3 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 5, marginBottom: 4 },
  chip: {
    paddingVertical: 4,
    paddingHorizontal: 9,
    borderRadius: 4,
    borderWidth: 1.5,
  },
  chipText: { fontSize: 10, fontWeight: '700', letterSpacing: 0.3 },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginVertical: 4,
  },
  switchLabel: { fontSize: 13 },

  runRow: { flexDirection: 'row', marginTop: 6, alignItems: 'center' },
  runCell: { flex: 1, alignItems: 'center', gap: 2 },
  runBtn: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, borderWidth: 1 },
  runBtnText: { fontSize: 11, fontWeight: '700' },
  durationText: { fontSize: 10, textAlign: 'center' },
});
