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
import Conductor, { Priority, type WeightPreset } from 'expo-conductor';
import { useTheme } from '../theme';
import { useConductor } from '../state/ConductorProvider';
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
  expanded: boolean;
}

const defaultCell = (weight: WeightPreset): CellSettings => ({
  active: false,
  priority: Priority.DEFAULT,
  weight,
  requiresCharging: false,
  requiresNetwork: false,
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

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function LabScreen() {
  const theme = useTheme();
  const { tasks, refresh } = useConductor();
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
            triggers: [{ type: 'recurrence', recurrence: { kind: 'interval', everyMs: 30_000 } }],
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
      setStatus(`✅ Scheduled ${scheduled} task${scheduled !== 1 ? 's' : ''}`);
    } catch (e) {
      setStatus('⚠ ' + (e instanceof Error ? e.message : 'Schedule failed'));
    }
  }, [cells, LANGS, refresh]);

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
      <Text style={[styles.screenTitle, { color: theme.text }]}>Cross-Language Lab</Text>
      <Text style={[styles.screenSub, { color: theme.muted }]}>
        Toggle cells, configure settings, then "Schedule active" to watch them run.
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
                  onToggle={() =>
                    updateCell(key, {
                      active: !(cell?.active ?? false),
                      expanded: !(cell?.active ?? false),
                    })
                  }
                  onExpandToggle={() => updateCell(key, { expanded: !(cell?.expanded ?? false) })}
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
  onExpandToggle: () => void;
  theme: ReturnType<typeof useTheme>;
}

function CellToggle({
  langColor,
  available,
  active,
  scheduled,
  onToggle,
  onExpandToggle,
  theme,
}: CellToggleProps) {
  if (!available) {
    return (
      <View style={[styles.cell, styles.cellDisabled, { borderColor: theme.border }]}>
        <Text style={{ color: theme.disabled, fontSize: 10 }}>N/A</Text>
      </View>
    );
  }

  return (
    <Pressable
      style={[
        styles.cell,
        {
          borderColor: active ? langColor : theme.border,
          backgroundColor: active ? `${langColor}18` : 'transparent',
        },
      ]}
      onPress={onToggle}
      onLongPress={onExpandToggle}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: active }}
    >
      <View
        style={[
          styles.cellDot,
          { backgroundColor: active ? langColor : theme.border },
        ]}
      />
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
  theme: ReturnType<typeof useTheme>;
}

function CellSettings({ langLabel, langColor, cell, onChange, theme }: CellSettingsProps) {
  return (
    <View style={[styles.settingsPanel, { borderColor: langColor }]}>
      <Text style={[styles.settingsTitle, { color: langColor }]}>{langLabel} settings</Text>

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
    </View>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  content: { padding: 16, paddingTop: 56 },
  screenTitle: { fontSize: 22, fontWeight: '700', marginBottom: 4 },
  screenSub: { fontSize: 13, marginBottom: 16, lineHeight: 18 },
  actionRow: { flexDirection: 'row', gap: 10, marginBottom: 8 },
  btn: { flex: 1, paddingVertical: 10, borderRadius: 10, alignItems: 'center' },
  btnText: { color: '#fff', fontWeight: '600', fontSize: 13 },
  status: { fontSize: 12, marginBottom: 10, textAlign: 'center' },

  headerRow: { flexDirection: 'row', marginBottom: 4, paddingHorizontal: 2 },
  archetypeLabel: { flex: 2, justifyContent: 'center' },
  colHeader: { flex: 1, alignItems: 'center' },
  colHeaderText: { fontSize: 11, fontWeight: '700' },

  archetypeCard: { padding: 10, marginBottom: 8 },
  archetypeRow: { flexDirection: 'row', alignItems: 'center', minHeight: 44 },
  archetypeIcon: { fontSize: 18, marginRight: 6 },
  archetypeText: { fontSize: 13, fontWeight: '500' },

  cell: {
    flex: 1,
    height: 40,
    marginHorizontal: 3,
    borderRadius: 8,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cellDisabled: { opacity: 0.35 },
  cellDot: { width: 10, height: 10, borderRadius: 5 },
  scheduledDot: {
    position: 'absolute',
    top: 4,
    right: 4,
    width: 6,
    height: 6,
    borderRadius: 3,
  },

  settingsPanel: {
    marginTop: 8,
    borderLeftWidth: 3,
    paddingLeft: 10,
    paddingTop: 4,
    paddingBottom: 4,
  },
  settingsTitle: { fontSize: 12, fontWeight: '700', marginBottom: 6 },
  settingsLabel: { fontSize: 11, marginTop: 4, marginBottom: 4 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 4 },
  chip: {
    paddingVertical: 4,
    paddingHorizontal: 10,
    borderRadius: 8,
    borderWidth: 1,
  },
  chipText: { fontSize: 11, fontWeight: '600' },
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
