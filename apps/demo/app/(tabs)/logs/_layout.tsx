import { Stack } from 'expo-router';
import { useStackHeaderOptions } from '../../../src/navigation/headerOptions';

export default function LogsStackLayout() {
  const header = useStackHeaderOptions();
  return <Stack screenOptions={{ ...header, title: 'Logs' }} />;
}
