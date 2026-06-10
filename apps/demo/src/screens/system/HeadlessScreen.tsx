/**
 * Headless tick subscreen — registers an expo-background-task periodic tick so JS
 * handlers can run after the app is terminated.
 */
import React from 'react';
import { useTheme } from '../../theme';
import {
  backgroundTaskStatus,
  disableHeadlessBackground,
  enableHeadlessBackground,
} from '../../backgroundTask';
import { Btn, Section, SubScreen, useOp } from './parts';
import { StyleSheet, View } from 'react-native';

export function HeadlessScreen() {
  const theme = useTheme();
  const { opResult, setOpResult, run } = useOp();

  return (
    <SubScreen
      lede="Registers an expo-background-task periodic tick that calls Conductor.runDueTasks(), so JS handlers survive a cold start. Requires the optional expo-task-manager + expo-background-task peer deps; the OS decides the real cadence (≈15 min minimum)."
      banner={opResult}
    >
      <Section title="BACKGROUND TICK" theme={theme}>
        <View style={hs.btnRow}>
          <Btn
            label="ENABLE 15m"
            color={theme.accent}
            grow
            onPress={() => run(async () => setOpResult(await enableHeadlessBackground(15)))}
          />
          <Btn
            label="STATUS"
            color={theme.accent}
            grow
            onPress={() => run(async () => setOpResult(await backgroundTaskStatus()))}
          />
          <Btn
            label="DISABLE"
            color={theme.danger}
            grow
            onPress={() => run(async () => setOpResult(await disableHeadlessBackground()))}
          />
        </View>
      </Section>
    </SubScreen>
  );
}

const hs = StyleSheet.create({
  btnRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
});
