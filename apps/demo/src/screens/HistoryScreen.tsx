/**
 * History Screen — shows a chronological list of TaskExecutionRecords folded from the
 * native-persisted event log. Works for both foreground and headless runs.
 */
import React, { useState } from 'react';
import {
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import type { TaskExecutionRecord } from 'expo-conductor';
import { useTheme } from '../theme';
import { useConductor } from '../state/ConductorProvider';
import { Badge } from '../components/Badge';

export function HistoryScreen() {
  const theme = useTheme();
  const { records, refreshHistory, clearHistory } = useConductor();
  const [filter, setFilter] = useState('');

  const filtered = filter.trim()
    ? records.filter(
        (r) =>
          r.taskId.toLowerCase().includes(filter.toLowerCase()) ||
          r.triggerType.toLowerCase().includes(filter.toLowerCase()),
      )
    : records;

  // Sorted newest-first for display.
  const sorted = [...filtered].sort((a, b) => b.firedAt - a.firedAt);

  return (
    <View style={[styles.root, { backgroundColor: theme.bg }]}>
      {/* Header */}
      <View style={[styles.header, { borderBottomColor: theme.border }]}>
        <Text style={[styles.title, { color: theme.text }]}>
          Execution History ({records.length})
        </Text>
        <View style={styles.headerActions}>
          <Pressable onPress={refreshHistory} style={styles.headerBtn}>
            <Text style={[styles.headerBtnText, { color: theme.accent }]}>↻ Refresh</Text>
          </Pressable>
          <Pressable onPress={clearHistory} style={styles.headerBtn}>
            <Text style={[styles.headerBtnText, { color: theme.danger }]}>🗑 Clear</Text>
          </Pressable>
        </View>
      </View>

      {/* Filter */}
      <TextInput
        style={[
          styles.searchInput,
          { backgroundColor: theme.card, borderColor: theme.border, color: theme.text },
        ]}
        placeholder="Filter by task ID or trigger…"
        placeholderTextColor={theme.muted}
        value={filter}
        onChangeText={setFilter}
        autoCapitalize="none"
        autoCorrect={false}
      />

      {/* List */}
      {sorted.length === 0 ? (
        <View style={styles.empty}>
          <Text style={[styles.emptyText, { color: theme.muted }]}>
            {records.length === 0
              ? 'No executions recorded yet.\nSchedule a task and let it fire!'
              : 'No results match the filter.'}
          </Text>
        </View>
      ) : (
        <FlatList
          data={sorted}
          keyExtractor={(item) => `${item.taskId}-${item.firedAt}-${item.attempt}`}
          renderItem={({ item }) => <HistoryRow record={item} theme={theme} />}
          contentContainerStyle={styles.list}
        />
      )}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Row component
// ---------------------------------------------------------------------------

interface RowProps {
  record: TaskExecutionRecord;
  theme: ReturnType<typeof useTheme>;
}

function statusBadge(record: TaskExecutionRecord, theme: ReturnType<typeof useTheme>) {
  switch (record.status) {
    case 'completed':
      return <Badge label={record.result ?? 'done'} color={theme.success} bg={theme.successBg} small />;
    case 'failed':
      return <Badge label="failed" color={theme.danger} bg={theme.dangerBg} small />;
    case 'error':
      return <Badge label="error" color={theme.danger} bg={theme.dangerBg} small />;
    case 'skipped':
      return <Badge label={`skipped: ${record.skippedReason ?? '?'}`} color={theme.warning} bg={theme.warningBg} small />;
    case 'running':
      return <Badge label="running…" color={theme.accent} bg={theme.accentMuted} small />;
    default:
      return null;
  }
}

function HistoryRow({ record, theme }: RowProps) {
  const firedTime = new Date(record.firedAt).toLocaleTimeString();
  const completedTime = record.completedAt
    ? new Date(record.completedAt).toLocaleTimeString()
    : null;
  const duration =
    record.completedAt != null ? `${record.completedAt - record.firedAt} ms` : null;

  return (
    <View
      style={[
        styles.row,
        { backgroundColor: theme.card, borderColor: theme.border },
      ]}
    >
      <View style={styles.rowTop}>
        <Text style={[styles.taskId, { color: theme.text }]} numberOfLines={1}>
          {record.taskId}
        </Text>
        {statusBadge(record, theme)}
      </View>
      <View style={styles.rowMeta}>
        <Text style={[styles.meta, { color: theme.muted }]}>
          {firedTime}
          {completedTime && completedTime !== firedTime ? ` → ${completedTime}` : ''}
          {duration ? ` · ${duration}` : ''}
          {' · '}
          {record.triggerType}
          {record.attempt > 1 ? ` · attempt #${record.attempt}` : ''}
        </Text>
      </View>
      {record.error && (
        <Text style={[styles.error, { color: theme.danger }]} numberOfLines={2}>
          {record.error}
        </Text>
      )}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    paddingHorizontal: 16,
    paddingTop: 56,
    paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
  },
  title: { fontSize: 20, fontWeight: '700' },
  headerActions: { flexDirection: 'row', gap: 8 },
  headerBtn: { padding: 4 },
  headerBtnText: { fontSize: 13, fontWeight: '600' },
  searchInput: {
    margin: 12,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    borderWidth: 1,
    fontSize: 14,
  },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 40 },
  emptyText: { fontSize: 14, textAlign: 'center', lineHeight: 22 },
  list: { paddingHorizontal: 12, paddingBottom: 20 },
  row: {
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 12,
    marginBottom: 8,
    gap: 4,
  },
  rowTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  taskId: { fontSize: 14, fontWeight: '600', flex: 1 },
  rowMeta: { flexDirection: 'row', flexWrap: 'wrap', gap: 4 },
  meta: { fontSize: 11, fontFamily: 'monospace' },
  error: { fontSize: 11, marginTop: 2 },
});
