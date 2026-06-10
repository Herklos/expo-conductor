import { Stack } from 'expo-router';
import { useStackHeaderOptions } from '../../../src/navigation/headerOptions';

/**
 * The System tab is a Stack: the hub (index) plus the pushed subscreens. Each leaf
 * supplies its own header title; the tab bar stays visible while you drill in.
 */
export default function SystemStackLayout() {
  const header = useStackHeaderOptions();
  return (
    <Stack screenOptions={header}>
      <Stack.Screen name="index" options={{ title: 'System' }} />
      <Stack.Screen name="permissions" options={{ title: 'Permissions' }} />
      <Stack.Screen name="budget" options={{ title: 'Resource Budget' }} />
      <Stack.Screen name="headless" options={{ title: 'Headless Tick' }} />
      <Stack.Screen name="eas" options={{ title: 'EAS Update' }} />
      <Stack.Screen name="tasks" options={{ title: 'Task Registry' }} />
    </Stack>
  );
}
