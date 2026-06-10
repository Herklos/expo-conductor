/**
 * Permissions subscreen — notification permission + live conductor status.
 */
import React, { useState } from 'react';
import { useTheme } from '../../theme';
import Conductor from 'expo-conductor';
import { InfoRow, Section, SubScreen, useOp } from './parts';

export function PermissionsScreen() {
  const theme = useTheme();
  const { opResult, setOpResult, run } = useOp();
  const [permGranted, setPermGranted] = useState<boolean | null>(null);
  const [conductorStatus, setConductorStatus] = useState<string | null>(null);

  return (
    <SubScreen
      lede="POST_NOTIFICATIONS is required on Android 13+ for notification triggers and headless-tick alerts. Conductor status reflects OS background restrictions."
      banner={opResult}
    >
      <Section title="PERMISSIONS" theme={theme}>
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
      </Section>
    </SubScreen>
  );
}
