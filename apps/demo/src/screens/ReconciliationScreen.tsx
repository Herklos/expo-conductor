/**
 * Reconciliation Screen — runs reconcile() over the last 24 h and displays:
 *   • matched (green)  — expected and ran within tolerance
 *   • aborted  (orange) — ran but failed/errored
 *   • missed   (red)   — expected, never ran
 *   • unexpected (purple) — ran but not expected
 *
 * background/push/appState occurrences are advisory — flagged but not counted as issues.
 */
import React, { useMemo, useState } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Stack } from 'expo-router';
import { LegendList } from '@legendapp/list/react-native';
import { reconcile, type ReconcileResult, type MatchedOccurrence, type ExpectedOccurrence } from 'expo-conductor';
import type { TaskExecutionRecord } from 'expo-conductor';
import { useTheme } from '../theme';
import { useConductor } from '../state/ConductorProvider';
import { Badge } from '../components/Badge';
import { Card } from '../components/Card';

type FilterKey = 'all' | 'missed' | 'aborted' | 'unexpected' | 'matched';

type DisplayItem =
  | { kind: 'matched';    data: MatchedOccurrence }
  | { kind: 'aborted';    data: MatchedOccurrence }
  | { kind: 'missed';     data: ExpectedOccurrence }
  | { kind: 'unexpected'; data: TaskExecutionRecord };

const FILTERS: { id: FilterKey; label: string }[] = [
  { id: 'all',        label: 'ALL' },
  { id: 'missed',     label: 'MISSED' },
  { id: 'aborted',    label: 'ABORTED' },
  { id: 'unexpected', label: 'UNEXPECT' },
  { id: 'matched',    label: 'MATCHED' },
];

export function ReconciliationScreen() {
  const theme = useTheme();
  const { tasks, records, refreshHistory } = useConductor();
  const [activeFilter, setActiveFilter] = useState<FilterKey>('all');
  const [windowH, setWindowH] = useState(24);

  const now = Date.now();

  const result: ReconcileResult = useMemo(
    () =>
      reconcile(tasks, records, {
        now,
        windowMs: windowH * 60 * 60 * 1_000,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tasks, records, windowH],
  );

  const { matched, missed, unexpected, aborted } = result;
  const abortedSet = new Set(aborted.map((a) => a.record.taskId + '-' + a.record.firedAt));

  const summaryStats = [
    { label: 'MATCHED',    count: matched.length,    color: theme.success },
    { label: 'ABORTED',    count: aborted.length,    color: theme.warning },
    { label: 'MISSED',     count: missed.length,     color: theme.danger },
    { label: 'UNEXPECT',   count: unexpected.length, color: theme.unexpected },
  ];

  const allItems: DisplayItem[] = useMemo(() => {
    const items: DisplayItem[] = [];
    for (const m of matched) {
      const isAborted = abortedSet.has(m.record.taskId + '-' + m.record.firedAt);
      items.push(isAborted ? { kind: 'aborted', data: m } : { kind: 'matched', data: m });
    }
    for (const m of missed)      items.push({ kind: 'missed',     data: m });
    for (const u of unexpected)  items.push({ kind: 'unexpected', data: u });
    // Sort by time descending (use the most relevant timestamp).
    return items.sort((a, b) => {
      const tA =
        a.kind === 'matched' || a.kind === 'aborted'
          ? a.data.occurrence.expectedAt
          : a.kind === 'missed'
          ? a.data.expectedAt
          : (a.data as TaskExecutionRecord).firedAt;
      const tB =
        b.kind === 'matched' || b.kind === 'aborted'
          ? b.data.occurrence.expectedAt
          : b.kind === 'missed'
          ? b.data.expectedAt
          : (b.data as TaskExecutionRecord).firedAt;
      return tB - tA;
    });
  }, [matched, missed, unexpected, aborted, abortedSet]);

  const filteredItems = useMemo(() => {
    if (activeFilter === 'all') return allItems;
    return allItems.filter((i) => i.kind === activeFilter);
  }, [allItems, activeFilter]);

  // Pinned legend — summary tallies, window selector, and the status filter chips
  // stay fixed at the top so they don't scroll out of reach as the list grows.
  const pinnedHeader = (
    <View style={[styles.pinned, { backgroundColor: theme.bg, borderBottomColor: theme.border }]}>
      <View style={styles.summaryArea}>
        <View style={styles.summaryRow}>
          {summaryStats.map((s) => (
            <View key={s.label} style={[styles.statCard, { borderColor: s.color }]}>
              <Text style={[styles.statCount, { color: s.color }]}>{s.count}</Text>
              <Text style={[styles.statLabel, { color: s.color }]}>{s.label}</Text>
            </View>
          ))}
        </View>

        <View style={styles.windowRow}>
          <Text style={[styles.windowLabel, { color: theme.muted }]}>Window:</Text>
          {[1, 6, 24].map((h) => (
            <Pressable
              key={h}
              style={[
                styles.windowChip,
                {
                  backgroundColor: windowH === h ? theme.accent : theme.border + '60',
                  borderColor: windowH === h ? theme.accent : theme.border,
                },
              ]}
              onPress={() => setWindowH(h)}
            >
              <Text
                style={[styles.windowChipText, { color: windowH === h ? '#fff' : theme.text }]}
              >
                {h}h
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      {/* Filter chips — the status legend */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.filterScroll}>
        <View style={styles.filterRow}>
          {FILTERS.map((f) => (
            <Pressable
              key={f.id}
              style={[
                styles.filterChip,
                {
                  backgroundColor:
                    activeFilter === f.id ? theme.accent : theme.card,
                  borderColor: activeFilter === f.id ? theme.accent : theme.border,
                },
              ]}
              onPress={() => setActiveFilter(f.id)}
            >
              <Text
                style={[
                  styles.filterChipText,
                  { color: activeFilter === f.id ? '#fff' : theme.text },
                ]}
              >
                {f.label}
              </Text>
            </Pressable>
          ))}
        </View>
      </ScrollView>
    </View>
  );

  // The advisory note is explanatory, not a control, so it scrolls with the rows.
  const scrollHeader = (
    <View style={[styles.advisory, { backgroundColor: theme.accentMuted }]}>
      <Text style={[styles.advisoryText, { color: theme.accent }]}>
        ℹ️  background / push / appState tasks are excluded from expected occurrences
        (OS decides timing) — only time, recurrence, and alarm tasks are exact.
      </Text>
    </View>
  );

  const empty = (
    <View style={styles.empty}>
      <Text style={[styles.emptyText, { color: theme.muted }]}>
        {allItems.length === 0
          ? 'No data yet — schedule some tasks and come back.'
          : `No ${activeFilter} items in the selected window.`}
      </Text>
    </View>
  );

  return (
    <>
      <Stack.Screen
        options={{
          headerRight: () => (
            <Pressable onPress={refreshHistory} hitSlop={8}>
              <Text style={[styles.refreshText, { color: theme.accent }]}>↻</Text>
            </Pressable>
          ),
        }}
      />
      <View style={[styles.root, { backgroundColor: theme.bg }]}>
        {pinnedHeader}
        <LegendList<DisplayItem>
          style={{ flex: 1 }}
          data={filteredItems}
          keyExtractor={(item: DisplayItem, i: number) => `${item.kind}-${i}`}
          renderItem={({ item }: { item: DisplayItem }) => <ReconcileRow item={item} theme={theme} />}
          ListHeaderComponent={scrollHeader}
          ListEmptyComponent={empty}
          contentContainerStyle={styles.list}
          estimatedItemSize={72}
          recycleItems
        />
      </View>
    </>
  );
}

// ---------------------------------------------------------------------------
// Row
// ---------------------------------------------------------------------------

interface ReconcileRowProps {
  item:
    | { kind: 'matched' | 'aborted'; data: MatchedOccurrence }
    | { kind: 'missed'; data: ExpectedOccurrence }
    | { kind: 'unexpected'; data: TaskExecutionRecord };
  theme: ReturnType<typeof useTheme>;
}

function ReconcileRow({ item, theme }: ReconcileRowProps) {
  if (item.kind === 'matched' || item.kind === 'aborted') {
    const { occurrence, record } = item.data;
    const delay = Math.abs(record.firedAt - occurrence.expectedAt);
    const isAborted = item.kind === 'aborted';
    return (
      <View
        style={[
          styles.row,
          { backgroundColor: theme.card, borderColor: isAborted ? theme.warning : theme.success },
        ]}
      >
        <View style={styles.rowTop}>
          <Text style={[styles.rowTaskId, { color: theme.text }]}>{record.taskId}</Text>
          {isAborted ? (
            <Badge label="aborted" color={theme.warning} bg={theme.warningBg} small />
          ) : (
            <Badge label="matched" color={theme.success} bg={theme.successBg} small />
          )}
        </View>
        <Text style={[styles.rowDetail, { color: theme.muted }]}>
          expected {new Date(occurrence.expectedAt).toLocaleTimeString()} ·
          fired {new Date(record.firedAt).toLocaleTimeString()} ·
          Δ{delay < 1000 ? `${delay}ms` : `${(delay / 1000).toFixed(0)}s`}
        </Text>
        {record.error && (
          <Text style={[styles.rowError, { color: theme.danger }]}>{record.error}</Text>
        )}
      </View>
    );
  }

  if (item.kind === 'missed') {
    const occ = item.data;
    return (
      <View
        style={[
          styles.row,
          { backgroundColor: theme.card, borderColor: theme.danger },
        ]}
      >
        <View style={styles.rowTop}>
          <Text style={[styles.rowTaskId, { color: theme.text }]}>{occ.taskId}</Text>
          <Badge label={occ.advisory ? 'missed (advisory)' : 'missed'} color={theme.danger} bg={theme.dangerBg} small />
        </View>
        <Text style={[styles.rowDetail, { color: theme.muted }]}>
          expected {new Date(occ.expectedAt).toLocaleTimeString()} · trigger: {occ.triggerType}
        </Text>
      </View>
    );
  }

  // unexpected
  const rec = item.data as TaskExecutionRecord;
  return (
    <View
      style={[
        styles.row,
        { backgroundColor: theme.card, borderColor: theme.unexpected },
      ]}
    >
      <View style={styles.rowTop}>
        <Text style={[styles.rowTaskId, { color: theme.text }]}>{rec.taskId}</Text>
        <Badge label="unexpected" color={theme.unexpected} bg={theme.unexpectedBg} small />
      </View>
      <Text style={[styles.rowDetail, { color: theme.muted }]}>
        fired {new Date(rec.firedAt).toLocaleTimeString()} · trigger: {rec.triggerType}
      </Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  root: { flex: 1 },
  refreshText: { fontSize: 20, fontWeight: '700' },
  pinned: { borderBottomWidth: StyleSheet.hairlineWidth },
  summaryArea: { paddingHorizontal: 12, paddingTop: 12, paddingBottom: 4 },
  summaryRow: { flexDirection: 'row', gap: 8, marginBottom: 10 },
  statCard: { flex: 1, borderRadius: 6, padding: 10, alignItems: 'center', borderWidth: 1.5 },
  statCount: { fontSize: 24, fontWeight: '800' },
  statLabel: { fontSize: 8, fontWeight: '800', letterSpacing: 1, marginTop: 3 },
  windowRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  windowLabel: { fontSize: 12 },
  windowChip: {
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 8,
    borderWidth: 1,
  },
  windowChipText: { fontSize: 12, fontWeight: '600' },
  advisory: {
    marginTop: 4,
    marginBottom: 8,
    padding: 10,
    borderRadius: 8,
  },
  advisoryText: { fontSize: 11, lineHeight: 16 },
  filterScroll: { height: 46 },
  filterRow: { flexDirection: 'row', paddingHorizontal: 12, gap: 8, paddingVertical: 4 },
  filterChip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 4,
    borderWidth: 1.5,
  },
  filterChipText: { fontSize: 9, fontWeight: '800', letterSpacing: 1 },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 40 },
  emptyText: { fontSize: 14, textAlign: 'center', lineHeight: 22 },
  list: { padding: 12, paddingBottom: 20 },
  row: {
    borderRadius: 10,
    borderWidth: 1.5,
    padding: 12,
    marginBottom: 8,
    gap: 4,
  },
  rowTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  rowTaskId: { fontSize: 13, fontWeight: '600', flex: 1 },
  rowDetail: { fontSize: 11, fontFamily: 'monospace' },
  rowError: { fontSize: 11, marginTop: 2 },
});
