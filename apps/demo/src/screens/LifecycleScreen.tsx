/**
 * System & Lifecycle screen — conductor controls, EAS update info,
 * trigger-type selector, permissions, budget, headless, task registry,
 * and real-time colorised event log.
 */
import React, { useCallback, useMemo, useState } from 'react';
import {
  FlatList,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import * as Updates from 'expo-updates';
import Conductor from 'expo-conductor';
import {
  backgroundTaskStatus,
  disableHeadlessBackground,
  enableHeadlessBackground,
} from '../backgroundTask';
import { useTheme, type Theme } from '../theme';
import { useConductor, type TriggerMode } from '../state/ConductorProvider';

const MONO = Platform.select({ ios: 'Courier New', android: 'monospace' }) ?? 'monospace';

function fmtDateTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// ─── Primitives ──────────────────────────────────────────────────────────────

function StatusDot({ color }: { color: string }) {
  return <View style={[dot.d, { backgroundColor: color }]} />;
}
const dot = StyleSheet.create({ d: { width: 8, height: 8, borderRadius: 4 } });

function SectionDivider({ title, theme }: { title: string; theme: Theme }) {
  return (
    <View style={divs.row}>
      <View style={[divs.line, { backgroundColor: theme.border }]} />
      <Text style={[divs.label, { color: theme.muted, fontFamily: MONO }]}>{title}</Text>
      <View style={[divs.line, { backgroundColor: theme.border }]} />
    </View>
  );
}
const divs = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', marginVertical: 12 },
  line: { flex: 1, height: StyleSheet.hairlineWidth },
  label: { fontSize: 9, fontWeight: '700', letterSpacing: 2, marginHorizontal: 10 },
});

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
  b: { paddingVertical: 6, paddingHorizontal: 13, borderRadius: 6, borderWidth: 1.5 },
  t: { fontSize: 11, fontWeight: '700', letterSpacing: 0.5 },
});

// ─── Trigger mode selector ────────────────────────────────────────────────────

const TRIGGER_MODES: { id: TriggerMode; label: string; sub: string }[] = [
  { id: 'interval',     label: 'Interval',     sub: 'WorkManager · 30 s recurring' },
  { id: 'alarm',        label: 'Exact Alarm',  sub: 'AlarmManager · precise timing' },
  { id: 'notification', label: 'Notification', sub: 'Local notification delivery' },
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

// ─── Permission / info row ────────────────────────────────────────────────────

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
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    marginBottom: 6,
  },
  text: { flex: 1 },
  lab: { fontSize: 12, fontWeight: '700' },
  val: { fontSize: 11, marginTop: 1 },
});

// ─── Log line colour ──────────────────────────────────────────────────────────

function logColor(line: string, theme: Theme): string {
  if (line.includes('execute →')) return theme.accent;
  if (line.includes('complete →')) return theme.success;
  if (line.includes('error →')) return theme.danger;
  if (line.includes('skipped →')) return theme.warning;
  return theme.muted;
}

// ─── Main screen ──────────────────────────────────────────────────────────────

export function LifecycleScreen() {
  const theme = useTheme();
  const { tasks, liveLog, refresh, triggerMode, setTriggerMode } = useConductor();
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
      <ScrollView contentContainerStyle={s.scroll}>

        {/* ── Page header ── */}
        <View style={[s.header, { borderBottomColor: theme.border }]}>
          <View style={s.headerRow}>
            <StatusDot color={conductorStatus === 'restricted' ? theme.warning : conductorStatus === 'available' ? theme.success : theme.muted} />
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

        {/* ── EAS Update ── */}
        <SectionDivider title="EAS UPDATE" theme={theme} />
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

        {/* ── Trigger type ── */}
        <SectionDivider title="TRIGGER TYPE  (affects Lab)" theme={theme} />
        <TriggerSelector value={triggerMode} onChange={setTriggerMode} theme={theme} />

        {/* ── Conductor control ── */}
        <SectionDivider title="CONDUCTOR CONTROL" theme={theme} />
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

        {/* ── Permissions ── */}
        <SectionDivider title="PERMISSIONS" theme={theme} />
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

        {/* ── Resource budget ── */}
        <SectionDivider title="RESOURCE BUDGET" theme={theme} />
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

        {/* ── Headless tick ── */}
        <SectionDivider title="HEADLESS TICK" theme={theme} />
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

        {/* ── Registered tasks ── */}
        <SectionDivider title={`REGISTERED TASKS  (${tasks.length})`} theme={theme} />
        {tasks.length === 0 ? (
          <Text style={[s.empty, { color: theme.muted, fontFamily: MONO }]}>— no tasks registered —</Text>
        ) : (
          <View style={[s.table, { borderColor: theme.border }]}>
            {/* header */}
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
                  idx % 2 === 0 ? {} : { backgroundColor: theme.card + '80' },
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

        <View style={{ height: 20 }} />
      </ScrollView>

      {/* ── Event log (terminal panel) ── */}
      <View style={[s.logWrap, { backgroundColor: theme.card, borderTopColor: theme.border }]}>
        {/* Terminal chrome */}
        <View style={[s.logChrome, { borderBottomColor: theme.border }]}>
          <View style={s.trafficLights}>
            <View style={[s.tl, { backgroundColor: theme.danger }]} />
            <View style={[s.tl, { backgroundColor: theme.warning }]} />
            <View style={[s.tl, { backgroundColor: theme.success }]} />
          </View>
          <Text style={[s.logTitle, { color: theme.muted, fontFamily: MONO }]}>
            EVENT LOG  ·  {liveLog.length} entries
          </Text>
        </View>
        <FlatList
          data={liveLog}
          keyExtractor={(_, i) => String(i)}
          renderItem={({ item }) => (
            <Text style={[s.logLine, { color: logColor(item, theme), fontFamily: MONO }]}>{item}</Text>
          )}
          style={s.logList}
          nestedScrollEnabled
        />
      </View>
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  root: { flex: 1 },
  scroll: { paddingHorizontal: 16, paddingTop: 56, paddingBottom: 16 },

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

  easCard: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 10,
    padding: 14,
    gap: 6,
  },
  easRow: { flexDirection: 'row', gap: 6 },
  easBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 5,
    alignSelf: 'flex-start',
  },
  easBadgeText: { fontSize: 10, fontWeight: '800', letterSpacing: 1 },
  easDate: { fontSize: 14, fontWeight: '600' },
  easId: { fontSize: 11 },

  btnRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },

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

  logWrap: { height: 200, borderTopWidth: StyleSheet.hairlineWidth },
  logChrome: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  trafficLights: { flexDirection: 'row', gap: 5 },
  tl: { width: 11, height: 11, borderRadius: 6 },
  logTitle: { fontSize: 10, fontWeight: '700', letterSpacing: 1.5 },
  logList: { flex: 1 },
  logLine: { fontSize: 11, paddingHorizontal: 12, paddingVertical: 2, lineHeight: 17 },
});
