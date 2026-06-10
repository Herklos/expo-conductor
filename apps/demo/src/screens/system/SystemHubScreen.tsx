/**
 * System hub — the cleaned-up control surface. Only the controls you touch every
 * session live here inline (trigger type, schedule, conductor control). The
 * occasional panels (permissions, resource budget, headless tick, EAS update) and
 * the full task registry are pushed subscreens reached via the rows below.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import Conductor from 'expo-conductor';
import { useTheme } from '../../theme';
import { useConductor } from '../../state/ConductorProvider';
import {
  Banner,
  Btn,
  MONO,
  NavRow,
  Section,
  StatusDot,
  ScheduleSelector,
  TriggerSelector,
  fmtDateTime,
  useOp,
} from './parts';

export function SystemHubScreen() {
  const theme = useTheme();
  const router = useRouter();
  const { tasks, refresh, triggerMode, setTriggerMode, scheduleConfig, setScheduleConfig } = useConductor();
  const { opResult, setOpResult, run } = useOp();
  const [conductorStatus, setConductorStatus] = useState<string | null>(null);

  // Auto-probe conductor status once so the hero reads live on entry.
  useEffect(() => {
    let alive = true;
    void Conductor.getStatus().then((st) => { if (alive) setConductorStatus(st); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  const scheduledCount = useMemo(() => tasks.filter((t) => t.nextRunAt != null).length, [tasks]);
  const nextRun = useMemo(() => {
    const times = tasks.map((t) => t.nextRunAt).filter((t): t is number => t != null);
    return times.length ? Math.min(...times) : null;
  }, [tasks]);

  const statusColor =
    conductorStatus === 'available' ? theme.success
    : conductorStatus === 'restricted' ? theme.warning
    : theme.muted;

  const go = useCallback((path: string) => () => router.push(path), [router]);

  return (
    <View style={[s.root, { backgroundColor: theme.bg }]}>
      <ScrollView contentContainerStyle={s.scroll}>

        {/* ── Status hero (screen title is the native Stack header) ── */}
        <View style={[s.hero, { backgroundColor: theme.card, borderColor: theme.border }]}>
          <View style={[s.heroAccent, { backgroundColor: statusColor }]} />
          <View style={s.heroMain}>
            <View style={s.heroStatusRow}>
              <StatusDot color={statusColor} size={10} />
              <Text style={[s.heroStatus, { color: theme.text }]}>
                {conductorStatus ? conductorStatus.toUpperCase() : 'PROBING…'}
              </Text>
            </View>
            <Text style={[s.heroSub, { color: theme.muted, fontFamily: MONO }]}>
              next ·  {nextRun != null ? fmtDateTime(nextRun) : '—'}
            </Text>
          </View>
          <View style={s.heroStats}>
            <Stat n={tasks.length} label="TASKS" theme={theme} />
            <View style={[s.heroDivider, { backgroundColor: theme.border }]} />
            <Stat n={scheduledCount} label="ARMED" color={theme.accent} theme={theme} />
          </View>
        </View>

        <Banner text={opResult} theme={theme} />

        {/* ── Trigger type ── */}
        <Section
          title="TRIGGER TYPE"
          desc="How tasks are scheduled when you press 'Schedule active' in the Lab — WorkManager, exact-alarm, or notification-linked delivery."
          theme={theme}
        >
          <TriggerSelector value={triggerMode} onChange={setTriggerMode} theme={theme} />
        </Section>

        {/* ── Schedule ── */}
        {triggerMode !== 'notification' && (
          <Section
            title="SCHEDULE"
            desc="Recurrence cadence used when 'Schedule active' runs. The notification trigger uses a fixed 10s one-shot."
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
              grow
              onPress={() => run(async () => {
                await Conductor.pause();
                setOpResult('conductor paused');
              })}
            />
            <Btn
              label="RESUME"
              color={theme.success}
              grow
              onPress={() => run(async () => {
                await Conductor.resume();
                await refresh();
                setOpResult('conductor resumed');
              })}
            />
            <Btn
              label="CANCEL ALL"
              color={theme.danger}
              grow
              onPress={() => run(async () => {
                const all = await Conductor.getTasks();
                await Promise.all(all.map((t) => Conductor.cancelTask(t.id)));
                await refresh();
                setOpResult(`cancelled ${all.length} task(s)`);
              })}
            />
          </View>
        </Section>

        {/* ── Pushed diagnostics ── */}
        <Section
          title="DIAGNOSTICS & SETUP"
          desc="One-time and occasional panels — opened on demand to keep this surface clean."
          theme={theme}
        >
          <NavRow
            glyph="🔔"
            label="Permissions"
            sub="POST_NOTIFICATIONS · conductor status"
            theme={theme}
            onPress={go('/system/permissions')}
          />
          <NavRow
            glyph="🎚"
            label="Resource budget"
            sub="cpu · network · battery · memory caps"
            theme={theme}
            onPress={go('/system/budget')}
          />
          <NavRow
            glyph="🛰"
            label="Headless tick"
            sub="expo-background-task periodic wake"
            theme={theme}
            onPress={go('/system/headless')}
          />
          <NavRow
            glyph="📦"
            label="EAS update"
            sub="running bundle · channel · embedded/OTA"
            theme={theme}
            onPress={go('/system/eas')}
          />
          <NavRow
            glyph="🗂"
            label="Registered tasks"
            sub={nextRun != null ? `next run ${fmtDateTime(nextRun)}` : 'no future occurrences'}
            hint={`${tasks.length}`}
            theme={theme}
            onPress={go('/system/tasks')}
          />
        </Section>

      </ScrollView>
    </View>
  );
}

function Stat({ n, label, color, theme }: { n: number; label: string; color?: string; theme: ReturnType<typeof useTheme> }) {
  return (
    <View style={s.stat}>
      <Text style={[s.statN, { color: color ?? theme.text, fontFamily: MONO }]}>{n}</Text>
      <Text style={[s.statL, { color: theme.muted }]}>{label}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1 },
  scroll: { paddingHorizontal: 16, paddingTop: 14, paddingBottom: 32 },

  hero: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    overflow: 'hidden',
    paddingVertical: 14,
    paddingRight: 14,
  },
  heroAccent: { width: 4, alignSelf: 'stretch', marginRight: 14 },
  heroMain: { flex: 1, gap: 4 },
  heroStatusRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  heroStatus: { fontSize: 18, fontWeight: '800', letterSpacing: 1 },
  heroSub: { fontSize: 11 },
  heroStats: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  heroDivider: { width: StyleSheet.hairlineWidth, height: 30 },
  stat: { alignItems: 'center', minWidth: 40 },
  statN: { fontSize: 22, fontWeight: '800' },
  statL: { fontSize: 8, fontWeight: '800', letterSpacing: 1.5, marginTop: 2 },

  btnRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
});
