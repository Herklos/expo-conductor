/**
 * Task registry subscreen — every task currently stored by the conductor.
 * 'Next run' is the computed next trigger time; '—' means no future occurrence.
 */
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../theme';
import { useConductor } from '../../state/ConductorProvider';
import { MONO, SubScreen, fmtDateTime } from './parts';

export function TasksScreen() {
  const theme = useTheme();
  const { tasks, refresh } = useConductor();

  return (
    <SubScreen lede={`${tasks.length} task${tasks.length !== 1 ? 's' : ''} registered with the conductor.`}>
      <View style={s.toolbar}>
        <Pressable onPress={() => void refresh()} style={({ pressed }) => [s.refresh, { borderColor: theme.border, opacity: pressed ? 0.6 : 1 }]}>
          <Text style={[s.refreshText, { color: theme.accent }]}>↻ REFRESH</Text>
        </Pressable>
      </View>

      {tasks.length === 0 ? (
        <Text style={[s.empty, { color: theme.muted, fontFamily: MONO }]}>— no tasks registered —</Text>
      ) : (
        <View style={[s.table, { borderColor: theme.border }]}>
          <View style={[s.head, { borderBottomColor: theme.border, backgroundColor: theme.card }]}>
            <Text style={[s.thId, { color: theme.muted }]}>TASK ID</Text>
            <Text style={[s.thPri, { color: theme.muted }]}>PRI</Text>
            <Text style={[s.thDate, { color: theme.muted }]}>NEXT RUN</Text>
          </View>
          {tasks.map((t, idx) => (
            <View
              key={t.id}
              style={[
                s.row,
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
    </SubScreen>
  );
}

const s = StyleSheet.create({
  toolbar: { flexDirection: 'row', justifyContent: 'flex-end', marginBottom: 10 },
  refresh: { borderWidth: 1.5, borderRadius: 4, paddingVertical: 6, paddingHorizontal: 12 },
  refreshText: { fontSize: 10, fontWeight: '800', letterSpacing: 1 },
  empty: { fontSize: 12, textAlign: 'center', paddingVertical: 16 },
  table: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, overflow: 'hidden' },
  head: { flexDirection: 'row', paddingVertical: 7, paddingHorizontal: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  thId: { flex: 3, fontSize: 9, fontWeight: '800', letterSpacing: 1.5 },
  thPri: { width: 36, fontSize: 9, fontWeight: '800', letterSpacing: 1.5, textAlign: 'center' },
  thDate: { flex: 3, fontSize: 9, fontWeight: '800', letterSpacing: 1.5, textAlign: 'right' },
  row: { flexDirection: 'row', paddingVertical: 8, paddingHorizontal: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  tdId: { flex: 3, fontSize: 11 },
  tdPri: { width: 36, fontSize: 11, textAlign: 'center' },
  tdDate: { flex: 3, fontSize: 10, textAlign: 'right' },
});
