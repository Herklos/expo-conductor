/**
 * Resource budget subscreen — caps the fraction of each resource class the
 * conductor may allocate across all concurrently running tasks.
 */
import React, { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTheme, type Theme } from '../../theme';
import Conductor from 'expo-conductor';
import { Btn, MONO, Section, SubScreen, useOp } from './parts';

type Budget = { cpu: number; network: number; battery: number; memory: number };
const FULL: Budget = { cpu: 1, network: 1, battery: 1, memory: 1 };

export function BudgetScreen() {
  const theme = useTheme();
  const { opResult, setOpResult, run } = useOp();
  const [budget, setBudget] = useState<Budget>(FULL);

  const apply = (next: Budget, msg: string) =>
    run(async () => {
      await Conductor.setResourceBudget(next);
      setBudget(next);
      setOpResult(msg);
    });

  return (
    <SubScreen
      lede="Caps how much of each resource class the conductor may allocate across all concurrently running tasks. Values are fractions of 1.0; tasks whose weight exceeds the remaining headroom are admission-deferred."
      banner={opResult}
    >
      <Section title="CURRENT BUDGET" theme={theme}>
        <View style={[meter.grid, { borderColor: theme.border, backgroundColor: theme.card }]}>
          <Gauge label="CPU"     value={budget.cpu}     theme={theme} />
          <Gauge label="NETWORK" value={budget.network} theme={theme} />
          <Gauge label="BATTERY" value={budget.battery} theme={theme} />
          <Gauge label="MEMORY"  value={budget.memory}  theme={theme} />
        </View>
      </Section>

      <Section title="PRESETS" theme={theme}>
        <View style={meter.btnRow}>
          <Btn label="CPU 0.5" color={theme.accent} grow onPress={() => apply({ ...FULL, cpu: 0.5 }, 'budget → cpu=0.5')} />
          <Btn label="NET 0.5" color={theme.accent} grow onPress={() => apply({ ...FULL, network: 0.5 }, 'budget → network=0.5')} />
          <Btn label="RESET" color={theme.success} fill grow onPress={() => apply(FULL, 'budget reset to 1.0')} />
        </View>
      </Section>
    </SubScreen>
  );
}

function Gauge({ label, value, theme }: { label: string; value: number; theme: Theme }) {
  const full = value >= 1;
  const color = full ? theme.success : theme.accent;
  return (
    <View style={meter.gauge}>
      <View style={meter.gaugeHead}>
        <Text style={[meter.gaugeLabel, { color: theme.muted }]}>{label}</Text>
        <Text style={[meter.gaugeVal, { color, fontFamily: MONO }]}>{value.toFixed(1)}</Text>
      </View>
      <View style={[meter.track, { backgroundColor: theme.border }]}>
        <View style={[meter.fill, { backgroundColor: color, width: `${Math.round(value * 100)}%` }]} />
      </View>
    </View>
  );
}

const meter = StyleSheet.create({
  grid: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, padding: 14, gap: 12 },
  gauge: { gap: 6 },
  gaugeHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  gaugeLabel: { fontSize: 9, fontWeight: '800', letterSpacing: 1.5 },
  gaugeVal: { fontSize: 13, fontWeight: '700' },
  track: { height: 6, borderRadius: 3, overflow: 'hidden' },
  fill: { height: 6, borderRadius: 3 },
  btnRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
});
