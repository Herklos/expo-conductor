/**
 * Shared building blocks for the System hub and its subscreens.
 *
 * These were lifted out of the former monolithic LifecycleScreen so the hub
 * (app/(tabs)/system/index.tsx) and every pushed subscreen (permissions, budget,
 * headless, eas, tasks) render from one cohesive industrial-amber kit.
 */
import React, { useCallback, useState } from 'react';
import {
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useTheme, type Theme } from '../../theme';
import type { TriggerMode, ScheduleConfig } from '../../state/ConductorProvider';

export const MONO = Platform.select({ ios: 'Courier New', android: 'monospace' }) ?? 'monospace';

export function fmtDateTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// ─── Status dot ───────────────────────────────────────────────────────────────

export function StatusDot({ color, size = 8 }: { color: string; size?: number }) {
  return <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color }} />;
}

// ─── Section header with optional description ─────────────────────────────────

export function Section({
  title,
  desc,
  theme,
  children,
}: {
  title: string;
  desc?: string;
  theme: Theme;
  children: React.ReactNode;
}) {
  return (
    <View style={sec.wrap}>
      <View style={[sec.header, { borderLeftColor: theme.accent }]}>
        <Text style={[sec.title, { color: theme.accent, fontFamily: MONO }]}>{title}</Text>
      </View>
      {desc != null && desc !== '' && (
        <Text style={[sec.desc, { color: theme.muted }]}>{desc}</Text>
      )}
      {children}
    </View>
  );
}
const sec = StyleSheet.create({
  wrap: { marginTop: 18, marginBottom: 4 },
  header: { borderLeftWidth: 3, paddingLeft: 10, marginBottom: 6 },
  title: { fontSize: 9, fontWeight: '800', letterSpacing: 2.5 },
  desc: { fontSize: 11, marginBottom: 10, lineHeight: 16, paddingLeft: 2 },
});

// ─── Outlined action button ───────────────────────────────────────────────────

export function Btn({
  label,
  onPress,
  color,
  fill = false,
  grow = false,
}: {
  label: string;
  onPress: () => void;
  color: string;
  fill?: boolean;
  grow?: boolean;
}) {
  return (
    <Pressable
      style={({ pressed }) => [
        btn.b,
        grow && { flexGrow: 1 },
        {
          borderColor: color,
          backgroundColor: fill ? color : pressed ? color + '28' : 'transparent',
          opacity: pressed ? 0.85 : 1,
        },
      ]}
      onPress={onPress}
    >
      <Text style={[btn.t, { color: fill ? '#fff' : color }]}>{label}</Text>
    </Pressable>
  );
}
const btn = StyleSheet.create({
  b: { paddingVertical: 8, paddingHorizontal: 14, borderRadius: 4, borderWidth: 1.5, alignItems: 'center' },
  t: { fontSize: 10, fontWeight: '800', letterSpacing: 1 },
});

// ─── Op-result banner + runner hook ───────────────────────────────────────────
//
// Every subscreen that performs an async conductor op shows the same single-line
// result banner; useOp() centralises the "…" / "⚠ error" plumbing.

export function useOp() {
  const [opResult, setOpResult] = useState('');
  const run = useCallback(async (fn: () => Promise<void>) => {
    setOpResult('…');
    try {
      await fn();
    } catch (e) {
      setOpResult('⚠ ' + String(e));
    }
  }, []);
  return { opResult, setOpResult, run };
}

export function Banner({ text, theme }: { text: string; theme: Theme }) {
  if (text === '') return null;
  return (
    <View style={[ban.box, { backgroundColor: theme.accentMuted, borderColor: theme.accent }]}>
      <Text style={[ban.text, { color: theme.accent, fontFamily: MONO }]}>{text}</Text>
    </View>
  );
}
const ban = StyleSheet.create({
  box: { paddingVertical: 8, paddingHorizontal: 12, borderRadius: 7, borderWidth: 1, marginBottom: 6 },
  text: { fontSize: 12 },
});

// ─── Permission / status row ──────────────────────────────────────────────────

export function InfoRow({
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

// ─── Navigation row — links the hub to a pushed subscreen ─────────────────────

export function NavRow({
  glyph,
  label,
  sub,
  hint,
  theme,
  onPress,
}: {
  glyph: string;
  label: string;
  sub: string;
  hint?: string;
  theme: Theme;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        nav.row,
        { borderColor: theme.border, backgroundColor: pressed ? theme.accentMuted : theme.card },
      ]}
    >
      <View style={[nav.glyphBox, { backgroundColor: theme.accentMuted, borderColor: theme.border }]}>
        <Text style={nav.glyph}>{glyph}</Text>
      </View>
      <View style={nav.text}>
        <Text style={[nav.label, { color: theme.text }]}>{label}</Text>
        <Text style={[nav.sub, { color: theme.muted, fontFamily: MONO }]} numberOfLines={1}>{sub}</Text>
      </View>
      {hint != null && hint !== '' && (
        <Text style={[nav.hint, { color: theme.accent, fontFamily: MONO }]} numberOfLines={1}>{hint}</Text>
      )}
      <Text style={[nav.chevron, { color: theme.muted }]}>›</Text>
    </Pressable>
  );
}
const nav = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 11,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderRadius: 8,
    marginBottom: 6,
  },
  glyphBox: { width: 34, height: 34, borderRadius: 7, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  glyph: { fontSize: 16 },
  text: { flex: 1 },
  label: { fontSize: 14, fontWeight: '700', letterSpacing: 0.3 },
  sub: { fontSize: 10, marginTop: 2 },
  hint: { fontSize: 11, fontWeight: '700' },
  chevron: { fontSize: 22, fontWeight: '300', marginLeft: 2 },
});

// ─── Subscreen scaffold ───────────────────────────────────────────────────────
//
// Pushed subscreens render under a native stack header (which owns the title + top
// inset), matching the per-tab header convention; this scroll uses plain padding.
// `lede` is a one-line context blurb.

export function SubScreen({
  lede,
  banner,
  children,
}: {
  lede?: string;
  banner?: string;
  children: React.ReactNode;
}) {
  const theme = useTheme();
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.bg }}
      contentContainerStyle={subStyles.content}
    >
      {lede != null && lede !== '' && (
        <Text style={[subStyles.lede, { color: theme.muted }]}>{lede}</Text>
      )}
      {banner != null && <Banner text={banner} theme={theme} />}
      {children}
    </ScrollView>
  );
}
const subStyles = StyleSheet.create({
  content: { paddingHorizontal: 16, paddingTop: 14, paddingBottom: 32 },
  lede: { fontSize: 12, lineHeight: 18, marginBottom: 4 },
});

// ─── Trigger mode selector ────────────────────────────────────────────────────

export const TRIGGER_MODES: { id: TriggerMode; label: string; sub: string }[] = [
  { id: 'interval',     label: 'Interval',     sub: 'WorkManager · recurrence trigger' },
  { id: 'alarm',        label: 'Exact Alarm',  sub: 'AlarmManager · precise timing' },
  { id: 'notification', label: 'Notification', sub: 'Local notification delivery · one-shot' },
];

export function TriggerSelector({
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
        const selected = m.id === value;
        return (
          <Pressable
            key={m.id}
            style={[
              ts.row,
              {
                borderColor: selected ? theme.accent : theme.border,
                backgroundColor: selected ? theme.accentMuted : 'transparent',
              },
            ]}
            onPress={() => onChange(m.id)}
          >
            <View style={[ts.radio, { borderColor: selected ? theme.accent : theme.muted }]}>
              {selected && <View style={[ts.radioDot, { backgroundColor: theme.accent }]} />}
            </View>
            <View style={ts.textBlock}>
              <Text style={[ts.lab, { color: selected ? theme.accent : theme.text }]}>{m.label}</Text>
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
        const selected_ = item.value === selected;
        return (
          <Pressable
            key={String(item.value)}
            style={[
              ss.chip,
              { backgroundColor: selected_ ? theme.accent : theme.border + '60', borderColor: selected_ ? theme.accent : theme.border },
            ]}
            onPress={() => onSelect(item.value)}
          >
            <Text style={[ss.chipText, { color: selected_ ? '#fff' : theme.text, fontFamily: MONO }]}>
              {item.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function ScheduleSelector({
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
        const selected = k.id === value.kind;
        return (
          <View key={k.id}>
            <Pressable
              style={[
                ts.row,
                { borderColor: selected ? theme.accent : theme.border, backgroundColor: selected ? theme.accentMuted : 'transparent' },
              ]}
              onPress={() => patch({ kind: k.id })}
            >
              <View style={[ts.radio, { borderColor: selected ? theme.accent : theme.muted }]}>
                {selected && <View style={[ts.radioDot, { backgroundColor: theme.accent }]} />}
              </View>
              <View style={ts.textBlock}>
                <Text style={[ts.lab, { color: selected ? theme.accent : theme.text }]}>{k.label}</Text>
                <Text style={[ts.sub, { color: theme.muted, fontFamily: MONO }]}>{k.sub}</Text>
              </View>
            </Pressable>

            {selected && k.id === 'interval' && (
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

            {selected && k.id === 'daily' && (
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

            {selected && k.id === 'weekly' && (
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

            {selected && k.id === 'cron' && (
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
