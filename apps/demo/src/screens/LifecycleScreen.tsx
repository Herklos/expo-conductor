/**
 * System screen — conductor controls, trigger selector, permissions,
 * resource budget, headless tick, EAS update info, and task registry.
 */
import React, { useCallback, useMemo, useState } from 'react';
import {
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Updates from 'expo-updates';
import Conductor from 'expo-conductor';
import {
  backgroundTaskStatus,
  disableHeadlessBackground,
  enableHeadlessBackground,
} from '../backgroundTask';
import { useTheme, type Theme } from '../theme';
import { useConductor, type TriggerMode, type ScheduleConfig } from '../state/ConductorProvider';

const MONO = Platform.select({ ios: 'Courier New', android: 'monospace' }) ?? 'monospace';

function fmtDateTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// ─── Status dot ───────────────────────────────────────────────────────────────

function StatusDot({ color }: { color: string }) {
  return <View style={[dot.d, { backgroundColor: color }]} />;
}
const dot = StyleSheet.create({ d: { width: 8, height: 8, borderRadius: 4 } });

// ─── Section header with optional description ─────────────────────────────────

function Section({
  title,
  desc,
  theme,
  children,
}: {
  title: string;
  desc: string;
  theme: Theme;
  children: React.ReactNode;
}) {
  return (
    <View style={sec.wrap}>
      <View style={[sec.header, { borderLeftColor: theme.accent }]}>
        <Text style={[sec.title, { color: theme.accent, fontFamily: MONO }]}>{title}</Text>
      </View>
      {desc !== '' && <Text style={[sec.desc, { color: theme.muted }]}>{desc}</Text>}
      {children}
    </View>
  );
}
const sec = StyleSheet.create({
  wrap: { marginTop: 16, marginBottom: 4 },
  header: { borderLeftWidth: 3, paddingLeft: 10, marginBottom: 6 },
  title: { fontSize: 9, fontWeight: '800', letterSpacing: 2.5 },
  desc: { fontSize: 11, marginBottom: 10, lineHeight: 16, paddingLeft: 2 },
});

// ─── Outlined action button ───────────────────────────────────────────────────

function Btn({
  label,
  onPress,
  color,
  fill = false,
}: {
  label: string;
  onPress: () => void;
  color: string;
  fill?: boolean;
}) {
  return (
    <Pressable
      style={({ pressed }) => [
        btn.b,
        {
          borderColor: color,
          backgroundColor: fill ? color : pressed ? color + '28' : 'transparent',
          opacity: pressed ? 0.8 : 1,
        },
      ]}
      onPress={onPress}
    >
      <Text style={[btn.t, { color: fill ? '#fff' : color }]}>{label}</Text>
    </Pressable>
  );
}
const btn = StyleSheet.create({
  b: { paddingVertical: 7, paddingHorizontal: 14, borderRadius: 4, borderWidth: 1.5 },
  t: { fontSize: 10, fontWeight: '800', letterSpacing: 1 },
});

// ─── Trigger mode selector ────────────────────────────────────────────────────

const TRIGGER_MODES: { id: TriggerMode; label: string; sub: string }[] = [
  { id: 'interval',     label: 'Interval',     sub: 'WorkManager · recurrence trigger' },
  { id: 'alarm',        label: 'Exact Alarm',  sub: 'AlarmManager · precise timing' },
  { id: 'notification', label: 'Notification', sub: 'Local notification delivery · one-shot' },
];

function TriggerSelector({
  value,
  onChange,
  theme,
}: {
  value: TriggerMode;
  onChange: (m: TriggerMode) => void;
  theme: Theme;
}) {
  return (
    <View style={ts.wrap}>
      {TRIGGER_MODES.map((m) => {
        const sel = m.id === value;
        return (
          <Pressable
            key={m.id}
            style={[
              ts.row,
              {
                borderColor: sel ? theme.accent : theme.border,
                backgroundColor: sel ? theme.accentMuted : 'transparent',
              },
            ]}
            onPress={() => onChange(m.id)}
          >
            <View style={[ts.radio, { borderColor: sel ? theme.accent : theme.muted }]}>
              {sel && <View style={[ts.radioDot, { backgroundColor: theme.accent }]} />}
            </View>
            <View style={ts.textBlock}>
              <Text style={[ts.lab, { color: sel ? theme.accent : theme.text }]}>{m.label}</Text>
              <Text style={[ts.sub, { color: theme.muted, fontFamily: MONO }]}>{m.sub}</Text>
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}
const ts = StyleSheet.create({
  wrap: { gap: 4 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 9,
    paddingHorizontal: 12,
    borderRadius: 8,
    borderWidth: 1.5,
    gap: 12,
  },
  radio: { width: 16, height: 16, borderRadius: 8, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  radioDot: { width: 7, height: 7, borderRadius: 4 },
  textBlock: { flex: 1 },
  lab: { fontSize: 13, fontWeight: '700' },
  sub: { fontSize: 10, marginTop: 1 },
});

// ─── Schedule selector ────────────────────────────────────────────────────────

const INTERVAL_PRESETS: { label: string; ms: number }[] = [
  { label: '15 s', ms: 15_000 },
  { label: '30 s', ms: 30_000 },
  { label: '1 m',  ms: 60_000 },
  { label: '5 m',  ms: 300_000 },
  { label: '15 m', ms: 900_000 },
  { label: '1 h',  ms: 3_600_000 },
];

const CRON_PRESETS: { label: string; expr: string }[] = [
  { label: 'Every 5 m',   expr: '*/5 * *' },
  { label: 'Every 15 m',  expr: '*/15 * *' },
  { label: 'Every hour',  expr: '0 * *' },
  { label: '9 am daily',  expr: '0 9 *' },
  { label: 'Mon 9 am',    expr: '0 9 1' },
];

const HOURS   = [0, 6, 9, 12, 17, 20, 23];
const MINUTES = [0, 15, 30, 45];
const WEEKDAYS: { label: string; value: number }[] = [
  { label: 'Sun', value: 0 }, { label: 'Mon', value: 1 }, { label: 'Tue', value: 2 },
  { label: 'Wed', value: 3 }, { label: 'Thu', value: 4 }, { label: 'Fri', value: 5 },
  { label: 'Sat', value: 6 },
];

function ChipRow({
  items,
  selected,
  onSelect,
  theme,
}: {
  items: { label: string; value: string | number }[];
  selected: string | number;
  onSelect: (v: string | number) => void;
  theme: Theme;
}) {
  return (
    <View style={ss.chipRow}>
      {items.map((item) => {
        const sel = item.value === selected;
        return (
          <Pressable
            key={String(item.value)}
            style={[
              ss.chip,
              { backgroundColor: sel ? theme.accent : theme.border + '60', borderColor: sel ? theme.accent : theme.border },
            ]}
            onPress={() => onSelect(item.value)}
          >
            <Text style={[ss.chipText, { color: sel ? '#fff' : theme.text, fontFamily: MONO }]}>
              {item.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function ScheduleSelector({
  value,
  onChange,
  theme,
}: {
  value: ScheduleConfig;
  onChange: (c: ScheduleConfig) => void;
  theme: Theme;
}) {
  const patch = (p: Partial<ScheduleConfig>) => onChange({ ...value, ...p });

  const KIND_ROWS: { id: ScheduleConfig['kind']; label: string; sub: string }[] = [
    { id: 'interval', label: 'Interval', sub: 'Recurring every N ms' },
    { id: 'daily',    label: 'Daily',    sub: 'Every day at HH:MM' },
    { id: 'weekly',   label: 'Weekly',   sub: 'One weekday at HH:MM' },
    { id: 'cron',     label: 'Cron',     sub: '3-field expression (min hr dow)' },
  ];

  return (
    <View style={ss.wrap}>
      {KIND_ROWS.map((k) => {
        const sel = k.id === value.kind;
        return (
          <View key={k.id}>
            <Pressable
              style={[
                ts.row,
                { borderColor: sel ? theme.accent : theme.border, backgroundColor: sel ? theme.accentMuted : 'transparent' },
              ]}
              onPress={() => patch({ kind: k.id })}
            >
              <View style={[ts.radio, { borderColor: sel ? theme.accent : theme.muted }]}>
                {sel && <View style={[ts.radioDot, { backgroundColor: theme.accent }]} />}
              </View>
              <View style={ts.textBlock}>
                <Text style={[ts.lab, { color: sel ? theme.accent : theme.text }]}>{k.label}</Text>
                <Text style={[ts.sub, { color: theme.muted, fontFamily: MONO }]}>{k.sub}</Text>
              </View>
            </Pressable>

            {sel && k.id === 'interval' && (
              <View style={ss.detail}>
                <Text style={[ss.detailLabel, { color: theme.muted }]}>Interval</Text>
                <ChipRow
                  items={INTERVAL_PRESETS.map((p) => ({ label: p.label, value: p.ms }))}
                  selected={value.everyMs}
                  onSelect={(v) => patch({ everyMs: v as number })}
                  theme={theme}
                />
              </View>
            )}

            {sel && k.id === 'daily' && (
              <View style={ss.detail}>
                <Text style={[ss.detailLabel, { color: theme.muted }]}>Hour</Text>
                <ChipRow
                  items={HOURS.map((h) => ({ label: String(h).padStart(2, '0'), value: h }))}
                  selected={value.hour}
                  onSelect={(v) => patch({ hour: v as number })}
                  theme={theme}
                />
                <Text style={[ss.detailLabel, { color: theme.muted }]}>Minute</Text>
                <ChipRow
                  items={MINUTES.map((m) => ({ label: String(m).padStart(2, '0'), value: m }))}
                  selected={value.minute}
                  onSelect={(v) => patch({ minute: v as number })}
                  theme={theme}
                />
              </View>
            )}

            {sel && k.id === 'weekly' && (
              <View style={ss.detail}>
                <Text style={[ss.detailLabel, { color: theme.muted }]}>Day</Text>
                <ChipRow
                  items={WEEKDAYS.map((d) => ({ label: d.label, value: d.value }))}
                  selected={value.weekday}
                  onSelect={(v) => patch({ weekday: v as number })}
                  theme={theme}
                />
                <Text style={[ss.detailLabel, { color: theme.muted }]}>Hour</Text>
                <ChipRow
                  items={HOURS.map((h) => ({ label: String(h).padStart(2, '0'), value: h }))}
                  selected={value.hour}
                  onSelect={(v) => patch({ hour: v as number })}
                  theme={theme}
                />
                <Text style={[ss.detailLabel, { color: theme.muted }]}>Minute</Text>
                <ChipRow
                  items={MINUTES.map((m) => ({ label: String(m).padStart(2, '0'), value: m }))}
                  selected={value.minute}
                  onSelect={(v) => patch({ minute: v as number })}
                  theme={theme}
                />
              </View>
            )}

            {sel && k.id === 'cron' && (
              <View style={ss.detail}>
                <Text style={[ss.detailLabel, { color: theme.muted }]}>Preset expression</Text>
                <ChipRow
                  items={CRON_PRESETS.map((p) => ({ label: p.label, value: p.expr }))}
                  selected={value.cron}
                  onSelect={(v) => patch({ cron: v as string })}
                  theme={theme}
                />
                <Text style={[ss.detailLabel, { color: theme.muted }]}>
                  Active: <Text style={{ color: theme.accent, fontFamily: MONO }}>{value.cron}</Text>
                </Text>
              </View>
            )}
          </View>
        );
      })}
    </View>
  );
}

const ss = StyleSheet.create({
  wrap: { gap: 4 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 6 },
  chip: { paddingVertical: 4, paddingHorizontal: 10, borderRadius: 8, borderWidth: 1 },
  chipText: { fontSize: 11, fontWeight: '600' },
  detail: { paddingHorizontal: 14, paddingTop: 8, paddingBottom: 4 },
  detailLabel: { fontSize: 10, fontWeight: '700', letterSpacing: 1, marginBottom: 4 },
});

// ─── Permission / status row ──────────────────────────────────────────────────

function InfoRow({
  dot: dotColor,
  label,
  value,
  action,
  theme,
}: {
  dot: string;
  label: string;
  value: string;
  action?: { label: string; onPress: () => void };
  theme: Theme;
}) {
  return (
    <View style={[ir.row, { borderColor: theme.border }]}>
      <StatusDot color={dotColor} />
      <View style={ir.text}>
        <Text style={[ir.lab, { color: theme.text, fontFamily: MONO }]}>{label}</Text>
        <Text style={[ir.val, { color: theme.muted }]}>{value}</Text>
      </View>
      {action && <Btn label={action.label} onPress={action.onPress} color={theme.accent} />}
    </View>
  );
}
const ir = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 9,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderRadius: 6,
    marginBottom: 6,
  },
  text: { flex: 1 },
  lab: { fontSize: 11, fontWeight: '700', letterSpacing: 0.5 },
  val: { fontSize: 10, marginTop: 2 },
});

// ─── Main screen ──────────────────────────────────────────────────────────────

export function LifecycleScreen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { tasks, refresh, triggerMode, setTriggerMode, scheduleConfig, setScheduleConfig } = useConductor();
  const [conductorStatus, setConductorStatus] = useState<string | null>(null);
  const [permGranted, setPermGranted] = useState<boolean | null>(null);
  const [opResult, setOpResult] = useState('');

  const run = useCallback(async (fn: () => Promise<void>) => {
    setOpResult('…');
    try {
      await fn();
    } catch (e) {
      setOpResult('⚠ ' + String(e));
    }
  }, []);

  const easInfo = useMemo(() => ({
    isEmbedded: Updates.isEmbeddedLaunch,
    createdAt: Updates.createdAt,
    updateId: Updates.updateId,
    channel: Updates.channel,
  }), []);

  return (
    <View style={[s.root, { backgroundColor: theme.bg }]}>
      <ScrollView contentContainerStyle={[s.scroll, { paddingTop: insets.top + 16 }]}>

        {/* ── Page header ── */}
        <View style={[s.header, { borderBottomColor: theme.border }]}>
          <View style={s.headerRow}>
            <StatusDot color={
              conductorStatus === 'available' ? theme.success
              : conductorStatus === 'restricted' ? theme.warning
              : theme.muted
            } />
            <Text style={[s.headerTitle, { color: theme.text }]}>SYSTEM CONTROL</Text>
          </View>
          <Text style={[s.headerCount, { color: theme.muted, fontFamily: MONO }]}>
            {tasks.length} task{tasks.length !== 1 ? 's' : ''} registered
          </Text>
        </View>

        {/* ── Op result banner ── */}
        {opResult !== '' && (
          <View style={[s.banner, { backgroundColor: theme.accentMuted, borderColor: theme.accent }]}>
            <Text style={[s.bannerText, { color: theme.accent, fontFamily: MONO }]}>{opResult}</Text>
          </View>
        )}

        {/* ── Trigger type ── */}
        <Section
          title="TRIGGER TYPE"
          desc="Controls how tasks are scheduled when you press 'Schedule active' in the Lab. Switch modes to demo WorkManager, exact-alarm, or notification-linked delivery."
          theme={theme}
        >
          <TriggerSelector value={triggerMode} onChange={setTriggerMode} theme={theme} />
        </Section>

        {/* ── Schedule ── */}
        {triggerMode !== 'notification' && (
          <Section
            title="SCHEDULE"
            desc="Recurrence cadence used when 'Schedule active' runs in the Lab. Notification trigger uses a fixed 10s one-shot."
            theme={theme}
          >
            <ScheduleSelector value={scheduleConfig} onChange={setScheduleConfig} theme={theme} />
          </Section>
        )}

        {/* ── Conductor control ── */}
        <Section
          title="CONDUCTOR CONTROL"
          desc="Pause suspends all scheduling and skips dispatch even for incoming triggers. Resume re-arms every registered task."
          theme={theme}
        >
          <View style={s.btnRow}>
            <Btn
              label="PAUSE"
              color={theme.warning}
              onPress={() => run(async () => {
                await Conductor.pause();
                setOpResult('conductor paused');
              })}
            />
            <Btn
              label="RESUME"
              color={theme.success}
              onPress={() => run(async () => {
                await Conductor.resume();
                await refresh();
                setOpResult('conductor resumed');
              })}
            />
            <Btn
              label="CANCEL ALL"
              color={theme.danger}
              onPress={() => run(async () => {
                const all = await Conductor.getTasks();
                await Promise.all(all.map((t) => Conductor.cancelTask(t.id)));
                await refresh();
                setOpResult(`cancelled ${all.length} task(s)`);
              })}
            />
          </View>
        </Section>

        {/* ── Permissions ── */}
        <Section
          title="PERMISSIONS"
          desc="POST_NOTIFICATIONS is required on Android 13+ for notification triggers and headless-tick alerts. Conductor status reflects OS background restrictions."
          theme={theme}
        >
          <InfoRow
            dot={permGranted === true ? theme.success : permGranted === false ? theme.danger : theme.muted}
            label="POST_NOTIFICATIONS"
            value={permGranted === true ? 'granted' : permGranted === false ? 'denied' : 'not checked'}
            action={{
              label: 'REQUEST',
              onPress: () => run(async () => {
                const granted = await Conductor.requestPermissions();
                setPermGranted(granted);
                setOpResult(`notifications: ${granted ? 'granted' : 'denied'}`);
              }),
            }}
            theme={theme}
          />
          <InfoRow
            dot={conductorStatus === 'available' ? theme.success : conductorStatus === 'restricted' ? theme.warning : theme.muted}
            label="CONDUCTOR STATUS"
            value={conductorStatus ?? 'not checked'}
            action={{
              label: 'CHECK',
              onPress: () => run(async () => {
                const st = await Conductor.getStatus();
                setConductorStatus(st);
                setOpResult(`status: ${st}`);
              }),
            }}
            theme={theme}
          />
        </Section>

        {/* ── Resource budget ── */}
        <Section
          title="RESOURCE BUDGET"
          desc="Caps how much of each resource class (CPU, network, battery, memory) the conductor may allocate across all concurrently running tasks. Values are fractions of 1.0."
          theme={theme}
        >
          <View style={s.btnRow}>
            <Btn
              label="CPU 0.5"
              color={theme.accent}
              onPress={() => run(async () => {
                await Conductor.setResourceBudget({ cpu: 0.5, network: 1, battery: 1, memory: 1 });
                setOpResult('budget → cpu=0.5');
              })}
            />
            <Btn
              label="NET 0.5"
              color={theme.accent}
              onPress={() => run(async () => {
                await Conductor.setResourceBudget({ cpu: 1, network: 0.5, battery: 1, memory: 1 });
                setOpResult('budget → network=0.5');
              })}
            />
            <Btn
              label="RESET"
              color={theme.success}
              fill
              onPress={() => run(async () => {
                await Conductor.setResourceBudget({ cpu: 1, network: 1, battery: 1, memory: 1 });
                setOpResult('budget reset to 1.0');
              })}
            />
          </View>
        </Section>

        {/* ── Headless tick ── */}
        <Section
          title="HEADLESS TICK"
          desc="Registers an expo-background-task periodic tick so JS handlers can run after the app is terminated. Requires expo-task-manager + expo-background-task optional deps."
          theme={theme}
        >
          <View style={s.btnRow}>
            <Btn
              label="ENABLE 15m"
              color={theme.accent}
              onPress={() => run(async () => {
                const r = await enableHeadlessBackground(15);
                setOpResult(r);
              })}
            />
            <Btn
              label="STATUS"
              color={theme.accent}
              onPress={() => run(async () => {
                const r = await backgroundTaskStatus();
                setOpResult(r);
              })}
            />
            <Btn
              label="DISABLE"
              color={theme.danger}
              onPress={() => run(async () => {
                const r = await disableHeadlessBackground();
                setOpResult(r);
              })}
            />
          </View>
        </Section>

        {/* ── EAS Update ── */}
        <Section
          title="EAS UPDATE"
          desc="Identifies the currently running bundle. 'Embedded' means the original build APK/IPA; 'OTA' means a live update was applied at launch via expo-updates."
          theme={theme}
        >
          <View style={[s.easCard, { backgroundColor: theme.card, borderColor: theme.border }]}>
            <View style={s.easRow}>
              <View style={[s.easBadge, { backgroundColor: easInfo.isEmbedded ? theme.warningBg : theme.successBg }]}>
                <Text style={[s.easBadgeText, { color: easInfo.isEmbedded ? theme.warning : theme.success }]}>
                  {easInfo.isEmbedded ? 'EMBEDDED' : 'OTA'}
                </Text>
              </View>
              {easInfo.channel && (
                <View style={[s.easBadge, { backgroundColor: theme.accentMuted }]}>
                  <Text style={[s.easBadgeText, { color: theme.accent }]}>{easInfo.channel}</Text>
                </View>
              )}
            </View>
            <Text style={[s.easDate, { color: theme.text, fontFamily: MONO }]}>
              {easInfo.createdAt ? fmtDateTime(easInfo.createdAt.getTime()) : '— no date available —'}
            </Text>
            {easInfo.updateId && (
              <Text style={[s.easId, { color: theme.muted, fontFamily: MONO }]}>
                ID  {easInfo.updateId.slice(0, 8)}…
              </Text>
            )}
          </View>
        </Section>

        {/* ── Registered tasks ── */}
        <Section
          title={`REGISTERED TASKS  (${tasks.length})`}
          desc="All tasks currently stored by the conductor. 'Next run' is the computed next trigger time; '—' means the task has no future scheduled occurrence."
          theme={theme}
        >
          {tasks.length === 0 ? (
            <Text style={[s.empty, { color: theme.muted, fontFamily: MONO }]}>— no tasks registered —</Text>
          ) : (
            <View style={[s.table, { borderColor: theme.border }]}>
              <View style={[s.tHead, { borderBottomColor: theme.border, backgroundColor: theme.card }]}>
                <Text style={[s.thId, { color: theme.muted }]}>TASK ID</Text>
                <Text style={[s.thPri, { color: theme.muted }]}>PRI</Text>
                <Text style={[s.thDate, { color: theme.muted }]}>NEXT RUN</Text>
              </View>
              {tasks.map((t, idx) => (
                <View
                  key={t.id}
                  style={[
                    s.tRow,
                    { borderBottomColor: theme.border },
                    idx % 2 !== 0 && { backgroundColor: theme.card + '80' },
                  ]}
                >
                  <Text style={[s.tdId, { color: theme.text, fontFamily: MONO }]} numberOfLines={1}>{t.id}</Text>
                  <Text style={[s.tdPri, { color: theme.accent, fontFamily: MONO }]}>p{t.priority}</Text>
                  <Text style={[s.tdDate, { color: theme.muted, fontFamily: MONO }]}>
                    {t.nextRunAt ? fmtDateTime(t.nextRunAt) : '—'}
                  </Text>
                </View>
              ))}
            </View>
          )}
        </Section>

        <View style={{ height: 24 }} />
      </ScrollView>
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  root: { flex: 1 },
  scroll: { paddingHorizontal: 16, paddingBottom: 16 },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingBottom: 12,
    marginBottom: 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  headerTitle: { fontSize: 15, fontWeight: '800', letterSpacing: 2 },
  headerCount: { fontSize: 11 },

  banner: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 7,
    borderWidth: 1,
    marginBottom: 6,
  },
  bannerText: { fontSize: 12 },

  btnRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },

  easCard: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 10,
    padding: 14,
    gap: 6,
  },
  easRow: { flexDirection: 'row', gap: 6 },
  easBadge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 5, alignSelf: 'flex-start' },
  easBadgeText: { fontSize: 10, fontWeight: '800', letterSpacing: 1 },
  easDate: { fontSize: 14, fontWeight: '600' },
  easId: { fontSize: 11 },

  empty: { fontSize: 12, textAlign: 'center', paddingVertical: 10 },
  table: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, overflow: 'hidden' },
  tHead: {
    flexDirection: 'row',
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  thId: { flex: 3, fontSize: 9, fontWeight: '800', letterSpacing: 1.5 },
  thPri: { width: 36, fontSize: 9, fontWeight: '800', letterSpacing: 1.5, textAlign: 'center' },
  thDate: { flex: 3, fontSize: 9, fontWeight: '800', letterSpacing: 1.5, textAlign: 'right' },
  tRow: { flexDirection: 'row', paddingVertical: 7, paddingHorizontal: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  tdId: { flex: 3, fontSize: 11 },
  tdPri: { width: 36, fontSize: 11, textAlign: 'center' },
  tdDate: { flex: 3, fontSize: 10, textAlign: 'right' },
});
