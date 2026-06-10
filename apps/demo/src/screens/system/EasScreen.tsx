/**
 * EAS update subscreen — identifies the currently running bundle.
 */
import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import * as Updates from 'expo-updates';
import { useTheme } from '../../theme';
import { MONO, Section, SubScreen, fmtDateTime } from './parts';

export function EasScreen() {
  const theme = useTheme();
  const info = useMemo(() => ({
    isEmbedded: Updates.isEmbeddedLaunch,
    createdAt: Updates.createdAt,
    updateId: Updates.updateId,
    channel: Updates.channel,
    runtimeVersion: Updates.runtimeVersion,
  }), []);

  return (
    <SubScreen lede="'Embedded' means the original build APK/IPA; 'OTA' means a live update was applied at launch via expo-updates.">
      <Section title="RUNNING BUNDLE" theme={theme}>
        <View style={[s.card, { backgroundColor: theme.card, borderColor: theme.border }]}>
          <View style={s.row}>
            <View style={[s.badge, { backgroundColor: info.isEmbedded ? theme.warningBg : theme.successBg }]}>
              <Text style={[s.badgeText, { color: info.isEmbedded ? theme.warning : theme.success }]}>
                {info.isEmbedded ? 'EMBEDDED' : 'OTA'}
              </Text>
            </View>
            {info.channel && (
              <View style={[s.badge, { backgroundColor: theme.accentMuted }]}>
                <Text style={[s.badgeText, { color: theme.accent }]}>{info.channel}</Text>
              </View>
            )}
          </View>

          <Text style={[s.date, { color: theme.text, fontFamily: MONO }]}>
            {info.createdAt ? fmtDateTime(info.createdAt.getTime()) : '— no date available —'}
          </Text>

          <View style={s.metaGrid}>
            <Meta k="UPDATE ID" v={info.updateId ? `${info.updateId.slice(0, 8)}…` : '—'} theme={theme} />
            <Meta k="RUNTIME" v={info.runtimeVersion ?? '—'} theme={theme} />
          </View>
        </View>
      </Section>
    </SubScreen>
  );
}

function Meta({ k, v, theme }: { k: string; v: string; theme: ReturnType<typeof useTheme> }) {
  return (
    <View style={s.meta}>
      <Text style={[s.metaK, { color: theme.muted }]}>{k}</Text>
      <Text style={[s.metaV, { color: theme.text, fontFamily: MONO }]}>{v}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, padding: 16, gap: 10 },
  row: { flexDirection: 'row', gap: 6 },
  badge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 5, alignSelf: 'flex-start' },
  badgeText: { fontSize: 10, fontWeight: '800', letterSpacing: 1 },
  date: { fontSize: 15, fontWeight: '600' },
  metaGrid: { flexDirection: 'row', gap: 24, marginTop: 2 },
  meta: { gap: 3 },
  metaK: { fontSize: 8, fontWeight: '800', letterSpacing: 1.5 },
  metaV: { fontSize: 12 },
});
