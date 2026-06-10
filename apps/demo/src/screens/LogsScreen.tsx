/**
 * Logs screen — two tabs:
 *   History  persisted TaskExecutionRecords folded from the native event log
 *   Live     real-time event stream (JS listener, in-memory, color-coded)
 */
import React, { useState } from 'react';
import {
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { LegendList } from '@legendapp/list/react-native';
import type { TaskExecutionRecord } from 'expo-conductor';
import { useTheme, type Theme } from '../theme';
import { useConductor } from '../state/ConductorProvider';
import { Badge } from '../components/Badge';

const MONO = Platform.select({ ios: 'Courier New', android: 'monospace' }) ?? 'monospace';

type LogTab = 'history' | 'live';

// ─── Shared header ────────────────────────────────────────────────────────────

function TabPill({
  active,
  onChange,
  theme,
}: {
  active: LogTab;
  onChange: (t: LogTab) => void;
  theme: Theme;
}) {
  return (
    <View style={[pill.wrap, { backgroundColor: theme.card, borderColor: theme.border }]}>
      {(['history', 'live'] as LogTab[]).map((tab) => {
        const sel = tab === active;
        return (
          <Pressable
            key={tab}
            style={[pill.btn, sel && { backgroundColor: theme.accent }]}
            onPress={() => onChange(tab)}
          >
            <Text style={[pill.txt, { color: sel ? '#fff' : theme.muted }]}>
              {tab === 'history' ? 'History' : 'Live'}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const pill = StyleSheet.create({
  wrap: {
    flexDirection: 'row',
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 3,
    gap: 2,
  },
  btn: { flex: 1, paddingVertical: 5, borderRadius: 8, alignItems: 'center' },
  txt: { fontSize: 12, fontWeight: '700' },
});

// ─── History tab ─────────────────────────────────────────────────────────────

function HistoryTab({ theme }: { theme: Theme }) {
  const { records, refreshHistory, clearHistory } = useConductor();
  const [filter, setFilter] = useState('');

  const filtered = filter.trim()
    ? records.filter(
        (r) =>
          r.taskId.toLowerCase().includes(filter.toLowerCase()) ||
          r.triggerType.toLowerCase().includes(filter.toLowerCase()),
      )
    : records;

  const sorted = [...filtered].sort((a, b) => b.firedAt - a.firedAt);

  const toolbar = (
    <>
      <View style={[ht.toolbar, { borderBottomColor: theme.border }]}>
        <TextInput
          style={[ht.input, { backgroundColor: theme.card, borderColor: theme.border, color: theme.text, flex: 1 }]}
          placeholder="Filter by task ID or trigger…"
          placeholderTextColor={theme.muted}
          value={filter}
          onChangeText={setFilter}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <Pressable onPress={refreshHistory} style={ht.act}>
          <Text style={[ht.actText, { color: theme.accent }]}>↻</Text>
        </Pressable>
        <Pressable onPress={clearHistory} style={ht.act}>
          <Text style={[ht.actText, { color: theme.danger }]}>🗑</Text>
        </Pressable>
      </View>
      {sorted.length === 0 && (
        <View style={ht.empty}>
          <Text style={[ht.emptyText, { color: theme.muted }]}>
            {records.length === 0
              ? 'No executions recorded yet.\nSchedule a task and let it fire!'
              : 'No results match the filter.'}
          </Text>
        </View>
      )}
    </>
  );

  return (
    <LegendList<TaskExecutionRecord>
      style={{ flex: 1 }}
      data={sorted}
      keyExtractor={(item: TaskExecutionRecord) => `${item.taskId}-${item.firedAt}-${item.attempt}`}
      renderItem={({ item }: { item: TaskExecutionRecord }) => <HistoryRow record={item} theme={theme} />}
      ListHeaderComponent={toolbar}
      contentContainerStyle={ht.list}
      estimatedItemSize={72}
      recycleItems
    />
  );
}

const ht = StyleSheet.create({
  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  input: {
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    fontSize: 13,
  },
  act: { padding: 6 },
  actText: { fontSize: 18, fontWeight: '700' },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 40 },
  emptyText: { fontSize: 14, textAlign: 'center', lineHeight: 22 },
  list: { paddingHorizontal: 12, paddingTop: 8, paddingBottom: 24 },
});

// ─── History row ─────────────────────────────────────────────────────────────

function statusBadge(r: TaskExecutionRecord, theme: Theme) {
  switch (r.status) {
    case 'completed':
      return <Badge label={r.result ?? 'done'} color={theme.success} bg={theme.successBg} small />;
    case 'failed':
    case 'error':
      return <Badge label={r.status} color={theme.danger} bg={theme.dangerBg} small />;
    case 'skipped':
      return <Badge label={`skipped: ${r.skippedReason ?? '?'}`} color={theme.warning} bg={theme.warningBg} small />;
    case 'running':
      return <Badge label="running…" color={theme.accent} bg={theme.accentMuted} small />;
    default:
      return null;
  }
}

function fmtTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function HistoryRow({ record, theme }: { record: TaskExecutionRecord; theme: Theme }) {
  const duration = record.completedAt != null ? `${record.completedAt - record.firedAt} ms` : null;

  return (
    <View style={[hr.row, { backgroundColor: theme.card, borderColor: theme.border }]}>
      <View style={hr.top}>
        <Text style={[hr.id, { color: theme.text }]} numberOfLines={1}>{record.taskId}</Text>
        {statusBadge(record, theme)}
      </View>
      <Text style={[hr.meta, { color: theme.muted, fontFamily: MONO }]}>
        {fmtTime(record.firedAt)}
        {duration ? `  ·  ${duration}` : ''}
        {'  ·  '}
        {record.triggerType}
        {record.attempt > 1 ? `  ·  attempt #${record.attempt}` : ''}
      </Text>
      {record.error && (
        <Text style={[hr.err, { color: theme.danger }]} numberOfLines={2}>{record.error}</Text>
      )}
    </View>
  );
}

const hr = StyleSheet.create({
  row: {
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 12,
    marginBottom: 8,
    gap: 4,
  },
  top: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  id: { fontSize: 14, fontWeight: '600', flex: 1 },
  meta: { fontSize: 11 },
  err: { fontSize: 11, marginTop: 2 },
});

// ─── Live tab ─────────────────────────────────────────────────────────────────

function liveColor(line: string, theme: Theme): string {
  if (line.includes('execute →')) return theme.accent;
  if (line.includes('complete →')) return theme.success;
  if (line.includes('error →')) return theme.danger;
  if (line.includes('skipped →')) return theme.warning;
  return theme.muted;
}

function LiveTab({ theme }: { theme: Theme }) {
  const { liveLog, clearLiveLog } = useConductor();

  const toolbar = (
    <>
      <View style={[lt.toolbar, { borderBottomColor: theme.border }]}>
        <View style={lt.dots}>
          <View style={[lt.dot, { backgroundColor: theme.danger }]} />
          <View style={[lt.dot, { backgroundColor: theme.warning }]} />
          <View style={[lt.dot, { backgroundColor: theme.success }]} />
        </View>
        <Text style={[lt.count, { color: theme.muted, fontFamily: MONO }]}>
          {liveLog.length} entries
        </Text>
        <Pressable onPress={clearLiveLog} style={lt.act}>
          <Text style={[lt.actText, { color: theme.danger }]}>🗑</Text>
        </Pressable>
      </View>
      {liveLog.length === 0 && (
        <View style={lt.empty}>
          <Text style={[lt.emptyText, { color: theme.muted, fontFamily: MONO }]}>
            — waiting for events —
          </Text>
        </View>
      )}
    </>
  );

  return (
    <LegendList<string>
      style={{ flex: 1 }}
      data={liveLog}
      keyExtractor={(_: string, i: number) => String(i)}
      renderItem={({ item }: { item: string }) => (
        <Text style={[lt.line, { color: liveColor(item, theme), fontFamily: MONO }]}>{item}</Text>
      )}
      ListHeaderComponent={toolbar}
      contentContainerStyle={lt.list}
      estimatedItemSize={22}
      recycleItems
    />
  );
}

const lt = StyleSheet.create({
  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  dots: { flexDirection: 'row', gap: 5 },
  dot: { width: 11, height: 11, borderRadius: 6 },
  count: { flex: 1, fontSize: 11 },
  act: { padding: 4 },
  actText: { fontSize: 18 },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  emptyText: { fontSize: 13 },
  list: { paddingHorizontal: 12, paddingTop: 8, paddingBottom: 24 },
  line: { fontSize: 12, lineHeight: 19, paddingVertical: 1 },
});

// ─── Root ─────────────────────────────────────────────────────────────────────

export function LogsScreen() {
  const theme = useTheme();
  const { records, liveLog } = useConductor();
  const [activeTab, setActiveTab] = useState<LogTab>('history');

  const count = activeTab === 'history' ? records.length : liveLog.length;

  return (
    <View style={[s.root, { backgroundColor: theme.bg }]}>
      {/* Toolbar — history/live toggle + count (the screen title is the Stack header) */}
      <View style={[s.header, { borderBottomColor: theme.border }]}>
        <View style={[s.countPill, { backgroundColor: theme.card, borderColor: theme.border }]}>
          <Text style={[s.countText, { color: theme.muted }]}>{count}</Text>
        </View>
        <TabPill active={activeTab} onChange={setActiveTab} theme={theme} />
      </View>

      {activeTab === 'history' ? (
        <HistoryTab theme={theme} />
      ) : (
        <LiveTab theme={theme} />
      )}
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  countPill: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
  },
  countText: { fontSize: 12, fontWeight: '600' },
});
