/**
 * Root layout — wraps the whole router tree in the app-wide providers.
 *
 * `ConductorProvider` must sit above the tabs so every screen shares task/history state.
 * Task HANDLER registration happens earlier still, at module scope in `index.ts`
 * (`import './src/tasks'`), so headless relaunches work without this tree mounting.
 */
import { Slot } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useColorScheme } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ConductorProvider } from '../src/state/ConductorProvider';

export default function RootLayout() {
  const scheme = useColorScheme();
  return (
    <SafeAreaProvider>
      <ConductorProvider>
        <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
        <Slot />
      </ConductorProvider>
    </SafeAreaProvider>
  );
}
